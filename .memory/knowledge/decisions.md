# mcp-manager — Decisions

Locked decisions (do not re-litigate without explicit sign-off). Each lists Decision / Reason / Evidence.

## Interception surface = the model proxy
- Decision: MVP intercepts at the model proxy, NOT the tool executor; model-proxy-only.
- Reason: a single choke point over the message stream, framework-agnostic.
- Evidence: `src/proxy/`, `src/ports/domain.ts`

## Protocols (v1) = OpenAI-compatible AND Anthropic-compatible
- Decision: both `/v1/chat/completions` + `/v1/models` (OpenAI) and `/v1/messages` (Anthropic), pass-through to one configured upstream.
- Reason: cover both major client SDKs from one upstream target.
- Evidence: `src/proxy/openai.ts`, `src/proxy/anthropic.ts`, `src/proxy/translate.ts`

## Model layer (v1) = single configured model, pass-through
- Decision: pass through one configured upstream model (LiteLLM-lite). Multi-model + per-client routing + fallback is v1.1.
- Reason: keep v1 minimal; extensible via ports.
- Evidence: `config/config.ts`, `src/ports/strategy.ts` (ModelRouter)

## Client identity read but NOT enforced
- Decision: per-client API key (LiteLLM-style) for routing/attribution; read but not enforced in default passthrough; no UI login (local, trusted, single-node).
- Reason: local tool — auth adds friction without value.
- Evidence: `src/proxy/upstream.ts` (FetchLike/auth), `src/proxy/context.ts` (`toClientId`)

## Policy engine = declarative ordered rule pipeline, live-editable
- Decision: ordered matcher+action rules, UI- and REST-editable. Scripting escape-hatch + LLM-as-policy matcher deferred to v1.1. Open/Closed.
- Reason: deterministic + inspectable rules first; scripting/LLM matchers add power later without core rework.
- Evidence: `src/policy/ruleEngine.ts`, `src/api/ruleSpec.ts`, `src/api/http.ts`

## Flagship loop rule
- Decision: last N consecutive identical (tool+params+result) calls → intervene. Feedback ladder: short-circuit + inject "you're looping/stuck, change approach" → warn+block → require-human/halt, with a cooldown. Knobs: window, require-consecutive, param/result-identity strictness (exact → normalized → LLM-judged).
- Reason: loops are the highest-value agent failure mode; graduated response avoids harsh over-punishment.
- Evidence: `src/policy/matchers/loopDetector.ts`, `src/policy/actions/*`, `src/policy/feedbackStore.ts`

## Block behavior = never silent
- Decision: block = drop the offending call AND return a message to the LLM ("blocked by rule X, reason…").
- Reason: the model must see why it was stopped to change behavior.
- Evidence: `src/policy/actions/block.ts`

## Session / loop detection = stateless per-request
- Decision: scan full per-request history (client resends all turns each request; no standard conversation-id on the wire). Session key = content-fingerprint of stable prefix + optional client token (`X-Session-Id`).
- Reason: statelessness means no server-side session store needed; survives restarts.
- Evidence: `src/session/session.ts`, `src/policy/matchers/loopDetector.ts`

## Tools NOT fronted in MVP
- Decision: MVP does not front tools; extensible via a `ToolProvider` port so MCP + skills can be injected as plugins later.
- Reason: keep core proxy-agnostic; tool gating can be added without rework.
- Evidence: `src/ports/strategy.ts` (ToolProvider)

## Storage = Repository, SQLite default, swappable
- Decision: Repository pattern with SQLite default; swappable to Postgres later.
- Reason: zero-dep local persistence now, portable storage interface later.
- Evidence: `src/storage/schema.ts`, `src/storage/sqlite.ts`, `src/ports/storage.ts`

## Dashboard = dependency-free, real-time, same process
- Decision: local web dashboard, no login, real-time (live tool-call stream + intervention log + counts/top tools) + rule authoring; built as dependency-free vanilla-JS SPA + built-in RFC6455 WebSocket + Node `http` REST, served by the same process. NO React/Vite/Tailwind/shadcn, NO `ws` package.
- Reason: keeps the whole system zero-dependency and single-process; supersedes an earlier React/Vite+Tailwind+shadcn draft.
- Evidence: `dashboard/`, `src/api/ws.ts`, `src/server/index.ts` (`DASHBOARD_FILES`)

## Live tool-call stream = dual-source (WS primary + /api/events polling)
- Decision: the dashboard populates its live stream from TWO sources — WebSocket as low-latency primary plus a ~2.5s `GET /api/events` polling fallback (deduped by event key), with a WS keepalive that reconnects after ~3 silent windows and a visible live/polling status banner.
- Reason: real access paths (tunnels/port-forwards/webviews) may not forward the `Upgrade: websocket` header, leaving a half-open socket that shows nothing while plain-HTTP fetch still works; polling guarantees records appear regardless of WS support.
- Evidence: `dashboard/app.js` (polling + dedup + keepalive), `src/api/http.ts` (`/api/events`), `src/telemetry/collector.ts` (`getRecentEvents`), `tests/e2e-integration.test.ts`

## Tool-call metrics = real cross-request pairing + real usage
- Decision: per-tool-call **duration (ms)** = time from issuance (`tool_calls[].id` in response N) to result arrival (matching `role:'tool'`/`tool_result` in request N+1), paired by `(sessionKey, toolCallId)` via a bounded in-memory tracker (`src/telemetry/toolMetrics.ts`, no timers). **Tokens** = real upstream `usage` of the producing turn (OpenAI prompt/completion/total; Anthropic input/output), deduped per turn at aggregation; raw payload size exposed as `chars` (no tokenizer — zero-dep budget).
- Reason: gives true "how long did this tool take + how many tokens it cost" without adding a dependency or fronting tools; reuses the existing telemetry → collector → `/api/stats` → dashboard flow.
- Evidence: `src/telemetry/toolMetrics.ts`, `src/telemetry/collector.ts`, `src/proxy/context.ts`, `tests/e2e-integration.test.ts`, `tests/e2e-policy.test.ts` (Scenario 3), `tool-metrics.md`.

## tool.call emission CENTRALIZED in context.ts (policy stage emits interventions only)
- Decision: `emitResponseTelemetry` (context.ts) runs UNCONDITIONALLY on every path and is the SOLE emitter of `tool.call` (with `id`+`tokens`) and the SOLE caller of `tracker.recordIssued`. The policy stage emits ONLY `policy.intervention`; its own tool-call emission was removed. Real `tool.result` events come from request-phase detection.
- Reason: previously, when a policy stage was present, context's emission was skipped and the policy stage emitted tool.calls without id/tokens and never recorded to the tracker → NO duration/tokens on the policy path. Centralizing makes default AND policy paths consistent and prevents double-count.
- Evidence: `src/proxy/context.ts` (no `policyHandlesCallTelemetry` guard), `src/policy/policyStage.ts`, `tests/policy-stage-events.test.ts`.

## Dashboard UI = enriched live stream + global controls (additive, no deps)
- Decision: keep the vanilla-JS, zero-dependency dashboard and enrich its live stream — one row per logical tool call showing status + Duration(ms) + In/Out/Total + Size (call↔result paired by id, sessionKey fallback; batched calls deduped by `event.id` — see the id-based-dedup decision below), click-to drill-down (args/result/session/ruleId), tool/status/session filters, plus a global-controls toolbar (time-range selector, clear-on-screen-history, JSON+CSV export of calls & interventions). Absent metric fields show "—" with a "no data yet" tooltip; the intervention log uses structured rows. All client-side over the bounded event buffer; NO server-side wipe endpoint added.
- Reason: makes the live stream genuinely useful (per-call cost + what actually happened) while staying zero-dependency and single-process; it is additive on top of the existing WS/poll dual-source and `/api/stats` flow, so no backend contract changes.
- Evidence: `dashboard/app.js` (createCallRow/updateCallRowWithResult/matchAndRenderResult, bindRowClick/renderRowDetail, applyFilters/inTimeRange/clearOnScreenHistory, buildCallsCsv/buildInterventionsCsv/exportJson, statNumCell/NO_DATA_TIP), `dashboard/index.html`, `tests/e2e-integration.test.ts`; `dashboard-ui.md`.

## Live panel = id-based batch dedup + honest per-turn token columns + size
- Decision: the live tool-call panel keys each row on the stable `tool.call` `event.id` (so batched parallel calls — even same-name, same-turn siblings — each get their own row instead of collapsing into one); it renders an honest **In / Out / Total** token breakdown (the full upstream turn usage `{input?,output?,total?}`, deduped per turn at aggregation — NOT a single tool's cost) plus a **Size** column from the paired result's `chars` (an always-available proxy when a turn reported no usage). OpenAI same-protocol streamed requests now inject `stream_options.include_usage=true`; non-streamed and Anthropic streaming paths are unchanged. The `ToolCallEvent` type keeps `id`/`tokens` optional; the "always present, unique" guarantee is enforced by both emitters.
- Reason: a batch of identical-named calls previously shared a single `type|sessionKey|at|toolName` dedup key, so only the first sibling rendered; and the raw per-row turn total misled readers into thinking a tiny tool read cost ~100k tokens. An id-based key fixes the collapse; splitting/relabeling tokens + adding Size makes per-row cost honest without changing backend aggregation. Test baseline 161 → **165**.
- Evidence: `src/proxy/context.ts` + `src/telemetry/stream-extract.ts` (stable unique `id`, `{input,output,total}`), `src/proxy/openai.ts` (`include_usage`), `dashboard/app.js` (`eventKey` includes `event.id`; `appendTokenAndSizeCells`/`setNumCellText`; In/Out/Total/Size cells), `dashboard/index.html` (9-col header row), `tests/e2e-integration.test.ts`, `tests/tool-result-pairing.test.ts`, `tests/telemetry-collector.test.ts`.

## Aggregates exclude the nested sub-agent wrapper (`task`)
- Decision: collector aggregates (totals AND averages — total/avg duration, total/input/output tokens, top-tools) exclude any event whose `toolName` matches a configurable set (default `['task']`, case-insensitive; `src/telemetry/aggregate-exclusions.ts` / `CollectorOptions.excludedTools`). Raw event retention (`getRecentEvents`) and `perSession` are NOT filtered, so the live dashboard stream + drill-down still show each such event.
- Reason: the `task` tool spawns a fresh sub-agent session and writes that entire sub-session's wall-time + token mass back into its single result row; counting it as one normal call skews every "typical call" average. The sub-agent's INNER tool calls (own names, own session) still count.
- Evidence: `src/telemetry/aggregate-exclusions.ts`, `src/telemetry/collector.ts`, `tests/telemetry-collector.test.ts` (exclusion scenarios), `tool-metrics.md`.

## Deferred scope
- **v1.1:** multi-model + per-client routing + fallback (full LiteLLM-lite); scripting hooks; LLM-as-policy matcher; Postgres option (streaming responses + their metrics already shipped — see the tool-call metrics decision).
- **Later:** MCP tool gateway; skills (injected via `ToolProvider` port).
