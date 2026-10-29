/* ==========================================================================
 * aitoolgate dashboard — Settings: API Providers pane.
 *
 * Builds the "API Providers" master–detail pane (provider list + add/edit
 * form) over the /api/api-providers REST contract. All module-local state
 * lives in the createProvidersPane() closure (one instance per settings modal).
 * Raw apiKeys are only shown in the editor form, never in list rows.
 *
 * Import graph: this -> dom.mjs only. Consumed by settings.mjs.
 * ==================================================================== */
import { $, el, errMsg } from './dom.mjs';

const PROVIDER_PROTOCOLS = ['openai', 'anthropic'];
const ACTIVE_RADIO_NAME = 'settings-provider-active'; // native radio group: one checked at most in the DOM too
const PROVIDERS_BASE = 'api/api-providers';          // relative base path, matching the dashboard convention
const PROBE_URL = PROVIDERS_BASE + '/probe';         // POST {protocol, baseUrl, apiKey?, id?} => {ok, latencyMs, models, error?}

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
              '<label for="pf-model">Model</label>' +
              '<select id="pf-model" class="pf-model-select"></select>' +
              '<div class="hint">\u201CFrom Request\u201D routes each request to the model the client asks for. Test or change the Base URL to list models.</div>' +
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
          '<div id="pf-test-result" class="probe-result" role="status" hidden></div>' +
          '<div class="prov-foot">' +
            '<button type="submit" class="btn btn-primary" id="pf-save">Save</button>' +
            '<button type="button" class="btn" id="pf-test">Test</button>' +
            '<span class="spacer"></span>' +
            '<button type="button" class="btn" id="pf-reset" title="Discard changes and reload the latest saved values" hidden>Reset to saved</button>' +
            '<button type="button" class="btn" id="pf-cancel">Cancel</button>' +
          '</div>' +
          '<div id="pf-error" class="form-error" role="alert" hidden></div>' +
        '</form>' +
      '</section>' +
    '</section>' +
  '</section>';

/* Builds one API Providers pane instance. opts.doFetch: bound fetch impl.
 * Returns { buildPane(): HTMLElement (unconnected), onShow(): refreshes list }. */
export function createProvidersPane(opts) {
  var doFetch = opts.doFetch;
  var els = {};                       // providers-pane ids, cached after mount
  var providerRows = [];              // last fetched list rows (apiKeySet only, never raw keys)
  var editorId = '';                  // '' => unsaved draft / neutral; string id => editing an existing saved record
  var isDraft = false;                // user is authoring a NEW (unsaved) provider in the form
  var provView = 'list';             // 'list' | 'form' — internal sub-view selector for the providers pane (not a route)
  var busyActive = false;             // guards overlapping PATCH {isActive:true} calls
  var busySave = false;               // guards overlapping create/update submits
  var savedModel = '';                // concrete model of the loaded record ('' => From Request); always kept as a select option
  var probeSeq = 0;                   // bumped per probe start/reset; responses from older probes are ignored
  var probeTimer = null;              // debounce timer for input-driven auto-probes
  var resultKey = null;               // inputsKey() of the last applied probe result (blur re-probes only when inputs differ)

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

  function providersPane() {
    var tpl = document.createElement('template');
    tpl.innerHTML = PROVIDER_PANE_HTML.trim();
    var pane = tpl.content.firstElementChild;   // not yet connected: resolve ids from the pane itself
    initProtocolSelect(pane.querySelector('#pf-protocol'));
    bindProvidersEvents(pane);
    return pane;
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
  // Raw keys never appear here.
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
      var delBtn = el('button', 'btn-ghost prov-del', '\u00D7');
      delBtn.type = 'button';
      delBtn.title = 'Delete this provider';
      delBtn.setAttribute('aria-label', 'Delete provider "' + d.name + '"');
      aux.appendChild(chip); aux.appendChild(delBtn);

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
      setProvError('Failed to load providers: ' + errMsg(e));
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
      setProvError('Could not make active: ' + errMsg(e));
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
      setProvError('Delete failed: ' + errMsg(e));
    }
  }

  /* ============================ editor form =========================== */
  function clearForm() {
    findEl('pf-name').value = '';
    findEl('pf-base-url').value = '';
    savedModel = '';
    renderModelOptions([], '');
    findEl('pf-api-key').value = '';
    findEl('pf-protocol').value = 'openai';       // spec default for fresh drafts
    ensureKeyHidden();
    setPfError(null);
    resetProbeState();
  }

  /* ============================ model + probe ========================= */
  // Model select: From Request ('' value) first, then probed ids, then any concrete
  // model that must survive (saved model or the previous selection) so edits never drop it.
  function renderModelOptions(models, selected) {
    var sel = findEl('pf-model');
    var values = [''];
    function add(v) { if (v && values.indexOf(v) === -1) values.push(v); }
    (models || []).forEach(function (m) { add(String(m)); });
    add(savedModel);
    add(selected);
    sel.textContent = '';
    values.forEach(function (v) {
      var o = el('option', null, v ? v : 'From Request');
      o.value = v;
      sel.appendChild(o);
    });
    sel.value = values.indexOf(selected) !== -1 ? selected : '';
  }

  // Key over the probe inputs; a result is applied only if this still matches at response time.
  function inputsKey() {
    return JSON.stringify([
      String(findEl('pf-protocol').value),
      String(findEl('pf-base-url').value).trim(),
      String(findEl('pf-api-key').value).trim(),
      editorId
    ]);
  }

  function resetProbeState() {
    if (probeTimer) clearTimeout(probeTimer);
    probeTimer = null;
    probeSeq++;
    resultKey = null;
    setProbeResult(null);
  }

  function setProbeResult(text, tone) {
    var n = findEl('pf-test-result');
    if (!n) return;
    n.textContent = text || '';
    n.className = 'probe-result' + (tone ? ' is-' + tone : '');
    n.hidden = !text;
  }

  // Probe the current form values. manual=true (Test button) always runs; auto probes
  // run only for a non-blank Base URL. Sends id (not a key) when the key field is blank on an
  // existing provider so the server uses the stored key.
  async function runProbe(manual) {
    var baseUrl = String(findEl('pf-base-url').value).trim();
    var apiKey = String(findEl('pf-api-key').value).trim();
    if (!baseUrl) {
      probeSeq++;
      resultKey = null;
      renderModelOptions([], findEl('pf-model').value);
      setProbeResult(manual ? 'Enter a Base URL to test.' : null, manual ? 'fail' : null);
      return;
    }
    var key = inputsKey();
    var seq = ++probeSeq;
    var body = { protocol: String(findEl('pf-protocol').value), baseUrl: baseUrl, apiKey: apiKey || null };
    if (!apiKey && editorId) body.id = String(editorId);
    setProbeResult('Probing\u2026', 'probing');
    try {
      var data = await fetchJson(PROBE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (seq !== probeSeq || key !== inputsKey()) return;   // stale: inputs or a newer probe superseded this one
      resultKey = key;
      var ms = Math.round(Number(data && data.latencyMs) || 0);
      if (data && data.ok) {
        var models = Array.isArray(data.models) ? data.models : [];
        renderModelOptions(models, findEl('pf-model').value);
        setProbeResult('Connected \u00B7 ' + models.length + (models.length === 1 ? ' model' : ' models') + ' \u00B7 ' + ms + ' ms', 'ok');
      } else {
        renderModelOptions([], findEl('pf-model').value);
        var detail = data && typeof data.error === 'string' && data.error ? data.error : 'unknown error';
        setProbeResult('Probe failed' + (data && data.status ? ' (HTTP ' + data.status + ')' : '') + ': ' + detail + ' \u00B7 ' + ms + ' ms', 'fail');
      }
    } catch (e) {
      if (seq !== probeSeq || key !== inputsKey()) return;
      renderModelOptions([], findEl('pf-model').value);
      setProbeResult('Probe failed: ' + errMsg(e), 'fail');
    }
  }

  // Debounced auto-probe on Base URL / protocol / API key input.
  function onProbeInput() {
    if (probeTimer) clearTimeout(probeTimer);
    probeTimer = setTimeout(function () { probeTimer = null; runProbe(false); }, 600);
  }

  // Blur probes immediately, but only when the inputs differ from the last applied result.
  function onProbeBlur() {
    if (probeTimer) { clearTimeout(probeTimer); probeTimer = null; }
    if (inputsKey() !== resultKey) runProbe(false);
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
    savedModel = rec.model == null ? '' : String(rec.model).trim();   // null => From Request
    renderModelOptions([], savedModel);
    findEl('pf-api-key').value = typeof rec.apiKey === 'string' ? rec.apiKey : '';   // raw key from GET detail / created+updated record
    var proto = String(rec.protocol || 'openai');
    findEl('pf-protocol').value = PROVIDER_PROTOCOLS.indexOf(proto) !== -1 ? proto : 'openai';
    ensureKeyHidden();
    setPfError(null);
    resetProbeState();
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
        setPfError('Could not load provider: ' + errMsg(e));
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
        setPfError('Reset failed: ' + errMsg(e));
      }
    }
  }

  // Read form values (trimmed), validate client-side FIRST (mirrors server rules),
  // then POST a brand-new draft or PATCH the existing record being edited.
  function readValues() {
    return {
      name: String(findEl('pf-name').value).trim(),
      baseUrl: String(findEl('pf-base-url').value).trim(),
      model: findEl('pf-model').value || null,            // From Request ('') => null
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
    var payload = { name: v.name, baseUrl: v.baseUrl, model: v.model, apiKey: v.apiKey, protocol: v.protocol };   // model null => From Request
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
      setPfError((creating ? 'Create failed: ' : 'Update failed: ') + errMsg(e));
    } finally {
      busySave = false;
    }
  }

  /* ============================ event wiring ========================== */
  function bindProvidersEvents(pane) {
    ['prov-add-btn', 'prov-list', 'prov-empty', 'prov-status', 'prov-error',
     'prov-editor-title', 'prov-form', 'pf-name', 'pf-base-url', 'pf-model',
     'pf-api-key', 'pf-key-toggle', 'pf-protocol', 'pf-save', 'pf-test', 'pf-test-result', 'pf-cancel', 'pf-reset', 'pf-error',
     'prov-list-view', 'prov-form-view']
      .forEach(function (id) { els[id] = pane.querySelector('#' + id); });

    findEl('prov-add-btn').addEventListener('click', startDraft);
    findEl('pf-cancel').addEventListener('click', discardEditor);
    findEl('pf-reset').addEventListener('click', resetToSaved);
    findEl('pf-key-toggle').addEventListener('click', toggleKeyVisibility);
    findEl('pf-test').addEventListener('click', function () { runProbe(true); });
    findEl('pf-base-url').addEventListener('input', onProbeInput);
    findEl('pf-api-key').addEventListener('input', onProbeInput);
    findEl('pf-protocol').addEventListener('change', onProbeInput);
    ['pf-base-url', 'pf-api-key', 'pf-protocol'].forEach(function (id) {
      findEl(id).addEventListener('blur', onProbeBlur);
    });
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

  return {
    buildPane: providersPane,
    onShow: function () { showListView(); refreshList(); }
  };
}
