/**
 * "From Request" provider model: a provider with `model: null` must not override the client's model
 * (wire null ↔ storage ''), while a concrete model keeps overriding.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createServer, type AtgServer } from '../src/server/index';
import { createRuleStore } from '../src/api/ruleStore';
import { createApiProviderStore } from '../src/api/providerStore';
import { createPersistentProviderStore } from '../src/api/persistentProviderStore';
import { validateProviderSpec } from '../src/api/providerSpec';
import { closeAtgServer } from './helpers';

function startMockUpstream(): Promise<{ url: string; bodies: string[]; close: () => Promise<void> }> {
  const bodies: string[] = [];
  const server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (chunk: Buffer) => {
      data += chunk.toString('utf8');
    });
    req.on('end', () => {
      bodies.push(data);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'chatcmpl-mock',
          object: 'chat.completion',
          created: 1,
          model: 'mock',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr === null || typeof addr !== 'object') return reject(new Error('no port'));
      resolve({
        url: `http://127.0.0.1:${addr.port}/v1`,
        bodies,
        close: async () => {
          server.closeAllConnections();
          await new Promise<void>((r) => server.close(() => r()));
        },
      });
    });
  });
}

async function startServer(upstreamUrl: string): Promise<{ port: number; srv: AtgServer }> {
  const srv = createServer(0, {
    upstream: { baseUrl: upstreamUrl, model: 'seed-model', protocol: 'openai' },
  }, { ruleStore: createRuleStore(), ws: false });
  if (!srv.listening) await new Promise<void>((resolve) => srv.once('listening', () => resolve()));
  const addr = srv.address();
  if (addr === null || typeof addr !== 'object') throw new Error('server did not bind');
  return { port: addr.port, srv };
}

test('validation accepts null and strings for model, rejects other types', () => {
  assert.equal(validateProviderSpec({ model: null }), null);
  assert.equal(validateProviderSpec({ model: 'gpt-x' }), null);
  assert.equal(validateProviderSpec({ model: '' }), null);
  assert.equal(validateProviderSpec({ model: 42 }), '"model" must be a string or null');
});

test('in-memory store defaults model to null and keeps null on update', () => {
  const store = createApiProviderStore();
  const created = store.add({ name: 'p', baseUrl: 'http://x/v1', protocol: 'openai' });
  assert.equal(created.model, null);
  const updated = store.update(created.id, { model: null });
  assert.equal(updated?.model, null);
});

test('persistent store round-trips null (stored as "" and read back as null)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'atg-from-request-'));
  const dbFile = join(dir, 'rules.db');
  try {
    const store = createPersistentProviderStore({ dbFile });
    const created = store.add({ name: 'p', baseUrl: 'http://x/v1', model: null, protocol: 'openai' });
    await new Promise((resolve) => setImmediate(resolve));

    const db = new DatabaseSync(dbFile);
    try {
      const row = db.prepare('SELECT model FROM api_providers WHERE id = ?').get(created.id) as { model: string };
      assert.equal(row.model, '');
    } finally {
      db.close();
    }

    const reopened = createPersistentProviderStore({ dbFile });
    assert.equal(reopened.get(created.id)?.model, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('PATCH with model null stores null, never the string "null"', async () => {
  const upstream = await startMockUpstream();
  const { port, srv } = await startServer(upstream.url);
  try {
    const base = `http://127.0.0.1:${port}/api/api-providers`;
    const created = (await (await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'p', baseUrl: upstream.url, protocol: 'openai', model: 'concrete' }),
    })).json()) as { id: string; model: string | null };
    assert.equal(created.model, 'concrete');

    const patched = (await (await fetch(`${base}/${created.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: null }),
    })).json()) as { model: string | null };
    assert.equal(patched.model, null);
  } finally {
    await closeAtgServer(srv);
    await upstream.close();
  }
});

test('POST without model yields null; active null-model provider forwards the client model unchanged', async () => {
  const upstream = await startMockUpstream();
  const { port, srv } = await startServer(upstream.url);
  try {
    const base = `http://127.0.0.1:${port}/api/api-providers`;
    const created = (await (await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'from-request', baseUrl: upstream.url, protocol: 'openai' }),
    })).json()) as { id: string; model: string | null };
    assert.equal(created.model, null);

    const activated = await fetch(`${base}/${created.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isActive: true }),
    });
    assert.equal(activated.status, 200);

    const chat = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'client-model', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(chat.status, 200);
    await chat.text();
    assert.equal(upstream.bodies.length, 1);
    assert.equal((JSON.parse(upstream.bodies[0]) as { model: string }).model, 'client-model');

    // Control: a concrete model still overrides the client's model.
    await fetch(`${base}/${created.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'concrete-override', isActive: true }),
    });
    const chat2 = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'client-model', messages: [{ role: 'user', content: 'hi' }] }),
    });
    await chat2.text();
    assert.equal((JSON.parse(upstream.bodies[1]) as { model: string }).model, 'concrete-override');
  } finally {
    await closeAtgServer(srv);
    await upstream.close();
  }
});
