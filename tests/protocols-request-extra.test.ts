import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createOpenAIChatProtocol } from '../src/protocols/openai-chat';
import { createAnthropicMessagesProtocol } from '../src/protocols/anthropic-messages';
import { reencodeRequest } from '../src/proxy/translate';
import type { InternalRequest } from '../src/ports/llm';

const openai = createOpenAIChatProtocol();
const anthropic = createAnthropicMessagesProtocol();

const openaiExtras = {
  max_completion_tokens: 512,
  response_format: { type: 'json_object' },
  seed: 7,
  stop: ['END'],
  n: 2,
  user: 'u-1',
  parallel_tool_calls: false,
  reasoning_effort: 'low',
  presence_penalty: 0.1,
  frequency_penalty: 0.2,
  logit_bias: { '50256': -100 },
  logprobs: true,
  store: false,
  metadata: { run: 'abc' },
  service_tier: 'auto',
  modalities: ['text'],
  audio: { voice: 'alloy' },
  prediction: { type: 'content', content: 'x' },
  functions: [{ name: 'f' }],
  function_call: 'auto',
};

const anthropicExtras = {
  stop_sequences: ['STOP'],
  top_k: 40,
  metadata: { user_id: 'u-1' },
  thinking: { type: 'enabled', budget_tokens: 1024 },
};

const openaiWire = {
  model: 'gpt-x',
  messages: [{ role: 'user', content: 'hi' }],
  max_tokens: 100,
  temperature: 0.5,
  ...openaiExtras,
};

const anthropicWire = {
  model: 'claude-x',
  max_tokens: 100,
  system: 'be brief',
  messages: [{ role: 'user', content: 'hi' }],
  ...anthropicExtras,
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

describe('request extra passthrough (same protocol only)', () => {
  it('openai same-protocol round trip keeps dropped top-level fields', () => {
    const encoded = openai.encodeRequest(decodeOpenAI(openaiWire));
    for (const [key, value] of Object.entries(openaiExtras)) {
      assert.deepEqual(encoded[key], value, `field ${key}`);
    }
    assert.equal(encoded.model, 'gpt-x');
    assert.equal(encoded.max_tokens, 100);
    assert.equal(encoded.temperature, 0.5);
  });

  it('anthropic same-protocol round trip keeps dropped top-level fields', () => {
    const encoded = anthropic.encodeRequest(decodeAnthropic(anthropicWire));
    for (const [key, value] of Object.entries(anthropicExtras)) {
      assert.deepEqual(encoded[key], value, `field ${key}`);
    }
    assert.equal(encoded.model, 'claude-x');
    assert.equal(encoded.system, 'be brief');
  });

  it('cross-protocol encode does not emit the opaque bag', () => {
    const fromOpenAI = anthropic.encodeRequest(decodeOpenAI(openaiWire));
    for (const key of Object.keys(openaiExtras)) assert.equal(key in fromOpenAI, false, `openai field ${key} leaked`);

    const fromAnthropic = openai.encodeRequest(decodeAnthropic(anthropicWire));
    for (const key of Object.keys(anthropicExtras)) assert.equal(key in fromAnthropic, false, `anthropic field ${key} leaked`);
  });

  it('modeled fields win over bag values with the same key', () => {
    const request = decodeOpenAI(openaiWire);
    request.extra = { protocol: 'openai-chat', fields: { temperature: 9, model: 'other', seed: 1 } };
    const encoded = openai.encodeRequest(request);
    assert.equal(encoded.temperature, 0.5);
    assert.equal(encoded.model, 'gpt-x');
    assert.equal(encoded.seed, 1);
  });

  it('bag never resurrects a modeled field that is absent from the model', () => {
    const request: InternalRequest = {
      model: 'gpt-x',
      messages: [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
      extra: { protocol: 'openai-chat', fields: { max_tokens: 5 } },
    };
    assert.equal('max_tokens' in openai.encodeRequest(request), false);
  });

  it('reencode for same protocol keeps the bag and applies the model override', () => {
    const wire = reencodeRequest('openai-chat', 'openai-chat', openaiWire as unknown, 'gpt-y') as Record<string, unknown>;
    assert.equal(wire.model, 'gpt-y');
    assert.deepEqual(wire.seed, 7);
    assert.deepEqual(wire.metadata, { run: 'abc' });
  });
});
