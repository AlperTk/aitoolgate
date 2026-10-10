// Dashboard entrypoint: all logic lives in ./js/*.mjs; this module only performs
// initial startup wiring. Loaded as an ES module (see index.html <script type="module">).
import { STATS_POLL_MS } from './js/constants.mjs';
import { state } from './js/state.mjs';
import { refreshStats, initTopTools } from './js/stats.mjs';
import { bindFormEvents, renderMatcherFields, renderActionFields, updateFormMode, refreshRules } from './js/rules.mjs';
import { bindFilterEvents, normalizeStreamHead } from './js/live-view.mjs';
import { connectWS, syncConnectivity, startEventsPolling } from './js/transport.mjs';
import { bindControlEvents } from './js/controls.mjs';
import { initViews } from './js/views.mjs';
import { initSettings } from './js/settings.mjs';
import { mountLayout } from './js/layout.mjs';

function init() {
  bindFormEvents();
  bindFilterEvents();
  normalizeStreamHead();   // self-heal the stream header structure at init
  bindControlEvents();
  initViews();              // client-side page routing (hashchange between views)
  initSettings();           // settings popup modal: header gear icon -> API-providers manager (see js/settings.mjs)
  renderMatcherFields(state.curMatcherType);
  renderActionFields(state.curActionType);
  updateFormMode();
  refreshStats();          // initial load: stats + rules in parallel
  initTopTools();          // build the top-tools data table (filter + sortable headers)
  refreshRules();
  connectWS();             // low-latency primary source (self-heals on close/dead)
  syncConnectivity();      // honest baseline: polling/fallback until the WS actually opens
  startEventsPolling();    // fallback: keeps the live stream alive without a WS
  setInterval(refreshStats, STATS_POLL_MS); // stats fallback poll
}

// Compose the page body first (mount dashboard/html/*.html into the shell slots),
// then wire features — feature modules bind to static ids that exist only after
// the fragments are mounted.
let booted = false; // guard so boot() (and thus init()) runs EXACTLY once
async function boot() {
  if (booted) return; // idempotent: safe even if both startup paths below fire
  booted = true;
  await mountLayout();   // compose the page body first (fragments into shell slots)
  init();                 // then wire features (they bind to ids that now exist)
}

// app.js is a <script type="module">, which browsers execute DEFERRED — i.e. AFTER
// the document is fully parsed, when document.readyState is already 'interactive'
// (or 'complete'), never 'loading'. So the readyState==='loading' listener branch is
// normally dead code here; we keep it only so the module also starts correctly if it
// were ever evaluated before parse completes. Either way boot() runs exactly once
// (guarded by `booted`) AFTER mountLayout() fully completes, regardless of readyState.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
