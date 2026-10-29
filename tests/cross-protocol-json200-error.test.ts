import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { streamAnthropicRequest, streamOpenAIRequest, type FetchLike, type UpstreamClient } from '../src/proxy/upstream';

const clientOf = (protocol: 'openai' | 'anthropic', fetchImpl: FetchLike): UpstreamClient => ({
  baseUrl: 'http://upstream.test/v1',
  model: 'm',
  protocol,
  fetchImpl,
});

const jsonResponse = (body: string): FetchLike =>
  async () => new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } });

/** Anthropic-shaped JSON-200 with metadata but no content blocks. */
const ANTHROPIC_EMPTY_JSON = JSON.stringify({
  id: 'msg_0',
  type: 'message',
  role: 'assistant',
  model: 'claude',
  content: [],
  usage: { input_tokens: 1, output_tokens: 0 },
});

/** OpenAI-shaped JSON-200 with metadata but no choices. */
const OPENAI_EMPTY_JSON = JSON.stringify({
  id: 'chatcmpl-0',
  object: 'chat.completion',
  created: 1,
  model: 'gpt',
  choices: [],
  usage: { prompt_tokens: 1, completion_tokens: 0, total_tokens: 1 },
});

const ANTHROPIC_CONTENT_JSON = JSON.stringify({
  id: 'msg_9',
  type: 'message',
  role: 'assistant',
  model: 'claude',
  content: [{ type: 'text', text: 'Hello' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 2, output_tokens: 1 },
});

const OPENAI_CONTENT_JSON = JSON.stringify({
  id: 'chatcmpl-9',
  object: 'chat.completion',
  created: 1,
  model: 'gpt',
  choices: [{ index: 0, message: { role: 'assistant', content: 'Hello' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
});

const OAI_CLIENT = { model: 'm', messages: [], stream: true } as never;
const ANTH_CLIENT = { model: 'm', messages: [], max_tokens: 16, stream: true } as never;

describe('cross-protocol JSON-200 without content: explicit client error', () => {
  it('OpenAI client + content-less Anthropic JSON-200 → 502 with OpenAI error shape', async () => {
    const res = await streamOpenAIRequest(clientOf('anthropic', jsonResponse(ANTHROPIC_EMPTY_JSON)), OAI_CLIENT);
    assert.equal(res.status, 502);
    assert.match(res.headers.get('content-type') ?? '', /application\/json/);
    const body = await res.json() as { error: { message: string; type: string } };
    assert.equal(body.error.message, 'upstream returned a non-streaming response without content');
    assert.equal(typeof body.error.type, 'string');
  });

  it('Anthropic client + content-less OpenAI JSON-200 → 502 with Anthropic error shape', async () => {
    const res = await streamAnthropicRequest(clientOf('openai', jsonResponse(OPENAI_EMPTY_JSON)), ANTH_CLIENT);
    assert.equal(res.status, 502);
    assert.match(res.headers.get('content-type') ?? '', /application\/json/);
    const body = await res.json() as { type: string; error: { type: string; message: string } };
    assert.equal(body.type, 'error');
    assert.equal(body.error.message, 'upstream returned a non-streaming response without content');
    assert.equal(typeof body.error.type, 'string');
  });
});

describe('cross-protocol JSON-200 with content: still synthesised as SSE', () => {
  it('OpenAI client + content-bearing Anthropic JSON-200 → 200 SSE', async () => {
    const res = await streamOpenAIRequest(clientOf('anthropic', jsonResponse(ANTHROPIC_CONTENT_JSON)), OAI_CLIENT);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Hello/);
  });

  it('Anthropic client + content-bearing OpenAI JSON-200 → 200 SSE', async () => {
    const res = await streamAnthropicRequest(clientOf('openai', jsonResponse(OPENAI_CONTENT_JSON)), ANTH_CLIENT);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Hello/);
  });
});
