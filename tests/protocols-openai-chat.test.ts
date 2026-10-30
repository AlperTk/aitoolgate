import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createOpenAIChatProtocol } from '../src/protocols/openai-chat';
import type { InternalLLMEvent } from '../src/ports/llm';

const protocol = createOpenAIChatProtocol();

async function collect(chunks: AsyncIterable<string> | Iterable<string>): Promise<InternalLLMEvent[]> {
  const out: InternalLLMEvent[] = [];
  for await (const event of protocol.decodeStream(chunks)) out.push(event);
  return out;
}

describe('openai-chat protocol', () => {
  it('encodes system, user, assistant tool calls and tool results', () => {
    const wire = protocol.encodeRequest({
      model: 'gpt-x',
      maxTokens: 100,
      messages: [
        { role: 'system', parts: [{ type: 'text', text: 'be brief' }] },
        { role: 'user', parts: [{ type: 'text', text: 'weather?' }] },
        {
          role: 'assistant',
          parts: [{ type: 'tool-call', id: 'c1', name: 'weather', args: { city: 'Oslo' } }],
        },
        {
          role: 'tool',
          parts: [{ type: 'tool-result', id: 'c1', name: 'weather', content: '-3C', isError: false }],
        },
      ],
      tools: [{ name: 'weather', description: 'get weather', parameters: { type: 'object' } }],
    });
    assert.deepEqual(wire, {
      model: 'gpt-x',
      max_tokens: 100,
      messages: [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: 'weather?' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 'weather', arguments: '{"city":"Oslo"}' } }],
        },
        { role: 'tool', tool_call_id: 'c1', name: 'weather', content: '-3C' },
      ],
      tools: [{ type: 'function', function: { name: 'weather', description: 'get weather', parameters: { type: 'object' } } }],
    });
  });

  it('round-trips text through encode and decode', () => {
    const decoded = protocol.decodeResponse({
      id: 'r1',
      model: 'gpt-x',
      choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
    });
    assert.deepEqual(decoded?.message, { role: 'assistant', parts: [{ type: 'text', text: 'hello' }] });
    assert.equal(decoded?.finishReason, 'stop');
    assert.equal(decoded?.id, 'r1');
  });

  it('decodes tool calls and maps usage with cache-hit split', () => {
    const decoded = protocol.decodeResponse({
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'c1', type: 'function', function: { name: 'weather', arguments: '{"city":"Oslo"}' } }],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 40 } },
    });
    assert.deepEqual(decoded?.message.parts, [{ type: 'tool-call', id: 'c1', name: 'weather', args: { city: 'Oslo' } }]);
    assert.equal(decoded?.finishReason, 'tool-calls');
    assert.deepEqual(decoded?.usage, { input: 60, output: 20, cacheHitInput: 40, total: 120 });
  });

  it('keeps wire tool-call index and leaves cacheWriteInput undefined', async () => {
    const chunks = [
      'data: {"choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"a","function":{"name":"f","arguments":"{}"}}]}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":1,"id":"b","function":{"name":"g","arguments":"{\\"x\\":1}"}}]}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\n',
      'data: [DONE]\n\n',
    ];
    const events = await collect(chunks);
    const calls = events.filter((e) => e.type === 'tool-call');
    assert.deepEqual(
      calls.map((e) => (e.type === 'tool-call' ? [e.index, e.rawArgs] : null)),
      [
        [0, '{}'],
        [1, '{"x":1}'],
      ],
    );
    const usage = events.find((e) => e.type === 'usage');
    assert.ok(usage?.type === 'usage' && !('cacheWriteInput' in usage.usage));
  });

  it('maps reasoning_content to reasoning and re-emits it on encode', () => {
    const decoded = protocol.decodeResponse({
      choices: [{ message: { role: 'assistant', content: 'ok', reasoning_content: 'think' }, finish_reason: 'stop' }],
    });
    assert.deepEqual(decoded?.message.parts, [
      { type: 'text', text: 'ok' },
      { type: 'reasoning', text: 'think' },
    ]);
    const wire = protocol.encodeRequest({
      model: 'm',
      messages: [{ role: 'assistant', parts: [{ type: 'reasoning', text: 'think' }, { type: 'text', text: 'ok' }] }],
    });
    assert.deepEqual(wire.messages, [{ role: 'assistant', content: 'ok', reasoning_content: 'think' }]);
  });

  it('assembles streamed tool-call arguments from index-keyed fragments', async () => {
    const chunks = [
      'data: {"choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"c1","function":{"name":"weather","arguments":""}}]}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"ci"}}]}}]}\n',
      '\ndata: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"ty\\":\\"Oslo\\"}"}}]}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\n',
      'data: [DONE]\n\n',
    ];
    const events = await collect(chunks);
    assert.deepEqual(events, [
      { type: 'step-start' },
      { type: 'tool-call', id: 'c1', name: 'weather', args: { city: 'Oslo' }, rawArgs: '{"city":"Oslo"}', index: 0 },
      { type: 'step-finish', finishReason: 'tool-calls' },
      { type: 'usage', usage: { input: 10, output: 5, total: 15 } },
      { type: 'finish', finishReason: 'tool-calls' },
    ]);
  });

  it('streams text deltas and reasoning fragments', async () => {
    const events = await collect([
      'data: {"choices":[{"delta":{"reasoning_content":"hm"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"!"},"finish_reason":"stop"}]}\n\n',
    ]);
    assert.deepEqual(events, [
      { type: 'step-start' },
      { type: 'reasoning', text: 'hm' },
      { type: 'text', text: 'Hi' },
      { type: 'text', text: '!' },
      { type: 'step-finish', finishReason: 'stop' },
      { type: 'finish', finishReason: 'stop' },
    ]);
  });

  it('ignores unknown frames without throwing', async () => {
    const events = await collect([
      ': keep-alive\n\n',
      'event: message\n',
      'data: {not json\n\n',
      'data: {"unexpected":true}\n\n',
      'data: {"choices":"weird"}\n\n',
      'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n',
    ]);
    assert.deepEqual(events, [
      { type: 'step-start' },
      { type: 'text', text: 'ok' },
      { type: 'step-finish', finishReason: 'stop' },
      { type: 'finish', finishReason: 'stop' },
    ]);
    assert.equal(protocol.decodeResponse({ unexpected: true }), undefined);
    assert.equal(protocol.decodeResponse(null), undefined);
  });
});
