/**
 * In-memory telemetry aggregator (slice 6b of telemetry/storage).
 *
 * Subscribes to a {@link TelemetryEventBus} and maintains live aggregates over
 * the event stream: total tool-call count, per-tool counts, a top-tools
 * ranking (with per-tool duration metrics), a bounded newest-first intervention
 * log, plus result/session counters and global duration/token usage totals.
 * Query methods expose these for the live dashboard. Purely in-memory: no
 * timers, no I/O, no persistence; {@link Collector.dispose} is what detaches
 * the view from its bus.
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
  /** Mean duration in ms over results reporting `durationMs`; omitted when the tool has none. */
  avgDurationMs?: number;
  /** Longest single-result duration in ms; omitted when the tool has none. */
  maxDurationMs?: number;
  /** Cumulative duration in ms across results reporting `durationMs`; omitted when the tool has none. */
  totalDurationMs?: number;
}

/** Options for {@link createCollector}. */
export interface CollectorOptions {
  /** The bus to subscribe to. Defaults to a fresh {@link createEventBus}. */
  bus?: TelemetryEventBus;
  /** Max intervention events to retain (newest kept); oldest beyond this evicted. Default 500. */
  maxInterventions?: number;
  /** Max recent raw events to retain in arrival order (oldest beyond this evicted). Default 200. */
  maxRecent?: number;
  /** Bound on distinct token-turn dedup keys retained (`${sessionKey}\u0000${at}`); oldest evicted beyond this. Default 10000. */
  maxTokenTurns?: number;
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
  /** Cumulative duration in ms across results reporting `durationMs`; omitted when none. */
  totalDurationMs?: number;
  /** Mean duration in ms across results reporting `durationMs`; omitted when none. */
  avgDurationMs?: number;
  /** Sum of `tokens.input` across distinct turns; omitted when no token usage observed. */
  totalInputTokens?: number;
  /** Sum of `tokens.output` across distinct turns; omitted when no token usage observed. */
  totalOutputTokens?: number;
  /** Sum of `tokens.total` across distinct turns; omitted when no token usage observed. */
  totalTokens?: number;
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
  /** Recent raw events retained in arrival order; up to `limit` most-recent, ascending (oldest-first), defensive copy. */
  getRecentEvents(limit?: number): TelemetryEvent[];
  /** A snapshot of all current aggregates. */
  summary(): CollectorSummary;
  /** Clear all aggregates (does not unsubscribe). */
  reset(): void;
  /** Unsubscribe from the bus; no further updates after this call. */
  dispose(): void;
}

/** Default retention cap for the intervention log. */
const DEFAULT_MAX_INTERVENTIONS = 500;

/** Default retention cap for the recent-events ring buffer. */
const DEFAULT_MAX_RECENT = 200;

/** Default bound on distinct token-turn dedup keys retained (oldest evicted beyond this). */
const DEFAULT_MAX_TOKEN_TURNS = 10000;

/** Create an in-memory {@link Collector} subscribed to a telemetry event bus. */
export function createCollector(options: CollectorOptions = {}): Collector {
  const bus = options.bus ?? createEventBus();
  const maxInterventions = options.maxInterventions ?? DEFAULT_MAX_INTERVENTIONS;
  const maxRecent = options.maxRecent ?? DEFAULT_MAX_RECENT;
  const maxTokenTurns = options.maxTokenTurns ?? DEFAULT_MAX_TOKEN_TURNS;

  let totalCalls = 0;
  let totalResults = 0;
  const perTool = new Map<string, number>();
  const perSession = new Map<string, number>();
  // Newest-first: index 0 is the most recent retained event.
  const interventions: InterventionEvent[] = [];
  // Oldest-first ring buffer: index 0 is the oldest retained event, appended in arrival order.
  const recent: TelemetryEvent[] = [];
  // Per-tool duration stats (cumulative sum / max / sample count) for tools reporting at least one result with durationMs.
  const toolDuration = new Map<string, { sum: number; max: number; count: number }>();
  // Global duration aggregates across all results reporting durationMs (sum + sample count).
  let totalDurationSum = 0;
  let totalDurationSamples = 0;
  // Global token aggregates across distinct turns (deduped by `${sessionKey}\u0000${at}`).
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalTokens = 0;
  let tokenSumsSeen = false;
  // Bounded, insertion-ordered set of seen token-turn dedup keys; the oldest key is evicted first beyond the cap.
  const tokenTurnKeys = new Set<string>();

  const handler: (event: TelemetryEvent) => void = (event) => {
    // Retain every incoming raw event in arrival order, evicting the oldest past the cap.
    recent.push(event);
    if (recent.length > maxRecent) {
      recent.shift();
    }
    switch (event.type) {
      case 'tool.call':
        totalCalls += 1;
        perTool.set(event.toolName, (perTool.get(event.toolName) ?? 0) + 1);
        perSession.set(event.sessionKey, (perSession.get(event.sessionKey) ?? 0) + 1);
        // Sum a turn's upstream token usage once, deduped by (sessionKey, at): calls sharing one
        // response turn repeat identical `tokens`, so only the first-seen turn contributes.
        if (event.tokens) {
          const turnKey = `${event.sessionKey}\u0000${event.at}`;
          if (!tokenTurnKeys.has(turnKey)) {
            tokenTurnKeys.add(turnKey);
            // Keep the dedup set bounded: evict the oldest key(s) beyond the configured cap.
            while (tokenTurnKeys.size > maxTokenTurns) {
              const oldest = tokenTurnKeys.values().next().value;
              if (oldest === undefined) break;
              tokenTurnKeys.delete(oldest);
            }
            totalInputTokens += event.tokens.input ?? 0;
            totalOutputTokens += event.tokens.output ?? 0;
            totalTokens += event.tokens.total ?? 0;
            tokenSumsSeen = true;
          }
        }
        break;
      case 'tool.result':
        totalResults += 1;
        // Accumulate duration metrics per tool and globally, only when measurable.
        if (typeof event.durationMs === 'number') {
          totalDurationSum += event.durationMs;
          totalDurationSamples += 1;
          const stats = toolDuration.get(event.toolName) ?? { sum: 0, max: 0, count: 0 };
          stats.sum += event.durationMs;
          stats.max = Math.max(stats.max, event.durationMs);
          stats.count += 1;
          toolDuration.set(event.toolName, stats);
        }
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
      .map(([toolName, count]): TopTool => {
        const entry: TopTool = { toolName, count };
        // Ride duration metrics along only when this tool has at least one result with durationMs.
        const stats = toolDuration.get(toolName);
        if (stats) {
          entry.avgDurationMs = stats.sum / stats.count;
          entry.maxDurationMs = stats.max;
          entry.totalDurationMs = stats.sum;
        }
        return entry;
      })
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

  const getRecentEvents = (limit?: number): TelemetryEvent[] => {
    // Most-recent events, still ascending (oldest-first): take the last `limit` entries.
    if (limit === undefined) return recent.slice();
    const n = Math.max(0, limit);
    return n >= recent.length ? recent.slice() : recent.slice(recent.length - n);
  };

  const summary = (): CollectorSummary => {
    const out: CollectorSummary = {
      totalCalls,
      totalResults,
      topTools: getTopTools(),
      interventions: getInterventions(),
    };
    // Global duration metrics are present only when some result reported durationMs.
    if (totalDurationSamples > 0) {
      out.totalDurationMs = totalDurationSum;
      out.avgDurationMs = totalDurationSum / totalDurationSamples;
    }
    // Token totals are present only when some turn reported token usage.
    if (tokenSumsSeen) {
      out.totalInputTokens = totalInputTokens;
      out.totalOutputTokens = totalOutputTokens;
      out.totalTokens = totalTokens;
    }
    return out;
  };

  const reset = (): void => {
    totalCalls = 0;
    totalResults = 0;
    perTool.clear();
    perSession.clear();
    interventions.length = 0;
    recent.length = 0;
    toolDuration.clear();
    totalDurationSum = 0;
    totalDurationSamples = 0;
    totalInputTokens = 0;
    totalOutputTokens = 0;
    totalTokens = 0;
    tokenSumsSeen = false;
    tokenTurnKeys.clear();
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
    getRecentEvents,
    summary,
    reset,
    dispose,
  };
}
