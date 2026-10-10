/* ==========================================================================
 * mcp-manager dashboard — Settings popup/modal (master–detail).
 *
 * A full-viewport overlay opened from the header's gear icon (#open-settings,
 * see html/header.html). LEFT rail = vertical category menu built from the
 * exported SETTINGS_SECTIONS registry (extensible: unknown future ids render a
 * neutral "coming soon" stub); RIGHT panel = content for the selected section.
 * The only implemented section today is "API Providers": it lists saved LLM
 * engine configs over the /api/api-providers REST contract and provides an
 * editor form beneath the list (unsaved draft => POST create; existing record
 * => PATCH by id). Radio selection issues PATCH {isActive:true} immediately so
 * exactly one active provider exists client-side, mirroring the server
 * invariant. Framework-free DOM + global fetch (injectable for unit tests);
 * all failures surface as inline messages — never crashes the page.
 *
 * Import graph: this -> dom.mjs only. Wired once from app.js init() AFTER
 * mountLayout() has mounted the header fragment that hosts the trigger button.
 * ==================================================================== */
import { $, el } from './dom.mjs';

/* ---- extensible settings-section registry ---------------------------- */
/* Adding a future category = append one entry here; its left-rail item and
   right-panel stub (or real pane) are generated automatically below. */
export const SETTINGS_SECTIONS = [
  { id: 'apiProviders', label: 'API Providers' }
];

const PROVIDER_PROTOCOLS = ['openai', 'anthropic'];
const DEFAULT_SECTION = SETTINGS_SECTIONS[0].id; // first registered section wins on open
const ACTIVE_RADIO_NAME = 'settings-provider-active'; // native radio group: one checked at most in the DOM too
const PROVIDERS_BASE = 'api/api-providers';          // relative base path, matching the dashboard convention

/* ---- pure helpers (unit-testable without any network or DOM) --------- */
/* Client-side validation mirroring the server rules (non-empty name/baseUrl;
 * model is optional): returns {ok, errors{field:message}} BEFORE any submit
 * hits network. */
export function validateClientSide(input) {
  var v = input || {};
  var errors = {};
  if (!String(v.name == null ? '' : v.name).trim()) errors.name = 'Name is required.';
  if (!String(v.baseUrl == null ? '' : v.baseUrl).trim()) errors.baseUrl = 'Base URL is required.';
  return { ok: Object.keys(errors).length === 0, errors: errors };
}

/* Display-only projection of a provider row record (list items show masked
 * key status via apiKeySet; raw keys are NEVER rendered here). */
export function formatProviderRow(provider) {
  var p = provider || {};
  var name = String(p.name == null ? '' : p.name);
  var protocol = String(p.protocol == null ? '' : p.protocol);
  return {
    id: p.id != null ? String(p.id) : '',
    name: name || '(unnamed)',
    baseUrl: String(p.baseUrl == null ? '' : p.baseUrl),
    model: String(p.model == null ? '' : p.model),
    protocol: protocol,
    protocolLabel: protocol === 'anthropic' ? 'Anthropic' : 'OpenAI',
    keySet: !!p.apiKeySet,
    active: !!p.isActive
  };
}

let initialized = false; // single-instance guard: initSettings() runs exactly once even if called twice

export function initSettings(options) {
  var opts = options || {};
  if (initialized) return;
  initialized = true;

  var f = typeof opts.fetchImpl === 'function' ? opts.fetchImpl : globalThis.fetch;
  // Bind fetch to its global so it works whether injected or default.
  var doFetch = f && f.bind ? f.bind(typeof window !== 'undefined' ? window : globalThis) : f;

  /* ---- module-local state ------------------------------------------- */
  var backdrop, dialogEl, railEl, panelEl, triggerEl;
  var els = {};                       // providers-pane ids, cached after mount
  var providerRows = [];              // last fetched list rows (apiKeySet only, never raw keys)
  var editorId = '';                  // '' => unsaved draft / neutral; string id => editing an existing saved record
  var isDraft = false;                // user is authoring a NEW (unsaved) provider in the form
  var currentSection = DEFAULT_SECTION;
  var provView = 'list';             // 'list' | 'form' — internal sub-view selector for the providers pane (not a route)
  var openFlag = false;
  var busyActive = false;             // guards overlapping PATCH {isActive:true} calls
  var busySave = false;               // guards overlapping create/update submits

  function detailUrl(id) { return PROVIDERS_BASE + '/' + encodeURIComponent(id); }

  /* JSON request helper: parses ok-responses as data, throws Error{status,message}
     otherwise using the server's {error} text when present. Never leaks network errors up. */
  async function fetchJson(url, init) {
    var res = await doFetch(url, init);
    var data = null;
    try { data = await res.json(); } catch (_e) { /* non-JSON body — status below suffices */ }
    if (!res.ok) {
      var msg = data && typeof data.error === 'string' ? data.error : 'HTTP ' + res.status;
      var err = new Error(msg);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function rowById(id) {
    for (var i = 0; i < providerRows.length; i++) {
      if (providerRows[i] && String(providerRows[i].id) === String(id)) return providerRows[i];
    }
    return null;
  }
  function findEl(id) { return els[id] || $(id); }

  /* ============================== overlay markup ======================== */
  const BACKDROP_HTML =
    '<div class="settings-backdrop" hidden>' +
      '<div class="settings-card card" role="dialog" aria-modal="true" aria-labelledby="settings-title" tabindex="-1">' +
        '<div class="settings-head">' +
          '<h2 id="settings-title">Settings</h2>' +
          '<button type="button" class="btn icon-btn" id="settings-close" aria-label="Close settings">&#215;</button>' +
        '</div>' +
        '<div class="settings-body">' +
          '<nav class="settings-rail-nav" aria-label="Settings sections">' +
            '<ul id="settings-rail" class="settings-rail"></ul>' +
          '</nav>' +
          '<main id="settings-panel" class="settings-panel"></main>' +
        '</div>' +
      '</div>' +
    '</div>';

  // Static skeleton of the API Providers pane, split into two sub-views toggled
  // by internal state (NOT a URL route — the modal isn't routed): a LIST view
  // (action bar + providers table, the default) and a FORM view (the add/edit
  // form). The pane-level error banner sits outside both so list failures stay
  // visible in either view. Only dynamic values are injected later.
  const PROVIDER_PANE_HTML =
    '<section class="settings-subpane" data-pane="apiProviders">' +
      '<div id="prov-error" class="form-error" role="alert" hidden></div>' +
      '<section id="prov-list-view" class="prov-view">' +
        '<div class="prov-bar">' +
          '<button type="button" class="btn btn-primary" id="prov-add-btn">+ Add Provider</button>' +
          '<span class="muted small prov-hint">Click a provider row to edit it \u00B7 select a radio circle to make that provider active.</span>' +
        '</div>' +
        '<ul id="prov-list" class="provider-list"></ul>' +
        '<div id="prov-status" class="small muted" hidden>Loading\u2026</div>' +
        '<div id="prov-empty" class="empty" hidden>No API providers yet \u2014 click "+ Add Provider" to configure an LLM engine.</div>' +
      '</section>' +
      '<section id="prov-form-view" class="prov-view is-hidden">' +
        '<section id="prov-editor" class="prov-editor">' +
          '<h3 id="prov-editor-title" class="section-title">Provider</h3>' +
          '<form id="prov-form" novalidate>' +
            '<div class="field-row">' +
              '<div class="field">' +
                '<label for="pf-name">Name</label>' +
                '<input id="pf-name" type="text" placeholder="e.g. OpenAI local" />' +
                '<div class="hint">Required. Shown as the provider label in the list.</div>' +
              '</div>' +
              '<div class="field">' +
                '<label for="pf-base-url">Base URL</label>' +
                '<input id="pf-base-url" type="text" placeholder="https://host.example/v1" />' +
                '<div class="hint">Required. Endpoint base for this engine (OpenAI- or Anthropic-style).</div>' +
              '</div>' +
            '</div>' +
            '<div class="field-row">' +
              '<div class="field">' +
                '<label for="pf-model">Model (optional)</label>' +
                '<input id="pf-model" type="text" placeholder="e.g. gpt-4o-mini" />' +
                '<div class="hint">Leave blank to route each request to the model the client requests.</div>' +
              '</div>' +
              '<div class="field">' +
                '<label for="pf-protocol">Protocol</label>' +
                '<select id="pf-protocol"></select>' +
                '<div class="hint">Wire protocol used when calling this endpoint.</div>' +
              '</div>' +
            '</div>' +
            '<div class="field field-key">' +
              '<label for="pf-api-key">API key</label>' +
              '<div class="key-line">' +
                '<input id="pf-api-key" class="pf-password" type="password" autocomplete="off" spellcheck="false" />' +
                '<button type="button" class="btn key-toggle" id="pf-key-toggle">Reveal</button>' +
              '</div>' +
              '<div class="hint">Optional. Leave blank for no key; saving an empty value clears any stored key.</div>' +
            '</div>' +
            '<div class="prov-foot">' +
              '<button type="submit" class="btn btn-primary" id="pf-save">Save</button>' +
              '<span class="spacer"></span>' +
              '<button type="button" class="btn" id="pf-reset" title="Discard changes and reload the latest saved values" hidden>Reset to saved</button>' +
              '<button type="button" class="btn" id="pf-cancel">Cancel</button>' +
            '</div>' +
            '<div id="pf-error" class="form-error" role="alert" hidden></div>' +
          '</form>' +
        '</section>' +
      '</section>' +
    '</section>';

  function buildModal() {
    var tpl = document.createElement('template');
    tpl.innerHTML = BACKDROP_HTML.trim();
    backdrop = tpl.content.firstElementChild;
    dialogEl = findEl('settings-dialog') || backdrop.firstElementChild;
    document.body.appendChild(tpl.content);
  }

  // Fill the protocol select from the contract's fixed protocol set (default openai).
  function initProtocolSelect(select) {
    select.textContent = '';
    PROVIDER_PROTOCOLS.forEach(function (proto) {
      var o = el('option', null, proto);
      o.value = proto;
      if (proto === 'openai') o.selected = true; // spec default
      select.appendChild(o);
    });
  }

  /* ======================== master–detail panes ======================= */
  function placeholderPane(section) {
    var pane = el('section', 'settings-subpane settings-placeholder');
    pane.setAttribute('data-pane', section.id);
    var h3 = el('h3', 'section-title', section.label);
    var p = el('p', 'small muted', 'Coming soon.');
    pane.appendChild(h3); pane.appendChild(p);
    return pane;
  }

  function providersPane() {
    var tpl = document.createElement('template');
    tpl.innerHTML = PROVIDER_PANE_HTML.trim();
    var pane = tpl.content.firstElementChild;   // not yet connected: resolve ids from the pane itself
    initProtocolSelect(pane.querySelector('#pf-protocol'));
    bindProvidersEvents(pane);
    return pane;
  }

  function ensurePanesBuilt() {
    SETTINGS_SECTIONS.forEach(function (section) {
      var existing = panelEl.querySelector('.settings-subpane[data-pane="' + section.id + '"]');
      if (!existing) {
        panelEl.appendChild(section.id === 'apiProviders' ? providersPane() : placeholderPane(section));
      }
    });
  }

  function renderRail() {
    railEl.textContent = '';
    SETTINGS_SECTIONS.forEach(function (section) {
      var li = el('li');
      var btn = el('button', 'rail-item' + (section.id === currentSection ? ' is-active' : ''), section.label);
      btn.type = 'button';
      btn.setAttribute('data-section-id', section.id);
      if (section.id === currentSection) btn.setAttribute('aria-current', 'true'); else btn.removeAttribute('aria-current');
      btn.addEventListener('click', function () { selectSection(section.id); });
      li.appendChild(btn);
      railEl.appendChild(li);
    });
  }

  function selectSection(id) {
    var known = SETTINGS_SECTIONS.some(function (s) { return s.id === id; });
    if (!known) return;                       // unknown ids are ignored by design
    currentSection = id;
    renderRail();
    Array.prototype.forEach.call(panelEl.children, function (pane) {
      pane.hidden = pane.getAttribute('data-pane') !== id;
    });
    if (id === 'apiProviders') { showListView(); refreshList(); } // fresh data on every show (hot-apply aware)
  }

  /* ====================== list: rendering + actions ==================== */
  function setProvError(msg) {
    var n = findEl('prov-error');
    if (!n) return;
    n.textContent = msg || '';
    n.hidden = !msg;
  }
  function setPfError(msg) {
    var n = findEl('pf-error');
    if (!n) return;
    n.textContent = msg || '';
    n.hidden = !msg;
  }
  function setStatus(text) {
    var n = findEl('prov-status');
    if (!n) return;
    n.textContent = text || '';
    n.hidden = !text;
  }

  /* Sub-view toggle: the API Providers pane alternates between a LIST view and an
     add/edit FORM view driven by module-local state (not a URL route). The form
     view starts hidden; the list view is the default on open / section-select. */
  function showListView() {
    provView = 'list';
    syncProvViews();
  }
  function showFormView() {
    provView = 'form';
    syncProvViews();
  }
  function syncProvViews() {
    var lv = findEl('prov-list-view');
    var fv = findEl('prov-form-view');
    if (lv) lv.classList.toggle('is-hidden', provView !== 'list');
    if (fv) fv.classList.toggle('is-hidden', provView !== 'form');
  }

  function updateLoadedMarkers() {
    var loadedId = editorId && !isDraft ? String(editorId) : '';
    Array.prototype.forEach.call(findEl('prov-list').querySelectorAll('.provider-row'), function (row) {
      row.classList.toggle('is-loaded', !!loadedId && row.getAttribute('data-provider-id') === loadedId);
    });
  }

  // Render rows from a freshly fetched list payload ({providers:[...], activeId}).
  // Raw keys never appear here — only the masked apiKeySet flag drives the dot.
  function renderProviders(data) {
    providerRows = data && Array.isArray(data.providers) ? data.providers.slice() : [];
    var list = findEl('prov-list');
    var emptyEl = findEl('prov-empty');
    if (!list) return;
    list.textContent = '';
    if (emptyEl) emptyEl.hidden = providerRows.length > 0;
    providerRows.forEach(function (p) {
      var d = formatProviderRow(p);
      var li = el('li', 'provider-row' + (d.active ? ' is-active' : ''));
      li.setAttribute('data-provider-id', d.id);

      var radio = el('input', 'prov-radio');
      radio.type = 'radio';
      radio.name = ACTIVE_RADIO_NAME;
      radio.value = d.id;
      radio.checked = d.active;                       // mirrors server invariant: at most one checked
      radio.setAttribute('aria-label', 'Make "' + d.name + '" the active provider');

      var info = el('div', 'provider-info');
      info.appendChild(el('span', 'provider-name', d.name));
      info.appendChild(el('span', 'provider-meta', (d.baseUrl || '\u2014') + ' \u00B7 ' + (d.model || '\u2014')));

      var aux = el('span', 'prov-aux');
      var chip = el('span', 'badge proto-chip ' + (d.protocol === 'anthropic' ? 'proto-anthropic' : 'proto-openai'), d.protocolLabel.toLowerCase());
      var dot = el('span', 'key-dot' + (d.keySet ? ' is-set' : ''));
      dot.title = d.keySet ? 'API key configured' : 'No API key set';
      var delBtn = el('button', 'btn-ghost prov-del', '\u00D7');
      delBtn.type = 'button';
      delBtn.title = 'Delete this provider';
      delBtn.setAttribute('aria-label', 'Delete provider "' + d.name + '"');
      aux.appendChild(chip); aux.appendChild(dot); aux.appendChild(delBtn);

      li.appendChild(radio); li.appendChild(info); li.appendChild(aux);
      list.appendChild(li);
    });
    updateLoadedMarkers();
  }

  async function refreshList() {
    setProvError(null);
    setStatus('Loading\u2026');
    try {
      var data = await fetchJson(PROVIDERS_BASE);
      renderProviders(data);
    } catch (e) {
      setProvError('Failed to load providers: ' + (e && e.message ? e.message : String(e)));
    } finally {
      setStatus(null);
    }
  }

  /* Radio selection => PATCH {isActive:true} IMMEDIATELY, then re-render from a
     fresh GET so radios/activeId always mirror the server's single-active row. */
  async function activateProvider(id) {
    if (!rowById(id)) return;               // guard: only act on rows known from the last fetched list
    if (busyActive) return;                 // prevent overlapping activations
    busyActive = true;
    try {
      await fetchJson(detailUrl(id), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive: true })
      });
      await refreshList();                  // authoritative reload: mirrors the server's single-active row
    } catch (e) {
      setProvError('Could not make active: ' + (e && e.message ? e.message : String(e)));
      var r2 = findEl('prov-list')?.querySelector('input.prov-radio[value="' + id + '"]');
      if (r2) r2.checked = false;           // revert optimistic UI state when the request fails
    } finally { busyActive = false; }
  }

  async function deleteProvider(id) {
    var p = rowById(id);
    var label = p ? formatProviderRow(p).name : '(unknown)';
    if (!window.confirm('Delete provider "' + label + '"? This cannot be undone.')) return;
    try {
      var res = await doFetch(detailUrl(id), { method: 'DELETE' });
      if (!res.ok && res.status !== 404) {
        var msg = 'HTTP ' + res.status;
        try { var d = await res.json(); if (d && typeof d.error === 'string') msg = d.error; } catch (_e) {}
        throw new Error(msg);
      }
      await refreshList(); // auto-promotion of a remaining provider is reflected here
      if (String(editorId) === String(id)) discardEditor();
    } catch (e) {
      setProvError('Delete failed: ' + (e && e.message ? e.message : String(e)));
    }
  }

  /* ============================ editor form =========================== */
  function clearForm() {
    findEl('pf-name').value = '';
    findEl('pf-base-url').value = '';
    findEl('pf-model').value = '';
    findEl('pf-api-key').value = '';
    findEl('pf-protocol').value = 'openai';       // spec default for fresh drafts
    ensureKeyHidden();
    setPfError(null);
  }

  function ensureKeyHidden() {
    var key = findEl('pf-api-key');
    key.type = 'password';
    findEl('pf-key-toggle').textContent = 'Reveal';
  }
  function toggleKeyVisibility() {
    var key = findEl('pf-api-key');
    var showing = key.type === 'text';
    key.type = showing ? 'password' : 'text';
    findEl('pf-key-toggle').textContent = showing ? 'Reveal' : 'Hide';
    if (!showing) key.focus();
  }

  function updateEditorTitle(name) {
    var t = findEl('prov-editor-title');
    if (!t) return;
    t.textContent = isDraft ? 'New provider' : name ? 'Edit \u201C' + name + '\u201D' : 'Provider';
  }
  function showReset(show) { findEl('pf-reset').hidden = !show; }

  function populateForm(rec, asExisting) {
    findEl('pf-name').value = String(rec.name == null ? '' : rec.name);
    findEl('pf-base-url').value = String(rec.baseUrl == null ? '' : rec.baseUrl);
    findEl('pf-model').value = String(rec.model == null ? '' : rec.model);
    findEl('pf-api-key').value = typeof rec.apiKey === 'string' ? rec.apiKey : '';   // raw key from GET detail / created+updated record
    var proto = String(rec.protocol || 'openai');
    findEl('pf-protocol').value = PROVIDER_PROTOCOLS.indexOf(proto) !== -1 ? proto : 'openai';
    ensureKeyHidden();
    setPfError(null);
    if (asExisting) {
      editorId = String(rec.id != null ? rec.id : '');
      isDraft = false;
      showReset(true);
    }
    updateEditorTitle(formatProviderRow(rec).name);
    updateLoadedMarkers();
  }

  // Clicking a row body loads that provider's FULL record (raw apiKey included)
  // via the GET detail endpoint and switches the form to existing-record mode.
  async function loadEditorFor(id) {
    try {
      var rec = await fetchJson(detailUrl(id));
      populateForm(rec, true);
      showFormView();                        // enter the FORM sub-view (edit mode, prefilled)
    } catch (e) {
      if (e && e.status === 404) {
        setPfError('Provider not found \u2014 it may have been deleted.');
        refreshList();                       // resync the list with the server
      } else {
        setPfError('Could not load provider: ' + (e && e.message ? e.message : String(e)));
      }
    }
  }

  function startDraft() {
    clearForm();
    editorId = '';                           // unsaved draft until Save succeeds
    isDraft = true;
    showReset(false);
    updateEditorTitle('');
    showFormView();                          // enter the FORM sub-view (new / unsaved-draft mode)
    findEl('prov-editor').scrollIntoView({ block: 'nearest' });
    findEl('pf-name').focus();
  }

  // Cancel: discard any unsaved draft/edits locally — no network call.
  function discardEditor() {
    clearForm();
    editorId = '';
    isDraft = false;
    showReset(false);
    updateEditorTitle('');
    updateLoadedMarkers();
    showListView();                          // return to the LIST sub-view, discarding the draft
  }

  async function resetToSaved() {
    if (!editorId) return;                   // only meaningful while editing an existing record
    try {
      var rec = await fetchJson(detailUrl(editorId));
      populateForm(rec, true);               // latest saved values win, in-progress edits discarded
    } catch (e) {
      if (e && e.status === 404) {
        setPfError('Provider not found \u2014 it may have been deleted.');
        discardEditor();
        refreshList();
      } else {
        setPfError('Reset failed: ' + (e && e.message ? e.message : String(e)));
      }
    }
  }

  // Read form values (trimmed), validate client-side FIRST (mirrors server rules),
  // then POST a brand-new draft or PATCH the existing record being edited.
  function readValues() {
    return {
      name: String(findEl('pf-name').value).trim(),
      baseUrl: String(findEl('pf-base-url').value).trim(),
      model: String(findEl('pf-model').value).trim(),
      apiKey: String(findEl('pf-api-key').value).trim(),   // '' => unset/null per contract
      protocol: PROVIDER_PROTOCOLS.indexOf(String(findEl('pf-protocol').value)) !== -1 ? findEl('pf-protocol').value : 'openai'
    };
  }

  async function saveFromForm() {
    if (busySave) return;
    var v = readValues();
    var check = validateClientSide(v);       // inline errors before ANY submit attempt
    if (!check.ok) {
      setPfError(Object.keys(check.errors).map(function (k) { return check.errors[k]; }).join(' '));
      return;
    }
    var payload = { name: v.name, baseUrl: v.baseUrl, model: v.model, apiKey: v.apiKey, protocol: v.protocol };
    busySave = true;
    try {
      var creating = !editorId;              // brand-new unsaved draft => create
      var url = creating ? PROVIDERS_BASE : detailUrl(editorId);
      var method = creating ? 'POST' : 'PATCH';
      var rec = await fetchJson(url, {
        method: method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!rec || typeof rec.id !== 'string') throw new Error('Unexpected response from server');
      populateForm(rec, true);               // created/updated full record: edit state now tracks its id
      await refreshList();                   // list + radios reflect the change immediately (hot-apply)
      showListView();                        // return to the LIST sub-view (refreshed)
    } catch (e) {
      setPfError((creating ? 'Create failed: ' : 'Update failed: ') + (e && e.message ? e.message : String(e)));
    } finally {
      busySave = false;
    }
  }

  /* ============================ event wiring ========================== */
  function bindProvidersEvents(pane) {
    ['prov-add-btn', 'prov-list', 'prov-empty', 'prov-status', 'prov-error',
     'prov-editor-title', 'prov-form', 'pf-name', 'pf-base-url', 'pf-model',
     'pf-api-key', 'pf-key-toggle', 'pf-protocol', 'pf-save', 'pf-cancel', 'pf-reset', 'pf-error',
     'prov-list-view', 'prov-form-view']
      .forEach(function (id) { els[id] = pane.querySelector('#' + id); });

    findEl('prov-add-btn').addEventListener('click', startDraft);
    findEl('pf-cancel').addEventListener('click', discardEditor);
    findEl('pf-reset').addEventListener('click', resetToSaved);
    findEl('pf-key-toggle').addEventListener('click', toggleKeyVisibility);
    findEl('prov-form').addEventListener('submit', function (ev) { ev.preventDefault(); saveFromForm(); });

    // Delegated row interactions — survive every list re-render. Row BODY clicks
    // load the editor; radio checks and delete buttons are handled separately.
    var list = findEl('prov-list');
    list.addEventListener('click', function (ev) {
      var delBtn = ev.target.closest ? ev.target.closest('.prov-del') : null;
      if (delBtn) {
        var dRow = delBtn.closest('.provider-row');
        if (dRow) deleteProvider(dRow.getAttribute('data-provider-id'));
        return;
      }
      if (ev.target.tagName === 'INPUT') return;   // radio activation goes through `change`
      var row = ev.target.closest ? ev.target.closest('.provider-row') : null;
      if (row) loadEditorFor(row.getAttribute('data-provider-id'));
    });
    list.addEventListener('change', function (ev) {
      var t = ev.target;
      if (t && t.type === 'radio' && t.name === ACTIVE_RADIO_NAME) activateProvider(t.value);
    });
  }

  function openSettings() {
    if (openFlag) return;
    openFlag = true;
    selectSection(currentSection);           // refreshes the visible pane's data
    backdrop.hidden = false;
    backdrop.classList.add('is-open');
    dialogEl.focus();                       // focus moved into the dialog on open
  }

  function closeSettings() {
    if (!openFlag) return;
    openFlag = false;
    backdrop.classList.remove('is-open');
    backdrop.hidden = true;
    try { triggerEl && triggerEl.focus(); } catch (_e) { /* trigger may be detached */ }
  }

  function bindOverlayEvents() {
    findEl('settings-close').addEventListener('click', closeSettings);
    backdrop.addEventListener('click', function (ev) {   // backdrop click closes; card clicks bubble with target≠backdrop
      if (ev.target === backdrop) closeSettings();
    });
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && openFlag) closeSettings();
    });
  }

  buildModal();
  els['settings-rail'] = railEl = $('settings-rail');
  panelEl = $('settings-panel');
  ensurePanesBuilt();
  renderRail();
  Array.prototype.forEach.call(panelEl.children, function (pane) { pane.hidden = pane.getAttribute('data-pane') !== currentSection; });
  // Note: providersPane() above already wired its own events during construction.
  bindOverlayEvents();

  triggerEl = $('open-settings');
  if (triggerEl) triggerEl.addEventListener('click', openSettings);
  else console.warn('[settings] Missing #open-settings trigger in header — settings modal not wired.');
}
