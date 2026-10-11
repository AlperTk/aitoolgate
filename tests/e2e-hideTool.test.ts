import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createProxyHandler, type ProxyOptions } from '../src/proxy/index';
import type { PolicyAction, PolicyRule } from '../src/policy/ruleEngine';
import { createHideToolAction } from '../src/policy/actions';
import { oaiCanned } from './helpers';

/**
 * End-to-end regression tests for the `hideTool` policy action: when a matching rule
 * fires, the named tool must be removed from the forwarded upstream request — both from
 * the top-level `tools` definitions AND from any in-message references (tool calls /
 * results) — across BOTH client protocols (OpenAI + Anthropic), for JSON and SSE bodies.
 * The assertion inspects the request body the upstream actually receives.
 */

const HIDDEN = 'secret_tool';
const KEPT = 'keep_tool';

/** A matcher that always fires. */
const alwaysMatch = { matches: () => ({ matched: true, reason: 'always' }) };

function hideRule(id: string): PolicyRule {
  return {
    id,
    enabled: true,
    description: `hide ${HIDDEN}`,
    matcher: alwaysMatch,
    action: createHideToolAction({ toolNames: [HIDDEN] }) as PolicyAction,
  };
}

// ---------------------------------------------------------------------------
// Helpers (mirror tests/e2e-policy.test.ts)
// ---------------------------------------------------------------------------

async function listen(server: http.Server): Promise<void> {
  await new Promise<void>((resolve) => {
    if (server.listening) return resolve();
    server.once('listening', () => resolve());
    server.listen(0);
  });
}

function portOf(server: http.Server): number {
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('server is not listening on a TCP port');
  return address.port;
}

interface FakeModel {
  server: http.Server;
  port: number;
  requests: unknown[];
  close(): Promise<void>;
}

async function createFakeModel(canned: unknown): Promise<FakeModel> {
  const requests: unknown[] = [];
  const server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (chunk: Buffer) => {
      data += chunk;
    });
    req.on('end', () => {
      if (data !== '') {
        try {
          requests.push(JSON.parse(data));
        } catch {
          /* non-JSON body: nothing to record */
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(canned));
    });
  });
  await listen(server);
  return {
    server,
    port: portOf(server),
    requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function startProxy(options: ProxyOptions): Promise<{ server: http.Server; port: number }> {
  const handler = createProxyHandler(options);
  const server = http.createServer((req, res) => {
    void handler(req, res).then(
      (handled) => {
        if (!handled) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'not_found' }));
        }
      },
      (err: unknown) => {
        if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'internal_error' }));
      },
    );
  });
  await listen(server);
  return { server, port: portOf(server) };
}

const OAI_CANNED = oaiCanned('chatcmpl-hid');
const ANTH_CANNED = {
  id: 'msg_hid',
  type: 'message',
  role: 'assistant',
  model: 'claude-x',
  content: [{ type: 'text', text: 'ok' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 1, output_tokens: 1 },
};

/** Assert the forwarded upstream body no longer carries `HIDDEN` anywhere, but still carries `KEPT`. */
function assertHiddenFromForwarded(forwarded: unknown): void {
  const body = JSON.stringify(forwarded);
  assert.ok(!body.includes(HIDDEN), 'the hidden tool must not appear anywhere in the forwarded request');
  assert.ok(body.includes(KEPT), 'the non-hidden tool should still be present in the forwarded request');
}

// ---------------------------------------------------------------------------
// OpenAI client → upstream (JSON buffered)
// ---------------------------------------------------------------------------

test('e2e hideTool (OpenAI, JSON): the hidden tool is stripped from the forwarded definitions AND message references', async () => {
  const fakeModel = await createFakeModel(OAI_CANNED);
  let proxy: Awaited<ReturnType<typeof startProxy>> | undefined;
  try {
    proxy = await startProxy({
      upstream: { baseUrl: `http://127.0.0.1:${fakeModel.port}/v1`, model: 'gpt-4o-mini', protocol: 'openai' },
      policy: { rules: [hideRule('oai-hide')] },
    });

    // History references the hidden tool (a prior turn called it), and the tools list defines it.
    const history = [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c-1', type: 'function', function: { name: HIDDEN, arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c-1', name: HIDDEN, content: 'boom' },
      { role: 'user', content: 'Go again.' },
    ];
    const res = await fetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: history,
        tools: [
          { type: 'function', function: { name: HIDDEN, parameters: { type: 'object' } } },
          { type: 'function', function: { name: KEPT, parameters: { type: 'object' } } },
        ],
      }),
    });
    assert.equal(res.status, 200);
    await res.json();

    assertHiddenFromForwarded(fakeModel.requests[0]);
  } finally {
    if (proxy) await proxy.server.close();
    await fakeModel.close();
  }
});

// ---------------------------------------------------------------------------
// Anthropic client → OpenAI upstream (cross-protocol, JSON buffered)
// ---------------------------------------------------------------------------

test('e2e hideTool (Anthropic→OpenAI cross-protocol, JSON): the hidden tool survives translation stripped from the forwarded request', async () => {
  const fakeModel = await createFakeModel(OAI_CANNED);
  let proxy: Awaited<ReturnType<typeof startProxy>> | undefined;
  try {
    proxy = await startProxy({
      upstream: { baseUrl: `http://127.0.0.1:${fakeModel.port}/v1`, model: 'claude-x', protocol: 'openai' },
      policy: { rules: [hideRule('anth-cross-hide')] },
    });

    // Anthropic-shaped history: an assistant tool_use + a user tool_result referencing the hidden tool.
    const messages = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'hi' },
          { type: 'tool_use', id: 'tu-1', name: HIDDEN, input: {} },
          { type: 'tool_use', id: 'tu-2', name: KEPT, input: {} },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tu-1', content: 'boom' },
          { type: 'tool_result', tool_use_id: 'tu-2', content: 'fine' },
        ],
      },
    ];
    const res = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': 'sk-test' },
      body: JSON.stringify({
        model: 'claude-x',
        max_tokens: 64,
        messages,
        tools: [
          { name: HIDDEN, input_schema: { type: 'object' } },
          { name: KEPT, input_schema: { type: 'object' } },
        ],
      }),
    });
    assert.equal(res.status, 200);
    await res.json();

    // The forwarded (translated-to-OpenAI) body must not re-expose the hidden tool.
    assertHiddenFromForwarded(fakeModel.requests[0]);
  } finally {
    if (proxy) await proxy.server.close();
    await fakeModel.close();
  }
});

// ---------------------------------------------------------------------------
// OpenAI client → Anthropic upstream (cross-protocol, JSON buffered)
// ---------------------------------------------------------------------------

test('e2e hideTool (OpenAI→Anthropic cross-protocol, JSON): the hidden tool is stripped before translation to Anthropic', async () => {
  const fakeModel = await createFakeModel(ANTH_CANNED);
  let proxy: Awaited<ReturnType<typeof startProxy>> | undefined;
  try {
    proxy = await startProxy({
      upstream: { baseUrl: `http://127.0.0.1:${fakeModel.port}`, model: 'claude-x', protocol: 'anthropic' },
      policy: { rules: [hideRule('oai-anth-cross-hide')] },
    });

    const res = await fetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-x',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [
          { type: 'function', function: { name: HIDDEN, parameters: { type: 'object' } } },
          { type: 'function', function: { name: KEPT, parameters: { type: 'object' } } },
        ],
      }),
    });
    assert.equal(res.status, 200);
    await res.json();

    assertHiddenFromForwarded(fakeModel.requests[0]);
  } finally {
    if (proxy) await proxy.server.close();
    await fakeModel.close();
  }
});

// ---------------------------------------------------------------------------
// OpenAI client → OpenAI upstream (SSE stream)
// ---------------------------------------------------------------------------

test('e2e hideTool (OpenAI, SSE stream:true): the hidden tool is stripped from the streamed forwarded request', async () => {
  const fakeModel = await createFakeModel(OAI_CANNED);
  let proxy: Awaited<ReturnType<typeof startProxy>> | undefined;
  try {
    proxy = await startProxy({
      upstream: { baseUrl: `http://127.0.0.1:${fakeModel.port}/v1`, model: 'gpt-4o-mini', protocol: 'openai' },
      policy: { rules: [hideRule('oai-stream-hide')] },
    });

    const res = await fetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        stream: true,
        messages: [
          { role: 'assistant', content: null, tool_calls: [{ id: 'c-1', type: 'function', function: { name: HIDDEN, arguments: '{}' } }] },
          { role: 'tool', tool_call_id: 'c-1', name: HIDDEN, content: 'boom' },
          { role: 'user', content: 'Go again.' },
        ],
        tools: [
          { type: 'function', function: { name: HIDDEN, parameters: { type: 'object' } } },
          { type: 'function', function: { name: KEPT, parameters: { type: 'object' } } },
        ],
      }),
    });
    assert.equal(res.status, 200);
    await res.text();

    assertHiddenFromForwarded(fakeModel.requests[0]);
  } finally {
    if (proxy) await proxy.server.close();
    await fakeModel.close();
  }
});
