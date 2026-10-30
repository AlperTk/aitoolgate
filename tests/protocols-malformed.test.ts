import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createOpenAIChatProtocol } from '../src/protocols/openai-chat';
import { createAnthropicMessagesProtocol } from '../src/protocols/anthropic-messages';

const openai = createOpenAIChatProtocol();
const anthropic = createAnthropicMessagesProtocol();

describe('malformed responses: decodeResponse carries id/model/usage without throwing', () => {
  it('openai body without choices keeps id, model and usage', () => {
    const common = openai.decodeResponse({
      id: 'chatcmpl-x',
      model: 'gpt-x',
      usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
    });
    assert.equal(common?.id, 'chatcmpl-x');
    assert.equal(common?.model, 'gpt-x');
    assert.notEqual(common?.usage, undefined);
    assert.deepEqual(common?.message.parts, []);
  });

  it('anthropic body without content keeps id, model and usage', () => {
    const common = anthropic.decodeResponse({
      id: 'msg_x',
      model: 'claude-x',
      usage: { input_tokens: 2, output_tokens: 1 },
    });
    assert.equal(common?.id, 'msg_x');
    assert.equal(common?.model, 'claude-x');
    assert.deepEqual(common?.message.parts, []);
  });

  it('omits missing fields instead of inventing them', () => {
    const common = openai.decodeResponse({ id: 'chatcmpl-y' });
    assert.equal(common?.id, 'chatcmpl-y');
    assert.equal(common?.model, undefined);
    assert.equal(common?.usage, undefined);
    assert.equal(common?.finishReason, undefined);
  });

  it('bodies with no content and no metadata, or non-objects, are undecodable (undefined)', () => {
    assert.equal(openai.decodeResponse({}), undefined);
    assert.equal(anthropic.decodeResponse({}), undefined);
    assert.equal(openai.decodeResponse(null), undefined);
    assert.equal(anthropic.decodeResponse('text'), undefined);
  });
});
