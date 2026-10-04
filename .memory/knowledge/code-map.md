# Code Map

> Navigate by "where would I change X?". Format: `symbol` — one-line role.

## `src/ports/` — Framework-agnostic contracts (core abstractions)
Everything else depends on these; changing behavior here ripples downstream.
- `domain.ts` — `Rule`, `ToolCall`, `ToolResult`, `ClientConfig`, `ModelConfig`, `SessionKey`.
- `pipeline.ts` — `Pipeline`, `RequestContext`, `ResponseContext`, stage interface (`handleRequest`/`handleResponse`/`onResult`/`use`).
- `strategy.ts` — `Matcher`, `Action`, `PolicyContext` (policy contract).
- `storage.ts` — storage port (persistence contract).
- `index.ts` — barrel re-export.

## `src/server/` — Composition root / entry point
- `index.ts` — `createServer()` (wires config + telemetry + proxy + api + dashboard + ws; returns `.mcm` test handle), `resolveDashboardDir()`, `resolveDashboardAsset()`, `serveStaticFile()`.

## `src/proxy/` — Forwarding + translation + context
- `index.ts` — `createProxyHandler()`, `SessionTokenPipeline` (`.use()` stage mount point), `ProxyOptions`, `readStringHeader()`.
- `context.ts` — `buildRequestContext()`, `runThroughPipeline()`, `emitResponseTelemetry()`, `syncResponseBody()`, `resolveAndEmitToolResults()`, `extractIncomingToolResults()`, `safeEmit()`, `detectResponseProtocol()`, `rehydrate{OpenAI,Anthropic}Response()`, `sessionKeyFromHeaders()`, `readJSONBody()`, `sendJSON()`. **Largest file in the proxy — per-request orchestration lives here.**
- `translate.ts` — `openaiToAnthropicRequest()` + response translation/rehydration (centralized protocol translation).
- `upstream.ts` — `forwardOpenAIRequest()`, `forwardAnthropicRequest()`, `streamToEndpoint()`, `pipeUpstreamStream()`, `streamOpenAIRequest()`.
- `openai.ts` — `handleOpenAIRoute()`, `modelListResponse()`, `isStreamRequest()`, `streamSameProtocol()`, `ensureStreamUsage()`.
- `anthropic.ts` — `handleAnthropicRoute()`, `streamSameProtocol()`, `isStreamRequest()`.

## `src/policy/` — Rule engine, matchers, actions
- `ruleEngine.ts` — `createRuleEngine()`, `PolicyRule`, `PolicyAction`, `RuleEvaluationResult`, `flagshipLoopRule()` (built-in default loop rule).
- `policyStage.ts` — `createPolicyStage()` (mounts rule engine as a pipeline stage).
- `feedbackStore.ts` — `SessionFeedbackStore`, `FeedbackMessage`.
- `normalize.ts` — `normalizeParams()` (consistent matching).
- `types.ts` — `PolicyMatcher`, `Match`, policy types.
- `matchers/` —
  - `loopDetector.ts` — `createLoopDetector()`, `signature()`, `extractPairs()`, `pairsFromContext()`.
  - `argPattern.ts` — `createArgPatternMatcher()`.
  - `toolName.ts` — `createToolNameMatcher()`.
  - `index.ts` — matcher barrel.
- `actions/` —
  - `block.ts` — `createBlockAction()`, `ActionEffect`, `buildMessage()`, `extractFromContext()`.
  - `hideTool.ts` — `createHideToolAction()`, `HideToolActionConfig`.
  - `injectMessage.ts` — `createInjectMessageAction()`, `InjectMessageActionConfig`.
  - `rewriteArgs.ts` — `createRewriteArgsAction()`, `RewriteArgsActionConfig`, `extractCalls()`, `parseArgs()`.
  - `index.ts` — action barrel.

## `src/telemetry/` — Event emission & metrics
- `event-bus.ts` — `TelemetryEventBus`, `createEventBus()`.
- `collector.ts` — `createCollector()` (events → storage).
- `toolMetrics.ts` — `createToolMetricsTracker()`, `.recordIssued()`.
- `events.ts` — `TelemetryEvent`, `ToolCallEvent`, `InterventionEvent`.
- `stream-extract.ts` — `createSseToolCallExtractor()`, `normalizeStreamUsage()`, `mergeUsage()`, `stableStreamCallId()`.

## `src/api/` — REST + WebSocket control plane
- `http.ts` — `createApiHandler()` (REST rule CRUD), `readJSONBody()` (only throwing handler).
- `ruleStore.ts` — in-memory `RuleStore`.
- `ruleSpec.ts` — rule spec shape/validation.
- `ws.ts` — `createWsServer()`, `IncomingFrame`.

## `src/session/`
- `session.ts` — `deriveSessionKey()`, `Message`; per-session state/token.

## `src/pipeline/`
- `index.ts` — `DefaultPipeline`, `createPipeline()` (base pipeline over ports; passthrough default).

## `src/storage/`
- `sqlite.ts` — `SqliteStorage` (node:sqlite `DatabaseSync` impl of the storage port).
- `schema.ts` — table/migration schema, `createDataTable()`.

## `config/`
- `config.ts` — `loadConfig()` (env vars + defaults: top-level `port`, nested `upstream.*`).

## `dashboard/`
- `index.html` — inlined dashboard view incl. `#stream-head`; `app.js` — boot/composition root.
- `js/layout.mjs` — fragment mounting (FRAGMENTS = header + rules only).
- `js/table.mjs` — `createDataTable()` widget (Top Tools / rules tables).
- `js/live-view.mjs` — real-time session/tool/intervention view (`storeInterventionForDrillDown()`, `normalizeStreamHead()`).
- `js/stats.mjs` — stats panel columns (avg column renders integers via `fmtOpt`).
- `js/dom.mjs` — `$` (getElementById), `el()`, `fmtOpt()`.
- `js/ingest.mjs` — event ingestion (`ingestEvent()`).
- `css/styles.css` — entry; `@import`s `css/{tokens,base,layout,components,rules,controls,table,responsive}.css` in that order.
- `css/tokens.css` — all design tokens: colors, type ramp (`--fs-*`, `--fw-*`, `--lh-*`), status tones (`--c-st-ok/pending/error/amber`), scroll (`--scroll-thumb(-hover)`).
- `css/components.css` — badges/pills; shared stream grid column rule (`.stream-head, .row-main`).
- `css/responsive.css` — viewport-fit layout block for ≥961px.
- `html/header.html`, `html/rules-view.html` — mounted fragments; `html/dashboard-view.html` — dead reference copy of the inlined view.

## `tests/`
- Run against compiled JS in `dist/`. Representative suites: `server-integration.test.ts`, `e2e-integration.test.ts`, `e2e-policy.test.ts`, `proxy.test.ts`, `rule-engine.test.ts`, `policy-stage.test.ts`, `policy-matchers.test.ts`, `feedback-store.test.ts`, `storage.test.ts`, `telemetry*.test.ts`, `ws.test.ts`, `http-api.test.ts`, `health.test.ts`, `dashboard-ws-url.test.ts`. Integration/e2e markers: `*-integration.test.ts`, `e2e-*.test.ts`.

## `dist/` — generated (ignore)

## Important Flows

### Proxied LLM request
```
createProxyHandler (proxy/index.ts)
    ↓  route by protocol
openai.ts / anthropic.ts
    ↓
buildRequestContext → runThroughPipeline (proxy/context.ts)
    ├── SessionTokenPipeline (session token)
    └── PolicyStage (policy/policyStage.ts)
          ↓ createRuleEngine (ruleEngine.ts)
        matchers/* → actions/* (block/hide/inject/rewrite)
    ↓
translate.ts (OpenAI↔Anthropic)
    ↓
upstream.ts → upstream model (JSON or SSE pipe)
    ↓
response stages → rehydrate → emitResponseTelemetry (safeEmit) → sendJSON/SSE
```

### Rule CRUD (control plane)
```
createApiHandler (api/http.ts)
    ↓ readJSONBody
RuleStore (api/ruleStore.ts)   [in-memory]
    ↓ spec validation
ruleSpec.ts
```

### Telemetry
```
proxy/policy producers --safeEmit--> TelemetryEventBus (event-bus.ts)
    ├── createCollector --> SqliteStorage (opt-in)
    ├── createToolMetricsTracker
    └── ws broadcast --> dashboard
```
