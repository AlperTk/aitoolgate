// Client-side page routing between the dashboard view and the policy-rules view.
// Hash-based routing driven by the native hashchange event. No dependencies, no
// import cycles: this module imports only from ./dom.mjs and ./rules.mjs.
// WS / polling / timers keep running in the background regardless of which page is
// shown; switching pages only toggles view visibility.
import { $ } from './dom.mjs';
import { refreshRules } from './rules.mjs';

// Route keys -> page view ids.
const VIEW_DASHBOARD = 'view-dashboard';
const VIEW_RULES = 'view-rules';
// Nav link hrefs (added in index.html header nav) matched to their routes.
const HREF_DASHBOARD = '#/';
const HREF_RULES = '#/rules';

// Resolve the active route from the current hash.
//   #/ (or empty)            -> dashboard
//   #/rules (any hash that   -> policy-rules
//   contains "rules")
function routeForHash(hash) {
  return hash && String(hash).indexOf('rules') !== -1 ? 'rules' : 'dashboard';
}

// Show the routed page view, hide the other, reflect the choice on the nav links,
// and (only when the rules page becomes active) re-fetch the rule list.
function applyRoute(viewKey) {
  const isRules = viewKey === 'rules';

  const dashView = $(VIEW_DASHBOARD);
  const rulesView = $(VIEW_RULES);
  if (dashView) dashView.classList.toggle('is-active', !isRules);
  if (rulesView) rulesView.classList.toggle('is-active', isRules);

  // Reflect the current page on the two header nav links.
  document.querySelectorAll('.nav-link').forEach((link) => {
    const href = link.getAttribute('href');
    const linkIsRules = href === HREF_RULES;
    link.classList.toggle('is-active', linkIsRules === isRules);
  });

  // Keep the policy-rule list fresh when its page becomes visible. Data flow
  // (WS / polling) is intentionally left untouched so it keeps running behind.
  if (isRules) refreshRules();
}

export function initViews() {
  // Apply the current route immediately, then re-route on every hash change.
  applyRoute(routeForHash(window.location.hash));
  window.addEventListener('hashchange', () => {
    applyRoute(routeForHash(window.location.hash));
  });
}
