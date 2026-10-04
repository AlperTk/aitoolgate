# Architecture

## Style
Layered **hexagonal / ports-and-adapters** monolith. Framework-agnostic contracts live in `src/ports/`; implementation modules depend on those ports, and `createXxx(...)` composition factories wire everything together in the single server entry point.

## Main Components

### `src/server/` — Composition root
- `createServer()` boots the whole process: loads config, constructs telemetry (event bus + collector + tool-metrics tracker), proxy handler, rule store, REST API handler, dashboard static server, and WebSocket server; returns a non-enumerable `.mcm` handle for tests. Auto-starts only when run as main.

### `src/proxy/` — Forwarding + translation
- `index.ts` — `createProxyHandler()` builds the protocol router + `SessionTokenPipeline` wrapper (exposes `.use()` to mount stages).
- `openai.ts` / `anthropic.ts` — per-protocol route handlers (`handleOpenAIRoute`, `handleAnthropicRoute`, `streamSameProtocol`, `modelListResponse`).
- `context.ts` — `buildRequestContext()`, `runThroughPipeline()` (runs request/response through stages), translate/rehydrate bodies, `emitResponseTelemetry()`, tool-result pairing (`resolveAndEmitToolResults`). Largest file in the proxy.
- `translate.ts` — centralized bidirectional OpenAI↔Anthropic translation (`openaiToAnthropicRequest` + response rehydration).
- `upstream.ts` — forwards to the configured upstream model (`forwardOpenAIRequest`, `forwardAnthropicRequest`, `streamToEndpoint`, `pipeUpstreamStream`).

### `src/policy/` — Rule engine & actions
- `ruleEngine.ts` — `createRuleEngine()` evaluates rules against a `PolicyContext` → `RuleEvaluationResult`; defines `PolicyRule`/`PolicyAction` and built-in `flagshipLoopRule()`.
- `policyStage.ts` — `createPolicyStage()` mounts the rule engine as a pipeline stage.
- `matchers/` — `loopDetector` (repeated tool-call loops via `signature`/`extractPairs`), `argPattern`, `toolName`; `normalize.ts` for consistent matching.
- `actions/` — `block`, `hideTool`, `injectMessage`, `rewriteArgs` (each `createXxxAction()`).
- `feedbackStore.ts` — `SessionFeedbackStore` persists injected corrective messages per session for drill-down.

### `src/telemetry/` — Event emission & metrics
- `event-bus.ts` — `TelemetryEventBus` (`createEventBus`). Emission guarded by `safeEmit` so it never breaks the request flow.
- `collector.ts` — `createCollector()` consumes events into storage.
- `toolMetrics.ts` — `createToolMetricsTracker()` aggregates per-tool metrics.
- `events.ts` — event type defs (`TelemetryEvent`, `ToolCallEvent`, `InterventionEvent`).
- `stream-extract.ts` — extracts tool calls + usage from SSE streams.

### `src/api/` — Control-plane HTTP
- `http.ts` — `createApiHandler()`: REST rule CRUD; `readJSONBody` is the only throwing handler.
- `ruleStore.ts` — in-memory `RuleStore`.
- `ruleSpec.ts` — rule spec shape/validation.
- `ws.ts` — `createWsServer()` live WebSocket feed (`IncomingFrame`).

### `src/session/`, `src/pipeline/`, `src/storage/`, `config/`
- `session/session.ts` — `deriveSessionKey()`, per-session state/token.
- `pipeline/index.ts` — `DefaultPipeline` / `createPipeline()` base pipeline over the ports contract.
- `storage/sqlite.ts` + `schema.ts` — SQLite persistence + table/migration schema (`createDataTable`).
- `config/config.ts` — `loadConfig()` reads env vars + defaults (top-level `port`, nested `upstream.*`).

### `dashboard/`
- Static real-time web UI (vanilla JS `.mjs`), served from disk on the app port (`http://localhost:8787/`), driven by REST + WebSocket; consumes intervention/tool events for drill-down views.
- DOM composition: `app.js` is the boot/composition root. `js/layout.mjs` FRAGMENTS mounts only `html/header.html` + `html/rules-view.html` — the dashboard view is **inlined directly in `index.html`** (`html/dashboard-view.html` is a dead reference copy, not mounted). `normalizeStreamHead()` self-heals the stream table header at boot.
- CSS layering: `css/styles.css` aggregates via `@import` in order: tokens → base → layout → components → rules → controls → table → responsive. Import order matters: later sheets win at equal specificity.

## Main Request Flow
```
Client (OpenAI or Anthropic endpoint)
    ↓  node:http
createProxyHandler route (openai.ts / anthropic.ts)
    ↓
buildRequestContext (context.ts) — parse body, derive SessionKey, model/client config
    ↓
runThroughPipeline (stages: policy stage on request, session-token stage)
    ├── PolicyStage → createRuleEngine → matchers → actions
    │      (may mutate messages / set feedback / emit InterventionEvent)
    ↓
translate to upstream protocol if needed (translate.ts)
    ↓
forward to upstream (upstream.ts) — JSON or SSE pipe
    ↓
response: run response stages → rehydrate to client protocol → sync body
    ↓
emit telemetry (response / ToolCallEvent / usage) via safeEmit
    ↓
stream JSON back to client (sendJSON / SSE)
```

## Event Flow
```
Proxy / Policy / Telemetry producers
    ↓  (safeEmit)
TelemetryEventBus (createEventBus)
    ├── Collector → storage (SQLite, opt-in)
    ├── ToolMetricsTracker → per-tool metrics
    └── ws.ts broadcast → dashboard live view (SSE/WebSocket)
```

## External Dependencies
| System | Purpose |
|---|---|
| Upstream model API (OpenAI/Anthropic) | Single LLM target all traffic forwards to |
| SQLite (`node:sqlite`) | Opt-in persistence of rules/events/tool metrics |
| Dashboard browser client | Real-time viewing of sessions, tool calls, interventions |
