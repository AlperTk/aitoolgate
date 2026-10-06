// Client-side page routing for the dashboard: switches between the live
// dashboard and the policy-rules page, and within the rules page between the
// rules LIST and the rule EDITOR (add / edit). Hash-based, dependency-free;
// imports only from ./dom.mjs and ./rules.mjs (no import cycle: this -> dom +
// rules; neither of those imports back here). WS / polling / timers keep
// running in the background regardless of which view is shown — switching pages
// only toggles view visibility and (re-)loads the relevant view's data.
import { $ } from './dom.mjs';
import { refreshRules, openNewRuleForm, openEditRuleForm } from './rules.mjs';

// Top-level + nested view ids.
const VIEW_DASHBOARD = 'view-dashboard';
const VIEW_RULES = 'view-rules';           // shared rules-page shell (both sub-views)
const RULES_LIST_VIEW = 'rule-list-view';  // list of existing rules (#/rules)
const RULE_EDITOR_VIEW = 'view-rule-editor'; // add/edit form (#/rules/new · #/rules/:id)
// Nav link hrefs (header nav) matched to their routes.
const HREF_RULES = '#/rules';

// Resolve the active route from the current hash into a small descriptor:
//   #/ (or any hash without a leading "rules") -> dashboard
//   #/rules                                    -> rules list
//   #/rules/new                                -> editor in ADD mode
//   #/rules/{id}                              -> editor in EDIT mode (id may be multi-segment)
function parseRoute(hash) {
  var raw = String(hash || '').replace(/^#\/?/, ''); // strip a leading "#" or "#/"
  var parts = raw.split('/').filter(Boolean);
  if (!parts.length || parts[0] !== 'rules') return { page: 'dashboard' };
  if (parts.length === 1) return { page: 'rules' };
  if (parts[1] === 'new') return { page: 'rule-new' };
  return { page: 'rule-edit', id: decodeURIComponent(parts.slice(1).join('/')) };
}

// Show the routed view, hide the others, reflect the choice on the nav links
// ("Policy Rules" stays highlighted for every rule sub-route), then drive the
// per-view data + form setup. The dashboard stream keeps running underneath.
function applyRoute(route) {
  var page = route.page;
  var isRulesPage = page !== 'dashboard';

  // Top-level page toggle: only one of dashboard / rules shows at a time.
  var dashView = $(VIEW_DASHBOARD);
  var rulesView = $(VIEW_RULES);
  if (dashView) dashView.classList.toggle('is-active', !isRulesPage);
  if (rulesView) rulesView.classList.toggle('is-active', isRulesPage);

  // Within the rules page: show the list, or the editor (add / edit).
  var listView = $(RULES_LIST_VIEW);
  var editorView = $(RULE_EDITOR_VIEW);
  if (listView) listView.classList.toggle('is-active', page === 'rules');
  if (editorView) editorView.classList.toggle('is-active', page === 'rule-new' || page === 'rule-edit');

  // Reflect the current page on the header nav links.
  document.querySelectorAll('.nav-link').forEach(function (link) {
    var linkIsRules = link.getAttribute('href') === HREF_RULES;
    link.classList.toggle('is-active', linkIsRules === isRulesPage);
  });

  // Per-view data + form setup.
  if (page === 'rules') refreshRules();                       // keep the list fresh
  else if (page === 'rule-new') openNewRuleForm();           // clean add-mode form
  else if (page === 'rule-edit') openEditRuleForm(route.id); // prefill from existing rule
}

export function initViews() {
  // Apply the current route immediately, then re-route on every hash change.
  applyRoute(parseRoute(window.location.hash));
  window.addEventListener('hashchange', function () {
    applyRoute(parseRoute(window.location.hash));
  });
}
