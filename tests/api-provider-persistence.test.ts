/**
 * Persistence coverage for the active provider selection: the DB must hold exactly one
 * `is_active=1` row after a switch or a remove-promotion, and a re-opened store must restore it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createPersistentProviderStore } from '../src/api/persistentProviderStore';

/** Let queued microtask persistence writes land. */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function activeRowIds(dbFile: string): string[] {
  const db = new DatabaseSync(dbFile);
  try {
    const rows = db.prepare('SELECT id FROM api_providers WHERE is_active = 1').all() as { id: string }[];
    return rows.map((row) => row.id);
  } finally {
    db.close();
  }
}

function withTempDb(run: (dbFile: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'atg-provider-persist-'));
  return run(join(dir, 'rules.db')).finally(() => rmSync(dir, { recursive: true, force: true }));
}

const sample = (name: string) => ({ name, baseUrl: `http://${name}.local`, model: 'm' });

test('persisted active switch survives restart with exactly one active row in DB', () =>
  withTempDb(async (dbFile) => {
    const store = createPersistentProviderStore({ dbFile });
    const first = store.add(sample('first'));
    const second = store.add(sample('second'));
    assert.equal(store.setActive(second.id), true);
    await flush();

    assert.deepEqual(activeRowIds(dbFile), [second.id]);

    const reopened = createPersistentProviderStore({ dbFile });
    assert.equal(reopened.getActive()?.id, second.id);
    assert.equal(reopened.get(first.id)?.isActive, false);
  }));

test('removing the active row promotes a remaining provider and persists it', () =>
  withTempDb(async (dbFile) => {
    const store = createPersistentProviderStore({ dbFile });
    const first = store.add(sample('first'));
    const second = store.add(sample('second'));
    const third = store.add(sample('third'));
    assert.equal(store.getActive()?.id, first.id);
    await flush();

    assert.equal(store.remove(first.id), true);
    const expectedPromoted = [second.id, third.id].sort()[0];
    await flush();

    assert.deepEqual(activeRowIds(dbFile), [expectedPromoted]);

    const reopened = createPersistentProviderStore({ dbFile });
    assert.equal(reopened.getActive()?.id, expectedPromoted);
    assert.equal(reopened.get(first.id), undefined);
  }));
