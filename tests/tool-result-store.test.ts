/**
 * Unit tests for the bounded in-memory {@link createToolResultStore}: put/get round-trip with
 * defensive copies, bounded oldest-by-`at` eviction, optional fire-and-forget persister,
 * TTL sweep, and purge. Mirrors the style of tests/rule-store.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createToolResultStore,
  type ToolResultEntry,
  type ToolResultPersister,
} from '../src/telemetry/toolResultStore';

const entry = (id: string, at: number): ToolResultEntry => ({
  id,
  content: `content-${id}`,
  chars: `content-${id}`.length,
  at,
});

test('put/get round-trips an entry and returns undefined for an unknown id', () => {
  const store = createToolResultStore();
  assert.equal(store.size(), 0);

  store.put('a', entry('a', 1));
  assert.equal(store.size(), 1);
  assert.deepEqual(store.get('a'), entry('a', 1));
  assert.equal(store.get('missing'), undefined);
});

test('accessors return defensive copies (mutating them never corrupts the store)', () => {
  const store = createToolResultStore();
  const source: ToolResultEntry = entry('a', 1);
  store.put('a', source);

  // Mutate the RETURNED copy: the stored entry is unaffected.
  const read = store.get('a');
  assert.ok(read !== undefined);
  read!.content = 'MUTATED';
  assert.equal(store.get('a')!.content, 'content-a');

  // Mutate the ORIGINAL passed-in object: the stored copy is unaffected.
  source.content = 'MUTATED-ORIG';
  assert.equal(store.get('a')!.content, 'content-a');
});

test('the store is bounded: past maxEntries it evicts the OLDEST by `at`', () => {
  const store = createToolResultStore({ maxEntries: 3 });
  // Insertion order differs from `at` order to prove eviction keys on `at`, not insertion.
  store.put('first', entry('first', 400));
  store.put('second', entry('second', 200));
  store.put('third', entry('third', 300));
  assert.equal(store.size(), 3);

  // Adding a fourth evicts the smallest-`at` entry ('second').
  store.put('fourth', entry('fourth', 500));
  assert.equal(store.size(), 3);
  assert.equal(store.get('second'), undefined, 'oldest-by-at entry was evicted');
  assert.notEqual(store.get('first'), undefined);
  assert.notEqual(store.get('third'), undefined);
  assert.notEqual(store.get('fourth'), undefined);
});

test('re-putting an existing id updates in place without growing the store', () => {
  const store = createToolResultStore({ maxEntries: 2 });
  store.put('a', entry('a', 1));
  store.put('b', entry('b', 2));
  assert.equal(store.size(), 2);
  store.put('a', { ...entry('a', 1), content: 'updated' });
  assert.equal(store.size(), 2);
  assert.equal(store.get('a')!.content, 'updated');
});

test('default maxEntries is 1000 (bounded even with no options)', () => {
  const store = createToolResultStore();
  for (let i = 0; i < 1001; i += 1) {
    store.put(`id-${i}`, entry(`id-${i}`, i));
  }
  assert.equal(store.size(), 1000);
  assert.equal(store.get('id-0'), undefined, 'oldest evicted under the default bound');
  assert.notEqual(store.get('id-1000'), undefined);
});

test('an optional persister is invoked fire-and-forget on every put (and never blocks/throws the caller)', () => {
  const persisted: ToolResultEntry[] = [];
  const persister: ToolResultPersister = {
    persist: (e: ToolResultEntry) => {
      persisted.push(e);
    },
  };
  const store = createToolResultStore({ persister });
  const source: ToolResultEntry = entry('a', 1);
  store.put('a', source);

  assert.equal(persisted.length, 1);
  assert.deepEqual(persisted[0], source);
  // The persister receives its OWN copy — mutating it does not affect the store.
  persisted[0].content = 'MUTATED-PERSISTED';
  assert.equal(store.get('a')!.content, 'content-a');

  // A throwing/async-rejecting persister must never break put() or drop the stored entry.
  const flakyStore = createToolResultStore({
    persister: {
      persist(): unknown {
        return Promise.reject(new Error('boom'));
      },
    },
  });
  flakyStore.put('x', entry('x', 2));
  assert.notEqual(flakyStore.get('x'), undefined);
});

test('TTL sweep drops entries older than ttlMs (lazy, on access) while keeping fresh ones', () => {
  const now = Date.now();
  const store = createToolResultStore({ ttlMs: 100 });
  store.put('old', { id: 'old', content: 'o', chars: 1, at: now - 5_000 }); // far past cutoff
  store.put('fresh', { id: 'fresh', content: 'f', chars: 1, at: now });
  // 'old' is beyond `now - ttlMs`; the next access sweeps it, leaving only 'fresh'.
  assert.equal(store.size(), 1);
  assert.equal(store.get('old'), undefined);
  assert.notEqual(store.get('fresh'), undefined);
});

test('without a TTL configured, entries are retained indefinitely (until eviction/purge)', () => {
  const store = createToolResultStore({ maxEntries: 10 });
  store.put('a', entry('a', 1));
  store.put('b', entry('b', 2));
  assert.equal(store.size(), 2);
  assert.notEqual(store.get('a'), undefined);
  assert.notEqual(store.get('b'), undefined);
});

test('purge removes every entry and resets the size to zero', () => {
  const store = createToolResultStore();
  store.put('a', entry('a', 1));
  store.put('b', entry('b', 2));
  assert.equal(store.size(), 2);
  store.purge();
  assert.equal(store.size(), 0);
  assert.equal(store.get('a'), undefined);
  assert.equal(store.get('b'), undefined);
});
