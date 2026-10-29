---
name: architecture
description: Module responsibilities, request/event/tool-result data flows, external systems, entry points, and key architectural decisions in aitoolgate. Read when you need to understand how components fit together or where a change belongs.
---

# Architecture

## Style
Layered **hexagonal / ports-and-adapters** monolith. Framework-agnostic contracts live in `src/ports/` (`domain`, `pipeline`, `strategy`, `telemetry`). Implementation modules depend on those ports (not on each other), and `createXxx(...)` composition factories wire everything together in the single server entry point. The server is the **only composition root**; the proxy receives its policy stage + telemetry deps via injected port interfaces (typed in `src/ports/telemetry.ts`, concrete defaults in `src/composition.ts`) — it never imports a concrete factory.
## Modules (one-line responsibility)
- `src/server/index.ts` — **composition root**: `createServer()` boots config→telemetry→proxy→rule-store→REST→static dashboard→WS; returns an `http.Server` with a non-enumerable `.atg` handle (`bus, collector, tracker, storage?, ruleStore, toolResultStore, toolResultPersister?, apiHandler, ws`). Auto-starts only when run as main.
- `src/proxy/` — forwarding + protocol translation. `index.ts` = `createProxyHandler()` (protocol router + `SessionTokenPipeline`; receives policy stage + telemetry via injected port interfaces, defaults from `src/composition.ts`); `openai.ts`/`anthropic.ts` = per-protocol route handlers; `context.ts` = `buildRequestContext()`, `runThroughPipeline()`, `emitResponseTelemetry()` (per-call `tool.call` — per-call `tokens` only for a single-call turn, per-call `callTokens` estimate on every call — + whole-turn `turn.usage`; per-result `tokens` estimate on `tool.result`), tool-result pairing; `translate.ts` = centralized OpenAI↔Anthropic conversion + response rehydration; `upstream.ts` = forwards to the single upstream (JSON/SSE); empty `baseUrl` (unconfigured) short-circuits all paths to a **503 JSON** `UNCONFIGURED_UPSTREAM` response, no fetch attempted.
- `src/policy/` — rule engine + matchers + actions + feedback. `ruleEngine.ts` (`createRuleEngine`, `PolicyRule`/`PolicyAction`, built-in `flagshipLoopRule`); `types.ts` (`ActionStrategy`, `ActionEffectKind`, `PolicyMatcher`, `Match`, `RuleContext`); `policyStage.ts` (`createPolicyStage` mounts the engine as a pipeline stage; dispatches effects via the `ActionStrategy` registry); `matchers/` (toolName, argPattern, loopDetector, always + `normalize.ts`); `actions/` (hideTool, rewriteArgs, injectMessage, addDescription + `index.ts` defining the `ActionEffect` union and the `ACTION_STRATEGIES` registry); `feedbackStore.ts` (`SessionFeedbackStore`).
- `src/ports/telemetry.ts` — port interfaces the proxy depends on: `TelemetryEventBus`, `Collector`, `ToolMetricsTracker`, `TelemetryStorage`, `TelemetryHelpers`, `SseExtractorFactory` (optionally takes the request `raw` body, `requestRaw`, so streamed `tool.call` events carry the request-provided tool description — mirroring the buffered `context.ts` path), `FeedbackStore`, `ProxyDefaults`.
- `src/telemetry/` — event emission + metrics. `event-bus.ts` (`TelemetryEventBus`), `collector.ts` (`createCollector`: total + per-tool duration/token/cache-hit/response-token/call-token aggregates + whole-turn token totals; attributes each turn's token mass to every tool observed in the turn via the `turn.usage` handler; reuses `estimateTokensFromChars`/`estimateCallTokens` from `tokenEstimate.ts`), `toolMetrics.ts` (`createToolMetricsTracker`), `events.ts` (event types, incl. whole-turn `turn.usage`, per-call `tool.call.callTokens` and estimated `tool.result.tokens`), `stream-extract.ts` (SSE tool-call extraction; per-call `tool.call` events are emitted at stream end — NOT as each call's `index` starts — so a single-call turn carries the turn's final merged usage while a batched turn omits per-call `tokens`; final whole-turn `turn.usage` at stream end), `protocol-common.ts` (shared `parseArgs`/`stableCallId`/`normalizeUsage`/`toolDescriptionMap` + `NormalizedUsage`, reused by proxy + telemetry; `toolDescriptionMap` maps a request's `tools` array to a name→description map so `tool.call` carries the request-provided description), `tokenEstimate.ts` (dependency-free char-based token estimation incl. `estimateCallTokens` (per-call request-side estimate: name + serialized args); fallback when upstream reports no usage), `toolResultStore.ts` (in-memory raw values + `ToolResultPersister` port), `sqliteToolResultPersister.ts` (optional SQLite drain), `aggregate-exclusions.ts`.
- `src/api/` — control-plane HTTP + WS. `http.ts` (`createApiHandler`: REST rule CRUD/stats/events/tool-result fetch + `api-providers` CRUD; `readJSONBody` is the only throwing handler); `crudStore.ts` (generic `createCrudStore<T>` + `createPersistentStore<T>` base reused by the rule and provider stores); `ruleStore.ts` (in-memory `RuleStore` over the `createCrudStore` base); `persistentRuleStore.ts` (write-through SQLite wrapper over the `createPersistentStore` base); `ruleSpec.ts` (RuleSpec shape/validation; action build/validate is registry-driven via `ACTION_STRATEGIES`); `providerSpec.ts` (dependency-free `ApiProvider` wire shape + `validateProviderSpec`, mirrors `ruleSpec`); `providerStore.ts` (in-memory `ApiProviderStore` over the `createCrudStore` base, enforces ≤1 active); `persistentProviderStore.ts` (write-through SQLite-backed provider store over the `createPersistentStore` base, `node:sqlite`); `providerProbe.ts` (`probeProvider`/`parseProbeBody`: upstream model-list reachability/auth probe, never throws); `ws.ts` (`createWsServer`, RFC6455).
- `src/composition.ts` — `defaultProxyDefaults`: the concrete DI factory defaults (bus/collector/tracker/policy-stage/SSE-extractor/usage helpers) that `createProxyHandler` uses by default and that the composition root (`src/server/index.ts`) reuses to build + inject the policy stage.
- `src/providers/` — pluggable provider adapters (OCP). `registry.ts` (`PROVIDER_ADAPTERS`, `lookupProviderAdapter`, `DEFAULT_PROVIDER_ADAPTER_ID`); `generic/` (baseUrl + apiKey, today's behaviour); `copilot/` (GitHub Copilot: endpoint resolution github.com/enterprise, per-request headers incl. `x-initiator`, chat-completions only); `auth/deviceOAuth.ts` (GitHub device-code login, `authState` JSON, entitlement check). Ports in `src/ports/provider.ts` (`ProviderAdapter`, `ResolvedUpstream`, `DecorateContext`) and `src/ports/auth.ts` (`AuthStrategy`). `src/proxy/upstream.ts` gets resolved headers and an optional per-request `decorateRequest`; it never imports an adapter.
- `src/session/` — `deriveSessionKey()` + per-session state/token.
- `src/pipeline/index.ts` — `DefaultPipeline`/`createPipeline()` base over the ports contract.
- `src/storage/` — `sqlite.ts` (`SqliteStorage`/`createSqliteStorage`) + `schema.ts` (migrations; **v3** adds the `api_providers` table, `SCHEMA_VERSION=3`).
- `config/config.ts` — `loadConfig()` reads env vars + defaults.
- `dashboard/` — static vanilla-JS real-time UI served on the app port. Includes a **Settings** gear overlay (`dashboard/js/settings.mjs` + `settings-providers.mjs` for the provider section, single-run `initSettings` + a `SETTINGS_SECTIONS` registry whose only entry today is `apiProviders`; helpers `validateClientSide`/`formatProviderRow`) wired once from `app.js`; `css/settings.css` (linked **last** in `index.html`). The **live view** stream table renders `In (est)` / `Out (est)` columns as per-call ESTIMATES (`tool.call.callTokens` / paired `tool.result.tokens` — not reported usage; event semantics in domain.md) and a turn-level `Context Size` cell rendered **once on the last row** of a turn — the dashboard now consumes `turn.usage` (ingest `turn.usage` case → `applyTurnUsageToRows`). The Description column was removed (description surfaces in the row detail panel). The column set is a cross-file invariant: adding/removing a header requires updating `STREAM_HEAD_CELLS` + `normalizeStreamHead`; the sub-960px mobile view shows only 7 columns.

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
                    → apply effects (hide/rewrite/inject/add-description) → emit InterventionEvent
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

## Provider hot-apply (no restart)
Dashboard/REST → `fetch` `POST/PATCH/DELETE /api/api-providers*` → provider store mutation → `applyActiveProvider` overwrites the proxy's **stable mutable `upstreamRef`** (`baseUrl/model/protocol/apiKey`) → the next request reads the new upstream. Provider rows persist to `api_providers` (shared `rules.db`). The single-active invariant is enforced by the store, not the proxy. See domain.md / constraints.md.

## Entry points
- **HTTP:** `GET /health`; OpenAI `GET /v1/models`, `POST /v1/chat/completions`; Anthropic `POST /v1/messages`; REST `GET /api/stats|events|rules`, `POST /api/rules`, `PATCH/DELETE /api/rules/:id`, `GET /api/tool-results/:id`; **provider** `GET/POST /api/api-providers`, `POST /api/api-providers/probe`; `GET/PATCH/DELETE /api/api-providers/:id` (wired only when a provider store is attached); static `dashboard/`.
- **WebSocket:** HTTP `upgrade` (conventionally `/ws`) → broadcasts each `TelemetryEvent` as a JSON frame; client text frame → `{ "echo": ... }`.
- **Auto-start:** `createServer()` runs only when `require.main === module`.
- **npm bin:** the entry doubles as the published `bin` (`aitoolgate`; shebang lives in the source entry) — packaging details in commands.md.
- Server handler dispatch precedence: `/health` → `/api/*` → static dashboard → proxy routes → 404; errors → 500.

## Key decisions (with rationale)
1. **Node stdlib first; runtime npm packages allowed when justified** (e.g. provider SDKs; user decision 2026-10-29 relaxed the former zero-dependency rule). Existing stdlib choices stay: `node:http`, `node:sqlite`, hand-written WebSocket (RFC6455). Rationale: keep the supply chain small, but don't reject a package that clearly pays off.
2. **Hexagonal + `createXxx` composition factories; single composition root (server).** Rationale: decoupling + testability; every subsystem is built from ports and injected. The proxy depends on injected port interfaces (`src/ports/telemetry.ts`); `src/composition.ts` holds the concrete defaults; `server/index.ts` is the single composition root.
3. **Non-throwing domain/proxy ops** (return `null`/`undefined` for not-found/no-match); only `readJSONBody` throws. Rationale: keeps the request hot path simple and total.
4. **Telemetry never breaks a request** — all emission via `safeEmit` (try/catch + swallow) and isolated bus handlers. A telemetry failure must not fail an LLM call.
5. **Centralized protocol translation** in `translate.ts` (request + response rehydration). Don't scatter conversion logic.
6. **Heavy tool-result values stored out-of-band** (in-memory keyed by id + optional async batched SQLite) rather than inline in events/WS frames. Rationale: bounded memory, uncluttered broadcasts, OCP/DIP behind a port gated by config (default off).
7. **Rules read live via a getter** so REST-posted rules take effect without restart; the built-in `flagship-loop-rule` is **wired in at composition time** (priority 0, evaluated first), **never persisted** (the rule store stays clean), and is re-added on restart without a DB seed; write-through persistence is best-effort with an in-memory fallback.
8. **Two separate DB files:** `data/rules.db` (rules, events, tool_calls, interventions) vs `data/tool-results.db` (heavy tool_results, gated off-by-default).
9. **Whole-turn token accounting** — per-turn token mass = upstream-reported usage when present, else an ESTIMATE over all message content via dependency-free `telemetry/tokenEstimate.ts` (~4 chars/token), emitted as ONE whole-turn `turn.usage` event shared by every event of the turn. Rationale: usage-less turns still account for honest token mass instead of none. The turn's input is split into base `input` + cache-hit `cacheHitInput`. A **batched** turn (>1 tool calls) omits per-call `tokens` on its `tool.call` events so the turn's token mass is carried ONCE by `turn.usage` (not duplicated per call); a **single-call** turn keeps per-call `tokens`. Per-call `tool.call.callTokens` (request-side estimate, `estimateCallTokens`) and per-result `tool.result.tokens` (estimated response-payload tokens) are surfaced per row in the dashboard and aggregated per tool as `totalCallTokens` / `totalResponseTokens`; the collector attributes each turn's token mass to every tool observed in the turn (once per distinct `(turn, tool)`). See domain.md for the event shape, the per-provider mapping, and the field-aware stream-merge rule.
10. **Runtime-switchable active upstream (provider store).** The proxy forwards to a **single *active* provider** (not concurrent routing/load-balancing). Providers persist in the shared `data/rules.db` (`api_providers`, schema v3); the active one is hot-applied via a **stable mutable `upstreamRef`** passed into the proxy (per-request reads observe live changes), so switching needs **no restart**. When the caller supplies a programmatic `options.upstream`, the `createServer` seed auto-creates one active provider from it if the store is empty; otherwise the store starts **empty** and LLM routes answer **503 JSON** until a provider is added + activated (dashboard Settings or `POST /api/api-providers`). The ≤1-active invariant, key-masking, auto-first activation, and the unconfigured-503 rule live in domain.md; persistence rules in constraints.md.
11. **ActionStrategy registry (OCP for policy actions).** Each policy action contributes an `ActionStrategy` (how to apply, describe, validate, and build its effect); `src/policy/actions/index.ts` exports `ACTION_STRATEGIES` mapping every `ActionEffectKind` to its strategy. The policy stage dispatches by `effect.type` and `ruleSpec` dispatches by `spec.type` — both look up a strategy instead of switching on the kind. Adding a new action = new strategy file + one registry entry (no `policyStage`/`ruleSpec` edit).

## External systems
| System | Purpose |
|---|---|
| Upstream model API (OpenAI/Anthropic) | One *active* target all traffic forwards to (active provider, or programmatic `options.upstream`; **503 JSON** when unconfigured); multiple persisted provider configs may exist but only the active one is used (see domain.md). |
| SQLite (`node:sqlite`) | Opt-in persistence of rules/events/tool metrics + **provider configs** (`api_providers`, shared `rules.db`); optional tool-result values. |
| Dashboard browser client | Real-time viewing of sessions, tool calls, interventions. |
