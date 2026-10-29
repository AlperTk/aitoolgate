import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { LLMEvent } from '../src/ports/llm';
import { createAnthropicMessagesProtocol } from '../src/protocols/anthropic-messages';
import { createOpenAIChatProtocol } from '../src/protocols/openai-chat';
import { streamAnthropicRequest, streamOpenAIRequest, type FetchLike, type UpstreamClient } from '../src/proxy/upstream';

const sseResponse = (body: string, status = 200): FetchLike =>
  async () => new Response(body, { status, headers: { 'Content-Type': 'text/event-stream' } });

const clientOf = (protocol: 'openai' | 'anthropic', fetchImpl: FetchLike): UpstreamClient => ({
  baseUrl: 'http://upstream.test/v1',
  model: 'm',
  protocol,
  fetchImpl,
});

async function collect(events: AsyncIterable<LLMEvent>): Promise<LLMEvent[]> {
  const out: LLMEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

const oaiFrame = (delta: Record<string, unknown>, finish: string | null = null): string =>
  `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'gpt', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;

const anthEvent = (name: string, data: Record<string, unknown>): string =>
  `event: ${name}\ndata: ${JSON.stringify({ type: name, ...data })}\n\n`;

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

const ANTHROPIC_THINKING = [
  anthEvent('message_start', { message: { id: 'msg_3', type: 'message', role: 'assistant', model: 'claude', content: [], usage: { input_tokens: 4, output_tokens: 1 } } }),
  anthEvent('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }),
  anthEvent('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'ponder' } }),
  anthEvent('content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: 'sig123' } }),
  anthEvent('content_block_stop', { index: 0 }),
  anthEvent('content_block_start', { index: 1, content_block: { type: 'text', text: '' } }),
  anthEvent('content_block_delta', { index: 1, delta: { type: 'text_delta', text: 'ok' } }),
  anthEvent('content_block_stop', { index: 1 }),
  anthEvent('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } }),
  anthEvent('message_stop', {}),
].join('');

const OPENAI_MIXED = [
  oaiFrame({ role: 'assistant', reasoning_content: 'think' }),
  oaiFrame({ content: 'Hi' }),
  oaiFrame({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"p":' } }] }),
  oaiFrame({ tool_calls: [{ index: 0, function: { arguments: '1}' } }] }),
  oaiFrame({}, 'tool_calls'),
  `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'gpt', choices: [], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } })}\n\n`,
  'data: [DONE]\n\n',
].join('');

const textOf = (events: LLMEvent[]): string =>
  events.map((e) => (e.type === 'text' ? e.text : '')).join('');

describe('cross-protocol stream: OpenAI client <- Anthropic upstream', () => {
  it('re-encodes text deltas and finish into OpenAI chunks', async () => {
    const res = await streamOpenAIRequest(clientOf('anthropic', sseResponse(ANTHROPIC_TEXT)), {
      model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: true,
    } as never);
    const events = await collect(createOpenAIChatProtocol().decodeStream([await res.text()]));
    assert.equal(textOf(events), 'Hello');
    assert.deepEqual(events.at(-1), { type: 'finish', finishReason: 'stop' });
  });

  it('re-encodes a tool_use block into an OpenAI tool_calls delta with complete args', async () => {
    const res = await streamOpenAIRequest(clientOf('anthropic', sseResponse(ANTHROPIC_TOOL)), {
      model: 'm', messages: [], stream: true,
    } as never);
    const events = await collect(createOpenAIChatProtocol().decodeStream([await res.text()]));
    assert.deepEqual(events.find((e) => e.type === 'tool-call'), { type: 'tool-call', id: 'tu_1', name: 'read', args: { p: 1 } });
    assert.deepEqual(events.at(-1), { type: 'finish', finishReason: 'tool-calls' });
  });

  it('carries signed thinking as reasoning_content text', async () => {
    const res = await streamOpenAIRequest(clientOf('anthropic', sseResponse(ANTHROPIC_THINKING)), {
      model: 'm', messages: [], stream: true,
    } as never);
    const events = await collect(createOpenAIChatProtocol().decodeStream([await res.text()]));
    const reasoning = events.filter((e) => e.type === 'reasoning').map((e) => e.text).join('');
    assert.equal(reasoning, 'ponder');
    assert.equal(textOf(events), 'ok');
  });
});

describe('cross-protocol stream: Anthropic client <- OpenAI upstream', () => {
  it('re-encodes text, tool-call and usage; drops unsigned reasoning', async () => {
    const res = await streamAnthropicRequest(clientOf('openai', sseResponse(OPENAI_MIXED)), {
      model: 'm', max_tokens: 100, messages: [], stream: true,
    } as never);
    const wire = await res.text();
    const events = await collect(createAnthropicMessagesProtocol().decodeStream([wire]));
    assert.equal(textOf(events), 'Hi');
    assert.equal(events.some((e) => e.type === 'reasoning'), false);
    assert.deepEqual(events.find((e) => e.type === 'tool-call'), { type: 'tool-call', id: 'call_1', name: 'read', args: { p: 1 } });
    assert.deepEqual(events.at(-1), { type: 'finish', finishReason: 'tool-calls' });
    assert.ok(wire.includes('event: message_stop'));
  });
});

describe('same-protocol stream bypass is unchanged', () => {
  it('OpenAI client + OpenAI upstream returns upstream bytes untouched', async () => {
    const res = await streamOpenAIRequest(clientOf('openai', sseResponse(OPENAI_MIXED)), {
      model: 'm', messages: [], stream: true,
    } as never);
    assert.equal(await res.text(), OPENAI_MIXED);
  });

  it('Anthropic client + Anthropic upstream returns upstream bytes untouched', async () => {
    const res = await streamAnthropicRequest(clientOf('anthropic', sseResponse(ANTHROPIC_THINKING)), {
      model: 'm', max_tokens: 10, messages: [], stream: true,
    } as never);
    assert.equal(await res.text(), ANTHROPIC_THINKING);
  });

  it('non-2xx upstream bodies pass through unchanged on a cross-protocol route', async () => {
    const errorBody = '{"error":"rate limited"}';
    const res = await streamOpenAIRequest(clientOf('anthropic', sseResponse(errorBody, 429)), {
      model: 'm', messages: [], stream: true,
    } as never);
    assert.equal(res.status, 429);
    assert.equal(await res.text(), errorBody);
  });
});

async function collectStrings(frames: AsyncIterable<string>): Promise<string> {
  let out = '';
  for await (const frame of frames) out += frame;
  return out;
}

const jsonResponse = (body: string, status = 200): FetchLike =>
  async () => new Response(body, { status, headers: { 'Content-Type': 'application/json' } });

const ANTHROPIC_JSON = JSON.stringify({
  id: 'msg_9',
  type: 'message',
  role: 'assistant',
  model: 'claude',
  content: [{ type: 'text', text: 'Hello' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 2, output_tokens: 1 },
});

describe('cross-protocol stream: id and model metadata', () => {
  it('decodeStream exposes the upstream id and model on step-start', async () => {
    const events = await collect(createOpenAIChatProtocol().decodeStream([OPENAI_MIXED]));
    assert.deepEqual(events[0], { type: 'step-start', id: 'c1', model: 'gpt' });
  });

  it('encodeStream uses the event id/model and omits model when unknown', async () => {
    const encoded = await collectStrings(createAnthropicMessagesProtocol().encodeStream([
      { type: 'step-start', id: 'c1', model: 'gpt' },
      { type: 'text', text: 'x' },
    ]));
    assert.match(encoded, /"id":"c1"/);
    assert.match(encoded, /"model":"gpt"/);
    const bare = await collectStrings(createOpenAIChatProtocol().encodeStream([{ type: 'text', text: 'x' }]));
    assert.match(bare, /"id":"chatcmpl-aitoolgate"/);
    assert.doesNotMatch(bare, /"model":""/);
  });
});

describe('cross-protocol stream: JSON-200 upstream bodies', () => {
  it('synthesises an OpenAI SSE stream from a decodable Anthropic JSON body', async () => {
    const res = await streamOpenAIRequest(clientOf('anthropic', jsonResponse(ANTHROPIC_JSON)), {
      model: 'm', messages: [], stream: true,
    } as never);
    const wire = await res.text();
    assert.ok(wire.length > 0, 'must not produce an empty stream');
    const events = await collect(createOpenAIChatProtocol().decodeStream([wire]));
    assert.equal(textOf(events), 'Hello');
    assert.deepEqual(events.at(-1), { type: 'finish', finishReason: 'stop' });
  });

  it('forwards an undecodable JSON-200 body raw', async () => {
    const body = '{"type":"error","error":{"message":"nope"}}';
    const res = await streamOpenAIRequest(clientOf('anthropic', jsonResponse(body)), {
      model: 'm', messages: [], stream: true,
    } as never);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), body);
  });
});
