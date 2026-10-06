/**
 * In-memory tool-call latency tracker (self-contained slice of telemetry).
 *
 * Pairs issued tool calls with their later results across successive requests so
 * the dashboard can answer "how many milliseconds did each tool call take". It
 * works purely on plain data ({@link IssuedCall} / {@link ToolResultIn}) and does
 * NOT import or depend on the telemetry pipeline or emission code, which keeps it
 * independently testable.
 *
 * Retention is enforced LAZILY inside each method — never via timers or
 * `setInterval` (which would hang the test event loop) — using an injectable
 * clock (default {@link monotonicEpochMs}, epoch milliseconds). On every public
 * call we FIRST sweep stale entries (`now() - at > ttlMs`), THEN enforce
 * capacity: if the retained set exceeds {@link ToolMetricsOptions.maxPending} we
 * evict the oldest-by-`at` entries (ties resolved by earliest-inserted first)
 * until within the cap.
 *
 * Duration attribution: each resolved result measures the span between its
 * MATCHED call's issue time and that result's arrival time, pairing on the
 * stable tool-call id — NEVER on message position — so interleaved / out-of-
 * order arrivals each take their own duration without fabricating any spread.
 * Batched calls whose results genuinely arrive together correctly share an
 * equal duration. Orphaned results (no matching pending call) are silently
 * skipped; unresolved calls simply stay pending until TTL-swept (they never
 * produce a bogus/negative/NaN duration); measured durations are clamped to
 * `>= 0`.
 */
import process from 'node:process';

/** Wall-clock anchor (epoch ms) captured once at module load; base of {@link monotonicEpochMs}. */
const CLOCK_BASE_WALL_MS = Date.now();
/** High-resolution monotonic base captured once at module load; drift source of {@link monotonicEpochMs}. */
const CLOCK_BASE_HRTIME = process.hrtime.bigint();

/**
 * Monotonically non-decreasing, wall-clock-aligned epoch-millisecond time: the
 * module-load wall anchor plus high-resolution monotonic elapsed time
 * (`process.hrtime`). Unlike a raw {@link Date.now} reading it never steps
 * backward (immune to NTP corrections), so issue→result spans measured across
 * telemetry components cannot go negative or jump. Used as the DEFAULT timing
 * source across telemetry; tests inject their own clock for determinism.
 */
export function monotonicEpochMs(): number {
  return CLOCK_BASE_WALL_MS + Math.max(0, Number((process.hrtime.bigint() - CLOCK_BASE_HRTIME) / 1_000_000n));
}

/** Options for {@link createToolMetricsTracker}. */
export interface ToolMetricsOptions {
  /** Max pending entries to retain before the oldest are evicted. Default 1000. */
  maxPending?: number;
  /** A pending entry whose issue time is older than this (epoch-ms delta) is swept. Default 300000 (5 min). */
  ttlMs?: number;
  /** Clock returning the current time in epoch milliseconds. Defaults to {@link monotonicEpochMs}. */
  now?: () => number;
}

/** An issued tool call awaiting its result. */
export interface IssuedCall {
  /** Stable tool-call id (links to a later {@link ToolResultIn.toolCallId}). */
  id: string;
  /**
   * When THAT specific call was issued/observed (epoch milliseconds). Calls batched in one
   * buffered response turn share the turn-level time (they were all observed at once); an
   * emitter that observes calls individually (e.g. the streamed SSE extractor) records each
   * call's own first-observation time so its duration measures a true per-call span.
   */
  at: number;
  /** Name of the invoked tool, when known (carried onto the resolved result as its `toolName`). */
  name?: string;
}

/** A tool result arriving later on the stream. */
export interface ToolResultIn {
  /** Id of the specific tool call this result is for; omitted when unknown. */
  toolCallId?: string;
  /** When the result arrived (epoch milliseconds). */
  at: number;
  /** Raw character length of the result payload, if known. */
  chars?: number;
}

/** A successfully paired tool call with its measured duration. */
export interface ResolvedToolCall {
  /** The resolved tool-call id. */
  toolCallId: string;
  /** Elapsed milliseconds from issue to result (clamped to >= 0). */
  durationMs: number;
  /** Name of the invoked tool, included only when the recorded issued call carried one. */
  toolName?: string;
  /** The result's payload size, included only when present on the incoming result. */
  chars?: number;
}

/** A live in-memory latency tracker pairing issued calls with later results. */
export interface ToolMetricsTracker {
  /**
   * Store issued calls keyed by `${sessionKey}\u0000${id}`. Entries with a missing
   * or empty `id` are skipped.
   */
  recordIssued(sessionKey: string, issued: IssuedCall[]): void;
  /**
   * Resolve results against pending calls, computing `durationMs = Math.max(0,
   * result.at - issuedAt)` (clamped non-negative). Each result first matches the
   * EXACT same-session bucket (`${sessionKey}\u0000${id}`); when that is absent —
   * e.g. the session key diverged or was empty between the issuing and resolving
   * request — it falls back to the most-recently-issued pending entry carrying the
   * same tool-call id in ANY session, so a call is never permanently stranded by a
   * header mismatch. Results with no matching pending id are silently skipped (not
   * included in the returned list); each id resolves only once. Sequential
   * single-client pairing, TTL sweep, and capacity behavior are all preserved.
   */
  resolveResults(sessionKey: string, results: ToolResultIn[]): ResolvedToolCall[];
  /** Number of pending entries currently retained. */
  pendingCount(): number;
  /** Clear all state (and bookkeeping), returning to a clean slate. */
  reset(): void;
}

const DEFAULT_MAX_PENDING = 1000;
const DEFAULT_TTL_MS = 300_000;

/** Retained pending entry: issue time, insertion order, and the id/name it represents. */
interface PendingEntry {
  /** Issue time (epoch milliseconds). */
  at: number;
  /** Monotonic insertion-order index, stable across re-issues of the same id. */
  seq: number;
  /** Stable tool-call id this pending entry represents (for cross-session fallback matching). */
  id: string;
  /** Invoked tool name, when the issuing call carried one (surfaced on the resolved call). */
  name?: string;
}

/** Create an in-memory {@link ToolMetricsTracker}. */
export function createToolMetricsTracker(options: ToolMetricsOptions = {}): ToolMetricsTracker {
  const maxPending = options.maxPending ?? DEFAULT_MAX_PENDING;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  // Default to the shared monotonic wall-clock (never steps backward); inject a controllable
  // clock via `now` for deterministic tests.
  const clock = options.now ?? monotonicEpochMs;

  // Keyed by `${sessionKey}\u0000${id}`.
  const entries = new Map<string, PendingEntry>();
  let seq = 0;

  const keyFor = (sessionKey: string, id: string): string => `${sessionKey}\u0000${id}`;

  /** Drop stale entries (`now() - at > ttlMs`) using the injected clock. */
  const sweep = (): void => {
    const now = clock();
    const stale: string[] = [];
    for (const [key, entry] of entries) {
      if (now - entry.at > ttlMs) stale.push(key);
    }
    for (const key of stale) entries.delete(key);
  };

  /** Evict oldest-by-`at` (ties → earliest inserted first) until within `maxPending`. */
  const enforceCapacity = (): void => {
    if (entries.size <= maxPending) return;
    const ordered = [...entries.entries()]
      .map(([key, entry]) => ({ key, at: entry.at, seq: entry.seq }))
      .sort((a, b) => a.at - b.at || a.seq - b.seq);
    const overflow = entries.size - maxPending;
    for (let i = 0; i < overflow; i++) entries.delete(ordered[i].key);
  };

  const recordIssued = (sessionKey: string, issued: IssuedCall[]): void => {
    sweep();
    for (const call of issued) {
      const id = call.id;
      if (!id) continue; // skip missing/empty ids
      const key = keyFor(sessionKey, id);
      const existing = entries.get(key);
      if (existing) {
        existing.at = call.at; // re-issue updates the time (and name) but keeps insertion order
        if (call.name !== undefined) existing.name = call.name;
      } else {
        const entry: PendingEntry = { at: call.at, seq: seq++, id };
        if (call.name !== undefined) entry.name = call.name;
        entries.set(key, entry);
      }
    }
    enforceCapacity();
  };

  /**
   * Locate the pending entry for `id`: prefer the EXACT same-session bucket
   * (`${sessionKey}\u0000${id}`); as a robustness fallback so a diverging or empty
   * `x-session-id` header cannot strand an issued call, otherwise the most-recently
   * issued pending entry carrying that id in ANY session. Returns the full key plus
   * the entry, or `undefined` when nothing matches.
   */
  const findPendingById = (sessionKey: string, id: string): { key: string; entry: PendingEntry } | undefined => {
    const exactKey = keyFor(sessionKey, id);
    const exact = entries.get(exactKey);
    if (exact !== undefined) return { key: exactKey, entry: exact };
    let bestKey: string | undefined;
    let best: PendingEntry | undefined;
    for (const [key, candidate] of entries) {
      if (candidate.id !== id) continue;
      // Prefer the most recent issue (largest `at`; ties broken by most-recently inserted).
      if (best === undefined || candidate.at > best.at || (candidate.at === best.at && candidate.seq > best.seq)) {
        best = candidate;
        bestKey = key;
      }
    }
    if (bestKey === undefined || best === undefined) return undefined;
    return { key: bestKey, entry: best };
  };

  const resolveResults = (sessionKey: string, results: ToolResultIn[]): ResolvedToolCall[] => {
    sweep();
    enforceCapacity();
    const resolved: ResolvedToolCall[] = [];
    for (const result of results) {
      const id = result.toolCallId;
      if (!id) continue; // no id cannot match any pending call
      const match = findPendingById(sessionKey, id);
      if (!match) continue; // unmatched → silently skipped
      entries.delete(match.key);
      const resolvedEntry: ResolvedToolCall = {
        toolCallId: id,
        durationMs: Math.max(0, result.at - match.entry.at),
      };
      if (match.entry.name !== undefined) resolvedEntry.toolName = match.entry.name;
      if (result.chars !== undefined) resolvedEntry.chars = result.chars;
      resolved.push(resolvedEntry);
    }
    return resolved;
  };

  const pendingCount = (): number => {
    sweep();
    enforceCapacity();
    return entries.size;
  };

  const reset = (): void => {
    entries.clear();
    seq = 0;
  };

  return { recordIssued, resolveResults, pendingCount, reset };
}
