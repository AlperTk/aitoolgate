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

/* ==================== human-first type-select labels ==================== */
// Human-first labels for the matcher / action type selects. The plain phrase
// leads; the internal identifier is shown as a muted secondary hint (see the
// <span class="muted">(identifier)</span> in the static HTML options and the
// dynamically-added options built by renderTypeOption).
var MATCHER_TYPE_LABELS = {
  toolName: 'Tool name',
  argPattern: 'Argument pattern',
  loop: 'Loop · repeated calls',
  always: 'Always'
};
var ACTION_TYPE_LABELS = {
  hideTool: 'Hide tool',
  rewriteArgs: 'Rewrite arguments',
  injectMessage: 'Inject a message',
  addDescription: 'Add a description'
};
// The human-first phrase for a matcher / action type (falls back to the raw
// identifier for an unknown type).
export function matcherTypeLabel(type) { return MATCHER_TYPE_LABELS[type] || String(type || ''); }
export function actionTypeLabel(type) { return ACTION_TYPE_LABELS[type] || String(type || ''); }
// Build a <select> option whose visible text is "Phrase (identifier)", the
// identifier rendered as a muted secondary hint. In the browser this is a text
// node + a <span class="muted">(identifier)</span>; in DOM-less test stubs (no
// document.createTextNode) it falls back to a flat, readable string so the
// label stays assertable via textContent.
export function renderTypeOption(value, phrase) {
  var o = document.createElement('option');
  o.value = value;
  var hint = '(' + value + ')';
  if (typeof document.createTextNode === 'function') {
    o.appendChild(document.createTextNode(phrase + ' '));
    var s = document.createElement('span');
    s.className = 'muted';
    s.textContent = hint;
    o.appendChild(s);
  } else {
    o.textContent = phrase + ' ' + hint;
  }
  return o;
}

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
  top.appendChild(el('div', 'rc-name', ruleLabel(spec)));
  card.appendChild(top);

  // Body: matcher / action summaries (+ priority when set).
  var body = el('div', 'rc-body');
  body.appendChild(summaryCell('Matcher', matcherSummary(spec.matcher)));
  body.appendChild(summaryCell('Action', actionSummary(spec.action, spec.matcher)));
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
  // The confirm shows the humanized label (description, or a friendly
  // matcher+action summary) instead of leaking a raw rule id.
  var label = ruleLabel(spec);
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
// The concrete tool name(s) a matcher targets (from toolName / toolNames).
// An empty list means the matcher does not name a specific tool.
function toolNamesFrom(m) {
  var names = [];
  if (!m) return names;
  if (typeof m.toolName === 'string' && m.toolName) names.push(m.toolName);
  if (Array.isArray(m.toolNames)) names = names.concat(m.toolNames.filter(function (n) { return typeof n === 'string' && n; }));
  return names.filter(function (n, i) { return names.indexOf(n) === i; });
}
// The single concrete tool a matcher targets, or null when it targets several
// or no specific tool (a toolNames[] list, an argPattern with no name, loop,
// or always). This is the "Target tool" for the read-only chip on the Action
// step — the only place the matcher -> action coupling is made explicit for
// actions that carry no tool name of their own (addDescription, and hideTool
// acting on the matched tool).
function matcherTargetToolName(m) {
  if (!m) return null;
  if (m.type === 'toolName' || m.type === 'argPattern') {
    var names = toolNamesFrom(m);
    if (names.length === 1) return names[0];
  }
  return null;
}


// The hideTool toolNames split into a block-list or an allow-list: a base
// pattern is each entry with a single leading ! stripped; the entries form an
// allow-list when ANY entry starts with ! (the ! is the allow-list marker and
// the keep-set is the union of all base patterns). Pure helpers shared by the
// actionSummary and the target chip.
function hideToolToolNames(toolNames) {
  var entries = Array.isArray(toolNames) ? toolNames.filter(function (n) { return typeof n === 'string' && n; }) : [];
  return {
    entries: entries,
    base: entries.map(function (n) { return n.charAt(0) === '!' ? n.slice(1) : n; }),
    allow: entries.some(function (n) { return n.charAt(0) === '!'; })
  };
}
// One-line human-first summary of a hideTool action's toolNames. Reused by the
// rule-card "Action" cell, the wizard's "Then: …" preview, and the humanized
// rule label. A block-list spells out a single entry ("hide webfetch" /
// "hide codebase_*"); an allow-list reads "hide all except <base>" (single) or
// "hide all except <base1> + <base2> …" (several, joined with " + "); a
// block-list with several entries collapses to a count ("hide N tools").
function hideToolSummary(toolNames) {
  var info = hideToolToolNames(toolNames);
  if (info.entries.length === 0) return 'hide tools';
  if (info.entries.length === 1) return info.allow ? 'hide all except ' + info.base[0] : 'hide ' + info.base[0];
  return info.allow ? 'hide all except ' + info.base.join(' + ') : 'hide ' + info.entries.length + ' tools';
}
// The read-only "Target tool" chip text for a hideTool action, derived from the
// action's own toolNames (patterns) rather than the matcher: block-list single
// ("Target: codebase_*") / several ("Target: N tools"); allow-list single
// ("Target: all except codebase_*") / several ("Target: all except knowledge_* +
// codebase_*", joined with " + "). When the field is empty it falls back to the
// matcher-mirroring target (the existing behaviour).
function hideToolTargetLabel(toolNames, matcher) {
  var info = hideToolToolNames(toolNames);
  if (info.entries.length === 1) return info.allow ? 'Target: all except ' + info.base[0] : 'Target: ' + info.base[0];
  if (info.entries.length > 1) return info.allow ? 'Target: all except ' + info.base.join(' + ') : 'Target: ' + info.entries.length + ' tools';
  var name = matcherTargetToolName(matcher);
  return name ? 'Target: ' + name : 'Applies to matching tool(s)';
}
// One-line human-first summary of a matcher spec. Reused by the rule-card body
// ("Matcher" cell) and the wizard's per-step "Fires when: …" preview.
export function matcherSummary(m) {
  if (!m) return '\u2014';
  switch (m.type) {
    case 'toolName': {
      var names = toolNamesFrom(m);
      return names.length ? 'by tool name' + (names.length > 1 ? 's' : '') + ': ' + names.join(', ') : 'by any tool';
    }
    case 'argPattern': {
      var parts = [];
      var t = toolNamesFrom(m);
      if (t.length) parts.push('on ' + t.join(', '));
      if (typeof m.pattern === 'string' && m.pattern) parts.push('arguments match ' + truncate(m.pattern, 48));
      return parts.length ? parts.join(' \u00B7 ') : 'all calls';
    }
    case 'loop': {
      var base = typeof m.window === 'number' ? m.window + '\u00D7 in a row' : 'repeated identical calls';
      var bits = [base];
      if (m.requireConsecutive === false) bits.push('anywhere in run');
      if (m.paramIdentity === 'exact') bits.push('exact params');
      else if (m.resultIdentity === 'exact') bits.push('exact results');
      return bits.join(' \u00B7 ');
    }
    case 'always':
      return 'every call';
    default: return '\u2014';
  }
}
// One-line human-first summary of an action spec. Reused by the rule-card body
// ("Action" cell) and the wizard's per-step "Then: …" preview. `matcher` is
// optional and supplies the target tool for addDescription (whose target is
// implied by the rule's matcher, not a field of the action).
export function actionSummary(a, matcher) {
  if (!a) return '\u2014';
  switch (a.type) {
    case 'hideTool':
      return hideToolSummary(a.toolNames);
    case 'rewriteArgs': {
      var mode = a.mode ? ' (' + a.mode + ')' : '';
      var target = a.toolCallId ? 'by call id ' + a.toolCallId : (typeof a.toolName === 'string' && a.toolName ? 'on ' + a.toolName : 'arguments');
      return 'rewrite arguments' + (target !== 'arguments' ? ' \u00B7 ' + target : '') + mode;
    }
    case 'injectMessage':
      return (a.role ? a.role + ' message' : 'inject a message') + (typeof a.content === 'string' && a.content ? ' \u00B7 \u201C' + truncate(a.content, 60) + '\u201D' : '');
    case 'addDescription': {
      var tgt = matcher ? matcherTargetToolName(matcher) : null;
      return tgt ? 'add a description to ' + tgt : 'add a description to matching tool(s)';
    }
    default: return '\u2014';
  }
}
// The human-readable label for a rule: its description when set, otherwise a
// friendly "New rule · <what it does>" label derived from the action (with the
// matcher) summary. Replaces the raw "Untitled rule" / bare-id fallback in the
// list card name and the delete confirmation.
export function ruleLabel(spec) {
  if (spec && typeof spec.description === 'string' && spec.description.trim()) return spec.description.trim();
  var a = spec ? spec.action : null;
  var m = spec ? spec.matcher : null;
  var as = a ? actionSummary(a, m) : '\u2014';
  if (as && as !== '\u2014') return 'New rule \u00B7 ' + as;
  return 'New rule';
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
  updatePreviews(); // refresh the live "When" preview + target chip after re-rendering
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
  updatePreviews(); // refresh the live "Then" preview + target chip after re-rendering
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
      // Entries are comma- or line-separated: split on commas or line breaks,
      // trim each, and drop empties. Pattern characters (* and !) are never
      // split points, so "codebase_*,webfetch" parses to ["codebase_*", "webfetch"]
      // and "codebase_*\n!webfetch" to ["codebase_*", "!webfetch"].
      var arr = String(raw).split(/[\n,]/).map(function (s) { return s.trim(); }).filter(function (s) { return s !== ''; });
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
// Per-step validators (pure — operate on spec sub-objects, no DOM access).
// Step 1 (When): the matcher is well-formed + carries its required fields.
function validateMatcher(m) {
  if (!isPlainObject(m) || typeof m.type !== 'string') return 'a matcher with a "type" is required';
  if (m.type === 'argPattern' && !(typeof m.pattern === 'string' && m.pattern !== '')) {
    return 'matcher requires a non-empty "pattern"';
  }
  if (m.type === 'loop' && m.window !== undefined && typeof m.window !== 'number') {
    return 'matcher "window" must be a number';
  }
  return null;
}
// Step 2 (Then): the action is well-formed + carries its required fields.
function validateAction(a) {
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
// Step 3 (Details): the rule fields — enabled must be a boolean and priority,
// when set, must be a number (description is optional).
function validateRuleFields(spec) {
  if (typeof spec.enabled !== 'boolean') return '"enabled" must be a boolean';
  if (spec.priority !== undefined && typeof spec.priority !== 'number') {
    return '"priority" must be a number';
  }
  return null;
}
// Client-side mirror of the server's validateSpec required-field checks so we
// can reject obviously-incomplete rules before they hit the network. Reuses the
// per-step validators above (step 3 rule fields, then step 1 matcher, then
// step 2 action) so the whole-form and per-step checks never drift apart.
export function clientValidate(spec) {
  var err = validateRuleFields(spec);
  if (err) return err;
  err = validateMatcher(spec.matcher);
  if (err) return err;
  err = validateAction(spec.action);
  if (err) return err;
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

// Assemble only the fields relevant to wizard step `n` (1 When · 2 Then ·
// 3 Details) into a spec; { spec } or { error }. Used by per-step validation so
// "Next" can check just the active step without reading the whole form.
export function collectStep(n) {
  var enabledEl = $('rule-enabled');
  var spec = { enabled: enabledEl ? !!enabledEl.checked : true };
  if (n === 1) {
    spec.matcher = { type: state.curMatcherType };
    var mbox = $('matcher-fields');
    if (mbox) {
      var me = readSection(MATCHER_FIELDS[state.curMatcherType] || [], mbox, spec.matcher);
      if (me) return { error: me };
    }
    return { spec: spec };
  }
  if (n === 2) {
    spec.action = { type: state.curActionType };
    var abox = $('action-fields');
    if (abox) {
      var ae = readSection(ACTION_FIELDS_ALL[state.curActionType] || [], abox, spec.action);
      if (ae) return { error: ae };
    }
    return { spec: spec };
  }
  var descEl = $('rule-description');
  if (descEl) { var d = descEl.value.trim(); if (d) spec.description = d; }
  var prEl = $('rule-priority');
  if (prEl) {
    var pr = prEl.value.trim();
    if (pr !== '') {
      var num = Number(pr);
      if (isNaN(num)) return { error: '"priority" must be a number' };
      spec.priority = num;
    }
  }
  return { spec: spec };
}
// Validate a single wizard step; returns an error string (invalid) or null
// (valid). Reuses the per-step validators over the step's collected fields.
export function validateStep(n) {
  var r = collectStep(n);
  if (r.error) return r.error;
  var spec = r.spec;
  if (n === 1) return validateMatcher(spec.matcher);
  if (n === 2) return validateAction(spec.action);
  return validateRuleFields(spec);
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
    // Human-first label for the dynamically-added option (e.g. addDescription):
    // "Add a description (addDescription)" — the identifier as a muted hint.
    sel.appendChild(renderTypeOption(type, actionTypeLabel(type)));
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
  state.curMatcherType = 'always';
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
  showStep(1); // a fresh (add-mode) form lands on step 1 (When)
}
// Reflect edit vs. add mode in the form buttons.
export function updateFormMode() {
  var editing = state.editingId !== '';
  // Cancel is now a persistent footer action (visible in both add and edit
  // modes); only the Save button's label and the editor title reflect mode.
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
  if (r.error) { showFormError(r.error); goToFirstInvalidStep(); return; }
  showFormError('');
  saveRule(r.spec);
}

/* ==================== live per-step previews + target chip ==================== */
// The best-effort matcher / action spec for the current form state, read from
// the live fields (collectStep) and falling back to the selected type when a
// field is not yet filled. Used to drive the live previews + target chip.
function currentMatcherSpec() {
  var r = collectStep(1);
  var m = r && r.spec && r.spec.matcher;
  if (!m || !m.type) m = { type: state.curMatcherType };
  return m;
}
function currentActionSpec() {
  var r = collectStep(2);
  var a = r && r.spec && r.spec.action;
  if (!a || !a.type) a = { type: state.curActionType };
  return a;
}
// Refresh the wizard's live previews and the read-only "Target tool" chip:
//   step 1 (#rule-when-preview)  "Fires when: <matcher summary>"
//   step 2 (#rule-then-preview)  "Then: <action summary>"
//   step 2 (#rule-target-chip)   for hideTool, the action's own tool names /
//                                patterns ("Target: codebase_*" / "Target: all
//                                except codebase_*" / "Target: N tools"); for every
//                                other action, the matcher's target tool
//                                ("Target: x" or "Applies to matching tool(s)")
//                                — the clarifier for actions (addDescription)
//                                whose target is implied by the matcher.
//   step 3 (#rule-combined-preview) "When <matcher> → then <action>. <Enabled|Disabled>"
// Every element is optional (guarded) so this is safe on a partially-materialized
// DOM (tests). Wired into the type-change + field-change handlers, renderMatcher
// / renderActionFields, and showStep.
export function updatePreviews() {
  var m = currentMatcherSpec();
  var a = currentActionSpec();
  var mSum = matcherSummary(m);
  var aSum = actionSummary(a, m);
  var when = $('rule-when-preview');
  if (when) when.textContent = 'Fires when: ' + mSum;
  var then = $('rule-then-preview');
  if (then) then.textContent = 'Then: ' + aSum;
  var chip = $('rule-target-chip');
  if (chip) {
    // hideTool names its own target (the toolNames patterns) — derive it from
    // the action, not the matcher; every other action mirrors the matcher.
    if (a.type === 'hideTool') {
      chip.textContent = hideToolTargetLabel(a.toolNames, m);
    } else {
      var name = matcherTargetToolName(m);
      chip.textContent = name ? 'Target: ' + name : 'Applies to matching tool(s)';
    }
  }
  var combined = $('rule-combined-preview');
  if (combined) {
    var en = $('rule-enabled');
    var on = en ? !!en.checked : true;
    combined.textContent = 'When ' + mSum + ' \u2192 then ' + aSum + '. ' + (on ? 'Enabled' : 'Disabled');
  }
}

/* ============================ wizard step state ==================== */
// The rule editor is a 3-step wizard: 1 When (matcher) · 2 Then (action) ·
// 3 Details. Only the active step is visible; the others stay in the DOM so
// their field state, event wiring, and dynamic renders persist across steps.
// Element ids are referenced by step number so the step logic never hardcodes
// three scattered literals.
var currentStep = 1;
var STEP_PANEL_IDS = { 1: 'rule-step-when', 2: 'rule-step-then', 3: 'rule-step-details' };
var STEP_INDICATOR_IDS = { 1: 'rule-step-ind-1', 2: 'rule-step-ind-2', 3: 'rule-step-ind-3' };
var FOOTER_BACK_ID = 'rule-btn-back';
var FOOTER_SAVE_ID = 'btn-add';
// Make only step `n` visible, refresh the indicator, and update the footer.
// Tolerates a partially-materialized DOM (tests) — missing elements are skipped.
export function showStep(n) {
  currentStep = (n === 2) ? 2 : (n === 3) ? 3 : 1;
  [1, 2, 3].forEach(function (s) {
    var p = $(STEP_PANEL_IDS[s]);
    if (!p) return;
    var active = s === currentStep;
    p.classList.toggle('is-active', active);
    p.hidden = !active;
  });
  updateStepIndicator();
  updateFooterNav();
  updatePreviews(); // keep the live previews / target chip current for the shown step
}
// The currently active wizard step (1 When · 2 Then · 3 Details).
export function getCurrentStep() { return currentStep; }
// A step is reachable from here if it is behind us, or every step between us
// and it validates (so walking forward through them would be legal).
function isReachable(n) {
  if (n <= currentStep) return true;
  for (var s = currentStep; s < n; s++) { if (validateStep(s)) return false; }
  return true;
}
// Refresh the step indicator: highlight the current step, mark done (valid)
// steps, and flag which steps are reachable (clickable).
function updateStepIndicator() {
  [1, 2, 3].forEach(function (s) {
    var item = $(STEP_INDICATOR_IDS[s]);
    if (!item) return;
    item.classList.toggle('is-current', s === currentStep);
    item.classList.toggle('is-done', s !== currentStep && validateStep(s) === null);
    item.classList.toggle('is-reachable', isReachable(s));
    item.setAttribute('aria-current', s === currentStep ? 'step' : 'false');
  });
}
// Refresh the footer: Back shows from step 2 on; Save is the primary action on
// step 3; Cancel always. (The step indicator is the forward navigation.)
function updateFooterNav() {
  var back = $(FOOTER_BACK_ID);
  if (back) back.hidden = currentStep <= 1;
  var save = $(FOOTER_SAVE_ID);
  if (save) save.classList.toggle('btn-primary', currentStep === 3);
}
// Step back without validation (going back is always allowed).
export function backStep() {
  if (currentStep <= 1) return;
  showFormError('');
  showStep(currentStep - 1);
}
// Jump directly to a step (the clickable step indicator). No-op when it is the
// current step or not reachable.
export function jumpToStep(n) {
  if (n === currentStep || !isReachable(n)) return;
  showFormError('');
  showStep(n);
}
// On a failed whole-form save, land on the first invalid step (so the error is
// shown in context); fall back to the last step when none are invalid.
function goToFirstInvalidStep() {
  for (var n = 1; n <= 3; n++) { if (validateStep(n)) { showStep(n); return; } }
  showStep(3);
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
    showStep(2); // prefill lands on Then: matcher + action are already filled
    // Focus a step-2 element (not the step-3 description): the first dynamic
    // action field if one is rendered, else the action-type select.
    var actionBox = $('action-fields');
    var firstField = actionBox && actionBox.querySelector('input, textarea, select');
    var focusEl = firstField || $('action-type') || $('rule-form');
    if (focusEl && typeof focusEl.focus === 'function') focusEl.focus();
  } else {
    resetForm(); // resetForm() lands the wizard on step 1
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
  showStep(1); // edit mode lands on step 1 (When)
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
  // Live previews + target chip: update as any dynamic field is typed / changed
  // (event delegation on the field containers survives the per-type re-renders),
  // and as the enabled state toggles (drives the combined preview's Enabled/
  // Disabled suffix). The type-change handlers above already refresh via render*.
  var mf = $('matcher-fields');
  if (mf) { mf.addEventListener('input', updatePreviews); mf.addEventListener('change', updatePreviews); }
  var af = $('action-fields');
  if (af) { af.addEventListener('input', updatePreviews); af.addEventListener('change', updatePreviews); }
  var en = $('rule-enabled');
  if (en) en.addEventListener('change', updatePreviews);
  var form = $('rule-form');
  if (form) form.addEventListener('submit', submitRule);
  // Wizard footer navigation: Back / Cancel (Save is the form submit).
  var back = $('rule-btn-back');
  if (back) back.addEventListener('click', backStep);
  var cancel = $('btn-cancel');
  if (cancel) cancel.addEventListener('click', function () { location.hash = '#/rules'; });
  // Clickable step indicator: jump to a reachable step.
  [1, 2, 3].forEach(function (s) {
    var item = $(STEP_INDICATOR_IDS[s]);
    if (item) item.addEventListener('click', function () { jumpToStep(s); });
  });
  var addRuleBtn = $('btn-add-rule');
  if (addRuleBtn) addRuleBtn.addEventListener('click', function () { location.hash = '#/rules/new'; });
}
