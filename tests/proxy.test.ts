import { test } from 'node:test';
import assert from 'node:assert/strict';
import type http from 'node:http';
import { createServer } from '../src/server/index';
import { makeMockFetch, closeHttpServer } from './helpers';
import type { FetchLike } from '../src/proxy/upstream';


function listen(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    if (server.listening) resolve();
    else server.once('listening', () => resolve());
  });
}

function portOf(server: http.Server): number {
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('server is not listening on a TCP port');
  }
  return address.port;
}


test('POST /v1/chat/completions returns the upstream response (openai → openai)', async () => {
  const upstreamCanned = {
    id: 'chatcmpl-xyz',
    object: 'chat.completion',
    created: 1700000000,
    model: 'gpt-4o-mini',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: 'Hello from upstream' },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
  };

  const server = createServer(0, {
    upstream: {
      baseUrl: 'http://mock.test/v1',
      model: 'gpt-4o-mini',
      protocol: 'openai',
      fetchImpl: makeMockFetch(upstreamCanned),
    },
  });
  await listen(server);
  const port = portOf(server);

  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'Hello' }],
      }),
    });
    assert.equal(res.status, 200);
    const body: unknown = await res.json();
    assert.deepEqual(body, upstreamCanned);
  } finally {
    await closeHttpServer(server);
  }
});

test('POST /v1/messages returns a correctly-translated Anthropic response (anthropic → openai upstream)', async () => {
  const upstreamCanned = {
    id: 'chatcmpl-xyz',
    object: 'chat.completion',
    created: 1700000000,
    model: 'gpt-4o-mini',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: 'Hello from upstream',
          tool_calls: [
            {
              id: 'c1',
              type: 'function',
              function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
            },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
    usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
  };

  const server = createServer(0, {
    upstream: {
      baseUrl: 'http://mock.test/v1',
      model: 'gpt-4o-mini',
      protocol: 'openai',
      fetchImpl: makeMockFetch(upstreamCanned),
    },
  });
  await listen(server);
  const port = portOf(server);

  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': 'test-key' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'Hello' }],
      }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      type: string;
      role: string;
      stop_reason: string;
      content: { type: string; text?: string; name?: string }[];
      usage: { input_tokens: number; output_tokens: number };
    };
    assert.equal(body.type, 'message');
    assert.equal(body.role, 'assistant');
    assert.equal(body.stop_reason, 'tool_use');
    assert.ok(Array.isArray(body.content));
    assert.ok(body.content.some((b) => b.type === 'text' && b.text === 'Hello from upstream'));
    assert.ok(body.content.some((b) => b.type === 'tool_use' && b.name === 'get_weather'));
    assert.equal(body.usage.input_tokens, 3);
    assert.equal(body.usage.output_tokens, 4);
  } finally {
    await closeHttpServer(server);
  }
});

function capturingFetch(sent: { model?: unknown }[]): FetchLike {
  return async (_url, init) => {
    sent.push(JSON.parse(String(init?.body)) as { model?: unknown });
    const body = {
      id: 'x',
      object: 'chat.completion',
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
}

test('provider model overrides the client-sent model on outgoing requests', async () => {
  const sent: { model?: unknown }[] = [];
  const server = createServer(0, {
    upstream: {
      baseUrl: 'http://mock.test/v1',
      model: 'provider-model',
      protocol: 'openai',
      fetchImpl: capturingFetch(sent),
    },
  });
  await listen(server);
  const port = portOf(server);

  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'client-model', messages: [{ role: 'user', content: 'Hi' }] }),
    });
    assert.equal(res.status, 200);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].model, 'provider-model');
  } finally {
    await closeHttpServer(server);
  }
});

test('blank provider model forwards the client-sent model unchanged', async () => {
  const sent: { model?: unknown }[] = [];
  const server = createServer(0, {
    upstream: {
      baseUrl: 'http://mock.test/v1',
      model: '   ',
      protocol: 'openai',
      fetchImpl: capturingFetch(sent),
    },
  });
  await listen(server);
  const port = portOf(server);

  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'client-model', messages: [{ role: 'user', content: 'Hi' }] }),
    });
    assert.equal(res.status, 200);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].model, 'client-model');
  } finally {
    await closeHttpServer(server);
  }
});

test('GET /v1/models returns the configured model(s)', async () => {
  const server = createServer(0, {
    upstream: {
      baseUrl: 'http://mock.test/v1',
      model: 'gpt-4o-mini',
      protocol: 'openai',
      fetchImpl: makeMockFetch({}),
    },
  });
  await listen(server);
  const port = portOf(server);

  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/models`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { object: string; data: { id: string }[] };
    assert.equal(body.object, 'list');
    assert.deepEqual(body.data.map((m) => m.id), ['gpt-4o-mini']);
  } finally {
    await closeHttpServer(server);
  }
});
