import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createCopilotAdapter, COPILOT_ADAPTER_ID } from '../src/providers/copilot/adapter';
import { lookupProviderAdapter, PROVIDER_ADAPTERS } from '../src/providers/registry';
import { serializeAuthState } from '../src/providers/auth/deviceOAuth';

const adapter = createCopilotAdapter();
const authState = serializeAuthState({ accessToken: 'gho_test_token' });

describe('copilot adapter endpoint', () => {
  it('resolves github.com (default and explicit) to api.githubcopilot.com with openai protocol', () => {
    assert.deepEqual(adapter.resolveEndpoint({ baseUrl: 'https://api.githubcopilot.com', protocol: 'anthropic', apiKey: null }), {
      baseUrl: 'https://api.githubcopilot.com',
      protocol: 'openai',
    });
    assert.equal(adapter.resolveEndpoint({ baseUrl: '', protocol: 'openai', apiKey: null }).baseUrl, 'https://api.githubcopilot.com');
    assert.equal(adapter.resolveEndpoint({ baseUrl: 'github.com', protocol: 'openai', apiKey: null }).baseUrl, 'https://api.githubcopilot.com');
  });

  it('resolves an enterprise domain to copilot-api.<domain>', () => {
    assert.equal(
      adapter.resolveEndpoint({ baseUrl: 'company.ghe.com', protocol: 'openai', apiKey: null }).baseUrl,
      'https://copilot-api.company.ghe.com',
    );
    assert.equal(
      adapter.resolveEndpoint({ baseUrl: 'https://Company.GHE.com/', protocol: 'openai', apiKey: null }).baseUrl,
      'https://copilot-api.company.ghe.com',
    );
  });

  it('keeps an already-resolved copilot-api host and falls back to default on unparseable input', () => {
    assert.equal(
      adapter.resolveEndpoint({ baseUrl: 'https://copilot-api.company.ghe.com', protocol: 'openai', apiKey: null }).baseUrl,
      'https://copilot-api.company.ghe.com',
    );
    assert.equal(adapter.resolveEndpoint({ baseUrl: 'https://[bad', protocol: 'openai', apiKey: null }).baseUrl, 'https://api.githubcopilot.com');
  });
});

describe('copilot adapter headers', () => {
  it('sets the Copilot header set with the authState token', () => {
    const headers = adapter.decorateHeaders!({
      headers: {},
      protocol: 'openai',
      authState,
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.deepEqual(headers, {
      Authorization: 'Bearer gho_test_token',
      'User-Agent': 'aitoolgate/1.0',
      'Openai-Intent': 'conversation-edits',
      'X-GitHub-Api-Version': '2026-08-01',
      'x-initiator': 'user',
    });
  });

  it('omits Authorization when authState is missing or malformed', () => {
    const none = adapter.decorateHeaders!({ headers: {}, protocol: 'openai', authState: null, messages: [] });
    assert.equal(none.Authorization, undefined);
    const bad = adapter.decorateHeaders!({ headers: {}, protocol: 'openai', authState: '{not json', messages: [] });
    assert.equal(bad.Authorization, undefined);
  });

  it('sets x-initiator to user when the last message is a user turn', () => {
    const headers = adapter.decorateHeaders!({
      headers: {},
      protocol: 'openai',
      authState,
      messages: [{ role: 'assistant', content: 'a' }, { role: 'user', content: 'b' }],
    });
    assert.equal(headers['x-initiator'], 'user');
  });

  it('sets x-initiator to agent when the last message is not a user turn', () => {
    const headers = adapter.decorateHeaders!({
      headers: {},
      protocol: 'openai',
      authState,
      messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'tool', content: 'c' }],
    });
    assert.equal(headers['x-initiator'], 'agent');
  });

  it('sets Copilot-Vision-Request only when a message carries image content', () => {
    const withImage = adapter.decorateHeaders!({
      headers: {},
      protocol: 'openai',
      authState,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: 'data:x' } }] },
      ],
    });
    assert.equal(withImage['Copilot-Vision-Request'], 'true');

    const textOnly = adapter.decorateHeaders!({
      headers: {},
      protocol: 'openai',
      authState,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'plain' }] }],
    });
    assert.equal(textOnly['Copilot-Vision-Request'], undefined);
  });
});

describe('copilot adapter registry', () => {
  it('is registered under copilot and looked up by id', () => {
    assert.equal(COPILOT_ADAPTER_ID, 'copilot');
    const found = lookupProviderAdapter('copilot');
    assert.notEqual(found, null);
    assert.equal(found?.id, 'copilot');
    assert.equal(found?.wireProtocol, 'openai');
    assert.equal(found?.auth.kind, 'deviceOAuth');
    assert.equal(PROVIDER_ADAPTERS.copilot, found);
  });

  it('still returns null for unknown ids', () => {
    assert.equal(lookupProviderAdapter('unknown-adapter'), null);
  });
});
