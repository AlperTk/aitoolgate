/**
 * Regression test for runtime rule wiring over the REAL server:
 *
 *   A rule POSTed via the REST API (`POST /api/rules`) at RUNTIME must reach the
 *   live proxy policy engine WITHOUT a server restart.
 *
 * The existing `tests/e2e-always-match.test.ts` covers the "always" matcher but
 * injects its rule DIRECTLY into `policy.rules` on `createProxyHandler`, bypassing
 * the REST path entirely. This test exercises the full composition root instead:
 * it starts the real `createServer` with NO caller-supplied policy, POSTs an
 * `{ type: 'always' }` + `{ type: 'hideTool', toolNames: ['task'] }` rule through
 * `/api/rules`, then sends a proxied request and asserts the forwarded upstream
 * body's `tools` array EXCLUDES `task` — all without restarting the server.
 *
 * If `createServer` built the engine from a startup snapshot/copy of the rule
 * collection (rather than reading the live rule store), the runtime-added rule
 * would NOT fire and this assertion would fail.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type AtgServer } from '../src/server/index';
import { createRuleStore } from '../src/api/ruleStore';
import { closeAtgServer, createFakeModel, oaiCanned } from './helpers';

const HIDDEN = 'task';
const KEPT = 'web_search';

/** Canned OpenAI non-streaming completion returned by the mock upstream. */
const OAI_CANNED = oaiCanned('chatcmpl-runtime-rules');

/** The tool definitions a fresh inbound request advertises (hidden + kept). */
function openAiTools(): unknown[] {
  return [
    { type: 'function', function: { name: HIDDEN, parameters: { type: 'object' } } },
    { type: 'function', function: { name: KEPT, parameters: { type: 'object' } } },
  ];
}

/** Collect the advertised tool names from a forwarded upstream body (OpenAI shape). */
function forwardedToolNames(forwarded: unknown): string[] {
  const body = forwarded as Record<string, unknown>;
  if (!Array.isArray(body.tools)) return [];
  return body.tools
    .map((tool) => {
      if (typeof tool !== 'object' || tool === null) return undefined;
      const record = tool as Record<string, unknown>;
      const fn = typeof record.function === 'object' && record.function !== null ? (record.function as Record<string, unknown>) : {};
      if (typeof fn.name === 'string') return fn.name;
      return typeof record.name === 'string' ? record.name : undefined;
    })
    .filter((name): name is string => typeof name === 'string');
}

async function startServer(
  opts: Parameters<typeof createServer>[1],
  mount?: Parameters<typeof createServer>[2],
): Promise<{ port: number; srv: AtgServer }> {
  // createServer(0) auto-listens internally (preserving existing behavior).
  const srv = createServer(0, opts, mount);
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


test('e2e runtime rules: a rule POSTed via REST hides a tool WITHOUT a restart', async () => {
  // The single live rule store: REST writes here, the proxy engine reads it live.
  const ruleStore = createRuleStore();
  const upstream = await createFakeModel(OAI_CANNED);
  const requests = upstream.requests;

  let srv: AtgServer | undefined;
  try {
    // NOTE: NO `policy` is passed in the proxy options. The composition root must
    // wire the mounted rule store into the engine itself — this is exactly what
    // this regression guards against being a startup snapshot/copy.
    const { port, srv: startedSrv } = await startServer(
      {
        upstream: { baseUrl: `http://127.0.0.1:${upstream.port}/v1`, model: 'gpt-4o-mini', protocol: 'openai' },
      },
      { ruleStore, ws: false },
    );
    srv = startedSrv;

    // Control: before any rule exists, the hidden tool survives passthrough.
    const controlRes = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'Do something.' }], tools: openAiTools() }),
    });
    assert.equal(controlRes.status, 200);
    await controlRes.arrayBuffer();
    assert.ok(
      forwardedToolNames(requests[requests.length - 1]).includes(HIDDEN),
      `control: '${HIDDEN}' present in the forwarded tools before any rule is added`,
    );

    // Add a rule via the REST API at RUNTIME (no restart).
    const ruleRes = await fetch(`http://127.0.0.1:${port}/api/rules`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        enabled: true,
        description: `hide ${HIDDEN} on every request`,
        matcher: { type: 'always' },
        action: { type: 'hideTool', toolNames: [HIDDEN] },
      }),
    });
    assert.equal(ruleRes.status, 201, 'POST /api/rules must return 201 for a valid always+hideTool spec');

    // Same live server, no restart: send another proxied request.
    const afterRes = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'Do something.' }], tools: openAiTools() }),
    });
    assert.equal(afterRes.status, 200);
    await afterRes.arrayBuffer();

    const names = forwardedToolNames(requests[requests.length - 1]);
    assert.ok(!names.includes(HIDDEN), `'${HIDDEN}' must be excluded from the forwarded tools by the runtime-added rule`);
    assert.ok(names.includes(KEPT), `'${KEPT}' should still be present in the forwarded tools`);
  } finally {
    if (srv) await closeAtgServer(srv);
    await upstream.close();
  }
});
