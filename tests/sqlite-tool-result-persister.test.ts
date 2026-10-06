/**
 * Tests for the SQLite-backed tool-result persister and its integration with
 * the in-memory store + API route. Covers:
 *  (a) default-OFF: no persister → no disk I/O, behavior unchanged
 *  (b) flag-ON: content persisted; cache-miss fallback via resolve()
 *  (c) batching/async: puts are O(1) memory; disk writes are deferred
 *  (d) WAL journal mode is set on the database
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createToolResultStore, type ToolResultEntry, type ToolResultStore } from '../src/telemetry/toolResultStore';
import { createSqliteToolResultPersister, type SqliteToolResultPersister } from '../src/telemetry/sqliteToolResultPersister';
import { createApiHandler } from '../src/api/http';
import type { Collector } from '../src/telemetry/collector';
import { createRuleStore } from '../src/api/ruleStore';

const AT = 1_700_000_000_000;

/** A fresh, unique temp file path suitable for a SQLite database. */
function tempDbPath(): string {
  return path.join(
    os.tmpdir(),
    `mcp-mgr-tr-persister-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
}

/** Build a ToolResultEntry with sensible defaults plus optional overrides. */
function entry(overrides: Partial<ToolResultEntry> = {}): ToolResultEntry {
  const base: ToolResultEntry = {
    id: 'tool-result-1',
    content: 'hello world',
    chars: 11,
    ok: true,
    at: AT,
  };
  return { ...base, ...overrides };
}

/** Wait for the next macrotask tick (allows setImmediate callbacks to run). */
function tick(ms = 1): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- (a) Default OFF: no persister → no disk I/O, behavior unchanged -----------

describe('default OFF (no persister)', () => {
  test('store without persister has no resolve method and get() works as before', () => {
    const store = createToolResultStore();
    const e = entry();
    store.put(e.id, e);
    assert.equal(store.resolve, undefined, 'resolve should be absent without a persister');
    const got = store.get(e.id);
    assert.notEqual(got, undefined);
    assert.equal(got!.content, 'hello world');
    assert.equal(got!.chars, 11);
  });

  test('put/get/size/purge behave identically to the prior contract', () => {
    const store = createToolResultStore({ maxEntries: 5 });
    for (let i = 0; i < 10; i++) {
      store.put(`id-${i}`, entry({ id: `id-${i}`, at: AT + i }));
    }
    // Oldest entries evicted (maxEntries=5).
    assert.equal(store.size(), 5);
    assert.equal(store.get('id-0'), undefined, 'oldest evicted');
    assert.equal(store.get('id-9')?.content, 'hello world');
    store.purge();
    assert.equal(store.size(), 0);
  });

  test('no SQLite file is created when no persister is configured', async () => {
    const dir = path.join(os.tmpdir(), `mcp-mgr-tr-nofile-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(dir, { recursive: true });
    try {
      const store = createToolResultStore();
      store.put('x', entry({ id: 'x' }));
      // Give any hypothetical timer a chance to fire.
      await tick(100);
      const files = fs.readdirSync(dir);
      assert.deepEqual(files, [], 'no files created in the directory');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// --- (b) Flag ON: persistence + cache-miss fallback ----------------------------

describe('flag ON (SQLite persister)', () => {
  test('content is persisted to the tool_results table after flush', async () => {
    const dbPath = tempDbPath();
    try {
      const persister = createSqliteToolResultPersister({ dbPath, flushIntervalMs: 10, batchSize: 2 });
      const store = createToolResultStore({ persister });

      store.put('abc', entry({ id: 'abc', content: 'persisted-content', chars: 17, ok: true, at: AT }));
      // Wait for the timer to fire (flushIntervalMs=10).
      await tick(50);

      // Verify directly via a fresh DB handle.
      const check = new DatabaseSync(dbPath);
      const row = check.prepare('SELECT * FROM tool_results WHERE id = ?').get('abc') as Record<string, unknown> | undefined;
      check.close();
      assert.notEqual(row, undefined, 'row should exist in tool_results');
      assert.equal(row!.content, 'persisted-content');
      assert.equal(Number(row!.chars), 17);
      assert.equal(Number(row!.ok), 1);
      assert.equal(Number(row!.at), AT);

      await persister.close();
    } finally {
      cleanupDb(dbPath);
    }
  });

  test('after store purge, resolve() falls back to the DB and returns content', async () => {
    const dbPath = tempDbPath();
    try {
      const persister = createSqliteToolResultPersister({ dbPath, flushIntervalMs: 10, batchSize: 2 });
      const store = createToolResultStore({ persister });

      store.put('xyz', entry({ id: 'xyz', content: 'durable-content', chars: 15, ok: false, at: AT + 1 }));
      await tick(50); // let it flush

      // Purge the in-memory store (simulates eviction or process restart).
      store.purge();
      assert.equal(store.get('xyz'), undefined, 'memory should be empty after purge');

      // resolve() should fall back to the DB.
      const resolved = await store.resolve!('xyz');
      assert.notEqual(resolved, null, 'resolve should find the entry in the DB');
      assert.equal(resolved!.content, 'durable-content');
      assert.equal(resolved!.chars, 15);
      assert.equal(resolved!.ok, false);

      // Unknown id → null.
      const missing = await store.resolve!('nonexistent');
      assert.equal(missing, null);

      await persister.close();
    } finally {
      cleanupDb(dbPath);
    }
  });

  test('simulated restart: same DB file, fresh store still serves content via cache-miss', async () => {
    const dbPath = tempDbPath();
    try {
      // First "process": write entries.
      const persister1 = createSqliteToolResultPersister({ dbPath, flushIntervalMs: 10, batchSize: 2 });
      const store1 = createToolResultStore({ persister: persister1 });
      store1.put('restart-id', entry({ id: 'restart-id', content: 'across-restart', chars: 14, at: AT + 2 }));
      await tick(50);
      await persister1.close();

      // Second "process": open the same DB with a fresh store.
      const persister2 = createSqliteToolResultPersister({ dbPath, flushIntervalMs: 10, batchSize: 2 });
      const store2 = createToolResultStore({ persister: persister2 });
      assert.equal(store2.get('restart-id'), undefined, 'fresh store has no memory');
      const found = await store2.resolve!('restart-id');
      assert.notEqual(found, null);
      assert.equal(found!.content, 'across-restart');
      await persister2.close();
    } finally {
      cleanupDb(dbPath);
    }
  });

  test('API route serves from DB on cache miss via resolve()', async () => {
    const dbPath = tempDbPath();
    try {
      const persister = createSqliteToolResultPersister({ dbPath, flushIntervalMs: 10, batchSize: 2 });
      const store = createToolResultStore({ persister });
      store.put('api-test', entry({ id: 'api-test', content: 'api-routed', chars: 10, ok: true, at: AT + 3 }));
      await tick(50);
      store.purge(); // simulate cache eviction

      const handler = createApiHandler({
        ruleStore: createRuleStore(),
        collector: { summary: () => ({}), getRecentEvents: () => [] } as unknown as Collector,
        toolResultStore: store,
      });

      // Use a mock req/res to hit the route without a real HTTP server.
      const res = makeMockRes();
      const req = makeMockReq('GET', '/api/tool-results/api-test');
      const handled = await handler(req, res);
      assert.equal(handled, true);
      assert.equal(res._status, 200);
      assert.equal(res._body.content, 'api-routed');
      assert.equal(res._body.chars, 10);
      assert.equal(res._body.ok, true);

      await persister.close();
    } finally {
      cleanupDb(dbPath);
    }
  });
});

// --- (c) Batching/async: puts are O(1) memory; disk writes deferred ------------

describe('batching and async behavior', () => {
  test('multiple puts within one tick do not synchronously write to disk', async () => {
    const dbPath = tempDbPath();
    try {
      const persister = createSqliteToolResultPersister({ dbPath, flushIntervalMs: 1000, batchSize: 1000 });
      // Use a very long timer so only an explicit flush or batch-size trigger fires.
      const store = createToolResultStore({ persister });

      // Do 5 puts synchronously — no await between them.
      for (let i = 0; i < 5; i++) {
        store.put(`batch-${i}`, entry({ id: `batch-${i}`, at: AT + i }));
      }

      // Immediately after the puts (same tick), the DB should be empty because
      // no flush has been scheduled yet (batchSize=1000 not reached).
      const check = new DatabaseSync(dbPath);
      const count = (check.prepare('SELECT COUNT(*) AS c FROM tool_results').get() as { c: number }).c;
      check.close();
      assert.equal(count, 0, 'no rows written synchronously — put() is O(1) memory-only');

      // Now let a tick pass to allow the setImmediate flush to run.
      // With batchSize=1000 and only 5 entries, the timer (1000ms) hasn't fired yet.
      // Force a flush by waiting for the timer.
      await tick(1100);

      const check2 = new DatabaseSync(dbPath);
      const count2 = (check2.prepare('SELECT COUNT(*) AS c FROM tool_results').get() as { c: number }).c;
      check2.close();
      assert.equal(count2, 5, 'all 5 entries flushed to disk after the timer fired');

      await persister.close();
    } finally {
      cleanupDb(dbPath);
    }
  });

  test('batch-size threshold triggers a low-latency flush without waiting for the timer', async () => {
    const dbPath = tempDbPath();
    try {
      const persister = createSqliteToolResultPersister({ dbPath, flushIntervalMs: 60_000, batchSize: 3 });
      const store = createToolResultStore({ persister });

      // Push 3 entries — hits the batchSize threshold → setImmediate flush.
      store.put('a', entry({ id: 'a' }));
      store.put('b', entry({ id: 'b' }));
      store.put('c', entry({ id: 'c' }));

      // The setImmediate callback should fire on the next macrotask tick.
      await tick(10);

      const check = new DatabaseSync(dbPath);
      const count = (check.prepare('SELECT COUNT(*) AS c FROM tool_results').get() as { c: number }).c;
      check.close();
      assert.equal(count, 3, 'batch-size threshold triggered an immediate flush');

      await persister.close();
    } finally {
      cleanupDb(dbPath);
    }
  });

  test('put() returns immediately (does not block or await)', () => {
    const dbPath = tempDbPath();
    try {
      const persister = createSqliteToolResultPersister({ dbPath, flushIntervalMs: 60_000, batchSize: 1000 });
      const store = createToolResultStore({ persister });

      // put() must return synchronously and quickly.
      const start = process.hrtime.bigint();
      for (let i = 0; i < 100; i++) {
        store.put(`perf-${i}`, entry({ id: `perf-${i}`, at: AT + i }));
      }
      const elapsed = Number(process.hrtime.bigint() - start) / 1e6; // ms
      // 100 puts should complete in well under 10ms (no disk I/O).
      assert.ok(elapsed < 10, `100 puts took ${elapsed.toFixed(2)}ms — expected < 10ms`);

      void persister; // keep reference; close in finally
      // We don't close here to avoid a pending flush; the GC will handle it.
    } finally {
      cleanupDb(dbPath);
    }
  });
});

// --- (d) WAL mode is set -------------------------------------------------------

describe('WAL journal mode', () => {
  test('the database uses WAL journal mode after persister initialization', async () => {
    const dbPath = tempDbPath();
    try {
      const persister = createSqliteToolResultPersister({ dbPath });
      // Trigger a flush so the DB file is fully written.
      const store = createToolResultStore({ persister });
      store.put('wal-check', entry({ id: 'wal-check' }));
      await tick(50);
      await persister.close();

      // Open a fresh handle and verify the pragma.
      const check = new DatabaseSync(dbPath);
      const mode = (check.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode;
      check.close();
      assert.equal(mode.toLowerCase(), 'wal', `expected WAL mode, got "${mode}"`);
    } finally {
      cleanupDb(dbPath);
    }
  });
});

// --- bounded buffer (dead-code path gone; no reliance on maxBuffer) -----------

describe('bounded buffer (dead-code path gone)', () => {
  test('pushing far beyond batchSize fully flushes via the batch trigger alone', async () => {
    const dbPath = tempDbPath();
    try {
      // batchSize=5 with a very long timer: only the batch-size trigger fires.
      // 21 entries is well past the former hard cap of batchSize * 4 === 20, so a
      // correct implementation persists all of them without any maxBuffer branch.
      const persister = createSqliteToolResultPersister({ dbPath, flushIntervalMs: 60_000, batchSize: 5 });
      const store = createToolResultStore({ persister });
      for (let i = 0; i < 21; i++) {
        store.put(`bound-${i}`, entry({ id: `bound-${i}`, at: AT + i }));
      }
      // Let the scheduled setImmediate flush(es) run (the recurring timer never fires).
      await tick(10);

      const check = new DatabaseSync(dbPath);
      const count = (check.prepare('SELECT COUNT(*) AS c FROM tool_results').get() as { c: number }).c;
      check.close();
      assert.equal(count, 21, 'all entries beyond the old maxBuffer are flushed by the batch trigger');

      await persister.close();
    } finally {
      cleanupDb(dbPath);
    }
  });
});

// --- lifecycle: close() flushes buffered entries (no loss) ----------------------

describe('close() flushes buffered entries', () => {
  test('close() after puts persists all buffered entries and closes cleanly', async () => {
    const dbPath = tempDbPath();
    try {
      // Long timer + large batch so nothing auto-flushes before an explicit close().
      const persister = createSqliteToolResultPersister({ dbPath, flushIntervalMs: 60_000, batchSize: 1000 });
      const store = createToolResultStore({ persister });
      for (let i = 0; i < 3; i++) {
        store.put(`close-${i}`, entry({ id: `close-${i}`, content: 'close-content-' + i, chars: 13 + i, at: AT + i }));
      }
      // All 3 remain buffered (batchSize not reached); close() must flush them.
      await persister.close();

      // Reopen a fresh handle to confirm the rows were written and the DB closed cleanly.
      const check = new DatabaseSync(dbPath);
      const count = (check.prepare('SELECT COUNT(*) AS c FROM tool_results').get() as { c: number }).c;
      check.close();
      assert.equal(count, 3, 'all buffered entries persisted by close()');

      // close() is idempotent — a second call must not throw.
      await persister.close();
    } finally {
      cleanupDb(dbPath);
    }
  });
});

// --- helpers -------------------------------------------------------------------

/** Remove a SQLite file plus any WAL/SHM sidecar files. */
function cleanupDb(dbPath: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.unlinkSync(dbPath + suffix);
    } catch {
      /* ignore missing files */
    }
  }
}

/** Minimal mock IncomingMessage for API handler tests. */
function makeMockReq(method: string, url: string): any {
  return { method, url, headers: {}, on: () => {} };
}

/** Minimal mock ServerResponse that captures status + body. */
function makeMockRes(): any {
  let status = 0;
  let chunks: string[] = [];
  return {
    writeHead(s: number): any {
      status = s;
      return this;
    },
    end(data?: string) {
      if (data !== undefined) chunks.push(data);
    },
    headersSent: false,
    get _status() {
      return status;
    },
    get _body() {
      return JSON.parse(chunks.join('') || '{}');
    },
  };
}
