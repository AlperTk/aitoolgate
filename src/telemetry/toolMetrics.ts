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
 * clock (default {@link Date.now}, epoch milliseconds). On every public call we
 * FIRST sweep stale entries (`now() - at > ttlMs`), THEN enforce capacity: if the
 * retained set exceeds {@link ToolMetricsOptions.maxPending} we evict the
 * oldest-by-`at` entries (ties resolved by earliest-inserted first) until within
 * the cap.
 */

/** Options for {@link createToolMetricsTracker}. */
export interface ToolMetricsOptions {
  /** Max pending entries to retain before the oldest are evicted. Default 1000. */
  maxPending?: number;
  /** A pending entry whose issue time is older than this (epoch-ms delta) is swept. Default 300000 (5 min). */
  ttlMs?: number;
  /** Clock returning the current time in epoch milliseconds. Defaults to {@link Date.now}. */
  now?: () => number;
}

/** An issued tool call awaiting its result. */
export interface IssuedCall {
  /** Stable tool-call id (links to a later {@link ToolResultIn.toolCallId}). */
  id: string;
  /** When it was issued (epoch milliseconds). */
  at: number;
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
   * Resolve results against same-session pending calls, computing
   * `durationMs = Math.max(0, result.at - issuedAt)`. Results with no matching
   * pending id are silently skipped (not included in the returned list).
   */
  resolveResults(sessionKey: string, results: ToolResultIn[]): ResolvedToolCall[];
  /** Number of pending entries currently retained. */
  pendingCount(): number;
  /** Clear all state (and bookkeeping), returning to a clean slate. */
  reset(): void;
}

const DEFAULT_MAX_PENDING = 1000;
const DEFAULT_TTL_MS = 300_000;

/** Retained pending entry: issue time plus a stable insertion-order sequence. */
interface PendingEntry {
  /** Issue time (epoch milliseconds). */
  at: number;
  /** Monotonic insertion-order index, stable across re-issues of the same id. */
  seq: number;
}

/** Create an in-memory {@link ToolMetricsTracker}. */
export function createToolMetricsTracker(options: ToolMetricsOptions = {}): ToolMetricsTracker {
  const maxPending = options.maxPending ?? DEFAULT_MAX_PENDING;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const clock = options.now ?? Date.now;

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
        existing.at = call.at; // re-issue updates the time but keeps insertion order
      } else {
        entries.set(key, { at: call.at, seq: seq++ });
      }
    }
    enforceCapacity();
  };

  const resolveResults = (sessionKey: string, results: ToolResultIn[]): ResolvedToolCall[] => {
    sweep();
    enforceCapacity();
    const resolved: ResolvedToolCall[] = [];
    for (const result of results) {
      const id = result.toolCallId;
      if (!id) continue; // no id cannot match any pending call
      const key = keyFor(sessionKey, id);
      const entry = entries.get(key);
      if (!entry) continue; // unmatched → silently skipped
      entries.delete(key);
      const resolvedEntry: ResolvedToolCall = {
        toolCallId: id,
        durationMs: Math.max(0, result.at - entry.at),
      };
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
