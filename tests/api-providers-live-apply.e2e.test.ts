/**
 * Backend end-to-end spec for the `/api/api-providers/*` REST feature, driven over
 * REAL local sockets (no mocked fetchers, no setTimeout/sleeps): every client request
 * goes client → real proxy HTTP server → (for chat traffic) a real mock-upstream HTTP
 * server, and every provider mutation goes through the PUBLIC REST routes on a live
 * `createServer` instance. Mirrors the style of tests/e2e-full-stack.test.ts and
 * tests/e2e-integration.test.ts.
 *
 * Covers:
 *   (a) all five /api/api-providers/* endpoints with their real status codes
 *   (b) key-masking: a stored secret apiKey never leaks in the list, appears exactly in
 *       the detail GET-by-id response
 *   (c) the single-active invariant across sequential REAL requests
 *   (d) deleting the active provider auto-promotes the lowest-id remaining row
 *   (e) LIVE-APPLY-WITHOUT-RESTART: switching the active provider via REST only re-routes
 *       subsequent real proxy chat requests to a different mock upstream, zero restarts
 *
 * NOTE: `createServer` always auto-seeds exactly ONE active "default" provider row from
 * the effective upstream snapshot (see src/server/index.ts). That seeded row is the
 * auto-first ("create-first auto-active") row; any explicit POST into a non-empty store
 * is default-inactive. All assertions below reflect that actual on-disk behavior.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createServer, type McmServer } from '../src/server/index';
import { closeMcmServer } from './helpers';
import { createRuleStore } from '../src/api/ruleStore';

type ServerOpts = Parameters<typeof createServer>[1];
type MountOpts = Parameters<typeof createServer>[2];

// --- shape of a provider row as it appears over the wire ---------------------
interface ProviderRow {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  protocol: string;
  isActive: boolean;
  /** Present (string) ONLY on the unmasked detail response. */
  apiKey?: string | null;
  /** Present ONLY on the masked list response. */
  apiKeySet?: boolean;
}
interface ListResponse {
  providers: ProviderRow[];
  activeId: string | null;
}

// --- mock upstream: a REAL local HTTP server (never a mocked fetcher) --------
interface MockUpstream {
  port: number;
  /** e.g. http://127.0.0.1:PORT/v1 */
  url: string;
  requests: { method: string; url: string; body: string }[];
  close(): Promise<void>;
}

async function createMockUpstream(name: string): Promise<MockUpstream> {
  const requests: MockUpstream['requests'] = [];
  const server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (chunk: Buffer) => {
      data += chunk.toString('utf8');
    });
    req.on('end', () => {
      requests.push({ method: req.method ?? 'GET', url: req.url ?? '/', body: data });
      // A valid non-streaming OpenAI chat completion so the proxy returns 200.
      const responseBody = JSON.stringify({
        id: `chatcmpl-${name}`,
        object: 'chat.completion',
        created: 1,
        model: `${name}-model`,
        choices: [{ index: 0, message: { role: 'assistant', content: `echo from ${name}` }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(responseBody);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  if (addr === null || typeof addr !== 'object') throw new Error('mock upstream did not bind a port');
  return {
    port: addr.port,
    url: `http://127.0.0.1:${addr.port}/v1`,
    requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

// --- server lifecycle --------------------------------------------------------
async function startServer(opts: ServerOpts, mount?: MountOpts): Promise<{ port: number; srv: McmServer }> {
  const srv = createServer(0, opts, mount); // auto-listens on an ephemeral port
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

/** A harmless upstream used to keep the provider store in-memory (no caller-upstream → no SQLite). */
const DUMMY_UPSTREAM: ServerOpts = { upstream: { baseUrl: 'http://127.0.0.1:1/v1', model: 'm', protocol: 'openai' } };
/** A mount that keeps the rule store in-memory and disables the WS layer (no disk, no lingering sockets). */
const IN_MEMORY_MOUNT: MountOpts = { ruleStore: createRuleStore(), ws: false };
/** The base URL of the provider registry on a given port. */
const api = (port: number): string => `http://127.0.0.1:${port}/api/api-providers`;
/** A POST/patch JSON helper (real local fetch over a real socket). */
function post(port: number, path: string, body: Record<string, unknown>, method: 'POST' | 'PATCH' = 'POST'): Promise<Response> {
  return fetch(`${api(port)}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// --- (a) + (b): all five endpoints, real status codes, and key-masking ------
test('api-providers: all five /api/api-providers/* endpoints return their real status codes', async () => {
  const { port, srv } = await startServer(DUMMY_UPSTREAM, IN_MEMORY_MOUNT);
  const base = api(port);
  try {
    const SECRET = 'sk-distinctive-SUPERSECRET-xyz123';

    // (a) POST create → 201, returns the full row (incl. the raw apiKey).
    const createRes = await post(port, '', {
      name: 'secret-prov',
      baseUrl: 'http://secret.local/v1',
      model: 'secret-model',
      apiKey: SECRET,
      protocol: 'openai',
    });
    assert.equal(createRes.status, 201, 'POST create must be 201');
    const created = (await createRes.json()) as ProviderRow;
    assert.ok(typeof created.id === 'string' && created.id.length > 0, 'the created row carries a store-assigned id');
    assert.equal(created.apiKey, SECRET, 'the POST create response exposes the full apiKey');

    // (a)+(b) GET list → 200, MASKED (no raw apiKey anywhere; apiKeySet flag only).
    const listRes = await fetch(base);
    assert.equal(listRes.status, 200, 'GET list must be 200');
    const listBody = (await listRes.json()) as ListResponse;
    const listJson = JSON.stringify(listBody);
    const entry = listBody.providers.find((p) => p.id === created.id);
    assert.ok(entry !== undefined, 'the created provider appears in the list');
    assert.equal(entry.apiKeySet, true, 'the list row exposes apiKeySet=true for the secret provider');
    assert.ok(!('apiKey' in entry), 'the list row never carries the raw apiKey field');
    assert.ok(!listJson.includes(SECRET), 'the secret apiKey never appears in the list response');

    // (a)+(b) GET by id → 200, FULL (the secret appears exactly here).
    const detailRes = await fetch(`${base}/${created.id}`);
    assert.equal(detailRes.status, 200, 'GET by id must be 200');
    const detail = (await detailRes.json()) as ProviderRow;
    assert.equal(detail.apiKey, SECRET, 'the detail GET-by-id response carries the exact secret apiKey');

    // (a) PATCH by id → 200.
    const patchRes = await post(port, `/${created.id}`, { name: 'renamed' }, 'PATCH');
    assert.equal(patchRes.status, 200, 'PATCH must be 200');
    const patched = (await patchRes.json()) as ProviderRow;
    assert.equal(patched.name, 'renamed', 'the PATCH response reflects the rename');

    // (a) DELETE by id → 200.
    const delRes = await fetch(`${base}/${created.id}`, { method: 'DELETE' });
    assert.equal(delRes.status, 200, 'DELETE must be 200');
    assert.equal(((await delRes.json()) as { deleted: boolean }).deleted, true, 'the DELETE response carries deleted:true');

    // (a) GET an unknown id → 404.
    assert.equal((await fetch(`${base}/does-not-exist`)).status, 404, 'GET an unknown id must be 404');

    // (a) PATCH an unknown id → 404.
    assert.equal((await post(port, '/does-not-exist', { name: 'x' }, 'PATCH')).status, 404, 'PATCH an unknown id must be 404');

    // (a) POST a degenerate body (missing required fields) → 400.
    assert.equal((await post(port, '', { name: '' })).status, 400, 'POST with a degenerate body must be 400');
  } finally {
    await closeMcmServer(srv);
  }
});

// --- (c): single-active invariant across sequential REAL requests ------------
test('api-providers: the single-active invariant holds across sequential real requests', async () => {
  const { port, srv } = await startServer(DUMMY_UPSTREAM, IN_MEMORY_MOUNT);
  const base = api(port);
  try {
    // The server auto-seeds exactly one active "default" row (the auto-first /
    // "create-first auto-active" row).
    const boot = (await (await fetch(base)).json()) as ListResponse;
    assert.equal(boot.providers.length, 1, 'the store starts with exactly the one seeded row');
    assert.ok(boot.providers[0].isActive, 'the seeded first row is auto-active (create-first auto-active)');
    assert.equal(boot.activeId, boot.providers[0].id, 'the seeded row is the single active id');

    // "create-second": a POST into a non-empty store is default-inactive.
    const created = (await (await post(port, '', {
      name: 'second-prov',
      baseUrl: 'http://second.local/v1',
      model: 'second-model',
      protocol: 'openai',
    })).json()) as ProviderRow;
    assert.ok(!created.isActive, 'create-second is default-inactive (the store was non-empty)');

    const afterCreate = (await (await fetch(base)).json()) as ListResponse;
    assert.equal(afterCreate.providers.length, 2, 'two rows exist now');
    assert.equal(afterCreate.providers.find((p) => p.id === created.id)?.isActive, false, 'create-second is still inactive in the list');
    assert.equal(afterCreate.activeId, boot.providers[0].id, 'the seeded row is still the single active id');

    // PATCH the second row active → exactly one active, and it is the NEW id.
    const patchRes = await post(port, `/${created.id}`, { isActive: true }, 'PATCH');
    assert.equal(patchRes.status, 200, 'PATCH isActive:true must be 200');
    assert.ok(((await patchRes.json()) as ProviderRow).isActive, 'the PATCHed row is now active');

    // A FRESH GET-list: exactly one row active matching the new id; the old row now false; never two.
    const afterPatch = (await (await fetch(base)).json()) as ListResponse;
    const activeRows = afterPatch.providers.filter((p) => p.isActive);
    assert.equal(activeRows.length, 1, 'exactly one row is active after the PATCH (never two simultaneously)');
    assert.equal(activeRows[0].id, created.id, 'the single active row is the newly activated id');
    assert.equal(afterPatch.providers.find((p) => p.id === boot.providers[0].id)?.isActive, false, 'the old (seeded) row is now inactive');
    assert.equal(afterPatch.activeId, created.id, 'activeId points at the newly activated id');
  } finally {
    await closeMcmServer(srv);
  }
});

// --- (d): deleting the active row promotes the lowest-id remaining row -------
test('api-providers: deleting the active row auto-promotes the lowest-id remaining row without crashing', async () => {
  const { port, srv } = await startServer(DUMMY_UPSTREAM, IN_MEMORY_MOUNT);
  const base = api(port);
  try {
    // Start: the seeded active row + two more (both default-inactive).
    const boot = (await (await fetch(base)).json()) as ListResponse;
    const seededId = boot.providers[0].id;
    assert.ok(boot.providers[0].isActive, 'the seeded row starts active');
    const mk = async (name: string): Promise<ProviderRow> =>
      (await (await post(port, '', {
        name,
        baseUrl: `http://${name}.local/v1`,
        model: `${name}-model`,
        protocol: 'openai',
      })).json()) as ProviderRow;
    const p1 = await mk('prov-a');
    const p2 = await mk('prov-b');
    assert.ok(!p1.isActive && !p2.isActive, 'the two created rows are default-inactive');

    const before = (await (await fetch(base)).json()) as ListResponse;
    assert.equal(before.providers.length, 3, 'three rows exist before the delete');

    // DELETE the ACTIVE (seeded) row → 200, no crash.
    const delRes = await fetch(`${base}/${seededId}`, { method: 'DELETE' });
    assert.equal(delRes.status, 200, 'deleting the active row must be 200 (no crash)');
    assert.equal(((await delRes.json()) as { deleted: boolean }).deleted, true, 'the delete response carries deleted:true');

    // A FRESH GET-list: exactly one row active, and it is the lexicographically-lowest remaining id.
    const after = (await (await fetch(base)).json()) as ListResponse;
    assert.equal(after.providers.length, 2, 'two rows remain after the delete');
    assert.ok(!after.providers.some((p) => p.id === seededId), 'the deleted active row is gone');
    const activeRows = after.providers.filter((p) => p.isActive);
    assert.equal(activeRows.length, 1, 'exactly one row is active after the delete');
    const lowestId = after.providers.map((p) => p.id).sort()[0];
    assert.equal(activeRows[0].id, lowestId, 'the promoted row is the lexicographically-lowest remaining id');
    assert.equal(after.activeId, lowestId, 'activeId points at the promoted lowest-id row');
  } finally {
    await closeMcmServer(srv);
  }
});

// --- (e): LIVE-APPLY-WITHOUT-RESTART (mockA → mockB via the public REST only) -
test('api-providers: live-apply without restart — mockA → mockB via the public REST endpoint only', async () => {
  const mockA = await createMockUpstream('mockA');
  const mockB = await createMockUpstream('mockB');
  try {
    // Seed the proxy's active provider at mockA via the cleanest options-based injection point
    // (createServer's `upstream` option): the auto-seed makes the mockA row the single active
    // provider AND the proxy's live upstream reference points at mockA. No restart needed later.
    const { port, srv } = await startServer(
      { upstream: { baseUrl: mockA.url, model: 'mockA-model', protocol: 'openai' } },
      IN_MEMORY_MOUNT,
    );
    const base = api(port);
    try {
      // A real proxy chat request (client → proxy → upstream), routed by the active provider's baseUrl.
      const chat = (msg: string): Promise<Response> =>
        fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'any', messages: [{ role: 'user', content: msg }] }),
        });

      // Request 1 → captured ONLY by mockA.
      const r1 = await chat('hello-from-client-to-A');
      assert.equal(r1.status, 200, 'request 1 must be proxied with HTTP 200');
      await r1.text();
      assert.equal(mockA.requests.length, 1, 'mockA captured exactly the first real proxy chat request');
      assert.equal(mockB.requests.length, 0, 'mockB captured nothing yet');
      assert.match(mockA.requests[0].url, /\/chat\/completions$/, 'mockA received a real chat/completions request');
      assert.ok(mockA.requests[0].body.includes('hello-from-client-to-A'), 'mockA received the client message body');

      // Switch the active provider to mockB via the PUBLIC REST endpoint only (create + PATCH).
      const createdB = (await (await post(port, '', {
        name: 'mockB-prov',
        baseUrl: mockB.url,
        model: 'mockB-model',
        protocol: 'openai',
      })).json()) as ProviderRow;
      assert.ok(!createdB.isActive, 'the mockB provider is default-inactive on create');
      const patchRes = await post(port, `/${createdB.id}`, { isActive: true }, 'PATCH');
      assert.equal(patchRes.status, 200, 'PATCH the mockB provider active must be 200');
      assert.ok(((await patchRes.json()) as ProviderRow).isActive, 'the mockB provider is now the active provider');

      // Request 2 → captured ONLY by mockB, on the SAME server process (zero restarts).
      const r2 = await chat('hello-from-client-to-B');
      assert.equal(r2.status, 200, 'request 2 must be proxied with HTTP 200');
      await r2.text();
      assert.equal(mockB.requests.length, 1, 'mockB captured exactly the second real proxy chat request');
      assert.match(mockB.requests[0].url, /\/chat\/completions$/, 'mockB received a real chat/completions request');
      assert.ok(mockB.requests[0].body.includes('hello-from-client-to-B'), 'mockB received the client message body');
      assert.equal(mockA.requests.length, 1, 'mockA still has only its single earlier request (no re-route back, no restart)');
      assert.ok(!mockA.requests[0].body.includes('hello-from-client-to-B'), 'the second request did NOT route to mockA');
    } finally {
      await closeMcmServer(srv);
    }
  } finally {
    await mockA.close();
    await mockB.close();
  }
});

// --- (f): an empty-model provider passes through the incoming request model ----
test('api-providers: an empty-model provider passes through the incoming request model', async () => {
  const mock = await createMockUpstream('passthrough');
  try {
    // Seed the proxy's active provider at the mock (createServer's `upstream` option): the
    // auto-seed makes the mock row the single active provider, so the proxy routes here.
    const { port, srv } = await startServer(
      { upstream: { baseUrl: mock.url, model: 'seed-model', protocol: 'openai' } },
      IN_MEMORY_MOUNT,
    );
    try {
      // (f-1) Create a provider with an EMPTY model — valid now that model is optional (not 400).
      const created = (await (await post(port, '', {
        name: 'empty-model-prov',
        baseUrl: mock.url,
        model: '',
        protocol: 'openai',
      })).json()) as ProviderRow;
      assert.ok(created.id, 'the empty-model provider was created with a store-assigned id');
      assert.equal(created.model, '', 'the created provider carries the empty model');

      // Make the empty-model provider the active one so the proxy routes chat traffic here.
      const patchRes = await post(port, `/${created.id}`, { isActive: true }, 'PATCH');
      assert.equal(patchRes.status, 200, 'PATCH the empty-model provider active must be 200');
      assert.ok(((await patchRes.json()) as ProviderRow).isActive, 'the empty-model provider is now the active provider');

      // (f-2) A real proxy chat request (client → proxy → upstream) carrying its own body.model.
      const chatRes = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'client-request-model', messages: [{ role: 'user', content: 'hello-passthrough' }] }),
      });
      assert.equal(chatRes.status, 200, 'the empty-model proxy chat request returns 200');
      await chatRes.text();
      assert.equal(mock.requests.length, 1, 'the mock upstream captured exactly the one real proxy chat request');
      assert.match(mock.requests[0].url, /\/chat\/completions$/, 'the mock received a real chat/completions request');
      assert.ok(mock.requests[0].body.includes('hello-passthrough'), 'the mock received the client message body');
      // The empty-model provider did NOT substitute its own (empty) model: the outgoing request
      // carried the SAME model the client requested, proving empty-model pass-through.
      const capturedModel = (JSON.parse(mock.requests[0].body) as { model?: string }).model;
      assert.equal(capturedModel, 'client-request-model', 'the empty-model provider passed through the incoming request model');
    } finally {
      await closeMcmServer(srv);
    }
  } finally {
    await mock.close();
  }
});
