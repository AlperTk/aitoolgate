/**
 * In-memory telemetry aggregator (slice 6b of telemetry/storage).
 *
 * Subscribes to a {@link TelemetryEventBus} and maintains live aggregates over
 * the event stream: total tool-call count, per-tool counts, a top-tools
 * ranking, a bounded newest-first intervention log, plus result/session
 * counters. Query methods expose these for the live dashboard. Purely
 * in-memory: no timers, no I/O, no persistence; {@link Collector.dispose} is
 * what detaches the view from its bus.
 */
import { createEventBus } from './event-bus';
import type { TelemetryEventBus } from './event-bus';
import type { InterventionEvent, TelemetryEvent } from './events';

/** A ranked entry in the top-tools list. */
export interface TopTool {
  /** The tool name. */
  toolName: string;
  /** How many times it was called. */
  count: number;
}

/** Options for {@link createCollector}. */
export interface CollectorOptions {
  /** The bus to subscribe to. Defaults to a fresh {@link createEventBus}. */
  bus?: TelemetryEventBus;
  /** Max intervention events to retain (newest kept); oldest beyond this evicted. Default 500. */
  maxInterventions?: number;
}

/** A snapshot of all current aggregates. */
export interface CollectorSummary {
  /** Count of `tool.call` events observed. */
  totalCalls: number;
  /** Count of `tool.result` events observed. */
  totalResults: number;
  /** Ranked tool calls (descending by count; ties alphabetical). */
  topTools: TopTool[];
  /** Retained intervention events, newest-first. */
  interventions: InterventionEvent[];
}

/** A live in-memory aggregation view over a telemetry event bus. */
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
  /** Tool calls ranked descending by count (ties alphabetical); all when n omitted. */
  getTopTools(n?: number): TopTool[];
  /** Retained intervention events, newest-first, capped at `limit`. */
  getInterventions(limit?: number): InterventionEvent[];
  /** A snapshot of all current aggregates. */
  summary(): CollectorSummary;
  /** Clear all aggregates (does not unsubscribe). */
  reset(): void;
  /** Unsubscribe from the bus; no further updates after this call. */
  dispose(): void;
}

/** Default retention cap for the intervention log. */
const DEFAULT_MAX_INTERVENTIONS = 500;

/** Create an in-memory {@link Collector} subscribed to a telemetry event bus. */
export function createCollector(options: CollectorOptions = {}): Collector {
  const bus = options.bus ?? createEventBus();
  const maxInterventions = options.maxInterventions ?? DEFAULT_MAX_INTERVENTIONS;

  let totalCalls = 0;
  let totalResults = 0;
  const perTool = new Map<string, number>();
  const perSession = new Map<string, number>();
  // Newest-first: index 0 is the most recent retained event.
  const interventions: InterventionEvent[] = [];

  const handler: (event: TelemetryEvent) => void = (event) => {
    switch (event.type) {
      case 'tool.call':
        totalCalls += 1;
        perTool.set(event.toolName, (perTool.get(event.toolName) ?? 0) + 1);
        perSession.set(event.sessionKey, (perSession.get(event.sessionKey) ?? 0) + 1);
        break;
      case 'tool.result':
        totalResults += 1;
        break;
      case 'policy.intervention':
        interventions.unshift(event);
        if (interventions.length > maxInterventions) {
          interventions.length = maxInterventions;
        }
        break;
      default:
        // Unknown event type: ignore safely.
        break;
    }
  };

  const unsubscribe = bus.subscribe(handler);

  const getTopTools = (n?: number): TopTool[] => {
    const ranked = [...perTool.entries()]
      .map(([toolName, count]) => ({ toolName, count }))
      .sort(
        (a, b) =>
          (b.count - a.count) ||
          (a.toolName === b.toolName ? 0 : a.toolName < b.toolName ? -1 : 1),
      );
    return n === undefined ? ranked : ranked.slice(0, Math.max(0, n));
  };

  const getInterventions = (limit?: number): InterventionEvent[] =>
    limit === undefined
      ? interventions.slice()
      : interventions.slice(0, Math.max(0, limit));

  const summary = (): CollectorSummary => ({
    totalCalls,
    totalResults,
    topTools: getTopTools(),
    interventions: getInterventions(),
  });

  const reset = (): void => {
    totalCalls = 0;
    totalResults = 0;
    perTool.clear();
    perSession.clear();
    interventions.length = 0;
  };

  const dispose = (): void => {
    unsubscribe();
  };

  return {
    get totalCalls(): number {
      return totalCalls;
    },
    get totalResults(): number {
      return totalResults;
    },
    get perTool(): ReadonlyMap<string, number> {
      return perTool;
    },
    get perSession(): ReadonlyMap<string, number> {
      return perSession;
    },
    get interventions(): readonly InterventionEvent[] {
      return interventions;
    },
    getTopTools,
    getInterventions,
    summary,
    reset,
    dispose,
  };
}
