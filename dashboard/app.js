// Dashboard entrypoint: all logic lives in ./js/*.mjs; this module only performs
// initial startup wiring. Loaded as an ES module (see index.html <script type="module">).
import { STATS_POLL_MS } from './js/constants.mjs';
import { state } from './js/state.mjs';
import { refreshStats, initTopToolsSort } from './js/stats.mjs';
import { bindFormEvents, renderMatcherFields, renderActionFields, updateFormMode, refreshRules } from './js/rules.mjs';
import { bindFilterEvents } from './js/live-view.mjs';
import { connectWS, syncConnectivity, startEventsPolling } from './js/transport.mjs';
import { bindControlEvents } from './js/controls.mjs';
import { initViews } from './js/views.mjs';

function init() {
  bindFormEvents();
  bindFilterEvents();
  bindControlEvents();
  initViews();              // client-side page routing (hashchange between views)
  renderMatcherFields(state.curMatcherType);
  renderActionFields(state.curActionType);
  updateFormMode();
  refreshStats();          // initial load: stats + rules in parallel
  initTopToolsSort();      // attach click-to-sort on top-tools table headers
  refreshRules();
  connectWS();             // low-latency primary source (self-heals on close/dead)
  syncConnectivity();      // honest baseline: polling/fallback until the WS actually opens
  startEventsPolling();    // fallback: keeps the live stream alive without a WS
  setInterval(refreshStats, STATS_POLL_MS); // stats fallback poll
}

// The script is loaded at the end of <body> so the DOM is ready; guard just in case.
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
