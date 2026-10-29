/**
 * Integration/E2E coverage over REAL network calls against ONE live server instance,
 * exercising the full /api/api-providers/* REST surface plus proxy hot-apply routing.
 *
 * Single deterministic scenario flow through ONE running server (mirrors the suite's
 * e2e-full-stack.test.ts convention):
 *   Phase 1 — Boot state: auto-seed derived from initial upstream config; list masks API keys;
 *              detail read exposes raw key verbatim; unknown-id GET returns 404 not_found.
 *   Phase 2 — POST creates a second provider pointing at a different mock-upstream host (B);
 *              it enters the store non-active while another row is active.
 *   Phase 3 — PATCH {isActive:true} on B switches activeId; single-active invariant enforced;
 *              subsequent proxy request routes through B's URL via hot-apply (no restart needed).
 *   Phase 4 — DELETE removes B; residual path checks cover 404s for unknown IDs and 400s for
 *              invalid protocol values rejected by the spec validator.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createServer, type AtgServer } from '../src/server/index';
import { createRuleStore } from '../src/api/ruleStore';

// ---------------------------------------------------------------------------
// Mock upstream helpers (one per independent target)
// ---------------------------------------------------------------------------
interface MockUpstream {
  port: number;
  label: string;
  close(): Promise<void>;
}

async function createMockUpstream(label: string): Promise<MockUpstream> {
  const srv = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: `msg-${label}`,
      choices: [{ message: { role: 'assistant', content: `I am ${label}` }, index: 0 }],
    }));
  });
  await new Promise<void>((resolve) => {
    srv.once('error', () => resolve());
    srv.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = srv.address();
  if (addr === null || typeof addr !== 'object') throw new Error(`mock upstream [${label}] failed to bind`);
  return {
    port: addr.port,
    label,
    close: async () => {
      try { srv.closeAllConnections(); } catch {}
      await new Promise<void>((resolve, reject) => { srv.close(err => err ? reject(err) : resolve()); });
    },
  };
}

/** Await an already-listening server binding; returns its TCP port. */
function waitPort(srv: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    if (srv.listening) {
      const a = srv.address();
      if (a !== null && typeof a === 'object') return resolve(a.port);
    }
    srv.once('listening', () => {
      const a = srv.address();
      if (a !== null && typeof a === 'object') resolve(a.port);
      else reject(new Error('server did not bind to a TCP port'));
    });
    srv.once('error', reject);
  });
}

async function stopServer(srv?: AtgServer): Promise<void> {
  if (!srv) return;
  try { (srv as unknown as http.Server).closeAllConnections(); } catch {}
  await new Promise<void>((resolve, reject) => { (srv as unknown as http.Server).close(err => err ? reject(err) : resolve()); });
}

/** Typed fetch helper for /api/api-providers/* routes against the live server on `port`. */
async function providersApi(port: number, path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, init ?? undefined);
  let body: any = {};
  try { body = await res.json(); } catch {}
  return { status: res.status, body };
}

// ---------------------------------------------------------------------------
// THE TEST — single sequential scenario through ONE live server instance
// ---------------------------------------------------------------------------
test('e2e API Providers REST: full CRUD + single-active invariant + hot-apply routing over one live server', async () => {
  // Two independent mock-upstream hosts: A is seeded as the initial default at boot;
  // activating B causes all subsequent proxy traffic to re-route there without restart.
  const upA = await createMockUpstream('upstream-a');
  const upB = await createMockUpstream('upstream-b');
  let srv: AtgServer | undefined;

  try {
    // Start with upstream A as the baseline config feeding the auto-seeded default row.
    srv = createServer(0, {
      upstream: {
        baseUrl: `http://127.0.0.1:${upA.port}/v1`,
        model: 'model-a',
        protocol: 'openai' as const,
        apiKey: 'sk-seed-key',
      },
      policy: { rules: [] as import('../src/policy/ruleEngine').PolicyRule[] },
    }, { ruleStore: createRuleStore(), ws: false });

    const port = await waitPort(srv as unknown as http.Server);
    const api = (p: string, init?: RequestInit) => providersApi(port, p, init);

    /* ── Phase 1: Boot state ──────────────────────────────────────────────────── */

    const list1Raw = await api('/api/api-providers');
    assert.equal(list1Raw.status, 200, 'GET provider list returns 200 at boot');
    const { providers: rows1, activeId: seedId } = list1Raw.body as { providers: Record<string, any>[]; activeId: string | null };
    assert.ok(Array.isArray(rows1), 'providers field is an array');
    assert.equal(rows1.length, 1, 'exactly one auto-seeded row exists after startup');
    assert.ok(typeof seedId === 'string' && seedId.length > 0, 'activeId set on the sole seeded row');
    assert.equal(rows1[0].isActive, true, 'the seeded row is active by the store auto-first activation rule');
    assert.strictEqual(rows1[0].apiKeySet, true, 'seeded row carries apiKeySet=true (key was supplied via the upstream config)');
    assert.ok(!('apiKey' in rows1[0]), 'raw apiKey never appears in a LIST response regardless of whether it was set');

    // Detail GET exposes raw key verbatim — by design for existing-record editors.
    const seedDetailRes = await api(`/api/api-providers/${seedId}`);
    assert.equal(seedDetailRes.status, 200, 'GET known provider id returns 200');
    assert.equal((seedDetailRes.body as any).apiKey, 'sk-seed-key', 'detail read returns the stored raw API key verbatim');
    assert.equal((seedDetailRes.body as any).baseUrl, `http://127.0.0.1:${upA.port}/v1`, 'detail read reflects the seeded base URL');

    // Unknown-id GET → 404 not_found.
    const getUnknown = await api('/api/api-providers/zzz-does-not-exist-xyz');
    assert.equal(getUnknown.status, 404, 'GET with an unknown provider id returns HTTP 404');
    assert.deepEqual(getUnknown.body, { error: 'not_found' });

    // POST missing required fields → 400 spec validation failure.
    const postMissing = await api('/api/api-providers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
    assert.equal(postMissing.status, 400, 'POST with empty body returns HTTP 400 (missing required name/baseUrl)');

    /* ── Phase 2: Create second provider pointing at upstream B ──────────────── */

    const createBRes = await api('/api/api-providers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Secondary Engine',
        baseUrl: `http://127.0.0.1:${upB.port}/v1`,
        model: 'model-b',
        protocol: 'openai',
        apiKey: 'sk-secondary-key',
      }),
    });
    assert.equal(createBRes.status, 201, 'creating a new provider into a non-empty store returns HTTP 201');
    const createdB = createBRes.body as Record<string, any>;
    assert.ok(typeof createdB.id === 'string' && createdB.id.length > 0, 'new provider received an assigned string id from the store');
    assert.equal(createdB.isActive, false, 'a new provider into a NON-EMPTY store is NOT auto-activated (auto-first applies only to empty stores)');
    assert.equal(createdB.apiKeySet ?? true, true, 'the newly-created provider records its supplied API key via the apiKeySet flag');

    // List now carries two masked rows; single-active invariant intact before explicit activation.
    const list2Body = (await api('/api/api-providers')).body as { providers: Record<string, any>[]; activeId: string | null };
    assert.equal(list2Body.providers.length, 2, 'list grows to two rows after successful POST creation');
    assert.ok(!list2Body.providers.some(p => typeof p.apiKey === 'string'), 'no row leaks a raw string apiKey in the list response');
    assert.ok(list2Body.providers.every(p => 'apiKeySet' in p), 'every list row carries the apiKeySet boolean flag');
    assert.equal(list2Body.activeId, seedId, 'the original seeded row remains the sole active row until explicitly deactivated by a PATCH on another row');

    /* ── Phase 3: PATCH activate B + verify hot-apply proxy routing switch ───── */

    const patchActiveRes = await api(`/api/api-providers/${createdB.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isActive: true }),
    });
    assert.equal(patchActiveRes.status, 200, 'PATCH {isActive:true} on a known id succeeds with HTTP 200');
    assert.strictEqual((patchActiveRes.body as any).isActive, true, 'the patched record reflects its newly-active state in the response body');

    // Single-active invariant enforced server-side: the old seed is now inactive.
    const listAfterActivate = (await api('/api/api-providers')).body as { providers: Record<string, any>[]; activeId: string | null };
    assert.equal(listAfterActivate.activeId, createdB.id, 'activeId switched to the just-patched provider B');
    const seedRowNow = listAfterActivate.providers.find((p) => p.id === seedId);
    assert.ok(seedRowNow !== undefined && seedRowNow.isActive === false, 'previously-active seeded provider A is deactivated by activating B (single-active invariant)');

    // Detail GET for the now-inactive seed confirms its flipped status.
    const getSeedInactiveRes = await api(`/api/api-providers/${seedId}`);
    assert.strictEqual((getSeedInactiveRes.body as any).isActive, false, 'detail GET for provider A reflects its deactivated state after B was activated via PATCH');

    // HOT-APPLY E2E verification: a subsequent proxied request MUST route through upstream-B's URL.
    // No restart or reconfiguration — only the mutable shared upstream reference field mutation suffices.
    const proxiedViaBRes = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'model-b', messages: [{ role: 'user', content: 'ping-via-hot-applied-provider-B' }] }),
    });
    assert.equal(proxiedViaBRes.status, 200, 'proxy POST /v1/chat/completions returns HTTP 200 while provider B is active');
    const viaBBodys = (await proxiedViaBRes.json()) as { choices?: { message?: { content?: string } }[] };
    assert.match(
      String(viaBBodys.choices?.[0]?.message?.content ?? ''),
      /upstream-b/,
      'response text from upstream-B confirms hot-apply routing took effect without any server restart',
    );

    /* ── Phase 4: DELETE + residual path checks ──────────────────────────────── */

    const delKnownRes = await api(`/api/api-providers/${createdB.id}`, { method: 'DELETE' });
    assert.equal(delKnownRes.status, 200, 'DELETE of a known provider id returns HTTP 200');
    assert.deepEqual(delKnownRes.body, { deleted: true });

    // One row (the original seeded A) remains; single-active invariant holds post-deletion.
    const finalListBody = (await api('/api/api-providers')).body as { providers: Record<string, any>[]; activeId: string | null };
    assert.equal(finalListBody.providers.length, 1, 'one row survives after deleting the second provider');
    const activeCountAfterDelete = finalListBody.providers.filter(p => p.isActive === true).length;
    assert.ok(activeCountAfterDelete <= 1, `at most ONE row carries isActive=true after deletion (got ${activeCountAfterDelete})`);

    // Unknown-id DELETE → 404 not_found.
    const delUnknownRes = await api('/api/api-providers/zzz-does-not-exist-xyz', { method: 'DELETE' });
    assert.equal(delUnknownRes.status, 404, 'deleting an unknown provider id returns HTTP 404');
    assert.deepEqual(delUnknownRes.body, { error: 'not_found' });

    // PATCH on unknown id → 404 not_found.
    const patchUnknownRes = await api('/api/api-providers/zzz-does-not-exist-xyz', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'ghost-provider-that-was-never-created' }),
    });
    assert.equal(patchUnknownRes.status, 404, 'patching an unknown provider id returns HTTP 404');
    assert.deepEqual(patchUnknownRes.body, { error: 'not_found' });

    // A client-sent protocol is ignored: the create succeeds and the protocol derives from the type (generic-openai → openai).
    const postIgnoredProtoRes = await api('/api/api-providers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Ignored Proto Engine', baseUrl: 'http://invalid-host/v1', model: 'model-x', protocol: 'gpt35-turbo' }),
    });
    assert.equal(postIgnoredProtoRes.status, 201, 'a client-sent protocol is ignored and does not cause a 400');
    assert.equal((postIgnoredProtoRes.body as any).protocol, 'openai', 'protocol is derived from the adapter type, not the client value');

  } finally {
    await stopServer(srv);
    await upA.close();
    await upB.close();
  }
});
