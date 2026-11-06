---
name: policy-and-telemetry
description: Policy rule matchers/actions, live rule and provider stores, and telemetry/tool-metric data flow in aitoolgate, verified from committed src and tests at HEAD.
---

# Policy engine and telemetry

Domain area memory. For module boundaries see [architecture](architecture.md).

## Policy rules

- Rule shape (README): `{ enabled, priority, matcher, action }`. Schemas are in `src/api/ruleSpec.ts` and `src/policy/ruleEngine.ts`.
- Matchers in `src/policy/matchers/`: `toolName.ts`, `argPattern.ts`, `loopDetector.ts`, `always.ts`. Index in `matchers/index.ts`.
- Actions in `src/policy/actions/`: `hideTool.ts`, `rewriteArgs.ts`, `injectMessage.ts`, `addDescription.ts`. Registry `ACTION_STRATEGIES` in `actions/index.ts`.
- Built-in `flagshipLoopRule` is registered at startup and is not persisted as a user rule (`src/server/index.ts` imports it from `ruleEngine.ts`).
- Rules created or edited through the dashboard or `/api/rules` apply live. The proxy reads rules through a getter, so no restart is needed (`src/proxy/index.ts` `PolicyOptions.rules`).
- `src/policy/normalize.ts` normalizes tool names and args before matching. Tests: `tests/policy/normalize.test.ts`.
- Per-session feedback queue (`src/policy/feedbackStore.ts`) carries response-side actions into the next request.

## Telemetry flow

- `src/telemetry/event-bus.ts`: synchronous in-memory bus. `subscribe` returns an unsubscribe function. `emit` returns a Promise.
- Events are typed in `src/telemetry/events.ts` (`ToolCallEvent`, `InterventionEvent`).
- `src/telemetry/collector.ts` aggregates live stats for `/api/stats`.
- `src/telemetry/toolMetrics.ts` pairs issued tool calls with later results to compute durations.
- `src/telemetry/stream-extract.ts` extracts tool calls from SSE frames (`sse-frames.ts`). `protocol-common.ts` is shared across protocols.
- `src/telemetry/tokenEstimate.ts`: uses provider-reported usage when present, else a character-based estimate. Per-tool token totals are attributed per turn, not per execution (README).
- `src/telemetry/aggregate-exclusions.ts` controls which events are excluded from aggregates.
- Large raw results go to `toolResultStore.ts` and `sqliteToolResultPersister.ts`, batched by `TOOL_RESULTS_FLUSH_MS` and `TOOL_RESULTS_BATCH_SIZE`.

## Verification pointers

- `tests/policy/` (rule-engine, policy-matchers, policy-stage, hide-tool-patterns, add-description-action, feedback-store).
- `tests/telemetry/` (telemetry-collector, tool-metrics, tool-result-store, sqlite-tool-result-persister, tool-error-patterns).
- `tests/e2e/e2e-policy.test.ts`, `e2e-hideTool.test.ts`, `e2e-always-match.test.ts`, `e2e-actions.test.ts`.
