import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Transform } from 'node:stream';
import { createProxyHandler } from '../src/proxy/index';
import { defaultProxyDefaults } from '../src/composition';
import { closeHttpServer } from './helpers';
import type { FetchLike, UpstreamClient } from '../src/proxy/upstream';
import type { ProxyDefaults } from '../src/ports/telemetry';

type Captured = { url: string; body: Record<string, unknown> };

const oaiFrame = (delta: Record<string, unknown>, finish: string | null = null): string =>
  `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'gpt', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;

const anthEvent = (name: string, data: Record<string, unknown>): string =>
  `event: ${name}\ndata: ${JSON.stringify({ type: name, ...data })}\n\n`;

const OPENAI_TEXT = [
  oaiFrame({ role: 'assistant', content: 'Hel' }),
  oaiFrame({ content: 'lo' }),
  oaiFrame({}, 'stop'),
  'data: [DONE]\n\n',
].join('');

const OPENAI_TOOL = [
  oaiFrame({ role: 'assistant', tool_calls: [{ index: 0, id: 'tu_1', type: 'function', function: { name: 'read', arguments: '' } }] }),
  oaiFrame({ tool_calls: [{ index: 0, function: { arguments: '{"p":' } }] }),
  oaiFrame({ tool_calls: [{ index: 0, function: { arguments: '1}' } }] }),
  oaiFrame({}, 'tool_calls'),
  'data: [DONE]\n\n',
].join('');

const ANTHROPIC_TEXT = [
  anthEvent('message_start', { message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude', content: [], usage: { input_tokens: 12, output_tokens: 1 } } }),
  anthEvent('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
  anthEvent('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Hel' } }),
  anthEvent('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'lo' } }),
  anthEvent('content_block_stop', { index: 0 }),
  anthEvent('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } }),
  anthEvent('message_stop', {}),
].join('');

const ANTHROPIC_TOOL = [
  anthEvent('message_start', { message: { id: 'msg_2', type: 'message', role: 'assistant', model: 'claude', content: [], usage: { input_tokens: 9, output_tokens: 1 } } }),
  anthEvent('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'tu_1', name: 'read', input: {} } }),
  anthEvent('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '{"p":' } }),
  anthEvent('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '1}' } }),
  anthEvent('content_block_stop', { index: 0 }),
  anthEvent('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 7 } }),
  anthEvent('message_stop', {}),
].join('');

function upstreamFetch(body: string, log: Captured[], contentType = 'text/event-stream'): FetchLike {
  return async (url, init) => {
    log.push({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    return new Response(body, { status: 200, headers: { 'Content-Type': contentType } });
  };
}

const OPENAI_JSON = JSON.stringify({
  id: 'chatcmpl-9',
  object: 'chat.completion',
  created: 1,
  model: 'gpt',
  choices: [{ index: 0, message: { role: 'assistant', content: 'Hello' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
});

function listen(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    if (server.listening) resolve();
    else server.once('listening', () => resolve());
  });
}

function portOf(server: http.Server): number {
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('server is not listening on a TCP port');
  return address.port;
}

/** Parse `data:` JSON payloads of an OpenAI-shaped SSE body. */
function openaiChunks(body: string): Array<Record<string, any>> {
  return body
    .split('\n')
    .filter((line) => line.startsWith('data:') && !line.includes('[DONE]'))
    .map((line) => JSON.parse(line.slice('data:'.length).trim()) as Record<string, any>);
}

/** Parse `event:`/`data:` frames of an Anthropic-shaped SSE body. */
function anthropicEvents(body: string): Array<{ event: string; data: Record<string, any> }> {
  return body
    .split('\n\n')
    .filter((block) => block.includes('event:'))
    .map((block) => {
      const event = /^event: (.+)$/m.exec(block)?.[1] ?? '';
      const data = /^data: (.+)$/m.exec(block)?.[1] ?? '{}';
      return { event, data: JSON.parse(data) as Record<string, any> };
    });
}

async function postStream(
  upstream: Pick<UpstreamClient, 'protocol' | 'fetchImpl'>,
  clientPath: string,
  clientBody: Record<string, unknown>,
  defaults: ProxyDefaults = defaultProxyDefaults,
): Promise<{ status: number; contentType: string | null; body: string }> {
  const handler = createProxyHandler({
    upstream: { baseUrl: 'http://mock.test/v1', model: 'm', ...upstream },
    defaults,
  });
  const srv = http.createServer(async (req, res) => {
    if (!(await handler(req, res))) {
      res.writeHead(404);
      res.end();
    }
  });
  srv.listen(0, '127.0.0.1');
  await listen(srv);
  try {
    const res = await fetch(`http://127.0.0.1:${portOf(srv)}${clientPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(clientBody),
    });
    return { status: res.status, contentType: res.headers.get('content-type'), body: await res.text() };
  } finally {
    await closeHttpServer(srv);
  }
}

const OAI_CLIENT = { model: 'gpt', stream: true, messages: [{ role: 'user', content: 'hi' }] };
const ANTH_CLIENT = { model: 'claude', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'hi' }] };
const ANTH_TOOL_CLIENT = {
  ...ANTH_CLIENT,
  tools: [{ name: 'read', description: 'read a file', input_schema: { type: 'object' } }],
};
const OAI_TOOL_CLIENT = {
  ...OAI_CLIENT,
  tools: [{ type: 'function', function: { name: 'read', description: 'read a file', parameters: { type: 'object' } } }],
};

test('OpenAI client + Anthropic upstream: stream:true returns OpenAI-shaped SSE text', async () => {
  const log: Captured[] = [];
  const res = await postStream({ protocol: 'anthropic', fetchImpl: upstreamFetch(ANTHROPIC_TEXT, log) }, '/v1/chat/completions', OAI_CLIENT);

  assert.equal(res.status, 200);
  assert.match(res.contentType ?? '', /^text\/event-stream/);
  const chunks = openaiChunks(res.body);
  assert.ok(chunks.length > 0);
  assert.ok(chunks.every((c) => c.object === 'chat.completion.chunk'));
  assert.equal(chunks.map((c) => c.choices[0]?.delta?.content ?? '').join(''), 'Hello');
  assert.equal(log.length, 1);
  assert.match(log[0]!.url, /\/messages$/);
  assert.equal(log[0]!.body.stream, true);
});

test('Anthropic client + OpenAI upstream: stream:true returns Anthropic-shaped SSE text', async () => {
  const log: Captured[] = [];
  const res = await postStream({ protocol: 'openai', fetchImpl: upstreamFetch(OPENAI_TEXT, log) }, '/v1/messages', ANTH_CLIENT);

  assert.equal(res.status, 200);
  assert.match(res.contentType ?? '', /^text\/event-stream/);
  const events = anthropicEvents(res.body);
  assert.equal(events[0]?.event, 'message_start');
  assert.equal(events.at(-1)?.event, 'message_stop');
  const text = events
    .filter((e) => e.event === 'content_block_delta' && e.data.delta?.type === 'text_delta')
    .map((e) => e.data.delta.text as string)
    .join('');
  assert.equal(text, 'Hello');
  assert.match(log[0]!.url, /\/chat\/completions$/);
  assert.equal(log[0]!.body.stream, true);
});

test('OpenAI client + Anthropic upstream: tool-call stream keeps tool name and arguments', async () => {
  const log: Captured[] = [];
  const res = await postStream({ protocol: 'anthropic', fetchImpl: upstreamFetch(ANTHROPIC_TOOL, log) }, '/v1/chat/completions', OAI_TOOL_CLIENT);

  assert.match(res.contentType ?? '', /^text\/event-stream/);
  const calls = openaiChunks(res.body).flatMap((c) => c.choices[0]?.delta?.tool_calls ?? []);
  assert.equal(calls[0]?.function?.name, 'read');
  assert.equal(calls.map((c) => c.function?.arguments ?? '').join(''), '{"p":1}');
});

test('Anthropic client + OpenAI upstream: tool-call stream keeps tool name and arguments', async () => {
  const log: Captured[] = [];
  const res = await postStream({ protocol: 'openai', fetchImpl: upstreamFetch(OPENAI_TOOL, log) }, '/v1/messages', ANTH_TOOL_CLIENT);

  assert.match(res.contentType ?? '', /^text\/event-stream/);
  const events = anthropicEvents(res.body);
  const start = events.find((e) => e.event === 'content_block_start' && e.data.content_block?.type === 'tool_use');
  assert.equal(start?.data.content_block.name, 'read');
  const args = events
    .filter((e) => e.event === 'content_block_delta' && e.data.delta?.type === 'input_json_delta')
    .map((e) => e.data.delta.partial_json as string)
    .join('');
  assert.equal(args, '{"p":1}');
});

test('telemetry extractor receives the UPSTREAM raw SSE bytes on cross-protocol streams', async () => {
  const seen: string[] = [];
  const spyDefaults: ProxyDefaults = {
    ...defaultProxyDefaults,
    makeSseExtractor: () =>
      new Transform({
        transform(chunk: Buffer, _enc, cb) {
          seen.push(chunk.toString('utf8'));
          cb(null, chunk);
        },
      }),
  };
  const log: Captured[] = [];
  const res = await postStream(
    { protocol: 'anthropic', fetchImpl: upstreamFetch(ANTHROPIC_TEXT, log) },
    '/v1/chat/completions',
    OAI_CLIENT,
    spyDefaults,
  );

  assert.equal(res.status, 200);
  const upstreamBytes = seen.join('');
  assert.ok(upstreamBytes.includes('event: message_start'), 'extractor must see upstream Anthropic frames');
  assert.ok(!upstreamBytes.includes('chat.completion.chunk'), 'extractor must not see translated client frames');
});

test('telemetry transform failure does not break the client stream', async () => {
  const brokenDefaults: ProxyDefaults = {
    ...defaultProxyDefaults,
    makeSseExtractor: () =>
      new Transform({
        transform(_chunk, _enc, cb) {
          cb(new Error('telemetry boom'));
        },
      }),
  };
  const log: Captured[] = [];
  const res = await postStream(
    { protocol: 'anthropic', fetchImpl: upstreamFetch(ANTHROPIC_TEXT, log) },
    '/v1/chat/completions',
    OAI_CLIENT,
    brokenDefaults,
  );

  assert.equal(res.status, 200);
  assert.equal(openaiChunks(res.body).map((c) => c.choices[0]?.delta?.content ?? '').join(''), 'Hello');
});

test('telemetry factory that throws synchronously does not break the client stream', async () => {
  const throwingDefaults: ProxyDefaults = {
    ...defaultProxyDefaults,
    makeSseExtractor: () => {
      throw new Error('factory boom');
    },
  };
  const log: Captured[] = [];
  const res = await postStream(
    { protocol: 'openai', fetchImpl: upstreamFetch(OPENAI_TEXT, log) },
    '/v1/messages',
    ANTH_CLIENT,
    throwingDefaults,
  );

  assert.equal(res.status, 200);
  const text = anthropicEvents(res.body)
    .filter((e) => e.data.delta?.type === 'text_delta')
    .map((e) => e.data.delta.text as string)
    .join('');
  assert.equal(text, 'Hello');
});

test('OpenAI client + Anthropic upstream: client chunks carry the upstream id and model', async () => {
  const log: Captured[] = [];
  const res = await postStream({ protocol: 'anthropic', fetchImpl: upstreamFetch(ANTHROPIC_TEXT, log) }, '/v1/chat/completions', OAI_CLIENT);

  const chunks = openaiChunks(res.body);
  assert.ok(chunks.length > 0);
  assert.ok(chunks.every((c) => c.id === 'msg_1' && c.model === 'claude'), 'every chunk must carry upstream id/model');
});

test('Anthropic client + OpenAI upstream: message_start carries the upstream id and model', async () => {
  const log: Captured[] = [];
  const res = await postStream({ protocol: 'openai', fetchImpl: upstreamFetch(OPENAI_TEXT, log) }, '/v1/messages', ANTH_CLIENT);

  const start = anthropicEvents(res.body).find((e) => e.event === 'message_start');
  assert.equal(start?.data.message.id, 'c1');
  assert.equal(start?.data.message.model, 'gpt');
});

test('Anthropic client + OpenAI JSON-200 upstream: synthesises an Anthropic SSE stream from the decoded body', async () => {
  const log: Captured[] = [];
  const res = await postStream({ protocol: 'openai', fetchImpl: upstreamFetch(OPENAI_JSON, log, 'application/json') }, '/v1/messages', ANTH_CLIENT);

  assert.equal(res.status, 200);
  const events = anthropicEvents(res.body);
  assert.ok(events.length > 0, 'JSON-200 must never produce an empty stream');
  assert.equal(events[0]?.event, 'message_start');
  assert.equal(events[0]?.data.message.id, 'chatcmpl-9');
  assert.equal(events.at(-1)?.event, 'message_stop');
  const text = events
    .filter((e) => e.event === 'content_block_delta' && e.data.delta?.type === 'text_delta')
    .map((e) => e.data.delta.text as string)
    .join('');
  assert.equal(text, 'Hello');
});

test('OpenAI client + Anthropic JSON-200 upstream with undecodable body: raw body is forwarded unchanged', async () => {
  const log: Captured[] = [];
  const raw = '{"unexpected":true}';
  const res = await postStream({ protocol: 'anthropic', fetchImpl: upstreamFetch(raw, log, 'application/json') }, '/v1/chat/completions', OAI_CLIENT);

  assert.equal(res.status, 200);
  assert.equal(res.body, raw);
});

test('same-protocol JSON-200 upstream bytes are forwarded byte-identical', async () => {
  const log: Captured[] = [];
  const res = await postStream({ protocol: 'openai', fetchImpl: upstreamFetch(OPENAI_JSON, log, 'application/json') }, '/v1/chat/completions', OAI_CLIENT);

  assert.equal(res.body, OPENAI_JSON);
});
