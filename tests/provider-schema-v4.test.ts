/**
 * Schema v4 coverage for api_providers: fresh + v3-upgrade migrations (existing rows get
 * adapterId `generic` / authType `apiKey`), opaque authState round-trip, adapter/authType
 * validation, and that no provider HTTP response serializes authState.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { applyMigrations, MIGRATIONS, SCHEMA_VERSION } from '../src/storage/schema';
import { createPersistentProviderStore } from '../src/api/persistentProviderStore';
import { createApiProviderStore } from '../src/api/providerStore';
import type { ApiProvider } from '../src/api/providerSpec';
import { validateProviderSpec } from '../src/api/providerSpec';
import { createApiHandler } from '../src/api/http';
import { createRuleStore } from '../src/api/ruleStore';
import { createCollector } from '../src/telemetry/collector';
import { createEventBus } from '../src/telemetry/event-bus';

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function columnNames(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
}

function withTempDb(run: (dbFile: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'atg-provider-v4-'));
  return run(join(dir, 'rules.db')).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test('fresh database migrates to v4 with the adapter/auth columns', () => {
  const db = new DatabaseSync(':memory:');
  try {
    applyMigrations(db);
    assert.equal(SCHEMA_VERSION, 5);
    const versions = (db.prepare('SELECT version FROM migrations ORDER BY version').all() as { version: number }[]).map(
      (r) => Number(r.version),
    );
    assert.deepEqual(versions, [1, 2, 3, 4, 5]);
    const cols = columnNames(db, 'api_providers');
    for (const col of ['adapter_id', 'auth_type', 'auth_state']) assert.ok(cols.includes(col), `missing ${col}`);
  } finally {
    db.close();
  }
});

test('a v3 database upgrades to v4 with existing rows intact and defaults applied', () =>
  withTempDb(async (dbFile) => {
    // Build a genuine v3 database: migrations 1..3 only, with one pre-existing provider row.
    const legacy = new DatabaseSync(dbFile);
    try {
      for (const m of MIGRATIONS.filter((mig) => mig.version <= 3)) legacy.exec(m.sql);
      legacy.exec('CREATE TABLE IF NOT EXISTS migrations (version INTEGER PRIMARY KEY)');
      for (const v of [1, 2, 3]) legacy.prepare('INSERT INTO migrations (version) VALUES (?)').run(v);
      legacy
        .prepare(
          'INSERT INTO api_providers (id, name, base_url, model, api_key, protocol, is_active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run('legacy-1', 'Legacy', 'http://legacy.local/v1', 'gpt-x', 'sk-legacy', 'anthropic', 1, 42);
    } finally {
      legacy.close();
    }

    // Opening through the persistent store runs the auto-applied migration.
    const store = createPersistentProviderStore({ dbFile });
    const migrated = store.get('legacy-1');
    assert.ok(migrated !== undefined);
    assert.equal(migrated.name, 'Legacy');
    assert.equal(migrated.baseUrl, 'http://legacy.local/v1');
    assert.equal(migrated.model, 'gpt-x');
    assert.equal(migrated.apiKey, 'sk-legacy');
    assert.equal(migrated.protocol, 'anthropic');
    assert.equal(migrated.isActive, true);
    assert.equal(migrated.createdAt, 42);
    assert.equal(migrated.adapterId, 'generic-anthropic');
    assert.equal(migrated.authType, 'apiKey');
    assert.equal(migrated.authState, null);

    const raw = new DatabaseSync(dbFile);
    try {
      const row = raw.prepare('SELECT adapter_id, auth_type, auth_state FROM api_providers WHERE id = ?').get('legacy-1') as {
        adapter_id: string;
        auth_type: string;
        auth_state: string | null;
      };
      assert.equal(row.adapter_id, 'generic-anthropic');
      assert.equal(row.auth_type, 'apiKey');
      assert.equal(row.auth_state, null);
    } finally {
      raw.close();
    }
  }));

test('adapterId, authType and opaque authState round-trip through the persistent store', () =>
  withTempDb(async (dbFile) => {
    const opaque = '{"accessToken":"gho_example","expiresAt":123}';
    const store = createPersistentProviderStore({ dbFile });
    const added = store.add({
      name: 'oauth',
      baseUrl: 'http://oauth.local/v1',
      protocol: 'openai',
      adapterId: 'generic-openai',
      authType: 'deviceOAuth',
      authState: opaque,
    });
    await flush();

    const reopened = createPersistentProviderStore({ dbFile });
    const restored = reopened.get(added.id);
    assert.equal(restored?.adapterId, 'generic-openai');
    assert.equal(restored?.authType, 'deviceOAuth');
    assert.equal(restored?.authState, opaque);
  }));

test('validateProviderSpec enforces adapterId and authType rules', () => {
  assert.equal(validateProviderSpec({ name: 'a', baseUrl: 'http://x' }), null);
  assert.equal(validateProviderSpec({ adapterId: 'generic-openai' }), null);
  assert.equal(validateProviderSpec({ authType: 'apiKey' }), null);
  assert.equal(validateProviderSpec({ authType: 'deviceOAuth' }), null);
  assert.notEqual(validateProviderSpec({ authType: 'bogus' }), null);
  assert.notEqual(validateProviderSpec({ authType: null }), null);
  assert.notEqual(validateProviderSpec({ adapterId: '' }), null);
  assert.notEqual(validateProviderSpec({ adapterId: 42 }), null);
  assert.notEqual(validateProviderSpec({ adapterId: 'no-such-adapter' }), null);
});

test('store defaults adapterId to generic and authType to apiKey when absent', () => {
  const store = createApiProviderStore();
  const created = store.add({ name: 'a', baseUrl: 'http://a/v1', protocol: 'openai' });
  assert.equal(created.adapterId, 'generic-openai');
  assert.equal(created.authType, 'apiKey');
  assert.equal(created.authState, null);
});

const SECRET_STATE = '{"accessToken":"SECRET-TOKEN-XYZ"}';

function seededProvider(): ApiProvider {
  return {
    id: 'p1',
    name: 'Copilot-like',
    baseUrl: 'http://p.local/v1',
    model: null,
    apiKey: 'sk-visible-to-detail-only',
    protocol: 'openai',
    adapterId: 'generic-openai',
    authType: 'deviceOAuth',
    authState: SECRET_STATE,
    isActive: true,
    createdAt: 1,
  };
}

async function withProviderApi(store: ReturnType<typeof createApiProviderStore>, run: (base: string) => Promise<void>) {
  const handler = createApiHandler({
    ruleStore: createRuleStore(),
    collector: createCollector({ bus: createEventBus() }),
    apiProviderStore: store,
  });
  const srv = http.createServer((req, res) => {
    void (async () => {
      const handled = await handler(req, res);
      if (!handled) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not_found' }));
      }
    })();
  });
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', () => resolve()));
  const port = (srv.address() as AddressInfo).port;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    srv.closeAllConnections();
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }
}

test('list responses never include authState; detail omits it too', async () => {
  const store = createApiProviderStore({ initial: [seededProvider()] });
  await withProviderApi(store, async (base) => {
    const listRes = await fetch(`${base}/api/api-providers`);
    const listText = await listRes.text();
    assert.equal(listRes.status, 200);
    assert.equal(listText.includes('authState'), false);
    assert.equal(listText.includes('SECRET-TOKEN-XYZ'), false);
    const list = JSON.parse(listText) as { providers: Record<string, unknown>[] };
    assert.equal(list.providers[0].adapterId, 'generic-openai');
    assert.equal(list.providers[0].authType, 'deviceOAuth');

    const detailRes = await fetch(`${base}/api/api-providers/p1`);
    const detailText = await detailRes.text();
    assert.equal(detailRes.status, 200);
    assert.equal(detailText.includes('authState'), false);
    assert.equal(detailText.includes('SECRET-TOKEN-XYZ'), false);
  });
});

test('POST/PATCH accept adapterId and authType and reject invalid values', async () => {
  const store = createApiProviderStore();
  await withProviderApi(store, async (base) => {
    const post = (body: unknown) =>
      fetch(`${base}/api/api-providers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    const created = await post({ name: 'n', baseUrl: 'http://n/v1', adapterId: 'generic-openai', authType: 'deviceOAuth' });
    assert.equal(created.status, 201);
    const createdBody = (await created.json()) as Record<string, unknown>;
    assert.equal(createdBody.adapterId, 'generic-openai');
    assert.equal(createdBody.authType, 'deviceOAuth');
    assert.equal('authState' in createdBody, false);

    assert.equal((await post({ name: 'n', baseUrl: 'http://n/v1', authType: 'bogus' })).status, 400);
    assert.equal((await post({ name: 'n', baseUrl: 'http://n/v1', adapterId: 'missing' })).status, 400);

    const id = (createdBody as { id: string }).id;
    const patched = await fetch(`${base}/api/api-providers/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ authType: 'apiKey' }),
    });
    assert.equal(patched.status, 200);
    assert.equal(((await patched.json()) as Record<string, unknown>).authType, 'apiKey');
  });
});
