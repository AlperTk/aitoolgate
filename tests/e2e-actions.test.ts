import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createProxyHandler, type ProxyOptions } from '../src/proxy/index';
import type { PolicyAction, PolicyRule } from '../src/policy/ruleEngine';
import type { PolicyMatcher } from '../src/policy/types';
import {
  createHideToolAction,
  createInjectMessageAction,
  createRewriteArgsAction,
} from '../src/policy/actions';
import { createToolNameMatcher } from '../src/policy/matchers';
import { closeHttpServer } from './helpers';

/**
 * End-to-end coverage for the FOUR policy action types. Each case drives REAL HTTP
 * requests through the proxy to a fake upstream and asserts the action's INTENDED
 * effect on what actually happens:
 *
 *   - hideTool      : the named tool is removed from the forwarded tools + references (baseline)
 *   - injectMessage : the corrective message is injected into the forwarded request
 *   - rewriteArgs   : the MATCHED tool call's arguments are rewritten in the forwarded request
 *                     (leaving unmatched calls untouched)
 *
 * Matchers are chosen to demonstrate each effect: `always` for unconditional actions
 * (`hideTool`, `injectMessage`) and a `toolName` matcher where a specific call must be
 * present in the incoming history / emitted by the model.
 */

const HIDDEN = 'secret_tool';
const KEPT = 'keep_tool';
const OTHER = 'web_search';
const EDITED = 'edit_file';
const INJECT_CONTENT = 'STOP AND RECONSIDER YOUR APPROACH';
const SESSION_TOKEN = 'sess-e2e-actions';

// ---------------------------------------------------------------------------
// Helpers (mirror tests/e2e-hideTool.test.ts and tests/e2e-policy.test.ts)
// ---------------------------------------------------------------------------

function listen(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    if (server.listening) {
      resolve();
      return;
    }
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

type Msg = Record<string, unknown>;

/** A matcher that fires on every evaluation. */
function alwaysMatch(): PolicyMatcher {
  return { matches: () => ({ matched: true, reason: 'always' }) };
}

function oaiPlainCompletion(): unknown {
  return {
    id: 'chatcmpl-e2e-actions',
    object: 'chat.completion',
    created: 1700000000,
    model: 'gpt-4o-mini',
    choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
  };
}

/** An OpenAI completion whose assistant message issues a single tool call. */
function oaiToolCallCompletion(id: string, name: string, args: Record<string, unknown>): unknown {
  return {
    id: 'chatcmpl-e2e-actions',
    object: 'chat.completion',
    created: 1700000000,
    model: 'gpt-4o-mini',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] },
        finish_reason: 'tool_calls',
      },
    ],
    usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
  };
}

/** The tool definitions an inbound request advertises (OpenAI shape). */
function openAiTools(names: string[]): unknown[] {
  return names.map((name) => ({ type: 'function', function: { name, parameters: { type: 'object' } } }));
}

function freshMessages(): Msg[] {
  return [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: 'Run it.' },
  ];
}

/** Collect the advertised tool-definition names from a forwarded upstream body. */
function forwardedToolNames(forwarded: unknown): string[] {
  const body = forwarded as Record<string, unknown> | undefined;
  if (!body || !Array.isArray(body.tools)) return [];
  const out: string[] = [];
  for (const tool of body.tools) {
    if (tool === null || typeof tool !== 'object') continue;
    const record = tool as Record<string, unknown>;
    const fn = typeof record.function === 'object' && record.function !== null ? (record.function as Record<string, unknown>) : {};
    if (typeof fn.name === 'string') out.push(fn.name);
    else if (typeof record.name === 'string') out.push(record.name);
  }
  return out;
}

interface ForwardedCall {
  id?: string;
  name?: string;
  arguments?: unknown;
}

/** Collect the assistant `tool_calls` (by id/name/arguments) from a forwarded request's messages. */
function forwardedAssistantToolCalls(forwarded: unknown): ForwardedCall[] {
  const out: ForwardedCall[] = [];
  const body = forwarded as Record<string, unknown> | undefined;
  if (!body || !Array.isArray(body.messages)) return out;
  for (const message of body.messages) {
    if (message === null || typeof message !== 'object' || Array.isArray(message)) continue;
    const m = message as Record<string, unknown>;
    if (m.role !== 'assistant') continue;
    const toolCalls = m.tool_calls;
    if (!Array.isArray(toolCalls)) continue;
    for (const tc of toolCalls) {
      if (tc === null || typeof tc !== 'object') continue;
      const t = tc as Record<string, unknown>;
      const fn = typeof t.function === 'object' && t.function !== null ? (t.function as Record<string, unknown>) : {};
      out.push({
        id: typeof t.id === 'string' ? t.id : undefined,
        name: typeof fn.name === 'string' ? fn.name : undefined,
        arguments: fn.arguments,
      });
    }
  }
  return out;
}

function assistantCallNames(forwarded: unknown): string[] {
  return forwardedAssistantToolCalls(forwarded)
    .map((call) => call.name ?? '')
    .filter((name) => name !== '');
}

/** True when some forwarded message carries exactly the given `content`. */
function hasMessageWithContent(forwarded: unknown, content: string): boolean {
  const body = forwarded as Record<string, unknown> | undefined;
  if (!body || !Array.isArray(body.messages)) return false;
  return body.messages.some(
    (message) => message !== null && typeof message === 'object' && !Array.isArray(message) && (message as Record<string, unknown>).content === content,
  );
}

// ---------------------------------------------------------------------------
// 1) hideTool — baseline: the named tool is stripped from the forwarded request
// ---------------------------------------------------------------------------

test('e2e actions: hideTool removes the named tool from the forwarded tools AND references', async () => {
  const fakeModel = await createFakeModel(oaiPlainCompletion());
  let proxy: Awaited<ReturnType<typeof startProxy>> | undefined;
  try {
    const rule: PolicyRule = {
      id: 'e2e-hide',
      enabled: true,
      description: `hide ${HIDDEN}`,
      matcher: alwaysMatch(),
      action: createHideToolAction({ toolNames: [HIDDEN] }) as PolicyAction,
    };
    proxy = await startProxy({
      upstream: { baseUrl: `http://127.0.0.1:${fakeModel.port}/v1`, model: 'gpt-4o-mini', protocol: 'openai' },
      policy: { rules: [rule] },
    });

    const res = await fetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: freshMessages(),
        tools: openAiTools([HIDDEN, KEPT]),
      }),
    });
    assert.equal(res.status, 200);
    await res.json();

    const forwarded = fakeModel.requests[0];
    const names = forwardedToolNames(forwarded);
    assert.ok(!names.includes(HIDDEN), `'${HIDDEN}' must be removed from the forwarded tools`);
    assert.ok(names.includes(KEPT), `'${KEPT}' should still be present in the forwarded tools`);
    assert.ok(!JSON.stringify(forwarded).includes(HIDDEN), 'no reference to the hidden tool may remain anywhere in the forwarded request');
  } finally {
    if (proxy) await closeHttpServer(proxy.server);
    await fakeModel.close();
  }
});

// ---------------------------------------------------------------------------
// 2) injectMessage — the corrective message is injected into the forwarded request
// ---------------------------------------------------------------------------

test('e2e actions: injectMessage inserts the corrective message into the forwarded request', async () => {
  const fakeModel = await createFakeModel(oaiPlainCompletion());
  let proxy: Awaited<ReturnType<typeof startProxy>> | undefined;
  try {
    const rule: PolicyRule = {
      id: 'e2e-inject',
      enabled: true,
      description: 'inject a corrective message on every request',
      matcher: alwaysMatch(),
      action: createInjectMessageAction({ role: 'user', content: INJECT_CONTENT }) as PolicyAction,
    };
    proxy = await startProxy({
      upstream: { baseUrl: `http://127.0.0.1:${fakeModel.port}/v1`, model: 'gpt-4o-mini', protocol: 'openai' },
      policy: { rules: [rule] },
    });

    const inbound = freshMessages();
    const res = await fetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o-mini', messages: inbound }),
    });
    assert.equal(res.status, 200);
    await res.json();

    const forwarded = fakeModel.requests[0] as { messages?: unknown[] };
    assert.ok(Array.isArray(forwarded.messages), 'the forwarded request must carry a messages array');
    assert.ok(hasMessageWithContent(fakeModel.requests[0], INJECT_CONTENT), 'the injected corrective message must reach the upstream model');
    assert.equal(forwarded.messages!.length, inbound.length + 1, 'exactly one corrective message was injected');
    const injected = forwarded.messages!.find((message) => hasContent(message, INJECT_CONTENT));
    assert.equal((injected as Msg | undefined)?.role, 'user', 'the injected message carries the configured role');
  } finally {
    if (proxy) await closeHttpServer(proxy.server);
    await fakeModel.close();
  }
});

function hasContent(message: unknown, content: string): boolean {
  return message !== null && typeof message === 'object' && !Array.isArray(message) && (message as Record<string, unknown>).content === content;
}

// ---------------------------------------------------------------------------
// 3) rewriteArgs — the MATCHED tool call's arguments are rewritten in the forwarded request
// ---------------------------------------------------------------------------

test('e2e actions: rewriteArgs rewrites only the matched tool call\u2019s arguments in the forwarded request', async () => {
  const fakeModel = await createFakeModel(oaiPlainCompletion());
  let proxy: Awaited<ReturnType<typeof startProxy>> | undefined;
  try {
    const rule: PolicyRule = {
      id: 'e2e-rewrite',
      enabled: true,
      description: `rewrite ${EDITED} arguments`,
      matcher: createToolNameMatcher({ toolName: EDITED }),
      action: createRewriteArgsAction({
        toolName: EDITED,
        arguments: { path: '/safe/dest.txt' },
        mode: 'replace',
      }) as PolicyAction,
    };
    proxy = await startProxy({
      upstream: { baseUrl: `http://127.0.0.1:${fakeModel.port}/v1`, model: 'gpt-4o-mini', protocol: 'openai' },
      policy: { rules: [rule] },
    });

    // History carries the target edit_file call AND an unrelated web_search call.
    const inbound: Msg[] = [
      { role: 'system', content: 'You are a helpful assistant.' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'c-edit', type: 'function', function: { name: EDITED, arguments: JSON.stringify({ path: '/tmp/dangerous.txt', content: 'x' }) } },
          { id: 'c-web', type: 'function', function: { name: OTHER, arguments: JSON.stringify({ q: 'hello' }) } },
        ],
      },
      { role: 'tool', tool_call_id: 'c-edit', name: EDITED, content: 'ok' },
      { role: 'user', content: 'Continue.' },
    ];
    const res = await fetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o-mini', messages: inbound }),
    });
    assert.equal(res.status, 200);
    await res.json();

    const calls = forwardedAssistantToolCalls(fakeModel.requests[0]);
    const edited = calls.find((call) => call.name === EDITED);
    assert.ok(edited !== undefined, 'the edit_file tool call must still be present in the forwarded request');
    assert.deepEqual(edited!.arguments, { path: '/safe/dest.txt' }, 'edit_file arguments are rewritten per the rule');
    assert.ok(!JSON.stringify(edited!.arguments).includes('/tmp/dangerous.txt'), 'the original dangerous argument is gone');

    // The non-targeted call is left untouched (proves the rewrite is scoped to the match).
    const web = calls.find((call) => call.name === OTHER);
    assert.ok(web !== undefined && JSON.stringify(web.arguments).includes('hello'), 'web_search arguments are left untouched');
  } finally {
    if (proxy) await closeHttpServer(proxy.server);
    await fakeModel.close();
  }
});
