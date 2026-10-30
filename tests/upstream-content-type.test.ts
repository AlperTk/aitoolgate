/**
 * Response Content-Type follows the body kind: streamed 2xx responses are
 * text/event-stream; non-2xx errors, 502 metadata-only errors and non-stream
 * JSON responses are application/json.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startAtgServer, closeAtgServer } from './helpers';
import type { FetchLike, UpstreamClient } from '../src/proxy/upstream';

function upstream(fetchImpl: FetchLike): UpstreamClient {
  return { baseUrl: 'http://127.0.0.1:9999/v1', model: 'gpt-4o-mini', protocol: 'openai', fetchImpl };
}
function jsonFetch(status: number, canned: unknown): FetchLike {
  return async () => new Response(JSON.stringify(canned), { status, headers: { 'Content-Type': 'application/json' } });
}
function sseFetch(text: string): FetchLike {
  const enc = new TextEncoder();
  return async () =>
    new Response(
      new ReadableStream({ start: (c) => { c.enqueue(enc.encode(text)); c.close(); } }),
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    );
}
const delta = (d: unknown): string => `data: ${JSON.stringify({ choices: [{ delta: d }] })}\n\n`;
const chatBody = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  model: 'gpt-4o-mini',
  messages: [{ role: 'user', content: 'hi' }],
  ...extra,
});
async function post(port: number, body: Record<string, unknown>): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}
const contentTypeOf = (res: Response): string => res.headers.get('content-type') ?? '';

test('streamed 2xx response is text/event-stream', async () => {
  const sse = delta({ content: 'hello' }) + 'data: [DONE]\n\n';
  const { port, srv } = await startAtgServer({ upstream: upstream(sseFetch(sse)) }, { ws: false });
  try {
    const res = await post(port, chatBody({ stream: true }));
    assert.equal(res.status, 200);
    assert.match(contentTypeOf(res), /^text\/event-stream/);
    await res.text();
  } finally {
    await closeAtgServer(srv);
  }
});

test('streamed non-2xx JSON error is application/json, not event-stream', async () => {
  const { port, srv } = await startAtgServer(
    { upstream: upstream(jsonFetch(429, { error: { message: 'rate limited' } })) },
    { ws: false },
  );
  try {
    const res = await post(port, chatBody({ stream: true }));
    assert.equal(res.status, 429);
    assert.match(contentTypeOf(res), /^application\/json/);
    await res.text();
  } finally {
    await closeAtgServer(srv);
  }
});

test('streamed 502 metadata-only error is application/json, not event-stream', async () => {
  const metadataOnly = { id: 'chatcmpl-0', object: 'chat.completion', created: 1, model: 'gpt', choices: [], usage: { prompt_tokens: 1, completion_tokens: 0, total_tokens: 1 } };
  const { port, srv } = await startAtgServer({ upstream: upstream(jsonFetch(200, metadataOnly)) }, { ws: false });
  try {
    const res = await post(port, chatBody({ stream: true }));
    assert.equal(res.status, 502);
    assert.match(contentTypeOf(res), /^application\/json/);
    await res.text();
  } finally {
    await closeAtgServer(srv);
  }
});

test('non-stream 200 JSON response is application/json', async () => {
  const canned = {
    id: 'chatcmpl-ct',
    object: 'chat.completion',
    created: 1700000000,
    model: 'gpt-4o-mini',
    choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
  };
  const { port, srv } = await startAtgServer({ upstream: upstream(jsonFetch(200, canned)) }, { ws: false });
  try {
    const res = await post(port, chatBody());
    assert.equal(res.status, 200);
    assert.match(contentTypeOf(res), /^application\/json/);
    await res.text();
  } finally {
    await closeAtgServer(srv);
  }
});
