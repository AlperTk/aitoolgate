/**
 * SQLite-backed {@link ToolResultPersister} implementing async, batched
 * persistence of raw tool results. Designed as an adapter over the
 * fire-and-forget sink port so the store core remains framework-agnostic.
 *
 * Key properties:
 * - `persist()` is O(1): appends to an in-memory buffer; never blocks the caller.
 * - Actual disk writes happen in a scheduled background callback (timer or
 *   setImmediate), using a single transaction per batch.
 * - `lookup()` performs an indexed SELECT; safe to call on the API request path
 *   (only invoked on an in-memory cache miss).
 * - WAL journal mode minimizes write contention.
 */
import { DatabaseSync } from 'node:sqlite';
import type { ToolResultEntry, ToolResultPersister } from './toolResultStore';

/** Options for {@link createSqliteToolResultPersister}. */
export interface SqliteToolResultPersisterOptions {
  /** Path to the SQLite database file. */
  dbPath: string;
  /** Milliseconds between scheduled background flushes (default `50`). */
  flushIntervalMs?: number;
  /** Number of buffered entries that trigger an immediate low-latency flush (default `100`). */
  batchSize?: number;
  /** Whether to checkpoint the WAL after each batch (default `false`). */
  fsyncPerBatch?: boolean;
}

/** A {@link ToolResultPersister} backed by SQLite, with lifecycle management. */
export interface SqliteToolResultPersister extends ToolResultPersister {
  lookup(id: string): Promise<ToolResultEntry | null>;
  /** Flush any pending entries and close the underlying database. */
  close(): Promise<void>;
}

/**
 * Create a {@link SqliteToolResultPersister} that batch-writes tool results to
 * a SQLite database at `options.dbPath`.
 *
 * The returned object implements the {@link ToolResultPersister} port plus an
 * async `lookup` method and a `close()` for clean teardown. When injected into
 * {@link createToolResultStore}, every `put` mirrors the entry here
 * fire-and-forget; the API route's `resolve()` falls back to `lookup` on a
 * cache miss.
 */
export function createSqliteToolResultPersister(
  options: SqliteToolResultPersisterOptions,
): SqliteToolResultPersister {
  const {
    dbPath,
    flushIntervalMs = 50,
    batchSize = 100,
    fsyncPerBatch = false,
  } = options;

  // Open the database and set up the schema (idempotent DDL).
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode=WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS tool_results (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      chars INTEGER NOT NULL,
      ok INTEGER,
      at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tool_results_at ON tool_results (at);
  `);

  // Pre-compiled statements reused across all operations.
  const insertStmt = db.prepare(
    'INSERT OR REPLACE INTO tool_results (id, content, chars, ok, at) VALUES (?, ?, ?, ?, ?)',
  );
  const selectStmt = db.prepare(
    'SELECT id, content, chars, ok, at FROM tool_results WHERE id = ?',
  );

  let buffer: ToolResultEntry[] = [];
  let timer: NodeJS.Timeout | null = null;
  let flushing = false;
  let closed = false;

  /** Start the recurring flush timer (no-op if already running or closed). */
  function startTimer(): void {
    if (timer !== null || closed) return;
    timer = setInterval(() => {
      void flush();
    }, flushIntervalMs);
    timer.unref(); // Don't keep the event loop alive solely for this timer.
  }

  /**
   * Flush the current buffer to disk in a single transaction. Safe to call
   * concurrently: entries appended during a flush land in the next buffer and
   * are picked up by the subsequent timer tick.
   */
  async function flush(): Promise<void> {
    if (flushing || buffer.length === 0 || closed) return;
    flushing = true;
    const batch = buffer;
    buffer = [];
    try {
      db.exec('BEGIN');
      for (const entry of batch) {
        insertStmt.run(
          entry.id,
          entry.content,
          entry.chars,
          entry.ok === undefined ? null : entry.ok ? 1 : 0,
          entry.at,
        );
      }
      db.exec('COMMIT');
      if (fsyncPerBatch) {
        db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      }
    } catch {
      // A failing persister must never break the request flow. Re-queue the
      // batch so it isn't silently lost (best-effort; the next flush retries).
      if (!closed && buffer.length === 0) {
        buffer = [...batch];
      }
    } finally {
      flushing = false;
    }
  }

  /**
   * O(1) append to the in-memory buffer. Never performs synchronous disk I/O.
   * Schedules a low-latency flush when the batch threshold is reached; the
   * recurring timer handles the rest.
   */
  function persist(entry: ToolResultEntry): void {
    if (closed) return;
    buffer.push({ ...entry }); // defensive copy — caller may mutate later
    startTimer();
    // Low-latency path: flush on next tick once the batch is full; the recurring
    // timer keeps the buffer bounded between batches.
    if (buffer.length >= batchSize) {
      setImmediate(() => {
        void flush();
      });
    }
  }

  /** Indexed single-row lookup; safe to call from the API request path. */
  async function lookup(id: string): Promise<ToolResultEntry | null> {
    const row = selectStmt.get(id) as Record<string, unknown> | undefined;
    if (row === undefined) return null;
    return {
      id: String(row.id),
      content: String(row.content),
      chars: Number(row.chars),
      ok: row.ok === null ? undefined : Boolean(row.ok),
      at: Number(row.at),
    };
  }

  /** Flush pending entries and close the database synchronously. */
  async function close(): Promise<void> {
    if (closed) return;
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
    // Flush remaining buffered entries before marking closed so they aren't lost
    // (flush() is a no-op once `closed` is set).
    await flush();
    closed = true;
    db.close();
  }

  return { persist, lookup, close };
}
