/**
 * In-memory telemetry aggregator (slice 6b of telemetry/storage).
 *
 * Subscribes to a {@link TelemetryEventBus} and maintains live aggregates over
 * the event stream: total tool-call count, per-tool counts, a top-tools
 * ranking (with per-tool duration and token metrics), a bounded newest-first intervention
 * log, plus result/session counters and global duration/token usage totals.
 * Query methods expose these for the live dashboard. Purely in-memory: no
 * timers, no I/O, no persistence; {@link Collector.dispose} is what detaches
 * the view from its bus.
 */
import { createEventBus } from './event-bus';
import type { TelemetryEventBus } from './event-bus';
import type { InterventionEvent, TelemetryEvent } from './events';
import { DEFAULT_AGGREGATE_EXCLUDED_TOOLS, isAggregateExcluded } from './aggregate-exclusions';
import { estimateTokensFromChars } from './tokenEstimate';

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
  /** Sum of `tokens.total` across distinct turns that invoked this tool (deduped by turn); omitted when the tool reported no total tokens. */
  totalTokens?: number;
  /** Sum of `tokens.cacheHitInput` across distinct turns that invoked this tool (deduped by turn); omitted when the tool reported no cache-hit input tokens. */
  totalCacheHitInputTokens?: number;
  /** Sum of estimated response-payload tokens (`estimateTokensFromChars(chars)`) across resolved results reporting `chars`; omitted when the tool has no resolved results. */
  totalResponseTokens?: number;
  /** Count of resolved results that reported `chars` for this tool; omitted when the tool has none. */
  resolvedCount?: number;
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
  /** Tool names excluded from aggregate statistics (matched case-insensitively). Raw events are always retained. Defaults to {@link DEFAULT_AGGREGATE_EXCLUDED_TOOLS}. */
  excludedTools?: readonly string[];
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
  /** Sum of `tokens.input` across distinct turns (from `tool.call` `tokens` and whole-turn `turn.usage` events); omitted when no token usage observed. */
  totalInputTokens?: number;
  /** Sum of `tokens.output` across distinct turns (from `tool.call` `tokens` and whole-turn `turn.usage` events); omitted when no token usage observed. */
  totalOutputTokens?: number;
  /** Sum of `tokens.total` across distinct turns (from `tool.call` `tokens` and whole-turn `turn.usage` events); omitted when no token usage observed. */
  totalTokens?: number;
  /** Sum of `tokens.cacheHitInput` across distinct turns (from `tool.call` `tokens` and whole-turn `turn.usage` events); omitted when no token usage observed. */
  totalCacheHitInputTokens?: number;
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
  // Tool names whose events are skipped by the aggregate accumulators (raw events are retained).
  const excludedTools = options.excludedTools ?? DEFAULT_AGGREGATE_EXCLUDED_TOOLS;

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
  let totalCacheHitInputTokens = 0;
  let tokenSumsSeen = false;
  // Bounded, insertion-ordered set of seen token-turn dedup keys; the oldest key is evicted first beyond the cap.
  const tokenTurnKeys = new Set<string>();
  // Per-tool token totals across distinct turns, deduped per (turn, tool): batched calls sharing one
  // turn attribute the turn's tokens once per tool rather than once per call.
  const toolTokens = new Map<string, number>();
  // Per-tool cache-hit input totals across distinct turns, deduped per (turn, tool), mirroring toolTokens.
  const toolCacheHitInput = new Map<string, number>();
  // Bounded, insertion-ordered set of seen per-tool token-turn dedup keys; the oldest key is evicted first beyond the cap.
  const toolTokenTurnKeys = new Set<string>();
  // Per-tool resolved-result response-token stats (accumulated estimated tokens + resolved result count).
  const toolResolvedResults = new Map<string, { totalResponseTokens: number; resolvedCount: number }>();

  /**
   * Sum a distinct turn's token mass EXACTLY ONCE, deduped by `${sessionKey}\u0000${at}`
   * (bounded at `maxTokenTurns`), whether it arrives on a `tool.call`'s `tokens` or on a
   * whole-turn `turn.usage` event — the shared dedup key is what keeps the two sources from
   * double-counting one turn (the first-seen source's tokens win).
   */
  const recordTurnTokensOnce = (turnKey: string, tokens: { input?: number; output?: number; total?: number; cacheHitInput?: number }): void => {
    if (tokenTurnKeys.has(turnKey)) return;
    tokenTurnKeys.add(turnKey);
    // Keep the dedup set bounded: evict the oldest key(s) beyond the configured cap.
    while (tokenTurnKeys.size > maxTokenTurns) {
      const oldest = tokenTurnKeys.values().next().value;
      if (oldest === undefined) break;
      tokenTurnKeys.delete(oldest);
    }
    totalInputTokens += tokens.input ?? 0;
    totalOutputTokens += tokens.output ?? 0;
    totalTokens += tokens.total ?? 0;
    totalCacheHitInputTokens += tokens.cacheHitInput ?? 0;
    tokenSumsSeen = true;
  };

  const handler: (event: TelemetryEvent) => void = (event) => {
    // Retain EVERY incoming raw event in arrival order, evicting the oldest past the cap. The
    // aggregation exclusion below is purely an aggregate filter: it never drops the raw event,
    // so excluded tools stay visible in the live dashboard stream and drill-down.
    recent.push(event);
    if (recent.length > maxRecent) {
      recent.shift();
    }
    switch (event.type) {
      case 'tool.call': {
        // Per-session call tallies stay raw (not "typical call" aggregates).
        perSession.set(event.sessionKey, (perSession.get(event.sessionKey) ?? 0) + 1);
        // Skip aggregate accumulation for excluded tools (e.g. the `task` wrapper) so totals,
        // averages, and per-tool rankings reflect normal tool calls only.
        if (isAggregateExcluded(event.toolName, excludedTools)) break;
        totalCalls += 1;
        perTool.set(event.toolName, (perTool.get(event.toolName) ?? 0) + 1);
        // Sum a turn's upstream token usage once, deduped by (sessionKey, at): calls sharing one
        // response turn repeat identical `tokens`, so only the first-seen turn contributes.
        if (event.tokens) {
          const turnKey = `${event.sessionKey}\u0000${event.at}`;
          recordTurnTokensOnce(turnKey, event.tokens);
          // Per-tool token total: attribute this turn's tokens to this tool once per distinct (turn, tool), so
          // batched same-turn calls don't double-count it. Mirrors the global turn-dedup above.
          const toolTurnKey = turnKey + '\u0000' + event.toolName;
          if (!toolTokenTurnKeys.has(toolTurnKey)) {
            toolTokenTurnKeys.add(toolTurnKey);
            while (toolTokenTurnKeys.size > maxTokenTurns) {
              const oldest = toolTokenTurnKeys.values().next().value;
              if (oldest === undefined) break;
              toolTokenTurnKeys.delete(oldest);
            }
            toolTokens.set(event.toolName, (toolTokens.get(event.toolName) ?? 0) + (event.tokens.total ?? 0));
            // Only attribute cache-hit mass when the turn actually reported it (so a tool whose
            // turns carried no cache-hit tokens leaves `totalCacheHitInputTokens` omitted, not 0).
            if (event.tokens.cacheHitInput !== undefined) {
              toolCacheHitInput.set(event.toolName, (toolCacheHitInput.get(event.toolName) ?? 0) + event.tokens.cacheHitInput);
            }
          }
        }
        break;
      }
      case 'tool.result': {
        // Aggregation-only exclusion: an excluded tool's result is skipped for every
        // result/duration aggregate, but its raw event is retained above.
        if (isAggregateExcluded(event.toolName, excludedTools)) break;
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
        // Accumulate estimated response-payload tokens per tool from each resolved result carrying a measurable char count.
        if (typeof event.chars === 'number' && Number.isFinite(event.chars) && event.chars > 0) {
          const estTokens = estimateTokensFromChars(event.chars);
          const resolved = toolResolvedResults.get(event.toolName) ?? { totalResponseTokens: 0, resolvedCount: 0 };
          resolved.totalResponseTokens += estTokens;
          resolved.resolvedCount += 1;
          toolResolvedResults.set(event.toolName, resolved);
        }
        break;
      }
      case 'turn.usage': {
        // Whole-turn token mass over ALL message content (not only tool calls/results): summed
        // exactly once per distinct (sessionKey, at) turn via the SAME dedup key as tool.call
        // `tokens`, so a turn carrying both sources contributes exactly once (first-seen wins).
        recordTurnTokensOnce(`${event.sessionKey}\u0000${event.at}`, event.tokens);
        break;
      }
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
        const toolTotalTokens = toolTokens.get(toolName);
        if (toolTotalTokens !== undefined) {
          entry.totalTokens = toolTotalTokens;
        }
        const toolCacheHit = toolCacheHitInput.get(toolName);
        if (toolCacheHit !== undefined) {
          entry.totalCacheHitInputTokens = toolCacheHit;
        }
        const toolResolved = toolResolvedResults.get(toolName);
        if (toolResolved) {
          entry.totalResponseTokens = toolResolved.totalResponseTokens;
          entry.resolvedCount = toolResolved.resolvedCount;
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
      out.totalCacheHitInputTokens = totalCacheHitInputTokens;
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
    totalCacheHitInputTokens = 0;
    tokenSumsSeen = false;
    tokenTurnKeys.clear();
    toolTokens.clear();
    toolCacheHitInput.clear();
    toolTokenTurnKeys.clear();
    toolResolvedResults.clear();
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
