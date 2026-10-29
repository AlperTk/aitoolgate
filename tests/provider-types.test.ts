/**
 * Provider types = adapter ids: the catalog, the v4→v5 remap of existing rows, the protocol
 * derived from the type (never client-supplied), and rejection of unknown types.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { applyMigrations, MIGRATIONS, SCHEMA_VERSION } from '../src/storage/schema';
import {
  DEFAULT_PROVIDER_ADAPTER_ID,
  listProviderTypes,
  lookupProviderAdapter,
  wireProtocolFor,
} from '../src/providers/registry';
import { validateProviderSpec } from '../src/api/providerSpec';
import { createApiProviderStore } from '../src/api/providerStore';
import { createPersistentProviderStore } from '../src/api/persistentProviderStore';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('catalog lists the three provider types with id, label and derived wire protocol', () => {
  const types = listProviderTypes();
  assert.deepEqual(
    types.map((t) => [t.id, t.wireProtocol]),
    [
      ['generic-openai', 'openai'],
      ['generic-anthropic', 'anthropic'],
      ['copilot', 'openai'],
    ],
  );
  for (const t of types) assert.ok(t.label.length > 0, `label for ${t.id}`);
  assert.equal(DEFAULT_PROVIDER_ADAPTER_ID, 'generic-openai');
});

test('the legacy generic id is no longer a registered type; wireProtocolFor derives per type', () => {
  assert.equal(lookupProviderAdapter('generic'), null);
  assert.equal(wireProtocolFor('generic-anthropic'), 'anthropic');
  assert.equal(wireProtocolFor('generic-openai'), 'openai');
  assert.equal(wireProtocolFor('copilot'), 'openai');
  assert.equal(wireProtocolFor('does-not-exist'), 'openai');
});

test('fresh database reaches v5 and migrations are idempotent', () => {
  const db = new DatabaseSync(':memory:');
  try {
    applyMigrations(db);
    applyMigrations(db);
    assert.equal(SCHEMA_VERSION, 5);
    const versions = (db.prepare('SELECT version FROM migrations ORDER BY version').all() as { version: number }[]).map(
      (r) => Number(r.version),
    );
    assert.deepEqual(versions, [1, 2, 3, 4, 5]);
  } finally {
    db.close();
  }
});

test('v4 → v5 remaps generic rows by stored protocol and derives protocol from the type', () => {
  const db = new DatabaseSync(':memory:');
  try {
    // Build a genuine v4 database with one row per legacy shape.
    for (const m of MIGRATIONS.filter((mig) => mig.version <= 4)) db.exec(m.sql);
    db.exec('CREATE TABLE IF NOT EXISTS migrations (version INTEGER PRIMARY KEY)');
    for (const v of [1, 2, 3, 4]) db.prepare('INSERT INTO migrations (version) VALUES (?)').run(v);
    const insert = db.prepare(
      'INSERT INTO api_providers (id, name, base_url, model, api_key, protocol, adapter_id, auth_type, is_active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    insert.run('g-anthropic', 'A', 'http://a/v1', 'm', null, 'anthropic', 'generic', 'apiKey', 1, 1);
    insert.run('g-openai', 'O', 'http://o/v1', 'm', null, 'openai', 'generic', 'apiKey', 0, 2);
    insert.run('copilot', 'C', 'https://github.com', '', null, 'openai', 'copilot', 'deviceOAuth', 0, 3);

    applyMigrations(db);

    const rows = (db.prepare('SELECT id, adapter_id, protocol FROM api_providers ORDER BY id').all() as {
      id: string;
      adapter_id: string;
      protocol: string;
    }[]).map((r) => ({ ...r }));
    assert.deepEqual(rows, [
      { id: 'copilot', adapter_id: 'copilot', protocol: 'openai' },
      { id: 'g-anthropic', adapter_id: 'generic-anthropic', protocol: 'anthropic' },
      { id: 'g-openai', adapter_id: 'generic-openai', protocol: 'openai' },
    ]);
  } finally {
    db.close();
  }
});

test('store derives protocol from the type on add and ignores a client-supplied protocol', () => {
  const store = createApiProviderStore();
  const created = store.add({ name: 'x', baseUrl: 'http://x/v1', adapterId: 'generic-anthropic', protocol: 'openai' });
  assert.equal(created.adapterId, 'generic-anthropic');
  assert.equal(created.protocol, 'anthropic');

  const defaulted = store.add({ name: 'd', baseUrl: 'http://d/v1', protocol: 'anthropic' });
  assert.equal(defaulted.adapterId, 'generic-openai');
  assert.equal(defaulted.protocol, 'openai');

  const patched = store.update(created.id, { adapterId: 'generic-openai' });
  assert.equal(patched?.protocol, 'openai', 'changing the type re-derives the protocol');
});

test('persistent store writes and reads the protocol derived from the type', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'atg-provider-types-'));
  const dbFile = join(dir, 'rules.db');
  try {
    const store = createPersistentProviderStore({ dbFile });
    const created = store.add({ name: 'p', baseUrl: 'http://p/v1', adapterId: 'generic-anthropic', protocol: 'openai' });
    assert.equal(created.protocol, 'anthropic');
    await new Promise((resolve) => setImmediate(resolve)); // writes are best-effort and deferred
    const raw = new DatabaseSync(dbFile);
    try {
      const row = raw.prepare('SELECT protocol FROM api_providers WHERE id = ?').get(created.id) as { protocol: string };
      assert.equal(row.protocol, 'anthropic');
    } finally {
      raw.close();
    }
    const reopened = createPersistentProviderStore({ dbFile });
    assert.equal(reopened.get(created.id)?.protocol, 'anthropic');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the spec accepts a client protocol as ignored input and rejects unknown types', () => {
  assert.equal(validateProviderSpec({ name: 'n', baseUrl: 'http://n/v1', protocol: 'gpt35-turbo' }), null);
  assert.equal(validateProviderSpec({ name: 'n', baseUrl: 'http://n/v1', adapterId: 'copilot' }), null);
  assert.equal(validateProviderSpec({ name: 'n', baseUrl: 'http://n/v1', adapterId: 'generic' }) !== null, true);
  assert.equal(validateProviderSpec({ name: 'n', baseUrl: 'http://n/v1', adapterId: 'missing' }) !== null, true);
  assert.equal(validateProviderSpec({ name: 'n', baseUrl: 'http://n/v1', adapterId: 42 }) !== null, true);
});

test('a copilot spec must be deviceOAuth with no apiKey', () => {
  const base = { name: 'c', baseUrl: 'https://github.com', adapterId: 'copilot' };
  assert.notEqual(validateProviderSpec({ ...base, authType: 'apiKey' }), null, 'POST copilot authType apiKey → 400');
  assert.notEqual(validateProviderSpec({ ...base, authType: 'apiKey', apiKey: null }), null);
  assert.notEqual(validateProviderSpec({ ...base, authType: 'deviceOAuth', apiKey: 'ghp_pasted' }), null, 'POST copilot apiKey string → 400');
  assert.equal(validateProviderSpec({ ...base, authType: 'deviceOAuth' }), null, 'POST copilot deviceOAuth without apiKey → valid');
  assert.equal(validateProviderSpec({ ...base, authType: 'deviceOAuth', apiKey: null }), null);
});

test('a PATCH on a copilot row cannot set apiKey', () => {
  const current = { adapterId: 'copilot', authType: 'deviceOAuth' as const };
  assert.notEqual(validateProviderSpec({ apiKey: 'ghp_pasted' }, current), null, 'PATCH copilot setting apiKey → 400');
  assert.equal(validateProviderSpec({ name: 'renamed' }, current), null);
});

test('a PATCH cannot move a row to copilot without deviceOAuth', () => {
  const current = { adapterId: 'generic-openai', authType: 'apiKey' as const };
  assert.notEqual(validateProviderSpec({ adapterId: 'copilot' }, current), null);
  assert.equal(validateProviderSpec({ adapterId: 'copilot', authType: 'deviceOAuth' }, current), null);
});

test('generic providers keep the apiKey rules', () => {
  assert.equal(validateProviderSpec({ name: 'g', baseUrl: 'http://g/v1', adapterId: 'generic-openai', authType: 'apiKey', apiKey: 'sk-1' }), null);
  assert.equal(validateProviderSpec({ name: 'g', baseUrl: 'http://g/v1', apiKey: 'sk-1' }), null);
  assert.notEqual(validateProviderSpec({ name: 'g', baseUrl: 'http://g/v1', apiKey: 42 }), null);
});
