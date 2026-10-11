/* ==========================================================================
 * aitoolgate dashboard — policy-rule authoring UI.
 *
 * The rule list / CRUD controls and the dynamic rule authoring form are one
 * tightly-coupled unit: the list's Edit button loads a serialized RuleSpec
 * into the form, and saving/deleting re-renders the list. They therefore live
 * in this single module (one SRP: "policy-rule authoring UI") so there is no
 * import cycle between them.
 *
 * Rules are added/toggled/deleted against the server's /api/rules endpoints
 * (the single source of truth); after every mutation the list is re-synced via
 * GET /api/rules. The form is built and read from the field schemas in
 * ./rule-schema.mjs, and shared runtime state for the add/edit round-trip
 * (editingId, curMatcherType, curActionType) is accessed exclusively through
 * `state` from ./state.mjs. Feature-module imports only — no cycles back into
 * app.js or other feature modules.
 * ========================================================================== */
import { $, el, isPlainObject, errMsg, showNotice, clearNotice, showFormError } from './dom.mjs';
import { state } from './state.mjs';
import { MATCHER_FIELDS, ACTION_FIELDS } from './rule-schema.mjs';

/* ========================= rules list / CRUD ====================== */
// Build one rule card for a serialized RuleSpec: an enabled toggle + action
// "severity" pill + name, then matcher / action (/priority) summaries, then id
// + edit/delete actions. Disabled rules render de-emphasized (.is-disabled).
export function renderRuleRow(spec) {
  var enabled = spec.enabled === true;
  var card = el('article', 'rule-card' + (enabled ? '' : ' is-disabled'));
  if (spec.id) card.dataset.id = spec.id;

  // Top row: enabled toggle, action "severity" pill, and the rule name.
  var top = el('div', 'rc-top');
  var toggle = el('label', 'rule-toggle check');
  var cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = enabled;
  cb.setAttribute('aria-label', 'Enabled');
  toggle.appendChild(cb);
  toggle.appendChild(el('span', null, enabled ? 'Enabled' : 'Disabled'));
  var sevType = spec.action && spec.action.type ? String(spec.action.type) : '\u2014';
  top.appendChild(toggle);
  top.appendChild(el('span', 'badge rc-sev ' + severityClass(sevType), sevType));
  top.appendChild(el('div', 'rc-name', spec.description || 'Untitled rule'));
  card.appendChild(top);

  // Body: matcher / action summaries (+ priority when set).
  var body = el('div', 'rc-body');
  body.appendChild(summaryCell('Matcher', matcherSummary(spec.matcher)));
  body.appendChild(summaryCell('Action', actionSummary(spec.action)));
  if (typeof spec.priority === 'number') body.appendChild(summaryCell('Priority', String(spec.priority)));
  card.appendChild(body);

  // Footer: bare rule id (secondary, muted) leading + edit/delete actions trailing.
  var foot = el('div', 'rc-foot');
  if (spec.id) foot.appendChild(el('span', 'rc-id', spec.id));
  var actions = el('div', 'rc-actions');
  var editBtn = el('a', 'btn', 'Edit');
  editBtn.href = '#/rules/' + encodeURIComponent(spec.id || '');
  editBtn.title = 'Edit rule';
  var delBtn = el('button', 'btn btn-danger', 'Delete');
  delBtn.type = 'button';
  delBtn.title = 'Delete rule';
  actions.appendChild(editBtn);
  actions.appendChild(delBtn);
  foot.appendChild(actions);
  card.appendChild(foot);

  // Wire behaviour. Edit navigates to the editor sub-view via its hash route.
  cb.addEventListener('change', function () { toggleEnabled(spec, cb.checked); });
  delBtn.addEventListener('click', function () { deleteRule(spec); });
  return card;
}
// Render the whole rule list from a RuleSpec[] and manage the empty state.
export function renderRules(rules) {
  var list = $('rule-list');
  if (!list) return;
  list.textContent = '';
  var arr = Array.isArray(rules) ? rules : [];
  state.rules = arr; // cache so openEditRuleForm can deep-link instantly
  var empty = $('rule-empty');
  if (empty) empty.hidden = arr.length !== 0;
  arr.forEach(function (spec) { list.appendChild(renderRuleRow(spec)); });
}
// GET /api/rules and re-render — called after every mutation so the list is
// always re-synced to the server (single source of truth).
export async function refreshRules() {
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
export async function toggleEnabled(spec, enabled) {
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
export async function deleteRule(spec) {
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

// POST a RuleSpec to create a new rule; returns the created spec (with its
// server-assigned id) on success. On a non-ok response it surfaces a global
// notice (the live-view quick-create channel, not the authoring form's inline
// error) and throws so callers can distinguish failure from success.
export async function createRule(spec) {
  var res = await fetch('api/rules', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(spec)
  });
  var data = null;
  try { data = await res.json(); } catch (_e) { /* non-JSON (204 / error text) */ }
  if (!res.ok) {
    showNotice('Rule not created: ' + (data && data.error ? data.error : 'HTTP ' + res.status));
    throw new Error(data && data.error ? data.error : 'HTTP ' + res.status);
  }
  return data;
}
// Minimal client-side dedupe: return the first cached rule whose matcher is a
// toolName matcher matching `name` (exact or listed in toolNames) AND whose
// action type equals `actionType`. Returns undefined when no match. Best-effort
// over the cached state.rules (single source of truth re-synced by refreshRules).
export function findDuplicatePolicyRule(rules, name, actionType) {
  return (Array.isArray(rules) ? rules : []).find(function (r) {
    if (!r || !r.matcher || !r.action) return false;
    var m = r.matcher, a = r.action;
    var nameMatch = m.type === 'toolName' &&
      (m.toolName === name || (Array.isArray(m.toolNames) && m.toolNames.indexOf(name) !== -1));
    return nameMatch && a.type === actionType;
  });
}

/* ============ list summaries + severity tones (pure helpers) =========== */
// Action type -> tokenized status tone used as a "severity" pill in the list.
// Derived from how intrusive each action is (no field in the spec declares it).
var SEVERITY_CLASS_BY_ACTION = {
  hideTool: 'badge-interv',     // high: removes tools from the model's set
  rewriteArgs: 'badge-pending', // moderate: rewrites arguments in place
  injectMessage: 'badge-ok'     // low: adds a message to the stream
};
function severityClass(actionType) {
  return SEVERITY_CLASS_BY_ACTION[actionType] || 'badge';
}
function truncate(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n - 1) + '\u2026' : s; }
// One-line human summary of a matcher spec (shown under "Matcher" in a row).
function matcherSummary(m) {
  if (!m) return '\u2014';
  switch (m.type) {
    case 'toolName': {
      var names = [];
      if (typeof m.toolName === 'string' && m.toolName) names.push(m.toolName);
      if (Array.isArray(m.toolNames)) Array.prototype.push.apply(names, m.toolNames);
      return names.length ? names.join(', ') : 'any tool';
    }
    case 'argPattern': {
      var parts = [];
      if (typeof m.toolName === 'string' && m.toolName) parts.push(m.toolName);
      else if (Array.isArray(m.toolNames) && m.toolNames.length) parts.push('[' + m.toolNames.join(', ') + ']');
      if (typeof m.pattern === 'string' && m.pattern) parts.push('args \u220b ' + truncate(m.pattern, 48));
      return parts.length ? parts.join(' \u00B7 ') : 'all calls';
    }
    case 'loop': {
      var bits = [];
      if (typeof m.window === 'number') bits.push(m.window + '\u00D7 in a row');
      if (m.requireConsecutive === false) bits.push('anywhere in run');
      if (m.paramIdentity === 'exact') bits.push('exact params');
      else if (m.resultIdentity === 'exact') bits.push('exact results');
      return bits.length ? bits.join(' \u00B7 ') : 'consecutive identical calls';
    }
    case 'always':
      return 'always';
    default: return '\u2014';
  }
}
// One-line human summary of an action spec (shown under "Action" in a row).
function actionSummary(a) {
  if (!a) return '\u2014';
  switch (a.type) {
    case 'hideTool':
      return Array.isArray(a.toolNames) && a.toolNames.length ? 'hide ' + a.toolNames.join(', ') : 'hide tools';
    case 'rewriteArgs': {
      var mode = a.mode ? ' (' + a.mode + ')' : '';
      var target = a.toolCallId ? 'id ' + a.toolCallId : (typeof a.toolName === 'string' && a.toolName ? a.toolName : 'arguments');
      return 'rewrite args' + (target !== 'arguments' ? ' \u00B7 ' + target : '') + mode;
    }
    case 'injectMessage':
      return (a.role ? a.role + ' message' : 'inject message') + (typeof a.content === 'string' && a.content ? ' \u00B7 \u201C' + truncate(a.content, 60) + '\u201D' : '');
    default: return '\u2014';
  }
}
// One labelled summary cell for the rule-card body.
function summaryCell(label, value) {
  var cell = el('div', 'rc-cell');
  cell.appendChild(el('div', 'rc-label', label));
  cell.appendChild(el('div', 'rc-value', value));
  return cell;
}

/* ========================= dynamic form build ===================== */
// Create one labelled control for a field definition, pre-filled from `value`.
export function makeField(prefix, def, value) {
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
export function setFieldControlValue(c, def, value) {
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
export function renderMatcherFields(type, values) {
  var box = $('matcher-fields');
  box.textContent = '';
  (MATCHER_FIELDS[type] || []).forEach(function (def) {
    box.appendChild(makeField('matcher-fields', def, values && values[def.key]));
  });
}
// The addDescription action was added to the backend after the field schemas in
// rule-schema.mjs were authored, so ACTION_FIELDS has no entry for it. Merge its
// single required `description` field in here (leaving every other action's schema
// untouched) so renderActionFields / collectSpec handle it like any other action.
var ACTION_FIELDS_ALL = Object.assign({}, ACTION_FIELDS, {
  addDescription: [
    { key: 'description', label: 'Tool description', kind: 'area', required: true, hint: 'The description text shown to the model for the matched tool' }
  ]
});
// Rebuild the action-fields container for a type, optionally pre-filled.
export function renderActionFields(type, values) {
  var box = $('action-fields');
  box.textContent = '';
  (ACTION_FIELDS_ALL[type] || []).forEach(function (def) {
    box.appendChild(makeField('action-fields', def, values && values[def.key]));
  });
}
// Read one control's value; returns { skip } or { value } or { err }.
export function readField(container, def) {
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
export function readSection(defs, container, out) {
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
export function clientValidate(spec) {
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
  if (a.type === 'addDescription' && !(typeof a.description === 'string' && a.description !== '')) {
    return 'action requires a non-empty "description" string';
  }
  return null;
}
// Assemble a full RuleSpec from the current form state; { spec } or { error }.
export function collectSpec() {
  var spec = { enabled: $('rule-enabled').checked };
  spec.matcher = { type: state.curMatcherType };
  var err = readSection(MATCHER_FIELDS[state.curMatcherType] || [], $('matcher-fields'), spec.matcher);
  if (err) return { error: err };
  spec.action = { type: state.curActionType };
  err = readSection(ACTION_FIELDS_ALL[state.curActionType], $('action-fields'), spec.action);
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
// The addDescription action is not in the static form HTML (dashboard/html/
// rules-view.html), so before it is selected (prefill / edit / wiring) ensure the
// action-type select carries an option for it. Idempotent: adds the option only
// when it is missing.
function ensureActionTypeOption(type) {
  var sel = $('action-type');
  if (!sel) return;
  var has = false;
  Array.prototype.forEach.call(sel.children || [], function (o) {
    if (o && o.value === type) has = true;
  });
  if (!has) {
    var o = document.createElement('option');
    o.value = type;
    o.textContent = type === 'addDescription' ? 'addDescription \u2014 set a tool description' : type;
    sel.appendChild(o);
  }
}
// Load an existing rule's serialized spec into the form for editing.
export function loadSpecIntoForm(spec) {
  state.editingId = spec.id || '';
  state.curMatcherType = spec.matcher && spec.matcher.type ? spec.matcher.type : 'loop';
  state.curActionType = spec.action && spec.action.type ? spec.action.type : 'hideTool';
  ensureActionTypeOption(state.curActionType);
  $('matcher-type').value = state.curMatcherType;
  $('action-type').value = state.curActionType;
  renderMatcherFields(state.curMatcherType, spec.matcher || {});
  renderActionFields(state.curActionType, spec.action || {});
  $('rule-enabled').checked = spec.enabled === true;
  $('rule-description').value = spec.description || '';
  $('rule-priority').value = typeof spec.priority === 'number' ? String(spec.priority) : '';
  updateFormMode();
  showFormError('');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
// Reset the form to a clean add-mode state.
export function resetForm() {
  state.editingId = '';
  state.curMatcherType = 'loop';
  state.curActionType = 'hideTool';
  $('matcher-type').value = state.curMatcherType;
  $('action-type').value = state.curActionType;
  renderMatcherFields(state.curMatcherType);
  renderActionFields(state.curActionType);
  $('rule-enabled').checked = true;
  $('rule-description').value = '';
  $('rule-priority').value = '';
  updateFormMode();
  showFormError('');
}
// Reflect edit vs. add mode in the form buttons.
export function updateFormMode() {
  var editing = state.editingId !== '';
  var cancelBtn = $('btn-cancel');
  if (cancelBtn) cancelBtn.hidden = !editing;
  var addBtn = $('btn-add');
  if (addBtn) addBtn.textContent = editing ? 'Save changes' : 'Add rule';
  var title = $('rule-editor-title');
  if (title) title.textContent = editing ? 'Edit rule' : 'New rule';
}
// Submit the form: POST (add) or PATCH (edit) a RuleSpec, then re-render.
export async function saveRule(spec) {
  try {
    var url, method;
    if (state.editingId) { url = 'api/rules/' + encodeURIComponent(state.editingId); method = 'PATCH'; }
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
    var wasEdit = state.editingId !== '';
    resetForm();
    flashSavedNote(wasEdit ? 'Changes saved.' : 'Rule added.');
    location.hash = '#/rules'; // return to the list so the change is visible
  } catch (e) {
    showFormError('Network error: ' + errMsg(e));
  }
}
export function submitRule(e) {
  if (e) e.preventDefault();
  var r = collectSpec();
  if (r.error) { showFormError(r.error); return; }
  showFormError('');
  saveRule(r.spec);
}

/* ========================= route -> form entry ====================== */
// Module-scope handle for the auto-dismissing save note's timer.
var savedTimer = null;
// Flash a transient save-confirmation note at the top of the rules page.
function flashSavedNote(msg) {
  var n = $('rule-saved-note');
  if (!n) return;
  n.textContent = msg;
  n.hidden = false;
  if (savedTimer) clearTimeout(savedTimer);
  savedTimer = setTimeout(function () { n.hidden = true; }, 2600);
}
// Open the editor in ADD mode: a clean, default form.
// A pending pre-fill spec for the ADD-mode editor, set by prefillNewRule() and
// consumed exactly once by openNewRuleForm(). Null when no pre-fill is pending.
var pendingNewRuleSpec = null;

export function openNewRuleForm() {
  if (pendingNewRuleSpec) {
    var spec = pendingNewRuleSpec;
    pendingNewRuleSpec = null; // consume exactly once
    loadSpecIntoForm(spec);
    var focusEl = $('rule-description') || $('rule-form');
    if (focusEl && typeof focusEl.focus === 'function') focusEl.focus();
  } else {
    resetForm();
  }
}

// Navigate to the ADD-mode editor with the form pre-filled. Sets a pending
// pre-fill then drives the router; if the current hash is already the add editor
// (no hashchange will fire) it opens the form directly.
//
// Accepts either a full RuleSpec (the quick-create callers in live-view) or a
// tool name + description that builds an addDescription spec:
//   prefillNewRule(toolName, description)
//     -> { matcher: { type: 'toolName', toolName }, action: { type: 'addDescription', description } }
// so a tool-detail "Override" button can pre-fill the editor in one call.
export function prefillNewRule(toolNameOrSpec, description) {
  var spec;
  if (typeof toolNameOrSpec === 'string' && typeof description === 'string') {
    spec = {
      enabled: true,
      matcher: { type: 'toolName', toolName: toolNameOrSpec },
      action: { type: 'addDescription', description: description }
    };
  } else {
    spec = toolNameOrSpec;
  }
  pendingNewRuleSpec = spec;
  if (String(location.hash || '').replace(/^#\/?/, '') !== 'rules/new') {
    location.hash = '#/rules/new'; // hashchange -> applyRoute -> openNewRuleForm()
  } else {
    openNewRuleForm();
  }
}
// Open the editor in EDIT mode for `id`. Uses the cached list when available so a
// deep-link opens instantly; otherwise fetches once. Falls back to the list (with a
// notice) when the rule cannot be found.
export async function openEditRuleForm(id) {
  var spec = (state.rules || []).find(function (r) { return r && r.id === id; });
  if (!spec) {
    try {
      var res = await fetch('api/rules');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      renderRules(await res.json());
      spec = (state.rules || []).find(function (r) { return r && r.id === id; });
    } catch (e) {
      showNotice('Rules unavailable: ' + errMsg(e));
      return;
    }
  }
  if (!spec) {
    showNotice('Rule not found: ' + id);
    location.hash = '#/rules';
    return;
  }
  loadSpecIntoForm(spec);
}

/* ========================= wiring =============================== */
// Wire the rule form's controls and the list's "Add rule" affordance:
//   - matcher/action type changes rebuild the dynamic fields and refresh mode;
//   - form submit collects + saves (POST for add, PATCH for edit);
//   - Cancel returns to the rules list (the form resets on the next open);
//   - the list toolbar's "Add rule" button opens the editor in add mode.
// (The editor's "Back to rules" link is a plain <a href="#/rules"> — native
// hash navigation drives the router, so it needs no handler here.)
export function bindFormEvents() {
  ensureActionTypeOption('addDescription'); // the dropdown must offer it for manual selection
  var mt = $('matcher-type');
  if (mt) mt.addEventListener('change', function () {
    state.curMatcherType = this.value;
    renderMatcherFields(state.curMatcherType);
    updateFormMode();
  });
  var at = $('action-type');
  if (at) at.addEventListener('change', function () {
    state.curActionType = this.value;
    renderActionFields(state.curActionType);
    updateFormMode();
  });
  var form = $('rule-form');
  if (form) form.addEventListener('submit', submitRule);
  var cancel = $('btn-cancel');
  if (cancel) cancel.addEventListener('click', function () { location.hash = '#/rules'; });
  var addRuleBtn = $('btn-add-rule');
  if (addRuleBtn) addRuleBtn.addEventListener('click', function () { location.hash = '#/rules/new'; });
}
