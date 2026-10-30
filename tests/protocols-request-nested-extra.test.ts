import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createOpenAIChatProtocol } from '../src/protocols/openai-chat';
import { createAnthropicMessagesProtocol } from '../src/protocols/anthropic-messages';
import type { InternalRequest } from '../src/ports/llm';

const openai = createOpenAIChatProtocol();
const anthropic = createAnthropicMessagesProtocol();

const openaiWire = {
  model: 'gpt-x',
  messages: [{ role: 'user', content: 'hi' }],
  tools: [
    {
      type: 'function',
      function: {
        name: 'lookup',
        description: 'find it',
        parameters: { type: 'object', properties: {} },
        strict: true,
      },
    },
  ],
};

const anthropicWire = {
  model: 'claude-x',
  max_tokens: 100,
  system: 'be brief',
  tools: [
    {
      name: 'lookup',
      description: 'find it',
      input_schema: { type: 'object', properties: {} },
      cache_control: { type: 'ephemeral' },
    },
  ],
  messages: [
    {
      role: 'user',
      content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } }],
    },
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'lookup', input: { q: 1 }, cache_control: { type: 'ephemeral' } }],
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'boom', is_error: true, cache_control: { type: 'ephemeral' } }],
    },
  ],
};

function decodeOpenAI(wire: Record<string, unknown>): InternalRequest {
  const decoded = openai.decodeRequest(wire);
  assert.ok(decoded);
  return decoded;
}

function decodeAnthropic(wire: Record<string, unknown>): InternalRequest {
  const decoded = anthropic.decodeRequest(wire);
  assert.ok(decoded);
  return decoded;
}

describe('nested request extra passthrough (same protocol only)', () => {
  it('openai tools[].function.strict survives a same-protocol round trip', () => {
    const encoded = openai.encodeRequest(decodeOpenAI(openaiWire)) as { tools: Array<{ function: Record<string, unknown> }> };
    assert.equal(encoded.tools[0].function.strict, true);
    assert.equal(encoded.tools[0].function.name, 'lookup');
    assert.equal(encoded.tools[0].function.description, 'find it');
  });

  it('openai strict is absent when encoded to anthropic', () => {
    const encoded = anthropic.encodeRequest(decodeOpenAI(openaiWire));
    assert.equal(JSON.stringify(encoded).includes('strict'), false);
  });

  it('anthropic cache_control on tools survives a same-protocol round trip', () => {
    const encoded = anthropic.encodeRequest(decodeAnthropic(anthropicWire)) as { tools: Array<Record<string, unknown>> };
    assert.deepEqual(encoded.tools[0].cache_control, { type: 'ephemeral' });
    assert.deepEqual(encoded.tools[0].input_schema, { type: 'object', properties: {} });
  });

  it('anthropic cache_control on content blocks survives a same-protocol round trip', () => {
    const encoded = anthropic.encodeRequest(decodeAnthropic(anthropicWire)) as { messages: Array<{ content: Array<Record<string, unknown>> }> };
    assert.deepEqual(encoded.messages[0].content[0], { type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } });
    assert.deepEqual(encoded.messages[1].content[0].cache_control, { type: 'ephemeral' });
    assert.deepEqual(encoded.messages[2].content[0].cache_control, { type: 'ephemeral' });
  });

  it('anthropic cache_control is absent when encoded to openai', () => {
    const encoded = openai.encodeRequest(decodeAnthropic(anthropicWire));
    assert.equal(JSON.stringify(encoded).includes('cache_control'), false);
  });

  it('anthropic tool_result.is_error survives a same-protocol round trip', () => {
    const request = decodeAnthropic(anthropicWire);
    const toolMessage = request.messages.find((message) => message.role === 'tool');
    assert.ok(toolMessage);
    assert.equal(toolMessage.parts[0].type === 'tool-result' && toolMessage.parts[0].isError, true);
    const encoded = anthropic.encodeRequest(request) as { messages: Array<{ content: Array<Record<string, unknown>> }> };
    assert.equal(encoded.messages[2].content[0].is_error, true);
  });

  it('modeled block fields win over opaque values with the same key', () => {
    const request: InternalRequest = {
      model: 'claude-x',
      messages: [
        {
          role: 'user',
          parts: [{ type: 'text', text: 'real', extra: { protocol: 'anthropic-messages', fields: { text: 'spoof', cache_control: { type: 'ephemeral' } } } }],
        },
      ],
    };
    const encoded = anthropic.encodeRequest(request) as { messages: Array<{ content: Array<Record<string, unknown>> }> };
    assert.deepEqual(encoded.messages[0].content[0], { type: 'text', text: 'real', cache_control: { type: 'ephemeral' } });
  });
});
