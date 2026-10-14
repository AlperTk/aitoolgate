import type { Transform } from 'node:stream';
import type { PipelineStage } from './pipeline';
import type { SessionKey } from './domain';
import type { TelemetryEvent, InterventionEvent, ToolCallEvent } from '../telemetry/events';
import type { TopTool, CollectorSummary } from '../telemetry/collector';
import type { IssuedCall, ToolResultIn, ResolvedToolCall } from '../telemetry/toolMetrics';
import type { FeedbackMessage } from '../policy/feedbackStore';
import type { PolicyRule } from '../policy/ruleEngine';

/** Port contracts for the telemetry + policy abstractions the model proxy depends on; concrete impls in `src/telemetry/` / `src/policy/` structurally satisfy them. */

/** Port: an in-memory telemetry event bus (`subscribe` returns an unsubscribe fn; `emit` dispatches synchronously). */
export interface TelemetryEventBus {
  /** Subscribe a handler; returns an unsubscribe function. */
  subscribe(handler: (event: TelemetryEvent) => void | Promise<void>): () => void;
  /** Emit an event to all current subscribers (synchronous dispatch). */
  emit(event: TelemetryEvent): Promise<void>;
}

/** Port: a live in-memory aggregation view over a telemetry event bus. */
export interface Collector {
  /** Count of `tool.call` events observed. */
  readonly totalCalls: number;
  /** Count of `tool.result` events observed. */
  readonly totalResults: number;
  /** Tool-call counts keyed by tool name. */
  readonly perTool: ReadonlyMap<string, number>;
  /** Call counts keyed by session key. */
  readonly perSession: ReadonlyMap<string, number>;
  /** Retained intervention events, newest-first (bounded). */
  readonly interventions: readonly InterventionEvent[];
  /** Tool calls ranked descending by count (ties alphabetical); all when `n` omitted. */
  getTopTools(n?: number): TopTool[];
  /** Retained intervention events, newest-first, capped at `limit`. */
  getInterventions(limit?: number): InterventionEvent[];
  /** Recent raw events retained in arrival order; up to `limit` most-recent, ascending. */
  getRecentEvents(limit?: number): TelemetryEvent[];
  /** A snapshot of all current aggregates. */
  summary(): CollectorSummary;
  /** Clear all aggregates (does not unsubscribe). */
  reset(): void;
  /** Unsubscribe from the bus; no further updates after this call. */
  dispose(): void;
}

/** Port: a tool-call latency tracker pairing issued calls with their later results. */
export interface ToolMetricsTracker {
  /** Store issued calls keyed by `${sessionKey}\u0000${id}` (entries with an empty id are skipped). */
  recordIssued(sessionKey: string, issued: IssuedCall[]): void;
  /** Resolve results against pending calls, computing a clamped non-negative `durationMs`. */
  resolveResults(sessionKey: string, results: ToolResultIn[]): ResolvedToolCall[];
  /** Number of pending entries currently retained. */
  pendingCount(): number;
  /** Clear all state (and bookkeeping), returning to a clean slate. */
  reset(): void;
}

/** Port: persistence sink for telemetry events (only what the proxy writes). */
export interface TelemetryStorage {
  /** Persist a tool call event. */
  recordToolCall(evt: ToolCallEvent): void;
  /** Persist a policy intervention event. */
  recordIntervention(evt: InterventionEvent): void;
}

/** Port: timing + token-estimation helpers threaded into every request path. */
export interface TelemetryHelpers {
  /** Current time in epoch milliseconds (monotonic wall-clock by default). */
  now(): number;
  /** Best-effort INPUT token mass of a request from its full message content. */
  estimateInputTokens(messages: unknown): number;
  /** Best-effort WHOLE-turn usage (input over messages, output over content + tool calls). */
  estimateTurnUsage(
    messages: unknown,
    content?: unknown,
    toolCalls?: readonly { arguments?: unknown }[],
  ): { input: number; output: number; total: number; cacheHitInput: number };
}

/** Port: a factory building the passthrough SSE tool-call extractor `Transform`; `requestRaw` (when provided) supplies the tool description. */
export interface SseExtractorFactory {
  (
    bus: TelemetryEventBus | undefined,
    sessionKey: string,
    clientId?: string,
    tracker?: ToolMetricsTracker,
    now?: () => number,
    inputTokens?: number,
    requestRaw?: unknown,
  ): Transform;
}

/** Port: a per-session FIFO feedback queue bridging response-side actions into the next request. */
export interface FeedbackStore {
  /** Append a message to the queue for `key` (FIFO; creates the queue if absent). */
  queue(key: string | SessionKey, message: FeedbackMessage): void;
  /** Return ALL queued messages for `key` in FIFO order and remove them (`[]` if none). */
  drain(key: string | SessionKey): FeedbackMessage[];
  /** Remove every queued entry for `key`. */
  clear(key: string | SessionKey): void;
  /** True when at least one message is queued for `key`. */
  has(key: string | SessionKey): boolean;
  /** Count of queued messages for one key, or across all keys when no key is given. */
  size(key?: string | SessionKey): number;
  /** Remove every key (for tests / reset). */
  purgeAll(): void;
}

/** Port: default builders for the policy stage and telemetry wiring (no concrete factory import). */
export interface ProxyDefaults {
  /** Create a fresh telemetry event bus. */
  makeBus(): TelemetryEventBus;
  /** Create a live collector subscribed to the given bus. */
  makeCollector(bus: TelemetryEventBus): Collector;
  /** Create a fresh tool-call latency tracker. */
  makeTracker(): ToolMetricsTracker;
  /** Build a policy stage from the given rules + optional feedback, wired to the bus. */
  makePolicyStage(
    rules: PolicyRule[] | (() => PolicyRule[]),
    feedback?: FeedbackStore,
    bus?: TelemetryEventBus,
  ): PipelineStage;
  /** The SSE tool-call extractor factory (streamed pass-through telemetry). */
  makeSseExtractor: SseExtractorFactory;
  /** Timing + token-estimation helpers threaded into every request path. */
  usage: TelemetryHelpers;
  /** Optional tool-error patterns (additive to the built-in heuristic); defaults to `[]`. */
  toolErrorPatterns?: string[];
}
