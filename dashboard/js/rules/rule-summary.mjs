/* ==========================================================================
 * aitoolgate dashboard — rule summary / label presentation.
 *
 * Pure presentation builders for policy rules: type-select labels, matcher and
 * action one-line summaries, the hideTool allow/block-list helpers, and the
 * human-readable rule label. No DOM, no shared state, no fetch; the only
 * dependency is the i18n `t()`. rules.mjs re-exports the public names and
 * imports the target helpers it needs for its chips and previews.
 * ========================================================================== */
import { t } from '../i18n/index.mjs';

/* ==================== human-first type-select labels ==================== */
// Human-first labels for the matcher / action type selects. The plain phrase
// leads; the internal identifier is shown as a muted secondary hint (see the
// <span class="muted">(identifier)</span> in the static HTML options and the
// dynamically-added options built by renderTypeOption in rules.mjs).
var MATCHER_TYPE_LABELS = {
  toolName: 'rules.type.matcher.toolName',
  argPattern: 'rules.type.matcher.argPattern',
  loop: 'rules.type.matcher.loop',
  always: 'rules.type.matcher.always'
};
var ACTION_TYPE_LABELS = {
  hideTool: 'rules.type.action.hideTool',
  rewriteArgs: 'rules.type.action.rewriteArgs',
  injectMessage: 'rules.type.action.injectMessage',
  addDescription: 'rules.type.action.addDescription'
};
// The human-first phrase for a matcher / action type (falls back to the raw
// identifier for an unknown type).
export function matcherTypeLabel(type) { return MATCHER_TYPE_LABELS[type] ? t(MATCHER_TYPE_LABELS[type]) : String(type || ''); }
export function actionTypeLabel(type) { return ACTION_TYPE_LABELS[type] ? t(ACTION_TYPE_LABELS[type]) : String(type || ''); }

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
export function matcherTargetToolName(m) {
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
export function hideToolToolNames(toolNames) {
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
  if (info.entries.length === 0) return t('rules.summary.hideTools');
  if (info.entries.length === 1) return info.allow ? t('rules.summary.hideAllExcept', { name: info.base[0] }) : t('rules.summary.hide', { name: info.base[0] });
  return info.allow ? t('rules.summary.hideAllExcept', { name: info.base.join(' + ') }) : t('rules.summary.hideCount', { count: info.entries.length });
}
// One-line human-first summary of a matcher spec. Reused by the rule-card body
// ("Matcher" cell) and the wizard's per-step "Fires when: …" preview.
export function matcherSummary(m) {
  if (!m) return '\u2014';
  switch (m.type) {
    case 'toolName': {
      var names = toolNamesFrom(m);
      if (!names.length) return t('rules.summary.byAnyTool');
      return names.length > 1
        ? t('rules.summary.byToolNames', { names: names.join(', ') })
        : t('rules.summary.byToolName', { names: names.join(', ') });
    }
    case 'argPattern': {
      var parts = [];
      var tn = toolNamesFrom(m);
      if (tn.length) parts.push(t('rules.summary.onTools', { names: tn.join(', ') }));
      if (typeof m.pattern === 'string' && m.pattern) parts.push(t('rules.summary.argumentsMatch', { pattern: truncate(m.pattern, 48) }));
      return parts.length ? parts.join(' \u00B7 ') : t('rules.summary.allCalls');
    }
    case 'loop': {
      var base = typeof m.window === 'number' ? t('rules.summary.inARow', { window: m.window }) : t('rules.summary.repeatedCalls');
      var bits = [base];
      if (m.requireConsecutive === false) bits.push(t('rules.summary.anywhereInRun'));
      if (m.paramIdentity === 'exact') bits.push(t('rules.summary.exactParams'));
      else if (m.resultIdentity === 'exact') bits.push(t('rules.summary.exactResults'));
      return bits.join(' \u00B7 ');
    }
    case 'always':
      return t('rules.summary.everyCall');
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
      var target = a.toolCallId ? t('rules.summary.byCallId', { id: a.toolCallId })
        : (typeof a.toolName === 'string' && a.toolName ? t('rules.summary.onTool', { name: a.toolName }) : null);
      return t('rules.summary.rewriteArgs') + (target ? ' \u00B7 ' + target : '') + mode;
    }
    case 'injectMessage':
      return (a.role ? t('rules.summary.roleMessage', { role: a.role }) : t('rules.summary.injectMessage')) + (typeof a.content === 'string' && a.content ? ' \u00B7 \u201C' + truncate(a.content, 60) + '\u201D' : '');
    case 'addDescription': {
      var tgt = matcher ? matcherTargetToolName(matcher) : null;
      return tgt ? t('rules.summary.addDescriptionTo', { name: tgt }) : t('rules.summary.addDescriptionMatching');
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
  if (as && as !== '\u2014') return t('rules.card.newRuleWith', { summary: as });
  return t('rules.newRule');
}
