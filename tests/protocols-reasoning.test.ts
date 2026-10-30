import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createOpenAIChatProtocol } from '../src/protocols/openai-chat';
import { createAnthropicMessagesProtocol } from '../src/protocols/anthropic-messages';
import type { InternalLLMEvent } from '../src/ports/llm';

const openai = createOpenAIChatProtocol();
const anthropic = createAnthropicMessagesProtocol();

const sse = (type: string, data: Record<string, unknown>): string =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;

async function collect(
  protocol: { decodeStream(chunks: Iterable<string>): AsyncIterable<InternalLLMEvent> },
  chunks: string[],
): Promise<InternalLLMEvent[]> {
  const out: InternalLLMEvent[] = [];
  for await (const event of protocol.decodeStream(chunks)) out.push(event);
  return out;
}

type WireMessage = { role: string; content: unknown; reasoning_content?: string };
type AnthropicWireMessage = { role: string; content: unknown };

describe('openai-chat reasoning', () => {
  it('decodes reasoning_content from a non-stream response into a reasoning part', () => {
    const decoded = openai.decodeResponse({
      model: 'm',
      choices: [
        {
          finish_reason: 'stop',
          message: { role: 'assistant', content: 'answer', reasoning_content: 'think' },
        },
      ],
    });
    assert.deepEqual(decoded?.message.parts, [
      { type: 'text', text: 'answer' },
      { type: 'reasoning', text: 'think' },
    ]);
  });

  it('decodes streamed reasoning_content deltas into reasoning events before text', async () => {
    const events = await collect(openai, [
      'data: {"choices":[{"delta":{"reasoning_content":"ab"}}]}\n\n',
      'data: {"choices":[{"delta":{"reasoning_content":"cd"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"x"}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ]);
    const reasoning = events.filter((event) => event.type === 'reasoning');
    assert.deepEqual(reasoning, [
      { type: 'reasoning', text: 'ab' },
      { type: 'reasoning', text: 'cd' },
    ]);
    assert.ok(events.some((event) => event.type === 'text' && event.text === 'x'));
  });

  it('encodes assistant reasoning parts back as reasoning_content on the request message', () => {
    const wire = openai.encodeRequest({
      model: 'm',
      messages: [
        {
          role: 'assistant',
          parts: [
            { type: 'reasoning', text: 'think' },
            { type: 'text', text: 'answer' },
          ],
        },
      ],
    }) as { messages: WireMessage[] };
    assert.deepEqual(wire.messages[0], { role: 'assistant', content: 'answer', reasoning_content: 'think' });
  });

  it('encodes reasoning-only assistant turns with content null and reasoning_content', () => {
    const wire = openai.encodeRequest({
      model: 'm',
      messages: [{ role: 'assistant', parts: [{ type: 'reasoning', text: 'only thoughts' }] }],
    }) as { messages: WireMessage[] };
    assert.deepEqual(wire.messages[0], { role: 'assistant', content: null, reasoning_content: 'only thoughts' });
  });

  it('encodes reasoning as reasoning_content on a non-stream response', () => {
    const wire = openai.encodeResponse({
      message: { role: 'assistant', parts: [{ type: 'reasoning', text: 'think' }, { type: 'text', text: 'hi' }] },
    }) as { choices: Array<{ message: WireMessage }> };
    assert.equal(wire.choices[0]?.message.reasoning_content, 'think');
    assert.equal(wire.choices[0]?.message.content, 'hi');
  });

  it('does not add reasoning_content when there is no reasoning', () => {
    const wire = openai.encodeRequest({
      model: 'm',
      messages: [{ role: 'assistant', parts: [{ type: 'text', text: 'plain' }] }],
    }) as { messages: WireMessage[] };
    assert.equal('reasoning_content' in (wire.messages[0] ?? {}), false);
  });
});

describe('anthropic-messages reasoning', () => {
  it('decodes a signed thinking block (non-stream) and round-trips it through encode and decode', () => {
    const decoded = anthropic.decodeResponse({
      model: 'm',
      content: [
        { type: 'thinking', thinking: 'hmm', signature: 'sig' },
        { type: 'text', text: 'hello' },
      ],
      stop_reason: 'end_turn',
    });
    assert.deepEqual(decoded?.message.parts, [
      { type: 'reasoning', text: 'hmm', signature: 'sig' },
      { type: 'text', text: 'hello' },
    ]);

    const wire = anthropic.encodeRequest({
      model: 'm',
      messages: [{ role: 'assistant', parts: decoded?.message.parts ?? [] }],
    }) as { messages: AnthropicWireMessage[] };
    assert.deepEqual(wire.messages[0]?.content, [
      { type: 'thinking', thinking: 'hmm', signature: 'sig' },
      { type: 'text', text: 'hello' },
    ]);

    const back = anthropic.decodeRequest({ model: 'm', max_tokens: 10, messages: wire.messages });
    assert.deepEqual(back?.messages[0]?.parts, [
      { type: 'reasoning', text: 'hmm', signature: 'sig' },
      { type: 'text', text: 'hello' },
    ]);
  });

  it('round-trips redacted_thinking through encode and decode', () => {
    const decoded = anthropic.decodeResponse({
      model: 'm',
      content: [{ type: 'redacted_thinking', data: 'opaque' }, { type: 'text', text: 'hi' }],
    });
    assert.deepEqual(decoded?.message.parts, [
      { type: 'reasoning', text: '', redactedData: 'opaque' },
      { type: 'text', text: 'hi' },
    ]);

    const wire = anthropic.encodeResponse({ message: decoded?.message ?? { role: 'assistant', parts: [] } }) as {
      content: unknown[];
    };
    assert.deepEqual(wire.content, [{ type: 'redacted_thinking', data: 'opaque' }, { type: 'text', text: 'hi' }]);

    const back = anthropic.decodeRequest({
      model: 'm',
      max_tokens: 10,
      messages: [{ role: 'assistant', content: wire.content }],
    });
    assert.deepEqual(back?.messages[0]?.parts, [
      { type: 'reasoning', text: '', redactedData: 'opaque' },
      { type: 'text', text: 'hi' },
    ]);
  });

  it('decodes signed thinking and redacted_thinking from a stream', async () => {
    const events = await collect(anthropic, [
      sse('message_start', { message: { id: 'm1', model: 'm', usage: { input_tokens: 1, output_tokens: 0 } } }),
      sse('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '' } }),
      sse('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'consider' } }),
      sse('content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: 'sigX' } }),
      sse('content_block_stop', { index: 0 }),
      sse('content_block_start', { index: 1, content_block: { type: 'redacted_thinking', data: 'opaque' } }),
      sse('content_block_stop', { index: 1 }),
      sse('message_stop', {}),
    ]);
    const reasoning = events.filter((event) => event.type === 'reasoning');
    assert.deepEqual(reasoning, [
      { type: 'reasoning', text: 'consider' },
      { type: 'reasoning', text: '', signature: 'sigX' },
      { type: 'reasoning', text: '', redactedData: 'opaque' },
    ]);
  });

  it('does not encode unsigned thinking (request or response)', () => {
    const parts = [
      { type: 'reasoning' as const, text: 'unsigned thought' },
      { type: 'text' as const, text: 'answer' },
    ];
    const request = anthropic.encodeRequest({ model: 'm', messages: [{ role: 'assistant', parts }] }) as {
      messages: AnthropicWireMessage[];
    };
    assert.deepEqual(request.messages[0]?.content, [{ type: 'text', text: 'answer' }]);

    const response = anthropic.encodeResponse({ message: { role: 'assistant', parts } }) as { content: unknown[] };
    assert.deepEqual(response.content, [{ type: 'text', text: 'answer' }]);
    assert.ok(!JSON.stringify(response).includes('thinking'));
  });
});

describe('reasoning decoding is non-throwing', () => {
  it('ignores unknown stream frames and unknown content blocks', async () => {
    const events = await collect(openai, [
      'data: {"choices":[{"delta":{"future_field":{"x":1}}}]}\n\n',
      'data: {broken\n\n',
      'event: weird\ndata: {"type":"future_event"}\n\n',
      'data: [DONE]\n\n',
    ]);
    assert.ok(Array.isArray(events));

    const anthropicEvents = await collect(anthropic, [
      'event: weird\ndata: {"type":"future_event","x":1}\n\n',
      'data: {broken\n\n',
      sse('content_block_start', { index: 0, content_block: { type: 'future_block', data: 'z' } }),
      sse('content_block_stop', { index: 0 }),
    ]);
    assert.ok(Array.isArray(anthropicEvents));

    const decoded = anthropic.decodeResponse({
      model: 'm',
      content: [{ type: 'future_block', data: 'z' }, { type: 'text', text: 'ok' }],
    });
    assert.deepEqual(decoded?.message.parts, [{ type: 'text', text: 'ok' }]);
  });
});
