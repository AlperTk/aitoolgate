# mcp-manager — Dashboard UI (dependency-free vanilla-JS SPA)

> Real-time local dashboard: live tool-call stream + counts/top tools + intervention log + rule authoring, plus a global-controls toolbar. Built as **vanilla JS** (NO React/Vite/Tailwind/shadcn, NO `ws` package), served same-origin at `/` by the same process. Design → `architecture.md`; exact endpoints/types → `api-reference.md`; build/serve rules → `conventions.md`. **No DOM/browser tests exist** — verify changes via `node --check` + `npm test` (~165 green) + structural grep + a manual browser pass.

## Key files
- `dashboard/index.html` — static shell; every section keyed by a DOM id (`#stream-panel`, `#stats-panel`, `#interventions-panel`, `#rules-panel`).
- `dashboard/app.js` — non-module plain browser script (~700+ lines, an IIFE); builds/updates DOM via `el()`; `init()` runs on load. Served **raw (not compiled)** by `src/server/index.ts` (`DASHBOARD_FILES`) from the compiled `dist/src/server` location (walks up ≤4 levels to the first `dashboard/index.html`; `mount.dashboardDir` override wins).
- `dashboard/styles.css` — hand-written styles.
Only these three files are editable for UI work. Do **not** add dependencies or compile the dashboard.

## Data sources (dual-source, self-healing)
- **WebSocket `/ws`** (hand-rolled RFC6455; `connectWS`/`handleWsMessage` + keepalive that reconnects after ~3 silent windows) **+ ~2.5s polling** `GET /api/events` fallback, deduped by `eventKey` (`type|sessionKey|at|toolName`, bounded set). Guarantees records appear even when the access path can't forward `Upgrade: websocket` (tunnels/port-forwards/webviews) — see `pitfalls.md`.
- `GET /api/stats` (~3s poll via `refreshStats`/`renderTopTools`) drives the aggregate tiles + top-tools table.
- A visible **live/polling banner** (`#stream-status`, `setConnected`/`syncConnectivity`) shows the current source instead of a silently-empty list.

## Sections

### LIVE TOOL CALLS (`#stream-panel`)
One row per **logical tool call**, keyed on the event's stable `event.id` (each distinct id → its own row, so batched parallel calls — even same-name, same-turn siblings — do NOT collapse; non-call events append an empty id segment to the dedup key). Columns: status badge (pending → ok/error), tool name, short session key, timestamp, **Duration (ms)**, then **In / Out / Total** (`tokens.input`/`output`/`total`; each renders `—` when absent) and **Size** (the paired result's `chars` — an always-available proxy when a turn reported no usage). A `<th>` header row is rendered above the list in `index.html`: Status | Tool | Session | Time | Duration(ms) | In | Out | Total | Size.
- **Call↔result pairing:** a `tool.result` is matched to its call by `toolCallId === call.id`; with no usable id it falls back to the same NON-EMPTY `sessionKey` + most-recent pending call (a uniform empty key never triggers the fallback). Unmatched results are retained as orphan rows rather than dropped. Both call and orphan rows build their In/Out/Total/Size cells via shared `appendTokenAndSizeCells` (+ `setNumCellText` for in-place updates on result arrival). Rows are updated in place via `updateCallRowWithResult` / `matchAndRenderResult` / `findCallForResult` (created by `createCallRow` / `createOrphanResultRow`).
- **Click-to drill-down:** toggling a row's `.s-expand` reveals an inline `.row-detail` block — full args (pretty-printed JSON), result `ok`/`chars`/`durationMs`, the FULL session key, and `ruleId` + `action` if an intervention fired (`storeInterventionForDrillDown` / `renderRowDetail` / `bindRowClick`). Toggling one row does not collapse the others.
- **Filters:** a `.stream-filters` bar (tool name / status / session) with a "showing X of Y" count, client-side over the buffered rows (`applyFilters` / `bindFilterEvents`), composing with the time range below.
- **Bounded history:** items cap (~200; `trimCallData` / `MAX_LIST_ITEMS`) into a 360px-scroll `.list-wrap`; each retained row carries `data-at` (and `data-session` for interventions) for time filtering/export.
- `ingestEvent()` is the single deduped entry point that renders both WS and poll events.

### COUNTS & TOP TOOLS (`#stats-panel`)
Tiles: total calls/results; total + avg duration (ms); total/input/output tokens (all `—` until data exists); a live row (this-session / results / interventions); a **top-tools table** (Tool | Calls | Avg(ms) | Max(ms)); footer "Interventions retained".
- Absent metric fields render `—` via `fmtOpt()`. The meaning of `—` (**"no data yet"**, not an error) is explained via a native tooltip: a shared `NO_DATA_TIP` constant + `setStatValue()` helper attach a `title` only while a tile shows `—`; `renderTopTools`/`statNumCell` set/clear it on the `Avg(ms)`/`Max(ms)` headers, each empty cell, and add a muted footnote under the table.
- The **Results count** reflects `CollectorSummary.totalResults` (real per-result pairing) — see `tool-metrics.md`. Aggregates (tiles + top-tools) EXCLUDE nested-wrapper tools (default `task`) via `aggregate-exclusions.ts`, so the Top Tools table has no `task` row while the live stream still shows each `task` event.

### INTERVENTION LOG (`#interventions-panel`)
Structured rows (`addInterventionRow`): distinct cells **Time (`iv-time`) | Rule id (`iv-rule`) | Action-type badge (`iv-action`, class `badge-interv`) | Detail message (`iv-detail`)**, built from `InterventionEvent {at, ruleId, action, detail?}` with per-cell `title`s (DOM-built → auto-escaped). Empty state = inline SVG pulse icon + text + a hint of what will appear. Same bounded cap as the stream.

### POLICY RULES (`#rules-panel`)
A rules list + an authoring form. Each **rule row** (`renderRuleRow`) exposes an enabled checkbox, description, id, and **Edit / Delete** buttons; clicking Edit loads the spec into the form. Form flow: `makeField`/`renderMatcherFields`/`renderActionFields` build dynamic matcher/action fields; `collectSpec`/`submitRule`/`saveRule` persist (REST `POST`); `loadSpecIntoForm`/`resetForm` manage add/edit mode; `toggleEnabled`/`deleteRule` mutate the store (REST `PATCH`/`DELETE`). Matcher/action type, Window, Require-consecutive, Param identity, Result identity, Description, Priority, and Enabled all carry help hints/tooltips (Priority: "lower number = higher precedence; blank = default"). See `api-reference.md` for RuleSpec shapes.

## Global controls toolbar
- **Time range** (`filter-time`; presets All / 5m / 15m / 1h + custom from–to via `filter-time-from`/`filter-time-to`): filters both calls and interventions by `at`, composing with the tool/status/session filters (`inTimeRange`/`onTimeRangeChange`/`applyCustomTimeRange`).
- **Clear on-screen history** (`btn-clear-history`): wipes only the client-side buffered events + DOM rows + live counters; keeps the dedup `seenEventKeys` set so polled replays don't repopulate; does **NOT** touch server aggregates (there is no server-side wipe endpoint).
- **Export** (calls & interventions, JSON + CSV): native `Blob` + `URL.createObjectURL` + `a.click()`. CSV is RFC-4180 (calls: type/at/time/toolName/sessionKey/status/durationMs/tokensInput/tokensOutput/tokensTotal/sizeChars; interventions add ruleId/action/detail). Helpers: `getVisibleCalls`/`getVisibleInterventions`/`buildCallsCsv`/`buildInterventionsCsv`/`exportJson`/`exportCsv`/`downloadFile`. Wired in `init()` via `bindControlEvents()`.

## Key symbols (approximate anchors — may shift)
`el` · `ingestEvent` · `createCallRow`/`updateCallRowWithResult`/`createOrphanResultRow`/`matchAndRenderResult`/`findCallForResult` · `storeInterventionForDrillDown`/`bindRowClick`/`renderRowDetail` · `applyFilters`/`bindFilterEvents`/`inTimeRange`/`onTimeRangeChange`/`applyCustomTimeRange` · `clearOnScreenHistory`/`interventionRowData` · `exportJson`/`exportCsv`/`buildCallsCsv`/`buildInterventionsCsv`/`getVisibleCalls`/`getVisibleInterventions`/`downloadFile` · `refreshStats`/`renderTopTools`/`statNumCell`/`NO_DATA_TIP`/`setStatValue`/`fmtOpt` · `addInterventionRow` · `renderRules`/`renderRuleRow`/`loadSpecIntoForm`/`collectSpec`/`saveRule`/`submitRule`/`toggleEnabled`/`deleteRule` · `connectWS`/`handleWsMessage`/`startEventsPolling`/`syncConnectivity`/`setConnected` (keepalive) · `init`/`bindFormEvents`/`bindControlEvents`.

## Business rules / assumptions
- **Zero-dep vanilla JS** — no framework, no `ws` package; UI edits touch only the three dashboard files; stay consistent (`el()`, existing class naming, `—` for absent values).
- The stream is a **bounded ring buffer** (~200 items); time-range + export operate over the retained window, not full lifetime history.
- **Per-row duration/tokens** rely on call↔result pairing by id (sessionKey fallback) and inherit the sequential-single-client assumption of the backend metrics (`tool-metrics.md`).
- `—` = "no data yet" (early run), never an error.
- "Clear history", time-range, and export are **client-side only**; they do not mutate server state.

## Testing
No DOM/browser tests exist (the e2e suite only asserts the dashboard files are *served*). Verify changes with: `node --check dashboard/app.js` (syntax), `npm test` (baseline ~165 green, no regression), a structural grep that new DOM ids/classes/helpers exist in the three files, and a **manual browser smoke-test** (tooltips render, drill-down toggles, filters apply, export download fires). See `pitfalls.md`.
