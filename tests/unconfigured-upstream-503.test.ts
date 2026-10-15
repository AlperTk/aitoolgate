/**
 * Coverage for the UNCONFIGURED-upstream path (env-based bootstrap removed):
 * a server booted with NO programmatic `options.upstream` starts with an EMPTY
 * provider store (no env-derived seed) and NO active upstream. Proxy forwarding
 * answers 503 with a JSON error on both client protocols (buffered and streamed)
 * without any upstream fetch, and the 503 disappears once a provider is created
 * + activated via the REST API (auto-first activation).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startAtgServer, closeAtgServer } from './helpers';
import { createRuleStore } from '../src/api/ruleStore';

const UNCONFIGURED_ERROR = 'No active upstream provider configured. Add one via the dashboard Settings or POST /api/api-providers.';

/** A canned upstream mock: a REAL local HTTP server answering with a fixed OpenAI completion. */
async function createCannedUpstream(): Promise<{ url: string; close(): Promise<void> }> {
  const srv = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: 'chatcmpl-canned',
      object: 'chat.completion',
      created: 1,
      model: 'canned-model',
      choices: [{ index: 0, message: { role: 'assistant', content: 'canned-response' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }));
  });
  await new Promise<void>((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = srv.address();
  if (addr === null || typeof addr !== 'object') throw new Error('canned upstream failed to bind a port');
  return {
    url: `http://127.0.0.1:${addr.port}/v1`,
    close: async () => {
      srv.closeAllConnections();
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    },
  };
}

test('unconfigured upstream: empty store at boot, 503 on proxy routes, recovered by a REST-created provider', async () => {
  // RULES_ENABLED=false keeps the provider store strictly in-memory (no shared data/rules.db
  // rows leaking into the scenario) while `options.upstream` stays UNSET — the case under test.
  const prevRulesEnabled = process.env.RULES_ENABLED;
  process.env.RULES_ENABLED = 'false';
  const canned = await createCannedUpstream();
  try {
    // startAtgServer pattern: ephemeral port (0), in-memory rule store, no WS layer.
    // `undefined` options = NO programmatic `options.upstream` (the unconfigured scenario).
    const { port, srv } = await startAtgServer(undefined, { ruleStore: createRuleStore(), ws: false });
    const base = `http://127.0.0.1:${port}`;
    try {
      // Boot state: the provider store is EMPTY — the env-based default-provider seed is gone,
      // so no "default" row exists and no provider is active.
      const listRes = await fetch(`${base}/api/api-providers`);
      assert.equal(listRes.status, 200, 'GET /api/api-providers returns 200 at boot');
      const listBody = (await listRes.json()) as { providers: unknown[]; activeId: string | null };
      assert.deepEqual(listBody.providers, [], 'no provider row is seeded at boot without a programmatic upstream');
      assert.equal(listBody.activeId, null, 'no provider is active at boot without a programmatic upstream');

      // OpenAI proxy route: 503 + the exact JSON error, with no upstream fetch attempted.
      const chatRes = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'any-model', messages: [{ role: 'user', content: 'hello' }] }),
      });
      assert.equal(chatRes.status, 503, 'the unconfigured upstream answers 503 on POST /v1/chat/completions');
      assert.match(chatRes.headers.get('content-type') ?? '', /json/, 'the 503 response carries a JSON content type');
      assert.deepEqual(await chatRes.json(), { error: UNCONFIGURED_ERROR }, 'the 503 body is the exact unconfigured-upstream error');

      // Streaming request: the same 503 contract (no SSE fetch attempted).
      const streamRes = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'any-model', stream: true, messages: [{ role: 'user', content: 'hello' }] }),
      });
      assert.equal(streamRes.status, 503, 'a streaming request also receives the 503 contract');
      assert.deepEqual(await streamRes.json(), { error: UNCONFIGURED_ERROR }, 'the streamed 503 body is the exact unconfigured-upstream error');

      // Anthropic proxy route: the same 503 contract.
      const anthropicRes = await fetch(`${base}/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'any-model', messages: [{ role: 'user', content: 'hello' }] }),
      });
      assert.equal(anthropicRes.status, 503, 'the unconfigured upstream answers 503 on POST /v1/messages');
      assert.deepEqual(await anthropicRes.json(), { error: UNCONFIGURED_ERROR }, 'the Anthropic 503 body is the exact unconfigured-upstream error');

      // Recovery: creating the FIRST provider via REST auto-activates it (auto-first activation)
      // and the same route now forwards to the canned upstream mock instead of answering 503.
      const createRes = await fetch(`${base}/api/api-providers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'canned', baseUrl: canned.url, model: 'canned-model', protocol: 'openai' }),
      });
      assert.equal(createRes.status, 201, 'POST /api/api-providers creates the first provider');
      const created = (await createRes.json()) as { isActive: boolean };
      assert.equal(created.isActive, true, 'the first provider is auto-activated (auto-first activation)');

      const afterRes = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'any-model', messages: [{ role: 'user', content: 'hello' }] }),
      });
      assert.equal(afterRes.status, 200, 'after activating a provider the proxy forwards (no more 503)');
      const afterBody = (await afterRes.json()) as { choices?: { message?: { content?: string } }[] };
      assert.match(
        String(afterBody.choices?.[0]?.message?.content ?? ''),
        /canned-response/,
        'the canned upstream mock captured the forwarded request',
      );
    } finally {
      await closeAtgServer(srv);
    }
  } finally {
    if (prevRulesEnabled === undefined) delete process.env.RULES_ENABLED;
    else process.env.RULES_ENABLED = prevRulesEnabled;
    await canned.close();
  }
});
