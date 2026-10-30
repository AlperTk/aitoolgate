import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createOpenAIChatProtocol } from '../src/protocols/openai-chat';
import { createAnthropicMessagesProtocol } from '../src/protocols/anthropic-messages';
import type { InternalRequest } from '../src/ports/llm';

const openai = createOpenAIChatProtocol();
const anthropic = createAnthropicMessagesProtocol();

const imageBlock = {
  type: 'image',
  source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
  cache_control: { type: 'ephemeral' },
};

const anthropicImageWire = {
  model: 'claude-x',
  max_tokens: 100,
  messages: [
    {
      role: 'user',
      content: [{ type: 'text', text: 'look at this' }, imageBlock],
    },
  ],
};

const anthropicSystemWire = {
  model: 'claude-x',
  max_tokens: 100,
  system: [{ type: 'text', text: 'be brief', cache_control: { type: 'ephemeral' } }],
  messages: [{ role: 'user', content: 'hi' }],
};

function decodeAnthropic(wire: Record<string, unknown>): InternalRequest {
  const decoded = anthropic.decodeRequest(wire);
  assert.ok(decoded);
  return decoded;
}

describe('opaque message parts (same protocol only)', () => {
  it('anthropic image block survives a same-protocol round trip unchanged', () => {
    const encoded = anthropic.encodeRequest(decodeAnthropic(anthropicImageWire));
    assert.deepEqual(encoded, anthropicImageWire);
  });

  it('anthropic image block is skipped without throwing by another protocol encoder', () => {
    const encoded = openai.encodeRequest(decodeAnthropic(anthropicImageWire)) as { messages: Array<{ role: string; content: unknown }> };
    assert.equal(JSON.stringify(encoded).includes('base64'), false);
    assert.deepEqual(encoded.messages, [{ role: 'user', content: 'look at this' }]);
  });

  it('opaque part tagged for another protocol is omitted by the anthropic encoder', () => {
    const request: InternalRequest = {
      model: 'claude-x',
      messages: [
        {
          role: 'user',
          parts: [
            { type: 'text', text: 'hi' },
            { type: 'opaque', protocol: 'openai-chat', block: { type: 'image_url' } },
          ],
        },
      ],
    };
    const encoded = anthropic.encodeRequest(request) as { messages: Array<{ content: unknown }> };
    assert.deepEqual(encoded.messages[0].content, [{ type: 'text', text: 'hi' }]);
  });

  it('block-form system keeps cache_control on a same-protocol round trip', () => {
    const encoded = anthropic.encodeRequest(decodeAnthropic(anthropicSystemWire));
    // The encoder emits user content as text blocks (only empty turns collapse to ""), so the expectation uses block form.
    assert.deepEqual(encoded, {
      ...anthropicSystemWire,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    });
  });

  it('string-form system stays a string when no block carries extra fields', () => {
    const encoded = anthropic.encodeRequest(
      decodeAnthropic({ model: 'claude-x', max_tokens: 100, system: 'be brief', messages: [{ role: 'user', content: 'hi' }] }),
    ) as { system: unknown };
    assert.equal(encoded.system, 'be brief');
  });
});
