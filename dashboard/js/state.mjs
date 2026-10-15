/* ==========================================================================
 * aitoolgate dashboard — shared runtime state container.
 *
 * A single mutable `state` object that centralizes every piece of shared
 * runtime state previously held in the app.js closure. Feature modules import
 * this one object and mutate its fields directly (e.g. `state.ws = socket`).
 * Pure data container — no imports.
 * ========================================================================== */

export const state = {
  // The open WebSocket (or null).
  ws: null,
  // Pending setTimeout handle for the WS reconnect retry.
  reconnectTimer: null,
  localCounts: { calls: 0, results: 0, interventions: 0 },
  // set while the form edits an existing rule
  editingId: '',
  // Defaults chosen so a freshly-emptied form still yields a valid RuleSpec:
  // matcher "loop" (all fields optional) + action "hideTool".
  curMatcherType: 'loop',
  curActionType: 'hideTool',
  // Last rule list fetched from the server (serialized RuleSpec[]). Cached so a
  // deep-link to #/rules/{id} can open the editor instantly without a round trip.
  rules: [],

  /* ---- resilience state for the dual-source live stream -----------
   * The WebSocket is the low-latency primary source. A /api/events poll is the
   * fallback so rows still populate when the browser cannot open a WS (tunnel,
   * port-forward, or a webview that drops the Upgrade header). Both funnel
   * through one deduped ingest path (ingestEvent) so each row renders once.
   */
  // single-instance interval running pollEvents()
  eventsPollTimer: null,
  // periodic keepalive text frame while the WS is open
  keepaliveTimer: null,
  // epoch-ms of the last inbound WS frame (echoes count)
  wsLastInboundAt: 0,
  // dedup gate: event keys already rendered (bounded)
  seenEventKeys: new Set(),
  // callId -> { li, callEv, resultEv, status, expanded, tokenCells? (the row's In/Out/Total cells), turnTokens? (applied turn.usage) }
  callRows: new Map(),
  // [{ li, ev }] unmatched tool.result rows
  orphanResultEntries: [],
  // sessionKey -> [{ ruleId, action, at, detail }]
  interventionsBySession: new Map(),
  // Time-window filter applied client-side over the buffered (retained) events.
  // mode: 'all' | 'preset' | 'custom'; startMs/endMs (epoch ms) bound the window.
  timeRange: { mode: 'all' },
  // Per-row raw data for intervention log rows (li -> { ruleId, action, at, detail,
  // sessionKey }), used by drill-down and export; kept in sync with the DOM.
  interventionRowData: new Map(),
  // Render-dedup only: sessionKey -> the single <li> row currently shown for that
  // session in the intervention log. A repeated policy.intervention event for an
  // already-seen sessionKey updates that row IN PLACE (no new <li> is created); a
  // new sessionKey gets a new row. Empty/absent sessionKeys keep the per-event
  // behavior (no entry is stored). Trimmed rows are dropped (see live-view.mjs
  // trimCallData) and clearOnScreenHistory clears the map. Unlike
  // interventionsBySession (which appends EVERY event for drill-down + the
  // 'intervention' status filter), this map holds one row per session for display.
  interventionRowBySession: new Map()
};
