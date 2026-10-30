import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createOpenAIChatProtocol } from '../src/protocols/openai-chat';
import { createAnthropicMessagesProtocol } from '../src/protocols/anthropic-messages';
import type { Protocol } from '../src/ports/protocol';
import type { InternalLLMEvent } from '../src/ports/llm';
import { reencodeRequest } from '../src/proxy/translate';
import { forwardRequest, streamForClient, type FetchLike, type UpstreamClient } from '../src/proxy/upstream';

const NO_CONTENT = 'upstream returned a non-streaming response without content';
const UNDECODABLE_REQUEST = 'request body could not be decoded';

const clientOf = (protocol: 'openai' | 'anthropic', fetchImpl: FetchLike): UpstreamClient => ({
  baseUrl: 'http://upstream.test/v1',
  model: 'm',
  protocol,
  fetchImpl,
});

const jsonResponse = (body: string): FetchLike =>
  async () => new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } });

const OPENAI_WIRE = {
  id: 'chatcmpl-9',
  object: 'chat.completion',
  created: 1,
  model: 'gpt',
  choices: [{ index: 0, message: { role: 'assistant', content: 'Hello' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
};

const ANTHROPIC_WIRE = {
  id: 'msg_9',
  type: 'message',
  role: 'assistant',
  model: 'claude',
  content: [{ type: 'text', text: 'Hello' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 2, output_tokens: 1 },
};

const OAI_REQUEST = { model: 'm', messages: [{ role: 'user', content: 'hi' }] };
const ANTH_REQUEST = { model: 'm', messages: [{ role: 'user', content: 'hi' }], max_tokens: 16 };

const openai = createOpenAIChatProtocol();
const anthropic = createAnthropicMessagesProtocol();

/** The expected client-side body: the upstream wire decoded to the internal form, then re-encoded. */
function reencodedResponse(from: Protocol, to: Protocol, wire: unknown): unknown {
  const internal = from.decodeResponse(wire);
  assert.notEqual(internal, undefined);
  return to.encodeResponse(internal!);
}

describe('non-stream response: decode → internal → encode for the client protocol', () => {
  it('OpenAI client + OpenAI upstream (same protocol) → re-encoded OpenAI body', async () => {
    const result = await forwardRequest(clientOf('openai', jsonResponse(JSON.stringify(OPENAI_WIRE))), 'openai-chat', OAI_REQUEST);
    assert.equal(result.status, 200);
    assert.equal(result.ok, true);
    assert.deepEqual(result.body, reencodedResponse(openai, openai, OPENAI_WIRE));
    const body = result.body as { choices: Array<{ message: { role: string; content: string } }> };
    assert.equal(body.choices[0]?.message.role, 'assistant');
    assert.equal(body.choices[0]?.message.content, 'Hello');
  });

  it('Anthropic client + Anthropic upstream (same protocol) → re-encoded Anthropic body', async () => {
    const result = await forwardRequest(
      clientOf('anthropic', jsonResponse(JSON.stringify(ANTHROPIC_WIRE))),
      'anthropic-messages',
      ANTH_REQUEST,
    );
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, reencodedResponse(anthropic, anthropic, ANTHROPIC_WIRE));
    const body = result.body as { type: string; role: string; content: Array<{ type: string; text: string }>; stop_reason: string };
    assert.equal(body.type, 'message');
    assert.equal(body.role, 'assistant');
    assert.equal(body.content[0]?.type, 'text');
    assert.equal(body.content[0]?.text, 'Hello');
    assert.equal(body.stop_reason, 'end_turn');
  });

  it('OpenAI client + Anthropic upstream (cross protocol) → OpenAI-shaped body', async () => {
    const result = await forwardRequest(clientOf('anthropic', jsonResponse(JSON.stringify(ANTHROPIC_WIRE))), 'openai-chat', OAI_REQUEST);
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, reencodedResponse(anthropic, openai, ANTHROPIC_WIRE));
    const body = result.body as { choices: Array<{ message: { content: string } }> };
    assert.equal(body.choices[0]?.message.content, 'Hello');
  });

  it('Anthropic client + OpenAI upstream (cross protocol) → Anthropic-shaped body', async () => {
    const result = await forwardRequest(clientOf('openai', jsonResponse(JSON.stringify(OPENAI_WIRE))), 'anthropic-messages', ANTH_REQUEST);
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, reencodedResponse(openai, anthropic, OPENAI_WIRE));
    const body = result.body as { type: string; content: Array<{ text: string }> };
    assert.equal(body.type, 'message');
    assert.equal(body.content[0]?.text, 'Hello');
  });
});

describe('Anthropic usage omission when internal usage is undefined', () => {
  const { usage: _usage, ...WIRE_WITHOUT_USAGE } = ANTHROPIC_WIRE;

  it('non-stream: no upstream usage → encoded body has no usage key', () => {
    const internal = anthropic.decodeResponse(WIRE_WITHOUT_USAGE);
    assert.notEqual(internal, undefined);
    assert.equal(internal!.usage, undefined);
    const body = anthropic.encodeResponse(internal!);
    assert.equal('usage' in body, false);
  });

  it('non-stream: upstream usage → real counts are present', () => {
    const internal = anthropic.decodeResponse(ANTHROPIC_WIRE);
    assert.notEqual(internal, undefined);
    const body = anthropic.encodeResponse(internal!) as { usage?: { input_tokens: number; output_tokens: number } };
    assert.deepEqual(body.usage, { input_tokens: 2, output_tokens: 1 });
  });

  it('stream: no usage event → message_delta has no usage key', async () => {
    const events: InternalLLMEvent[] = [
      { type: 'step-start', id: 'msg_1', model: 'claude' },
      { type: 'text', text: 'Hello' },
      { type: 'finish', finishReason: 'stop' },
    ];
    const frames: string[] = [];
    for await (const chunk of anthropic.encodeStream(events)) frames.push(chunk);
    const delta = frames.find((f) => f.startsWith('event: message_delta\n'));
    assert.notEqual(delta, undefined);
    const data = JSON.parse(delta!.split('\n')[1]!.slice('data: '.length)) as Record<string, unknown>;
    assert.equal('usage' in data, false);
  });
});

describe('non-SSE 2xx upstream body that cannot be decoded: client-protocol 502', () => {
  const htmlResponse: FetchLike = async () =>
    new Response('<html>gateway</html>', { status: 200, headers: { 'Content-Type': 'text/html' } });

  it('OpenAI client → 502 with OpenAI error shape', async () => {
    const res = await streamForClient(clientOf('openai', htmlResponse), 'openai-chat', { ...OAI_REQUEST, stream: true });
    assert.equal(res.status, 502);
    assert.match(res.headers.get('content-type') ?? '', /application\/json/);
    const body = await res.json() as { error: { message: string; type: string } };
    assert.equal(body.error.message, NO_CONTENT);
    assert.equal(typeof body.error.type, 'string');
  });

  it('Anthropic client → 502 with Anthropic error shape', async () => {
    const res = await streamForClient(clientOf('anthropic', htmlResponse), 'anthropic-messages', { ...ANTH_REQUEST, stream: true });
    assert.equal(res.status, 502);
    const body = await res.json() as { type: string; error: { message: string } };
    assert.equal(body.type, 'error');
    assert.equal(body.error.message, NO_CONTENT);
  });

  it('non-stream forward of an undecodable 200 body → 502 with client error body, not the raw bytes', async () => {
    const result = await forwardRequest(clientOf('openai', htmlResponse), 'openai-chat', OAI_REQUEST);
    assert.equal(result.status, 502);
    assert.equal(result.ok, false);
    assert.equal((result.body as { error: { message: string } }).error.message, NO_CONTENT);
  });
});

describe('undecodable client request: error response, nothing sent upstream', () => {
  // `messages` missing → the client-protocol decoder returns undefined.
  const undecodableOpenAI = { model: 'm' };
  const undecodableAnthropic = { model: 'm', max_tokens: 16 };

  it('reencodeRequest returns undefined instead of an empty-message request', () => {
    assert.equal(reencodeRequest('openai-chat', 'openai-chat', undecodableOpenAI), undefined);
    assert.equal(reencodeRequest('anthropic-messages', 'openai-chat', undecodableAnthropic), undefined);
  });

  it('forwardRequest → 400 client error and no upstream call', async () => {
    let calls = 0;
    const counting: FetchLike = async () => {
      calls += 1;
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const result = await forwardRequest(clientOf('openai', counting), 'openai-chat', undecodableOpenAI);
    assert.equal(result.status, 400);
    assert.equal(result.ok, false);
    assert.equal((result.body as { error: { message: string } }).error.message, UNDECODABLE_REQUEST);
    assert.equal(calls, 0);
  });

  it('streamForClient → 400 Anthropic error and no upstream call', async () => {
    let calls = 0;
    const counting: FetchLike = async () => {
      calls += 1;
      return new Response('data: {}\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    };
    const res = await streamForClient(clientOf('openai', counting), 'anthropic-messages', undecodableAnthropic);
    assert.equal(res.status, 400);
    const body = await res.json() as { type: string; error: { message: string } };
    assert.equal(body.type, 'error');
    assert.equal(body.error.message, UNDECODABLE_REQUEST);
    assert.equal(calls, 0);
  });
});
