/* ==========================================================================
 * mcp-manager dashboard — vanilla-JS SPA controller.
 *
 * A classic (non-module) browser script with zero dependencies. It talks to the
 * same-origin REST API (`api/stats`, `api/rules` — relative paths resolve to
 * `/api/...` when the page is served at `/`) and the built-in WebSocket at
 * `/ws`. All DOM access goes through the ids defined in index.html.
 * ========================================================================== */
(function () {
  'use strict';

  /* ---- tunables ------------------------------------------------------ */
  var MAX_LIST_ITEMS = 200;   // cap for the live + intervention lists
  var STATS_POLL_MS = 3000;   // fallback poll interval for /api/stats
  var WS_RECONNECT_MS = 1500; // retry delay after the socket closes

  /* ---- tiny DOM helpers ---------------------------------------------- */
  function $(id) { return document.getElementById(id); }
  // Create an element with an optional class and text content.
  function el(tag, className, text) {
    var n = document.createElement(tag);
    if (className) n.className = className;
    if (text !== undefined) n.textContent = text;
    return n;
  }
  // Escape untrusted text before it is interpolated into innerHTML.
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
  // Format an epoch-ms timestamp as local HH:MM:SS; '-' when absent/invalid.
  function fmtTime(ms) {
    if (typeof ms !== 'number' || !isFinite(ms)) return '-';
    var d = new Date(ms);
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }
  // True only for plain objects (records), not arrays or null.
  function isPlainObject(v) {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
  }
  function errMsg(e) { return e && e.message ? e.message : String(e); }
  // Show a short session key (hashes are long); truncate with an ellipsis.
  function shortSession(k) {
    k = String(k || '');
    return k.length > 14 ? k.slice(0, 12) + '…' : k;
  }

  /* ---- module state -------------------------------------------------- */
  var ws = null;
  var reconnectTimer = null;
  var localCounts = { calls: 0, results: 0, interventions: 0 };
  var editingId = '';            // set while the form edits an existing rule
  // Defaults chosen so a freshly-emptied form still yields a valid RuleSpec:
  // matcher "loop" (all fields optional) + action "block" (all fields optional).
  var curMatcherType = 'loop';
  var curActionType = 'block';

  /* ---- field schemas -------------------------------------------------
   * Each dynamic form control is described here by `kind`. `readField` and
   * `makeField` interpret `kind`, and `clientValidate` enforces the required
   * fields the server's validateSpec also requires. This keeps the emitted
   * RuleSpec in sync with src/api/ruleSpec.ts without any framework.
   * ------------------------------------------------------------------- */
  var MATCHER_FIELDS = {
    loop: [
      { key: 'window', label: 'Window', kind: 'number', hint: 'Consecutive identical calls to flag (server default 4)' },
      { key: 'requireConsecutive', label: 'Require consecutive', kind: 'bool', def: true, hint: 'The run must sit at the tail of the sequence' },
      { key: 'paramIdentity', label: 'Param identity', kind: 'select', options: ['', 'exact', 'normalized'] },
      { key: 'resultIdentity', label: 'Result identity', kind: 'select', options: ['', 'exact', 'normalized'] }
    ],
    toolName: [
      { key: 'toolName', label: 'Tool name', kind: 'text', hint: 'A single tool to match' },
      { key: 'toolNames', label: 'Tool names', kind: 'list', hint: 'Comma-separated; OR-ed with the single name' }
    ],
    argPattern: [
      { key: 'toolName', label: 'Tool name', kind: 'text', hint: 'Restrict to this tool (omit for all)' },
      { key: 'toolNames', label: 'Tool names', kind: 'list', hint: 'Comma-separated; omit for all' },
      { key: 'pattern', label: 'Argument pattern', kind: 'text', required: true, hint: 'Case-sensitive, matched against serialized args' }
    ]
  };
  var ACTION_FIELDS = {
    block: [
      { key: 'reason', label: 'Reason', kind: 'text', hint: 'Substituted for {reason}' },
      { key: 'message', label: 'Message', kind: 'text', hint: 'Verbatim; overrides template' },
      { key: 'template', label: 'Template', kind: 'text', hint: 'Supports {tool} and {reason}' }
    ],
    hideTool: [
      { key: 'toolNames', label: 'Tools to hide', kind: 'list', required: true, hint: 'Comma-separated tool names' }
    ],
    rewriteArgs: [
      { key: 'toolName', label: 'Tool name', kind: 'text', hint: 'Target by name' },
      { key: 'toolCallId', label: 'Tool call id', kind: 'text', hint: 'Takes precedence over the name' },
      { key: 'arguments', label: 'Arguments (JSON object)', kind: 'json', required: true, hint: 'Full replacement or partial merge' },
      { key: 'mode', label: 'Mode', kind: 'select', options: ['', 'replace', 'merge'] }
    ],
    injectMessage: [
      { key: 'role', label: 'Role', kind: 'select', options: ['', 'user', 'system'] },
      { key: 'content', label: 'Content', kind: 'area', required: true, hint: 'Text injected into the stream' }
    ]
  };

  /* ============================== notices ============================ */
  function showNotice(msg) {
    var n = $('notice');
    if (!msg) return;
    n.textContent = msg;
    n.hidden = false;
  }
  function clearNotice() {
    var n = $('notice');
    n.textContent = '';
    n.hidden = true;
  }
  function showFormError(msg) {
    var n = $('form-error');
    if (msg) { n.textContent = msg; n.hidden = false; }
    else { n.textContent = ''; n.hidden = true; }
  }

  /* ========================= stats / top tools ====================== */
  // Render the ranked top-tools table from a CollectorSummary.topTools array.
  function renderTopTools(top) {
    var tb = $('top-tools');
    tb.textContent = '';
    if (!top || !top.length) {
      tb.innerHTML = '<tr><td colspan="2" class="muted">—</td></tr>';
      return;
    }
    tb.innerHTML = top.map(function (t) {
      return '<tr><td>' + esc(t.toolName) + '</td><td class="num-col">' + esc(String(t.count)) + '</td></tr>';
    }).join('');
  }
  // GET /api/stats and refresh the counts + top-tools panel. Fetched on load
  // and every STATS_POLL_MS so numbers stay current even if the WS drops.
  async function refreshStats() {
    try {
      var res = await fetch('api/stats');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var s = await res.json();
      $('total-calls').textContent = String(typeof s.totalCalls === 'number' ? s.totalCalls : 0);
      $('total-results').textContent = String(typeof s.totalResults === 'number' ? s.totalResults : 0);
      renderTopTools(s.topTools);
      $('interventions-retained').textContent = String(Array.isArray(s.interventions) ? s.interventions.length : 0);
      clearNotice();
    } catch (e) {
      showNotice('Stats unavailable: ' + errMsg(e));
    }
  }

  /* ========================= live event lists ======================= */
  // Prepend a row to a <ul>, keeping at most `max` children (newest-first).
  function prependTrim(listEl, node, max) {
    listEl.insertBefore(node, listEl.firstChild);
    while (listEl.children.length > max) {
      listEl.removeChild(listEl.lastChild);
    }
  }
  // Append a tool.call row to the live stream.
  function addCallRow(ev) {
    var li = el('li', 'stream-row');
    var when = typeof ev.at === 'number' ? new Date(ev.at).toLocaleString() : '';
    li.innerHTML =
      '<span class="badge badge-call">call</span>' +
      '<span class="s-tool">' + esc(ev.toolName) + '</span>' +
      '<span class="s-session muted" title="' + esc(ev.sessionKey) + '">' + esc(shortSession(ev.sessionKey)) + '</span>' +
      '<time class="s-time" title="' + esc(when) + '">' + fmtTime(ev.at) + '</time>';
    prependTrim($('stream-list'), li, MAX_LIST_ITEMS);
    $('stream-empty').hidden = true;
  }
  // Interleave a tool.result status (ok/error) into the live stream.
  function addResultRow(ev) {
    var isErr = ev.ok === false;
    var li = el('li', 'stream-row');
    var when = typeof ev.at === 'number' ? new Date(ev.at).toLocaleString() : '';
    li.innerHTML =
      '<span class="badge ' + (isErr ? 'badge-err' : 'badge-ok') + '">' + (isErr ? 'error' : 'ok') + '</span>' +
      '<span class="s-tool">' + esc(ev.toolName) + '</span>' +
      '<span class="s-session muted" title="' + esc(ev.sessionKey) + '">' + esc(shortSession(ev.sessionKey)) + '</span>' +
      '<time class="s-time" title="' + esc(when) + '">' + fmtTime(ev.at) + '</time>';
    prependTrim($('stream-list'), li, MAX_LIST_ITEMS);
    $('stream-empty').hidden = true;
  }
  // Append a policy.intervention row to the intervention log.
  function addInterventionRow(ev) {
    var li = el('li', 'stream-row intervention-row');
    var when = typeof ev.at === 'number' ? new Date(ev.at).toLocaleString() : '';
    li.innerHTML =
      '<span class="badge badge-interv">' + esc(ev.action || 'intervention') + '</span>' +
      '<span class="i-rule muted">rule&nbsp;' + esc(ev.ruleId) + '</span>' +
      '<span class="i-detail" title="' + esc(ev.detail) + '">' + esc(ev.detail || '') + '</span>' +
      '<time class="s-time" title="' + esc(when) + '">' + fmtTime(ev.at) + '</time>';
    prependTrim($('intervention-list'), li, MAX_LIST_ITEMS);
    $('intervention-empty').hidden = true;
  }
  // Refresh the "this session" per-type counters driven by WS events.
  function updateLiveCounters() {
    $('live-calls').textContent = String(localCounts.calls);
    $('live-results').textContent = String(localCounts.results);
    $('live-interventions').textContent = String(localCounts.interventions);
  }
  // Dispatch a single parsed WebSocket frame by its `type` discriminator.
  // Non-telemetry frames (e.g. { echo }) fall through and are ignored.
  function handleWsMessage(raw) {
    var ev;
    try { ev = JSON.parse(raw); } catch (_e) { return; } // ignore non-JSON frames
    if (!ev || typeof ev !== 'object') return;
    switch (ev.type) {
      case 'tool.call':
        localCounts.calls += 1; addCallRow(ev); updateLiveCounters(); break;
      case 'tool.result':
        localCounts.results += 1; addResultRow(ev); updateLiveCounters(); break;
      case 'policy.intervention':
        localCounts.interventions += 1; addInterventionRow(ev); updateLiveCounters(); break;
      default:
        break; // echo or unknown frame — nothing to render
    }
  }

  /* ========================= rules list / CRUD ====================== */
  // Build one <li> for a serialized RuleSpec with an enabled toggle + buttons.
  function renderRuleRow(spec) {
    var li = el('li', 'rule');
    var main = el('div', 'rule-main');
    var toggle = el('label', 'rule-toggle check');
    var cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = spec.enabled === true;
    toggle.appendChild(cb);
    var text = el('div', 'rule-text');
    text.appendChild(el('div', 'rule-desc', spec.description || ('Rule ' + spec.id)));
    text.appendChild(el('div', 'rule-id muted', spec.id || ''));
    main.appendChild(toggle);
    main.appendChild(text);
    var actions = el('div', 'rule-actions');
    var editBtn = el('button', 'btn', 'Edit');
    editBtn.type = 'button';
    var delBtn = el('button', 'btn btn-danger', 'Delete');
    delBtn.type = 'button';
    actions.appendChild(editBtn);
    actions.appendChild(delBtn);
    li.appendChild(main);
    li.appendChild(actions);
    cb.addEventListener('change', function () { toggleEnabled(spec, cb.checked); });
    editBtn.addEventListener('click', function () { loadSpecIntoForm(spec); });
    delBtn.addEventListener('click', function () { deleteRule(spec); });
    return li;
  }
  // Render the whole rule list from a RuleSpec[] and manage the empty state.
  function renderRules(rules) {
    var list = $('rule-list');
    list.textContent = '';
    var arr = Array.isArray(rules) ? rules : [];
    $('rule-empty').hidden = arr.length !== 0;
    arr.forEach(function (spec) { list.appendChild(renderRuleRow(spec)); });
  }
  // GET /api/rules and re-render — called after every mutation so the list is
  // always re-synced to the server (single source of truth).
  async function refreshRules() {
    try {
      var res = await fetch('api/rules');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      renderRules(await res.json());
      clearNotice();
    } catch (e) {
      showNotice('Rules unavailable: ' + errMsg(e));
    }
  }
  // Toggle a rule's enabled flag via PATCH /api/rules/{id} with a partial body.
  async function toggleEnabled(spec, enabled) {
    try {
      var res = await fetch('api/rules/' + encodeURIComponent(spec.id), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: enabled })
      });
      if (!res.ok && res.status !== 404) showNotice('Toggle failed: HTTP ' + res.status);
      refreshRules();
    } catch (e) {
      showNotice('Toggle error: ' + errMsg(e));
    }
  }
  // Delete a rule via DELETE /api/rules/{id}.
  async function deleteRule(spec) {
    var label = spec.description || spec.id;
    if (!window.confirm('Delete rule "' + label + '"?')) return;
    try {
      var res = await fetch('api/rules/' + encodeURIComponent(spec.id), { method: 'DELETE' });
      if (!res.ok && res.status !== 404) showNotice('Delete failed: HTTP ' + res.status);
      refreshRules();
    } catch (e) {
      showNotice('Delete error: ' + errMsg(e));
    }
  }

  /* ========================= dynamic form build ===================== */
  // Create one labelled control for a field definition, pre-filled from `value`.
  function makeField(prefix, def, value) {
    var wrap = el('div', 'field dyn');
    var id = prefix + '-' + def.key;
    var lab = el('label', null, def.label + (def.required ? ' *' : ''));
    lab.htmlFor = id;
    var c = document.createElement('input');
    switch (def.kind) {
      case 'list': c = document.createElement('textarea'); c.rows = 2; break;
      case 'json': c = document.createElement('textarea'); c.rows = 3; break;
      case 'area': c = document.createElement('textarea'); c.rows = 3; break;
      case 'number': c.type = 'number'; c.step = 1; break;
      case 'bool': c.type = 'checkbox'; break;
      case 'select':
        c = document.createElement('select');
        (def.options || ['']).forEach(function (opt) {
          var o = document.createElement('option');
          o.value = opt;
          o.textContent = opt === '' ? '(default)' : opt;
          c.appendChild(o);
        });
        break;
      default: c.type = 'text';
    }
    c.id = id;
    c.dataset.field = def.key;
    setFieldControlValue(c, def, value);
    wrap.appendChild(lab);
    wrap.appendChild(c);
    if (def.hint) wrap.appendChild(el('div', 'hint', def.hint));
    return wrap;
  }
  // Populate a control with a value based on its field `kind`.
  function setFieldControlValue(c, def, value) {
    switch (def.kind) {
      case 'text': case 'area': c.value = value == null ? '' : String(value); break;
      case 'list':
        c.value = Array.isArray(value) ? value.join(', ') : (value == null ? '' : String(value));
        break;
      case 'json': c.value = value == null ? '' : JSON.stringify(value, null, 2); break;
      case 'number': c.value = value == null ? '' : String(value); break;
      case 'bool':
        // No value → use the schema default (requireConsecutive defaults to true).
        c.checked = value == null ? (def.def === undefined ? true : !!def.def) : (value === true);
        break;
      case 'select': c.value = value == null ? '' : String(value); break;
    }
  }
  // Rebuild the matcher-fields container for a type, optionally pre-filled.
  function renderMatcherFields(type, values) {
    var box = $('matcher-fields');
    box.textContent = '';
    (MATCHER_FIELDS[type] || []).forEach(function (def) {
      box.appendChild(makeField('matcher-fields', def, values && values[def.key]));
    });
  }
  // Rebuild the action-fields container for a type, optionally pre-filled.
  function renderActionFields(type, values) {
    var box = $('action-fields');
    box.textContent = '';
    (ACTION_FIELDS[type] || []).forEach(function (def) {
      box.appendChild(makeField('action-fields', def, values && values[def.key]));
    });
  }
  // Read one control's value; returns { skip } or { value } or { err }.
  function readField(container, def) {
    var c = container.querySelector('[data-field="' + def.key + '"]');
    if (!c) return { skip: true };
    var raw = c.value;
    switch (def.kind) {
      case 'text': case 'area': {
        var t = String(raw).trim();
        return t === '' ? { skip: true } : { value: t };
      }
      case 'list': {
        var arr = String(raw).split(',').map(function (s) { return s.trim(); }).filter(function (s) { return s !== ''; });
        return arr.length === 0 ? { skip: true } : { value: arr };
      }
      case 'json': {
        var j = String(raw).trim();
        if (j === '') return { skip: true };
        var parsed;
        try { parsed = JSON.parse(j); } catch (_e) { return { err: '"' + def.key + '" must be valid JSON' }; }
        if (!isPlainObject(parsed)) return { err: '"' + def.key + '" must be a JSON object' };
        return { value: parsed };
      }
      case 'number': {
        var nraw = String(raw).trim();
        if (nraw === '') return { skip: true };
        var num = Number(nraw);
        if (isNaN(num)) return { err: '"' + def.key + '" must be a number' };
        return { value: num };
      }
      case 'bool':
        return { value: c.checked }; // always included (meaningful either way)
      case 'select':
      default:
        return raw === '' ? { skip: true } : { value: raw };
    }
  }
  // Read all fields for one section into `out`; returns an error string or null.
  function readSection(defs, container, out) {
    for (var i = 0; i < defs.length; i++) {
      var r = readField(container, defs[i]);
      if (r.err) return r.err;
      if (r.skip) continue;
      out[defs[i].key] = r.value;
    }
    return null;
  }
  // Client-side mirror of the server's validateSpec required-field checks so we
  // can reject obviously-incomplete rules before they hit the network.
  function clientValidate(spec) {
    if (typeof spec.enabled !== 'boolean') return '"enabled" must be a boolean';
    var m = spec.matcher, a = spec.action;
    if (!isPlainObject(m) || typeof m.type !== 'string') return 'a matcher with a "type" is required';
    if (m.type === 'argPattern' && !(typeof m.pattern === 'string' && m.pattern !== '')) {
      return 'matcher requires a non-empty "pattern"';
    }
    if (m.type === 'loop' && m.window !== undefined && typeof m.window !== 'number') {
      return 'matcher "window" must be a number';
    }
    if (!isPlainObject(a) || typeof a.type !== 'string') return 'an action with a "type" is required';
    if (a.type === 'hideTool' && !(Array.isArray(a.toolNames) && a.toolNames.length > 0)) {
      return 'action requires a non-empty "toolNames" array';
    }
    if (a.type === 'rewriteArgs' && !isPlainObject(a.arguments)) {
      return 'action requires an "arguments" object';
    }
    if (a.type === 'injectMessage' && !(typeof a.content === 'string' && a.content !== '')) {
      return 'action requires a non-empty "content" string';
    }
    return null;
  }
  // Assemble a full RuleSpec from the current form state; { spec } or { error }.
  function collectSpec() {
    var spec = { enabled: $('rule-enabled').checked };
    spec.matcher = { type: curMatcherType };
    var err = readSection(MATCHER_FIELDS[curMatcherType], $('matcher-fields'), spec.matcher);
    if (err) return { error: err };
    spec.action = { type: curActionType };
    err = readSection(ACTION_FIELDS[curActionType], $('action-fields'), spec.action);
    if (err) return { error: err };
    var d = $('rule-description').value.trim();
    if (d) spec.description = d;
    var pr = $('rule-priority').value.trim();
    if (pr !== '') {
      var n = Number(pr);
      if (isNaN(n)) return { error: '"priority" must be a number' };
      spec.priority = n;
    }
    var verr = clientValidate(spec);
    if (verr) return { error: verr };
    return { spec: spec };
  }
  // Load an existing rule's serialized spec into the form for editing.
  function loadSpecIntoForm(spec) {
    editingId = spec.id || '';
    curMatcherType = spec.matcher && spec.matcher.type ? spec.matcher.type : 'loop';
    curActionType = spec.action && spec.action.type ? spec.action.type : 'block';
    $('matcher-type').value = curMatcherType;
    $('action-type').value = curActionType;
    renderMatcherFields(curMatcherType, spec.matcher || {});
    renderActionFields(curActionType, spec.action || {});
    $('rule-enabled').checked = spec.enabled === true;
    $('rule-description').value = spec.description || '';
    $('rule-priority').value = typeof spec.priority === 'number' ? String(spec.priority) : '';
    updateFormMode();
    showFormError('');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  // Reset the form to a clean add-mode state.
  function resetForm() {
    editingId = '';
    curMatcherType = 'loop';
    curActionType = 'block';
    $('matcher-type').value = curMatcherType;
    $('action-type').value = curActionType;
    renderMatcherFields(curMatcherType);
    renderActionFields(curActionType);
    $('rule-enabled').checked = true;
    $('rule-description').value = '';
    $('rule-priority').value = '';
    updateFormMode();
    showFormError('');
  }
  // Reflect edit vs. add mode in the form buttons.
  function updateFormMode() {
    var editing = editingId !== '';
    $('btn-cancel').hidden = !editing;
    $('btn-add').textContent = editing ? 'Save changes' : 'Add rule';
  }
  // Submit the form: POST (add) or PATCH (edit) a RuleSpec, then re-render.
  async function saveRule(spec) {
    try {
      var url, method;
      if (editingId) { url = 'api/rules/' + encodeURIComponent(editingId); method = 'PATCH'; }
      else { url = 'api/rules'; method = 'POST'; }
      var res = await fetch(url, {
        method: method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(spec)
      });
      var data = null;
      try { data = await res.json(); } catch (_e) { /* non-JSON (204 / error text) */ }
      if (!res.ok) {
        showFormError(data && data.error ? data.error : 'Request failed (' + res.status + ')');
        return;
      }
      resetForm();
      refreshRules();
    } catch (e) {
      showFormError('Network error: ' + errMsg(e));
    }
  }
  function submitRule(e) {
    if (e) e.preventDefault();
    var r = collectSpec();
    if (r.error) { showFormError(r.error); return; }
    showFormError('');
    saveRule(r.spec);
  }

  /* ========================= WebSocket lifecycle ====================== */
  // Reflect connected/disconnected on the header indicator.
  function setConnected(on) {
    var s = $('conn-status');
    s.classList.toggle('connected', !!on);
    s.classList.toggle('disconnected', !on);
    $('conn-label').textContent = on ? 'connected' : 'disconnected';
  }
  // Open (or re-open) the same-origin /ws socket with simple reconnect-on-close.
  function connectWS() {
    try {
      if (ws) {
        try { if (ws.readyState !== WebSocket.CLOSED) ws.close(); } catch (_e) { /* ignore */ }
      }
    } catch (_e) { /* ignore */ }
    var url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
    var socket;
    try { socket = new WebSocket(url); }
    catch (_e) { setConnected(false); scheduleReconnect(); return; }
    ws = socket;
    ws.onopen = function () { setConnected(true); };
    ws.onmessage = function (ev) { handleWsMessage(ev.data); };
    ws.onerror = function () { /* a close follows — handled there */ };
    ws.onclose = function () { setConnected(false); scheduleReconnect(); };
  }
  // Schedule a single retry after a short delay (guarded against stacking).
  function scheduleReconnect() {
    if (reconnectTimer != null) return;
    reconnectTimer = setTimeout(function () {
      reconnectTimer = null;
      connectWS();
    }, WS_RECONNECT_MS);
  }

  /* ============================== wiring ============================= */
  function bindFormEvents() {
    $('matcher-type').addEventListener('change', function () {
      curMatcherType = this.value;
      renderMatcherFields(curMatcherType);
      updateFormMode();
    });
    $('action-type').addEventListener('change', function () {
      curActionType = this.value;
      renderActionFields(curActionType);
      updateFormMode();
    });
    $('rule-form').addEventListener('submit', submitRule);
    $('btn-cancel').addEventListener('click', resetForm);
  }
  function init() {
    bindFormEvents();
    renderMatcherFields(curMatcherType);
    renderActionFields(curActionType);
    updateFormMode();
    refreshStats();   // initial load: stats + rules in parallel
    refreshRules();
    connectWS();
    setInterval(refreshStats, STATS_POLL_MS); // fallback poll
  }
  // The script is loaded at the end of <body> so the DOM is ready; guard just in case.
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
