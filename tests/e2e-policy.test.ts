import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createProxyHandler } from '../src/proxy/index';
import { flagshipLoopRule, type PolicyAction, type PolicyRule } from '../src/policy/ruleEngine';
import { createToolNameMatcher } from '../src/policy/matchers/index';
import { createHideToolAction } from '../src/policy/actions/index';
import { createEventBus } from '../src/telemetry/event-bus';
import { createCollector } from '../src/telemetry/collector';
import { closeHttpServer } from './helpers';
/** The corrective message injected by the default flagship loop rule. */
const LOOP_CORRECTION =
  'You appear to be stuck repeating the same tool call. Stop repeating identical calls and change your approach to make progress.';
/** Fixed client session token shared across a session's requests. */
const SESSION_TOKEN = 'sess-e2e-block-s2';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function listen(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    if (server.listening) {
      resolve();
      return;
    }
    server.once('listening', () => resolve());
    // Actually start the server on an ephemeral TCP port (port 0); without this
    // the 'listening' event never fires and every caller of this helper hangs.
    server.listen(0);
  });
}

function portOf(server: http.Server): number {
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('server is not listening on a TCP port');
  }
  return address.port;
}


/** A fake upstream model: records each request body it receives and returns a canned OpenAI response. */
interface FakeModel {
  server: http.Server;
  port: number;
  requests: unknown[];
  setCanned(canned: unknown): void;
  close(): Promise<void>;
}

async function createFakeModel(initialCanned: unknown): Promise<FakeModel> {
  const requests: unknown[] = [];
  let current = initialCanned;
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
      res.end(JSON.stringify(current));
    });
  });
  await listen(server);
  return {
    server,
    port: portOf(server),
    requests,
    setCanned: (canned: unknown) => {
      current = canned;
    },
    close: () => closeHttpServer(server),
  };
}

async function startProxy(options: Parameters<typeof createProxyHandler>[0]): Promise<{
  server: http.Server;
  port: number;
}> {
  const handleProxyRequest = createProxyHandler(options);
  const server = http.createServer((req, res) => {
    void handleProxyRequest(req, res).then(
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

type Msg = Record<string, unknown>;

function messageKey(message: unknown): string {
  return JSON.stringify(message);
}

function messageRole(message: unknown): string | undefined {
  if (message === null || typeof message !== 'object' || Array.isArray(message)) return undefined;
  const role = (message as Msg).role;
  return typeof role === 'string' ? role : undefined;
}

function messageContent(message: unknown): unknown {
  if (message === null || typeof message !== 'object' || Array.isArray(message)) return undefined;
  return (message as Msg).content;
}

function plainCompletion(): unknown {
  return {
    id: 'chatcmpl-e2e-plain',
    object: 'chat.completion',
    created: 1700000000,
    model: 'gpt-4o-mini',
    choices: [
      { index: 0, message: { role: 'assistant', content: 'OK, I will change my approach.' }, finish_reason: 'stop' },
    ],
    usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
  };
}

function bashCompletion(): unknown {
  return {
    id: 'chatcmpl-e2e-bash',
    object: 'chat.completion',
    created: 1700000000,
    model: 'gpt-4o-mini',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'bash-1',
              type: 'function',
              function: { name: 'bash', arguments: '{"command":"rm -rf /"}' },
            },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
    usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
  };
}

/** A fresh, trivial client history (no tool calls) for a brand-new turn. */
function freshMessages(): Msg[] {
  return [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: 'Run it.' },
  ];
}

// ---------------------------------------------------------------------------
// Scenario 1: request-in loop intervention reaches the upstream model
// ---------------------------------------------------------------------------

test('e2e policy: flagship loop rule injects a corrective message that reaches the upstream model', async () => {
  const fakeModel = await createFakeModel(plainCompletion());
  let proxy: Awaited<ReturnType<typeof startProxy>> | undefined;
  try {
    proxy = await startProxy({
      upstream: {
        baseUrl: `http://127.0.0.1:${fakeModel.port}/v1`,
        model: 'gpt-4o-mini',
        protocol: 'openai',
      },
      policy: { rules: [flagshipLoopRule()] },
    });

    // Client history ending in FOUR consecutive identical tool calls (each with an identical result).
    const args = JSON.stringify({ cmd: 'echo hi' });
    const history: Msg[] = [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Do it four times identically.' },
    ];
    for (let i = 1; i <= 4; i += 1) {
      history.push({
        role: 'assistant',
        content: null,
        tool_calls: [{ id: `call-${i}`, type: 'function', function: { name: 'run_script', arguments: args } }],
      });
      history.push({ role: 'tool', tool_call_id: `call-${i}`, name: 'run_script', content: 'hi' });
    }

    const res = await fetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o-mini', messages: history }),
    });
    assert.equal(res.status, 200);
    await res.json();

    const forwarded = (fakeModel.requests[0] ?? {}) as { messages?: unknown[] };
    assert.ok(Array.isArray(forwarded.messages), 'forwarded request must carry a messages array');
    const forwardedMessages = forwarded.messages!;
    assert.equal(forwardedMessages.length, history.length + 1, 'exactly one corrective message was injected');

    const originalKeys = new Set(history.map(messageKey));
    const extras = forwardedMessages.filter((message) => !originalKeys.has(messageKey(message)));
    assert.equal(extras.length, 1, 'the loop rule injected exactly one new message');
    assert.equal(messageRole(extras[0]), 'user');
    assert.equal(messageContent(extras[0]), LOOP_CORRECTION);
  } finally {
    if (proxy) await closeHttpServer(proxy.server);
    await fakeModel.close();
  }
});

// ---------------------------------------------------------------------------
// Scenario 3: cross-request tool-call/result pairing through an ACTIVE policy stage
// ---------------------------------------------------------------------------

test(
  'e2e policy: an issued tool call and its later same-session result pair into one call + one real result',
  async () => {
    // A rule that matches nothing (so no intervention noise), but whose presence puts an
    // active policy stage in the pipeline -> context.ts defers tool.call observation to it.
    const inertRule: PolicyRule = {
      id: 'inert-noop',
      enabled: true,
      description: 'Matches nothing.',
      matcher: createToolNameMatcher({ toolName: '__never_called__' }),
      action: createHideToolAction({ toolNames: ['__never_called__'] }) as PolicyAction,
    };

    // Upstream emits ONE tool call (id bash-1) with token usage on the first turn, then a
    // plain text turn for the second request (so only one tool.call is observed in total).
    const fakeModel = await createFakeModel(bashCompletion());
    const bus = createEventBus();
    const collector = createCollector({ bus });
    let proxy: Awaited<ReturnType<typeof startProxy>> | undefined;
    try {
      proxy = await startProxy({
        upstream: {
          baseUrl: `http://127.0.0.1:${fakeModel.port}/v1`,
          model: 'gpt-4o-mini',
          protocol: 'openai',
        },
        policy: { rules: [inertRule], sessionIdHeader: 'x-session-id' },
        telemetry: { bus, collector },
      });

      const post = (messages: Msg[]): Promise<Response> =>
        fetch(`http://127.0.0.1:${proxy!.port}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-session-id': SESSION_TOKEN },
          body: JSON.stringify({ model: 'gpt-4o-mini', messages }),
        });

      // Req N: fresh history; the LLM issues one tool call (id bash-1) + reports usage.
      const resN = await post(freshMessages());
      assert.equal(resN.status, 200);
      await resN.json();

      // Req N+1: same session; plain response, but the client feeds back the matching
      // role:'tool' result so the request phase can pair it against the issued call.
      fakeModel.setCanned(plainCompletion());
      const nextMessages: Msg[] = [
        ...freshMessages(),
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'bash-1', type: 'function', function: { name: 'bash', arguments: '{"command":"rm -rf /"}' } }],
        },
        { role: 'tool', tool_call_id: 'bash-1', name: 'bash', content: 'boom' },
      ];
      const resNp1 = await post(nextMessages);
      assert.equal(resNp1.status, 200);
      await resNp1.json();

      const summary = collector.summary();
      // Exactly ONE tool.call for the issued call (no double-emission between the active
      // policy stage and context emission)...
      assert.equal(summary.totalCalls, 1, `expected exactly one tool.call, got ${summary.totalCalls}`);
      // ...and exactly ONE REAL tool.result, paired across the two successive requests.
      assert.equal(summary.totalResults, 1, `expected exactly one real tool.result, got ${summary.totalResults}`);
    } finally {
      if (proxy) await closeHttpServer(proxy.server);
      await fakeModel.close();
      collector.dispose();
    }
  },
);
