# mcp-manager — Tool-call metrics (duration + tokens)

> Post-MVP addition: per-tool-call execution duration (ms) + token consumption, surfaced in `/api/stats` + dashboard. Rationale → `decisions.md`; traps → `pitfalls.md`; exact shapes → `api-reference.md`. Test baseline moved 132 → **151 tests / 0 fail**.

## What it does
For every LLM-issued tool call, record:
- **Duration (ms):** real tool-execution window — from when the call is ISSUED (response N carries `tool_calls[].id`) until its result ARRIVES (request N+1 carries the matching `role:'tool'` / Anthropic `tool_result`). Paired by `(sessionKey, toolCallId)` across successive requests of the same session.
- **Tokens:** the upstream `usage` of the turn that produced the call (OpenAI prompt/completion/total; Anthropic input/output), attached to each `tool.call`; raw payload size also exposed as `chars` on `tool.result` (no tokenizer — zero external deps).
Surfaced as per-tool aggregates + global totals via `Collector.summary()` → `GET /api/stats`, plus dashboard tiles/columns.

## Key files
- `src/telemetry/toolMetrics.ts` — NEW bounded cross-request pairing tracker. `createToolMetricsTracker({maxPending?=1000, ttlMs?=300000, now?=Date.now})` → `{ recordIssued(sessionKey, {id,at}[]); resolveResults(sessionKey, {toolCallId?,at,chars?}[]): {toolCallId,durationMs,chars?}[]; pendingCount(); reset() }`. In-memory only, NO timers; TTL+capacity enforced lazily with an injectable clock; key `${sessionKey}\u0000${id}`; `resolveResults` returns only matched ids and clamps duration to ≥0.
- `src/proxy/context.ts` — CENTRALIZED emission. `summarizeResponse` returns `{toolCalls, content, usage?}`; `emitResponseTelemetry` runs UNCONDITIONALLY at response-out on EVERY path, attaching `id`+`tokens` to each `tool.call` and calling `tracker.recordIssued`. Request-phase detects incoming tool results (both protocols) → `tracker.resolveResults` → emits a REAL per-result `tool.result` with `toolCallId`/`durationMs`/`chars`. The old SYNTHETIC single per-response `tool.result` was removed.
- `src/policy/policyStage.ts` — emits ONLY `policy.intervention` events; its own `tool.call` emission was REMOVED (prevents double-count and ensures `recordIssued` is never skipped). Do NOT re-add tool-call emission here.
- `src/telemetry/collector.ts` — aggregates per-tool `{avg,max,total}DurationMs` + global `totalDurationMs/avgDurationMs/totalInputTokens/totalOutputTokens/totalTokens`. Token sums DEDUPED per `(sessionKey, at)` turn so a multi-call turn counts once (bounded set, `maxTokenTurns?=10000`). New summary/topTools fields are OPTIONAL (omitted until data exists).
- `src/api/ws.ts` — FIXED latent bug: `encodeFrame` set the RFC6455 MASK bit on unmasked server→client frames for lengths >125 bytes (wrote `0xfe`/`0xff`); larger real `tool.call` payloads tripped it and hung the WS e2e. Now writes `0x7e`/`0x7f`.
- `src/server/index.ts` + `src/proxy/index.ts` — ONE shared tracker instantiated in `createProxyHandler`, exposed non-enumerable on `.telemetry.tracker` and `McmServerHandle.tracker`. Same-protocol streaming paths feed the tracker via `src/telemetry/stream-extract.ts`.
- `dashboard/*` — top-tools table gained Avg(ms)/Max(ms) columns; new tiles: total/input/output tokens + total/avg duration (`fmtOpt` renders `—` when a field is absent early-run).

## Business rules / assumptions
- **Sequential-single-client** pairing: duration relies on per-session request ordering (consistent with the existing "last request" session-key design). Concurrent multi-client traffic sharing one session key may mis-pair issue/result.
- Tokens = real upstream usage aggregated at TURN level (deduped), NOT fabricated per-tool splits; each `tool.call` carries the turn's usage. `chars` is raw payload size (best-effort, not token-accurate — no dependency budget for a tokenizer).
- A call whose result never arrives (blocked/loop/stopped client) contributes to `totalCalls`/top-tools but yields NO `tool.result`/duration until its result is seen (or the pending entry ages out via TTL/cap).
- Anthropic-NATIVE streaming is out of scope (the OpenAI-shaped stream extractor can't parse it); same-protocol streaming paths DO feed the tracker.

## Tests
New/updated: `tests/tool-metrics.test.ts` (tracker, 10 cases incl. TTL sweep + capacity eviction); `tests/telemetry-collector.test.ts` (token dedup + duration aggregation); `tests/e2e-integration.test.ts` (DEFAULT path: two successive same-session requests → one call(id+tokens) + one real result(durationMs>0)); `tests/e2e-policy.test.ts` Scenario 3 (POLICY path: same); `tests/policy-stage-events.test.ts` (stage emits no tool.call); `tests/ws.test.ts` (large-frame mask regression). Total **151 tests**.
