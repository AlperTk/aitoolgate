/**
 * A single raw tool-result record held for later retrieval (e.g. over
 * `GET /api/tool-results/:id`). The primary source of truth is memory; an
 * optional {@link ToolResultPersister} lets a durable backend (e.g. SQLite)
 * mirror every record WITHOUT the store core knowing about it — dependency
 * inversion keeps this class open to extension (a SQLite sink plugs in here
 * without touching the memory store or the proxy emission path).
 */
export interface ToolResultEntry {
  /** Stable id of the tool call this result belongs to (the store key). */
  id: string;
  /** Raw result content (caller-capped so each entry stays bounded in memory). */
  content: string;
  /** Full character length of the (uncapped) result payload. */
  chars: number;
  /** Whether the call succeeded, when known. */
  ok?: boolean;
  /** When the result was recorded (epoch milliseconds). */
  at: number;
}

/**
 * Minimal fire-and-forget sink port. Implementations may run async internally but
 * must not block the caller synchronously; {@link createToolResultStore} invokes
 * them without awaiting and swallows any failure, so a failing persister can
 * never break the request flow.
 *
 * When `lookup` is provided, {@link ToolResultStore.resolve} falls back to it on
 * an in-memory cache miss (e.g. after eviction or a process restart), enabling
 * durable retrieval without changing the synchronous hot path.
 */
export interface ToolResultPersister {
  persist(entry: ToolResultEntry): void;
  /**
   * Optional async read for cache-miss fallback. When absent, `resolve` returns
   * `null` for entries not in memory. Implementations should be cheap (indexed
   * SELECT) since this runs only on the API request path when memory misses.
   */
  lookup?(id: string): Promise<ToolResultEntry | null>;
}

/** Options for {@link createToolResultStore}. */
export interface ToolResultStoreOptions {
  /** Maximum number of entries retained before oldest-by-`at` eviction (default 1000). */
  maxEntries?: number;
  /** Optional time-to-live (ms); entries older than this are swept lazily on access. */
  ttlMs?: number;
  /** Optional durable sink invoked (fire-and-forget) on every {@link ToolResultStore.put}. */
  persister?: ToolResultPersister;
}

/** An in-memory, bounded registry of raw tool results keyed by stable id. */
export interface ToolResultStore {
  /** Store a defensive copy of `entry`; evict the oldest (by `at`) once past `maxEntries`; persist if configured. */
  put(id: string, entry: ToolResultEntry): void;
  /** A defensive copy of the entry at `id`, or `undefined` when absent/expired. */
  get(id: string): ToolResultEntry | undefined;
  /**
   * Resolve an entry: checks memory first (synchronous fast path); on a miss and
   * a persister with `lookup` is available, falls back to the durable store.
   * Returns `null` when the entry is found nowhere. Absent from the returned
   * object when no persister with `lookup` is configured (backward-compatible).
   */
  resolve?(id: string): Promise<ToolResultEntry | null>;
  /** Number of entries currently retained (after a lazy TTL sweep). */
  size(): number;
  /** Remove every entry (expired or not). */
  purge(): void;
}

const DEFAULT_MAX_ENTRIES = 1000;

/** Shallow-copy an entry so callers cannot mutate stored state via a returned reference. */
function copyEntry(entry: ToolResultEntry): ToolResultEntry {
  return { ...entry };
}

/**
 * Fire-and-forget persist: never awaited, never lets a failure surface to the
 * caller. Tolerates an implementation that returns a promise (defensively
 * attaches a no-op rejection handler) even though the port contract is `void`.
 */
function safePersist(persister: ToolResultPersister, entry: ToolResultEntry): void {
  try {
    const result: unknown = persister.persist(copyEntry(entry));
    if (result !== null && typeof result === 'object' && typeof (result as { catch?: unknown }).catch === 'function') {
      (result as Promise<unknown>).catch(() => {});
    }
  } catch {
    // A failing persister must never break the request flow.
  }
}

/**
 * Create a bounded in-memory {@link ToolResultStore}. Memory is the primary
 * source of truth; when `options.persister` is supplied it is invoked
 * fire-and-forget on every `put` so a durable backend can mirror the stream.
 * The store is bounded two ways: a hard cap (`maxEntries`, default 1000) that
 * evicts the oldest entry by `at`, and an optional `ttlMs` lazy sweep.
 * Accessors return defensive copies throughout, mirroring {@link createRuleStore}.
 */
export function createToolResultStore(options: ToolResultStoreOptions = {}): ToolResultStore {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const ttlMs = options.ttlMs;
  const persister = options.persister;
  const entries = new Map<string, ToolResultEntry>();

  /** Remove entries whose age exceeds the TTL (no-op when no TTL is configured). */
  function sweepTtl(): void {
    if (ttlMs === undefined) return;
    const cutoff = Date.now() - ttlMs;
    for (const [id, entry] of entries) {
      if (entry.at <= cutoff) entries.delete(id);
    }
  }

  /** Evict oldest-by-`at` entries until the registry is within the bound. */
  function evictToBound(): void {
    while (entries.size > maxEntries) {
      let oldestId: string | undefined;
      let oldestAt = Infinity;
      for (const [id, entry] of entries) {
        if (entry.at < oldestAt) {
          oldestAt = entry.at;
          oldestId = id;
        }
      }
      if (oldestId === undefined) break; // defensive: cannot happen when size > maxEntries > 0
      entries.delete(oldestId);
    }
  }

  function put(id: string, entry: ToolResultEntry): void {
    sweepTtl();
    entries.set(id, copyEntry(entry));
    if (persister !== undefined) safePersist(persister, entry);
    evictToBound();
  }

  function get(id: string): ToolResultEntry | undefined {
    sweepTtl();
    const found = entries.get(id);
    return found === undefined ? undefined : copyEntry(found);
  }

  function size(): number {
    sweepTtl();
    return entries.size;
  }

  function purge(): void {
    entries.clear();
  }

  const store: ToolResultStore = { put, get, size, purge };

  // Only expose `resolve` when a persister with a `lookup` method is present,
  // keeping the synchronous-only contract for callers that don't need it.
  const lookupFn = persister?.lookup;
  if (typeof lookupFn === 'function') {
    store.resolve = async (id: string): Promise<ToolResultEntry | null> => {
      // Memory hit is the fast path (synchronous).
      const memHit = entries.get(id);
      if (memHit !== undefined) return copyEntry(memHit);
      // Cache miss: fall back to the durable store.
      try {
        const found = await lookupFn.call(persister, id);
        return found === null ? null : copyEntry(found);
      } catch {
        // A failing persister must never break the API response.
        return null;
      }
    };
  }

  return store;
}
