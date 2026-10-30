---
name: architecture
description: System boundaries, module dependency direction, composition root, request/event flows, and persistence boundaries of aitoolgate. Read before any cross-module change or when adding a new component.
---
# Architecture

Snapshot: 9a2fbb5b684093c9197a81929d7741a91c9718ec. Coverage: partial (see `_sync.md`).

## Style
Hexagonal single-process app. Framework-independent contracts live in `src/ports/`; implementations live in feature directories and are wired in one place.

## Composition root
- `src/server/index.ts::createServer(port?, options?, mount?)` is the only composition root and returns `AtgServer`.
- Startup order (observed): `loadConfig` → telemetry bus, collector, tool-metrics tracker → optional SQLite tool-result persister → `toolResultStore` → `ruleStore` (in-memory or SQLite) → `buildUpstreamRef` → `apiProviderStore` (+ seed) → `applyActiveProvider` → `policyStage` → `createProxyHandler` → `createApiHandler` → `createHttpRouter` → optional WebSocket server → `listen`.
- Default DI component set: `src/composition.ts::defaultProxyDefaults` (typed `ProxyDefaults`, declared in `src/ports/telemetry.ts`). It supplies `makeBus`, `makeCollector`, `makeTracker`, `makePolicyStage`, `makeSseExtractor`, `usage`, `toolErrorPatterns`. The proxy receives these through `defaults:`, not by direct import.

## Ports (contracts) — `src/ports/`
| File | Main contracts |
|---|---|
| auth.ts | `AuthStrategy`, `AuthCredentials` |
| domain.ts | `ClientConfig`, `ModelConfig`, `PolicyEvent`, `Rule`, `SessionKey`, `ToolCall`, `ToolResult` |
| pipeline.ts | `Pipeline`, `PipelineStage`, `RequestContext`, `ResponseContext`, `ResultContext`, `ChatMessage` |
| strategy.ts | `Action`, `Matcher`, `PolicyContext` |
| protocol.ts | `Protocol` |
| provider.ts | `ProviderAdapter`, `ProviderConfig`, `ResolvedUpstream`, `WireProtocol` |
| llm.ts | internal LLM request/response/event types |
| telemetry.ts | `TelemetryEventBus`, `Collector`, `ToolMetricsTracker`, `TelemetryStorage`, `FeedbackStore`, `ProxyDefaults` |

Known implementers (verified by find_implementations): `Protocol` → `createOpenAIChatProtocol`, `createAnthropicMessagesProtocol`; `ProviderAdapter` → `createGenericAdapter`, `createCopilotAdapter`; `AuthStrategy` → `createApiKeyAuth`, `createDeviceOAuthAuth`; `PipelineStage` → `createPolicyStage`; `Pipeline` → `DefaultPipeline` (`src/pipeline/index.ts`), `SessionTokenPipeline` (`src/proxy/index.ts`); `Action` → 4 action factories; `Matcher` → `toPortMatcher`; `TelemetryEventBus` → `createEventBus`.
Unresolved implementers: `Collector`, `ToolMetricsTracker`, `TelemetryStorage`, `FeedbackStore`.

## Request routing (`src/server/index.ts::createHttpRouter`)
Order: `/health` → REST `api` handler (returns `true` when handled) → dashboard static assets (GET) → `handleProxyRequest` → 404 `not_found`. Thrown error → 500 `internal_error`.

## Main flows
1. **Proxy request** — see `modules/proxy.md`. `createProxyHandler` → `handleOpenAIRoute` / `handleAnthropicRoute` → pipeline + policy → `forwardRequest` or `streamForClient` → protocol conversion → client.
2. **Telemetry event** — producers emit to the shared bus; the collector aggregates and the WebSocket server broadcasts. See `modules/telemetry.md`.
   - Producers: `createSseToolCallExtractor` (`tool.call`, `turn.usage`), proxy context (`tool.result`), policy stage (`policy.intervention`).
   - Bus `emit` isolates each subscriber with try/catch; a failing subscriber does not break the client stream.
3. **Rule/provider management** — REST `/api/*` → stores → SQLite when configured. See `modules/api-storage.md`.

## Shared dependencies
- Telemetry bus is shared by proxy, REST API, and WebSocket server (single instance from `createServer`).
- Policy stage gets a live rules getter: `() => [flagshipRule, ...caller rules, ...ruleStore.list()]`. The flagship loop rule is spliced in at wiring time and is not persisted.
- Upstream is a single mutable ref (`buildUpstreamRef`) updated by `applyActiveProvider`.

## Persistence boundaries
- In-memory: collector ring/aggregates, tool-metrics pending map, tool-result map, default stores, WS (no buffer), feedback queues.
- SQLite (`node:sqlite`): rules and events (`src/storage/sqlite.ts`), API providers, tool results (optional persister). Migrations are the `MIGRATIONS` list in `src/storage/schema.ts` (v1–v5).

## Module directories
`server`, `proxy`, `protocols`, `providers`, `policy`, `telemetry`, `api`, `ports`, `pipeline`, `session`, `storage`, `composition.ts`, `config/config.ts`, `dashboard/` (static, excluded from TypeScript build). Module memories: `modules/proxy.md`, `modules/protocols.md`, `modules/providers.md`, `modules/policy.md`, `modules/telemetry.md`, `modules/api-storage.md`.
