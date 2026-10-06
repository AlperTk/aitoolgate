# Open Tasks (Backlog)

> User-reported open items (session 2026-10-04). Not yet scheduled for implementation.

## 1. Policy tool-hiding appears not to work — must be checked
- Problem: the hideTool policy action does not seem to take effect. Needs investigation + verification of actual behavior.
- Likely starting points: `src/policy/actions/hideTool.ts` (`createHideToolAction()`, `HideToolActionConfig`), its mount in `src/policy/policyStage.ts`, how hidden tools reach the client/dashboard (drill-down views in `dashboard/`).
- First step: reproduce — which rule configuration, which protocol (OpenAI vs Anthropic), and what exactly is missing (tool absent from list? still callable? UI not reflecting?).
- Resolution (2026-10-05): FIXED + verified. `hideToolsFromRequest()` (src/policy/policyStage.ts) now strips hidden tool definitions AND in-message references (OpenAI `tool_calls` / `role:'tool'`; Anthropic `tool_use` / `tool_result`) via centralized `stripHiddenToolReferences`; effective on all paths (both protocols, JSON + SSE, before translation); passthrough stays byte-identical when nothing matches. e2e suite tests/e2e-hideTool.test.ts green.
- Status: closed

## 2. Improve the policy/rules screen design
- Problem: the dashboard rules (policy) view needs design improvement. Candidate direction: move the rule creation **form off the main list view into a separate "add" screen** (list stays clean; form gets its own space).
- Likely starting points: `dashboard/html/rules-view.html` (fragment mounted via `js/layout.mjs` FRAGMENTS), rule CRUD REST endpoints in `src/api/http.ts` / `ruleStore.ts`.
- Note: follow existing dashboard CSS conventions (token-first, viewport-fit layout ≥961px) if/when implemented.
- Resolution (2026-10-05): IMPLEMENTED + verified. Rules view split into hash-routed screens: `#/rules` clean card-grid **list** (action-derived severity badge + enabled toggle + Edit/Delete + empty state), `#/rules/new` **add editor**, `#/rules/:id` **edit editor** (reuses form, prefilled, "Edit rule" heading + cancel shown). REST contract unchanged; CRUD + empty-state toggle + dynamic form fields verified in Chromium.
- Status: closed

## 3. Tool durations skew in batch calls — find a better measurement method
- Problem: per-tool duration metrics are wrong/skewed when a single call batch contains multiple tool calls (parallel/batched tool use). Investigate a more accurate attribution method.
- Likely starting points: `src/telemetry/stream-extract.ts` (call extraction from SSE streams), call↔result pairing in `src/proxy/context.ts` (`resolveAndEmitToolResults`), aggregation in `src/telemetry/toolMetrics.ts`, event shapes in `src/telemetry/events.ts` (`ToolCallEvent`).
- Key question: how should per-call start/end timestamps be attributed when results arrive interleaved or out of order within one batch?
- Resolution (2026-10-05): IMPLEMENTED + verified. Per-call duration attribution via monotonic `monotonicEpochMs` clock (injectable `now()`) + per-call `StreamToolCall.firstSeenAt` / `emitCallAt` (emitted events keep the shared turn-level `at`); additive `id`/`durationMs`/`chars` fields on the tool-result event (WS/dashboard backward-compatible); orphans clamped >=0 (no NaN). Batched co-arriving results share identical durations by design. e2e suite tests/e2e-tool-duration-attribution.test.ts green.
- Status: closed

## 4. Show actual tool-result value in the live view (on-demand)
- Problem: the live tool-call screen shows call args but not the tool's actual returned output value.
- Resolution (2026-10-06): IMPLEMENTED + verified. WS `ToolResultEvent` stays metadata-only; the raw result value is captured into a bounded in-memory `toolResultStore` keyed by tool-call id and served via `GET /api/tool-results/:id`; dashboard row-detail reworked into an `Arguments | Response | Details` tab strip with a lazily-fetching, cached "Response" tab. Optional SQLite persistence behind `config.toolResults.enabled` (default off) via a `ToolResultPersister` port + async batched WAL drain (request hot path does no synchronous disk I/O). Full suite 242 pass / 0 fail; WS event unchanged.
- Status: closed
