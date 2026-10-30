import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createAnthropicMessagesProtocol } from '../src/protocols/anthropic-messages';
import type { InternalLLMEvent } from '../src/ports/llm';

const protocol = createAnthropicMessagesProtocol();

async function collect(chunks: AsyncIterable<string> | Iterable<string>): Promise<InternalLLMEvent[]> {
  const out: InternalLLMEvent[] = [];
  for await (const event of protocol.decodeStream(chunks)) out.push(event);
  return out;
}

const sse = (type: string, data: Record<string, unknown>): string =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;

describe('anthropic-messages protocol', () => {
  it('encodes system, text, thinking with signature, tool_use and tool_result', () => {
    const wire = protocol.encodeRequest({
      model: 'claude-x',
      messages: [
        { role: 'system', parts: [{ type: 'text', text: 'be brief' }] },
        { role: 'user', parts: [{ type: 'text', text: 'weather?' }] },
        {
          role: 'assistant',
          parts: [
            { type: 'reasoning', text: 'need a tool', signature: 'sig1' },
            { type: 'reasoning', text: '', redactedData: 'opaque' },
            { type: 'text', text: 'checking' },
            { type: 'tool-call', id: 'tu1', name: 'weather', args: { city: 'Oslo' } },
          ],
        },
        {
          role: 'tool',
          parts: [{ type: 'tool-result', id: 'tu1', name: 'weather', content: 'failed', isError: true }],
        },
      ],
    });
    assert.deepEqual(wire, {
      model: 'claude-x',
      max_tokens: 4096,
      system: 'be brief',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'weather?' }] },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'need a tool', signature: 'sig1' },
            { type: 'redacted_thinking', data: 'opaque' },
            { type: 'text', text: 'checking' },
            { type: 'tool_use', id: 'tu1', name: 'weather', input: { city: 'Oslo' } },
          ],
        },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'failed', is_error: true }] },
      ],
    });
  });

  it('decodes text, thinking, redacted thinking and tool_use with usage and stop reason', () => {
    const decoded = protocol.decodeResponse({
      id: 'msg_1',
      model: 'claude-x',
      stop_reason: 'tool_use',
      content: [
        { type: 'thinking', thinking: 'hmm', signature: 'sig' },
        { type: 'redacted_thinking', data: 'opaque' },
        { type: 'text', text: 'hello' },
        { type: 'tool_use', id: 'tu1', name: 'weather', input: { city: 'Oslo' } },
      ],
      usage: { input_tokens: 30, cache_creation_input_tokens: 10, cache_read_input_tokens: 40, output_tokens: 7 },
    });
    assert.deepEqual(decoded?.message.parts, [
      { type: 'reasoning', text: 'hmm', signature: 'sig' },
      { type: 'reasoning', text: '', redactedData: 'opaque' },
      { type: 'text', text: 'hello' },
      { type: 'tool-call', id: 'tu1', name: 'weather', args: { city: 'Oslo' } },
    ]);
    assert.equal(decoded?.finishReason, 'tool-calls');
    assert.deepEqual(decoded?.usage, { input: 40, output: 7, cacheHitInput: 40, cacheWriteInput: 10, total: 87 });
    assert.equal(decoded?.id, 'msg_1');
  });

  it('reports cacheWriteInput, wire block index and raw argument string on streamed tool_use', async () => {
    const events = await collect([
      sse('message_start', {
        message: { id: 'msg_2', usage: { input_tokens: 5, cache_creation_input_tokens: 7, output_tokens: 1 } },
      }),
      sse('content_block_start', { index: 1, content_block: { type: 'tool_use', id: 'tu2', name: 'lookup', input: {} } }),
      sse('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '{"q":' } }),
      sse('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '"x"}' } }),
      sse('content_block_stop', { index: 1 }),
      sse('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 2 } }),
      sse('message_stop', {}),
    ]);
    assert.deepEqual(events.find((e) => e.type === 'tool-call'), {
      type: 'tool-call',
      id: 'tu2',
      name: 'lookup',
      args: { q: 'x' },
      rawArgs: '{"q":"x"}',
      index: 1,
    });
    assert.deepEqual(events.find((e) => e.type === 'usage'), {
      type: 'usage',
      usage: { input: 12, output: 2, cacheWriteInput: 7, total: 14 },
    });
  });

  it('assembles streamed tool_use input from partial_json fragments', async () => {
    const events = await collect([
      sse('message_start', { message: { id: 'msg_1', usage: { input_tokens: 12, output_tokens: 1 } } }).slice(0, 25),
      sse('message_start', { message: { id: 'msg_1', usage: { input_tokens: 12, output_tokens: 1 } } }).slice(25),
      sse('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'tu1', name: 'weather', input: {} } }),
      sse('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '{"ci' } }),
      sse('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: 'ty":"Oslo"}' } }),
      sse('content_block_stop', { index: 0 }),
      sse('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 9 } }),
      sse('message_stop', {}),
    ]);
    assert.deepEqual(events, [
      { type: 'step-start', id: 'msg_1' },
      { type: 'tool-call', id: 'tu1', name: 'weather', args: { city: 'Oslo' }, rawArgs: '{"city":"Oslo"}', index: 0 },
      { type: 'usage', usage: { input: 12, output: 9, total: 21 } },
      { type: 'step-finish', finishReason: 'tool-calls' },
      { type: 'finish', finishReason: 'tool-calls' },
    ]);
  });

  it('streams thinking, signature and text deltas and maps cache usage', async () => {
    const events = await collect([
      sse('message_start', { message: { id: 'msg_2', usage: { input_tokens: 5, cache_read_input_tokens: 20, output_tokens: 1 } } }),
      sse('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '' } }),
      sse('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'consider' } }),
      sse('content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: 'sigX' } }),
      sse('content_block_stop', { index: 0 }),
      sse('content_block_start', { index: 1, content_block: { type: 'redacted_thinking', data: 'opaque' } }),
      sse('content_block_stop', { index: 1 }),
      sse('content_block_start', { index: 2, content_block: { type: 'text', text: '' } }),
      sse('content_block_delta', { index: 2, delta: { type: 'text_delta', text: 'Hi' } }),
      sse('content_block_stop', { index: 2 }),
      sse('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } }),
      sse('message_stop', {}),
    ]);
    assert.deepEqual(events, [
      { type: 'step-start', id: 'msg_2' },
      { type: 'reasoning', text: 'consider' },
      { type: 'reasoning', text: '', signature: 'sigX' },
      { type: 'reasoning', text: '', redactedData: 'opaque' },
      { type: 'text', text: 'Hi' },
      { type: 'usage', usage: { input: 5, output: 3, cacheHitInput: 20, total: 28 } },
      { type: 'step-finish', finishReason: 'stop' },
      { type: 'finish', finishReason: 'stop' },
    ]);
  });

  it('ignores unknown and malformed frames without throwing', async () => {
    const events = await collect([
      'event: ping\ndata: {"type":"ping"}\n\n',
      'event: weird\ndata: {"type":"future_event","x":1}\n\n',
      'data: {broken\n\n',
      'data: [DONE]\n\n',
      sse('message_delta', { delta: { stop_reason: 'end_turn' } }),
    ]);
    assert.deepEqual(events, [
      { type: 'step-finish', finishReason: 'stop' },
      { type: 'finish', finishReason: 'stop' },
    ]);
    assert.equal(protocol.decodeResponse({ type: 'error' }), undefined);
  });
});
