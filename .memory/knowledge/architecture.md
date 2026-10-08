---
name: architecture
description: Module responsibilities, request/event/tool-result data flows, external systems, entry points, and key architectural decisions in mcp-manager. Read when you need to understand how components fit together or where a change belongs.
---

# Architecture

## Style
Layered **hexagonal / ports-and-adapters** monolith. Framework-agnostic contracts live in `src/ports/` (`domain`, `pipeline`, `strategy`, `storage`, `event-bus`). Implementation modules depend on those ports (not on each other), and `createXxx(...)` composition factories wire everything together in the single server entry point. The server is the **only composition root**.

## Modules (one-line responsibility)
- `src/server/index.ts` — **composition root**: `createServer()` boots config→telemetry→proxy→rule-store→REST→static dashboard→WS; returns an `http.Server` with a non-enumerable `.mcm` handle (`bus, collector, tracker, storage?, ruleStore, toolResultStore, toolResultPersister?, apiHandler, ws`). Auto-starts only when run as main.
- `src/proxy/` — forwarding + protocol translation. `index.ts` = `createProxyHandler()` (protocol router + `SessionTokenPipeline`, exposes `.use()`); `openai.ts`/`anthropic.ts` = per-protocol route handlers; `context.ts` = `buildRequestContext()`, `runThroughPipeline()`, rehydration, `emitResponseTelemetry()` (per-call `tool.call` + whole-turn `turn.usage`), tool-result pairing (largest file); `translate.ts` = centralized OpenAI↔Anthropic conversion; `upstream.ts` = forwards to the single upstream (JSON/SSE).
- `src/policy/` — rule engine + matchers + actions + feedback. `ruleEngine.ts` (`createRuleEngine`, `PolicyRule`/`PolicyAction`, built-in `flagshipLoopRule`); `policyStage.ts` (`createPolicyStage` mounts the engine as a pipeline stage); `matchers/` (toolName, argPattern, loopDetector, always + `normalize.ts`); `actions/` (block, hideTool, injectMessage, rewriteArgs); `feedbackStore.ts` (`SessionFeedbackStore`).
- `src/telemetry/` — event emission + metrics. `event-bus.ts` (`TelemetryEventBus`), `collector.ts` (`createCollector`: total + per-tool duration/token/response-token aggregates + whole-turn token totals), `toolMetrics.ts` (`createToolMetricsTracker`), `events.ts` (event types, incl. whole-turn `turn.usage`), `stream-extract.ts` (SSE tool-call extraction + final `turn.usage` at stream end), `tokenEstimate.ts` (dependency-free char-based token estimation; fallback when upstream reports no usage), `toolResultStore.ts` (in-memory raw values + `ToolResultPersister` port), `sqliteToolResultPersister.ts` (optional SQLite drain), `aggregate-exclusions.ts`.
- `src/api/` — control-plane HTTP + WS. `http.ts` (`createApiHandler`: REST rule CRUD/stats/events/tool-result fetch; `readJSONBody` is the only throwing handler); `ruleStore.ts` (in-memory `RuleStore`); `persistentRuleStore.ts` (write-through SQLite wrapper); `ruleSpec.ts` (RuleSpec shape/validation); `ws.ts` (`createWsServer`, RFC6455).
- `src/session/` — `deriveSessionKey()` + per-session state/token.
- `src/pipeline/index.ts` — `DefaultPipeline`/`createPipeline()` base over the ports contract.
- `src/storage/` — `sqlite.ts` (`SqliteStorage`/`createSqliteStorage`) + `schema.ts` (migrations).
- `config/config.ts` — `loadConfig()` reads env vars + defaults.
- `dashboard/` — static vanilla-JS real-time UI served on the app port.

## Request flow
```
Client (OpenAI or Anthropic endpoint)
   │  node:http
   ▼
createProxyHandler route (openai.ts / anthropic.ts)
   ▼
buildRequestContext (context.ts): parse body, derive SessionKey, model/client config
   ▼
runThroughPipeline: [session-token stage] → [policy stage]
      policy stage: drain+splice per-session feedback → evaluate rules (all enabled, by priority)
                    → apply effects (hide/block/rewrite/inject) → emit InterventionEvent
   ▼
translate to upstream protocol if needed (translate.ts)
   ▼
forward to upstream (upstream.ts) — buffered JSON  OR  SSE pipe (same-protocol stream bypasses buffer)
   ▼
response stages → rehydrate to client protocol → emit tool-call/result telemetry (centralized, safeEmit)
   ▼
send JSON/SSE back to client
```

## Event flow
```
Producers (proxy / policy stage / SSE extractor)
   │  safeEmit (never throws into request path)
   ▼
TelemetryEventBus (createEventBus)  [sync dispatch, each handler isolated]
   ├── Collector          → storage (SQLite, opt-in)  +  /api/stats, /api/events
   ├── ToolMetricsTracker → per-tool duration/token metrics
   └── ws.ts broadcast    → dashboard live view (raw TelemetryEvent JSON frames)
```

## Tool-result value (on-demand drill-down)
The WS `ToolResultEvent` stays **metadata-only** (`ok`/`durationMs`/`chars`/tokens). Raw result **values** are captured out-of-band at `resolveAndEmitToolResults` into an in-memory `toolResultStore` (bounded, key = tool-call id), served by `GET /api/tool-results/:id` (memory-first, then optional DB fallback). When `config.toolResults.enabled` is on, an async batched SQLite drain persists them (default off) so the hot path never does synchronous disk I/O.

## Entry points
- **HTTP:** `GET /health`; OpenAI `GET /v1/models`, `POST /v1/chat/completions`; Anthropic `POST /v1/messages`; REST `GET /api/stats|events|rules`, `POST /api/rules`, `PATCH/DELETE /api/rules/:id`, `GET /api/tool-results/:id`; static `dashboard/`.
- **WebSocket:** HTTP `upgrade` (conventionally `/ws`) → broadcasts each `TelemetryEvent` as a JSON frame; client text frame → `{ "echo": ... }`.
- **Auto-start:** `createServer()` runs only when `require.main === module`.
- Server handler dispatch precedence: `/health` → `/api/*` → static dashboard → proxy routes → 404; errors → 500.

## Key decisions (with rationale)
1. **Zero runtime dependencies** (Node stdlib only: `node:http`, `node:sqlite`, hand-written WebSocket). Rationale: portable single-host tool with a minimal supply chain. Cost: hand-rolled RFC6455 + reliance on Node's built-in SQLite.
2. **Hexagonal + `createXxx` composition factories; single composition root (server).** Rationale: decoupling + testability; every subsystem is built from ports and injected.
3. **Non-throwing domain/proxy ops** (return `null`/`undefined` for not-found/no-match); only `readJSONBody` throws. Rationale: keeps the request hot path simple and total.
4. **Telemetry never breaks a request** — all emission via `safeEmit` (try/catch + swallow) and isolated bus handlers. A telemetry failure must not fail an LLM call.
5. **Centralized protocol translation** in `translate.ts` (request + response rehydration). Don't scatter conversion logic.
6. **Heavy tool-result values stored out-of-band** (in-memory keyed by id + optional async batched SQLite) rather than inline in events/WS frames. Rationale: bounded memory, uncluttered broadcasts, OCP/DIP behind a port gated by config (default off).
7. **Rules read live via a getter** so REST-posted rules take effect without restart; the built-in `flagship-loop-rule` is **never persisted**; write-through persistence is best-effort with an in-memory fallback.
8. **Two separate DB files:** `data/rules.db` (rules, events, tool_calls, interventions) vs `data/tool-results.db` (heavy tool_results, gated off-by-default).
9. **Whole-turn token accounting** — per-turn token mass = upstream-reported usage when present, else an ESTIMATE over all message content via dependency-free `telemetry/tokenEstimate.ts` (~4 chars/token), emitted as ONE whole-turn `turn.usage` event shared by every event of the turn. Rationale: usage-less turns still account for honest token mass instead of none. See domain.md for the per-turn dedup key and the omit-don't-fabricate rule.

## External systems
| System | Purpose |
|---|---|
| Upstream model API (OpenAI/Anthropic) | Single target all traffic forwards to (`config.upstream`). |
| SQLite (`node:sqlite`) | Opt-in persistence of rules/events/tool metrics; optional tool-result values. |
| Dashboard browser client | Real-time viewing of sessions, tool calls, interventions. |
