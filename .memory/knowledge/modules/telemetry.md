---
name: telemetry
description: The telemetry module (src/telemetry): shared event bus, event types and producers, collector aggregation, tool-metrics tracker, token estimates, and tool-result store. Read when adding or changing events, metrics, or stats.
---
# Module: telemetry (`src/telemetry/`)

Snapshot: 9a2fbb5b684093c9197a81929d7741a91c9718ec. Coverage: partial — bus, collector handler, SSE extractor emit sites read by grep/body; tracker, token helpers, tool-result store overview only.

## Scope
- Owns: event bus, event type union, collector aggregation, pending tool-call tracker, token estimates, tool-result store (in-memory with optional persistence).
- Consumers: WebSocket server and REST stats/events (`src/api/`), dashboard.

## Critical objects
| Symbol | Path | Responsibility |
|---|---|---|
| `createEventBus` | src/telemetry/event-bus.ts | Set of handlers; each handler's sync throw and async rejection swallowed |
| `createCollector` | src/telemetry/collector.ts | One bus subscriber; retains raw events in ring (`maxRecent`), aggregates per tool, excludes configured tools from aggregates only |
| `createToolMetricsTracker` | src/telemetry/toolMetrics.ts | In-memory pending-call map (TTL, max pending) |
| token helpers | src/telemetry/tokenEstimate.ts | Pure functions: `estimateCallTokens`, `estimateInputTokens`, `estimateOutputTokens`, `estimateTokensFromChars`, `estimateTurnUsage` |
| `TelemetryEvent` union | src/telemetry/events.ts | `tool.call`, `tool.result`, `turn.usage`, `policy.intervention` |
| `createSseToolCallExtractor` | src/telemetry/stream-extract.ts | Emits `tool.call` and `turn.usage` from SSE |
| `createToolResultStore` | src/telemetry/toolResultStore.ts | In-memory map; fire-and-forget persist via `safePersist` (try/catch) |
| `createSqliteToolResultPersister` | src/telemetry/sqliteToolResultPersister.ts | Write-through SQLite persister; wired only when `TOOL_RESULTS_ENABLED` |

## Event flow
1. Producers: `createSseToolCallExtractor` (`tool.call`, `turn.usage`); proxy context (`tool.result`, enclosing symbol unverified); policy stage (`policy.intervention`).
2. `createEventBus.emit` dispatches to every subscriber, each isolated.
3. Subscribers: collector (aggregates all types); WebSocket server (`src/api/ws.ts::createWsServer`) broadcasts every event as a text frame with no buffering.

## Change recipe — add an event type
1. Add the variant to the `TelemetryEvent` union in `src/telemetry/events.ts`.
2. Emit from the producer through the injected bus (not a direct import of the bus).
3. Handle in `createCollector` if it must be aggregated; WS forwards all events automatically.
4. Verify: `tests/proxy-telemetry.test.ts`, `tests/policy-stage-events.test.ts`.

## Unknowns
## Resolved
- Tool-metrics tracker: not subscribed to the bus. Its `recordIssued` is called only from `src/telemetry/stream-extract.ts::createSseToolCallExtractor` (`emitCallAt`). `resolveResults` has no non-test caller found, so pending-result resolution is effectively unwired in production code.
- `createSqliteStorage` `recordToolCall` / `recordIntervention`: no non-test callers; only referenced in `tests/storage.test.ts`.
- The bus subscriber set in `src/proxy/index.ts::createProxyHandler` does not reference the tracker.
