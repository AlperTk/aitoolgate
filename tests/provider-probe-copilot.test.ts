import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type AtgServer } from '../src/server/index';
import { closeAtgServer } from './helpers';
import { createRuleStore } from '../src/api/ruleStore';
import { createApiProviderStore, type ApiProviderStore } from '../src/api/providerStore';
import { serializeAuthState } from '../src/providers/auth/deviceOAuth';

/** Coverage for the probe-by-id path (copilot listModels), credential exposure on provider routes, and the generic inline probe. */

const TOKEN = 'gho_probe_copilot_secret_token';
const API_KEY = 'sk-probe-inline-key-456';
const MODELS = { data: [{ id: 'gpt-4o' }, { id: 'claude-3.5' }, { id: 'gpt-4o' }] };
const realFetch = globalThis.fetch;

interface UpstreamCall {
  url: string;
  headers: Record<string, string>;
}

type Body = Record<string, any>;

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Intercept only https upstream calls (the test's own requests go to 127.0.0.1 and pass through). */
function stubUpstream(calls: UpstreamCall[], respond: () => Response): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (!url.startsWith('https://')) return realFetch(input, init);
    calls.push({ url, headers: { ...((init?.headers ?? {}) as Record<string, string>) } });
    return respond();
  }) as typeof fetch;
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
}

async function start(store: ApiProviderStore): Promise<{ port: number; srv: AtgServer }> {
  const srv = createServer(
    0,
    { upstream: { baseUrl: 'http://127.0.0.1:1/v1', model: 'm', protocol: 'openai' } },
    { ruleStore: createRuleStore(), ws: false, apiProviderStore: store },
  );
  await new Promise<void>((resolve, reject) => {
    if (srv.listening) resolve();
    else {
      srv.once('listening', () => resolve());
      srv.once('error', reject);
    }
  });
  const addr = srv.address();
  if (addr === null || typeof addr !== 'object') throw new Error('server did not bind a TCP port');
  return { port: addr.port, srv };
}

async function call(port: number, method: string, path: string, body?: unknown): Promise<{ status: number; text: string; json: Body }> {
  const res = await realFetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text, json: text.length > 0 ? (JSON.parse(text) as Body) : {} };
}

function seedCopilot(store: ApiProviderStore, apiKey: string | null = null) {
  return store.add({
    name: 'GitHub Copilot',
    baseUrl: 'https://github.com',
    model: null,
    adapterId: 'copilot',
    authType: 'deviceOAuth',
    authState: serializeAuthState({ accessToken: TOKEN }),
    apiKey,
    isActive: true,
  });
}

test('copilot probe by id lists models through the copilot header set with the stored token', async () => {
  const store = createApiProviderStore();
  const row = seedCopilot(store);
  const calls: UpstreamCall[] = [];
  stubUpstream(calls, () => jsonResponse(MODELS));
  const { port, srv } = await start(store);
  try {
    const res = await call(port, 'POST', '/api/api-providers/probe', { id: row.id });
    assert.equal(res.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.githubcopilot.com/models');
    assert.equal(calls[0].headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(calls[0].headers['Openai-Intent'], 'conversation-edits');
    assert.equal(calls[0].headers['User-Agent'], 'aitoolgate/1.0');
    assert.equal(res.json.ok, true);
    assert.deepEqual(res.json.models, ['claude-3.5', 'gpt-4o']);
    assert.equal(res.text.includes(TOKEN), false, 'probe response must not contain the token');
  } finally {
    await closeAtgServer(srv);
  }
});

test('copilot probe errors are redacted: upstream body and thrown messages never echo the token', async () => {
  const store = createApiProviderStore();
  const row = seedCopilot(store);
  const { port, srv } = await start(store);
  try {
    const calls: UpstreamCall[] = [];
    stubUpstream(calls, () => new Response(`denied for ${TOKEN}`, { status: 401 }));
    const denied = await call(port, 'POST', '/api/api-providers/probe', { id: row.id });
    assert.equal(denied.status, 200);
    assert.equal(denied.json.ok, false);
    assert.equal(denied.json.status, 401);
    assert.equal(denied.json.error, 'upstream responded 401');
    assert.equal(denied.text.includes(TOKEN), false);

    stubUpstream(calls, () => {
      throw new Error(`socket hang up while using ${TOKEN}`);
    });
    const thrown = await call(port, 'POST', '/api/api-providers/probe', { id: row.id });
    assert.equal(thrown.json.ok, false);
    assert.ok(String(thrown.json.error).includes('***'));
    assert.equal(thrown.text.includes(TOKEN), false);
  } finally {
    await closeAtgServer(srv);
  }
});

test('probe by unknown id answers 404 JSON; saved probe ignores client-supplied credentials', async () => {
  const store = createApiProviderStore();
  const row = seedCopilot(store);
  const calls: UpstreamCall[] = [];
  stubUpstream(calls, () => jsonResponse(MODELS));
  const { port, srv } = await start(store);
  try {
    const missing = await call(port, 'POST', '/api/api-providers/probe', { id: 'nope' });
    assert.equal(missing.status, 404);
    assert.equal(missing.json.error, 'not_found');

    const withBodyKey = await call(port, 'POST', '/api/api-providers/probe', { id: row.id, apiKey: 'client-token' });
    assert.equal(withBodyKey.status, 200);
    assert.equal(calls[0].headers.Authorization, `Bearer ${TOKEN}`);
  } finally {
    await closeAtgServer(srv);
  }
});

test('GET list and detail of a copilot row never expose authState or any apiKey', async () => {
  const store = createApiProviderStore();
  const row = seedCopilot(store, 'sk-leaked-on-copilot');
  const { port, srv } = await start(store);
  try {
    const list = await call(port, 'GET', '/api/api-providers');
    assert.equal(list.status, 200);
    const listed = list.json.providers.find((p: Body) => p.id === row.id);
    assert.ok(listed);
    assert.equal('authState' in listed, false);
    assert.equal('apiKey' in listed, false);
    assert.equal(listed.apiKeySet, false);

    const detail = await call(port, 'GET', `/api/api-providers/${row.id}`);
    assert.equal(detail.status, 200);
    assert.equal('authState' in detail.json, false);
    assert.equal(detail.json.apiKey, null);
    for (const text of [list.text, detail.text]) {
      assert.equal(text.includes(TOKEN), false);
      assert.equal(text.includes('sk-leaked-on-copilot'), false);
    }
  } finally {
    await closeAtgServer(srv);
  }
});

test('PATCH apiKey on a copilot (deviceOAuth) row is rejected with 400 JSON and nothing is written', async () => {
  const store = createApiProviderStore();
  const row = seedCopilot(store);
  const { port, srv } = await start(store);
  try {
    const res = await call(port, 'PATCH', `/api/api-providers/${row.id}`, { apiKey: 'sk-written-by-patch' });
    assert.equal(res.status, 400);
    assert.equal(typeof res.json.error, 'string');
    assert.equal(res.text.includes('sk-written-by-patch'), false);

    const detail = await call(port, 'GET', `/api/api-providers/${row.id}`);
    assert.equal(detail.json.apiKey, null);
    assert.equal(detail.text.includes('sk-written-by-patch'), false);
    assert.equal(store.get(row.id)?.apiKey, null);
  } finally {
    await closeAtgServer(srv);
  }
});

test('generic inline probe keeps the protocol auth header and the /v1/models URL', async () => {
  const store = createApiProviderStore();
  const calls: UpstreamCall[] = [];
  stubUpstream(calls, () => jsonResponse(MODELS));
  const { port, srv } = await start(store);
  try {
    const res = await call(port, 'POST', '/api/api-providers/probe', {
      protocol: 'openai',
      baseUrl: 'https://api.example.com',
      apiKey: API_KEY,
    });
    assert.equal(res.status, 200);
    assert.equal(calls[0].url, 'https://api.example.com/v1/models');
    assert.equal(calls[0].headers.Authorization, `Bearer ${API_KEY}`);
    assert.deepEqual(res.json.models, ['claude-3.5', 'gpt-4o']);
    assert.equal(res.text.includes(API_KEY), false);
  } finally {
    await closeAtgServer(srv);
  }
});
