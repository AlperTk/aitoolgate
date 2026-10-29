import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PROVIDER_ADAPTERS, lookupProviderAdapter } from '../src/providers/registry';
import { createGenericAdapter, GENERIC_ANTHROPIC_ADAPTER_ID, GENERIC_OPENAI_ADAPTER_ID } from '../src/providers/generic/adapter';
import { createApiKeyAuth } from '../src/providers/generic/apiKeyAuth';
import { forwardOpenAIRequest, type UpstreamClient } from '../src/proxy/upstream';

describe('provider adapter registry', () => {
  it('registers the generic-openai, generic-anthropic and copilot types and looks them up by id', () => {
    assert.deepEqual(Object.keys(PROVIDER_ADAPTERS), [GENERIC_OPENAI_ADAPTER_ID, GENERIC_ANTHROPIC_ADAPTER_ID, 'copilot']);
    const adapter = lookupProviderAdapter(GENERIC_OPENAI_ADAPTER_ID);
    assert.notEqual(adapter, null);
    assert.equal(adapter?.id, 'generic-openai');
    assert.equal(adapter?.auth.kind, 'apiKey');
  });

  it('returns null for unknown ids, including the removed legacy id and prototype keys', () => {
    assert.equal(lookupProviderAdapter(''), null);
    assert.equal(lookupProviderAdapter('generic'), null);
    assert.equal(lookupProviderAdapter('constructor'), null);
    assert.equal(lookupProviderAdapter('__proto__'), null);
  });
});

describe('generic provider adapter', () => {
  const openaiAdapter = createGenericAdapter('openai');
  const anthropicAdapter = createGenericAdapter('anthropic');

  it('keeps the stored base URL and derives the protocol from the adapter type', () => {
    assert.deepEqual(
      openaiAdapter.resolveEndpoint({ baseUrl: 'https://api.example.com/v1/', protocol: 'openai', apiKey: null }),
      { baseUrl: 'https://api.example.com/v1/', protocol: 'openai' },
    );
    assert.deepEqual(
      anthropicAdapter.resolveEndpoint({ baseUrl: 'http://localhost:4000/v1', protocol: 'anthropic', apiKey: 'k' }),
      { baseUrl: 'http://localhost:4000/v1', protocol: 'anthropic' },
    );
  });

  it('emits Bearer and x-api-key headers when a key is set', () => {
    assert.deepEqual(openaiAdapter.auth.resolveHeaders({ apiKey: 'sk-test' }), {
      Authorization: 'Bearer sk-test',
      'x-api-key': 'sk-test',
    });
  });

  it('emits no auth headers when the key is absent, null or empty', () => {
    assert.deepEqual(openaiAdapter.auth.resolveHeaders({ apiKey: undefined }), {});
    assert.deepEqual(openaiAdapter.auth.resolveHeaders({ apiKey: null }), {});
    assert.deepEqual(openaiAdapter.auth.resolveHeaders({ apiKey: '' }), {});
  });

  it('ApiKeyAuth factory yields an independent strategy with the same rule', () => {
    const auth = createApiKeyAuth();
    assert.equal(auth.kind, 'apiKey');
    assert.deepEqual(auth.resolveHeaders({ apiKey: 'k' }), { Authorization: 'Bearer k', 'x-api-key': 'k' });
  });
});

describe('upstream auth header fallback', () => {
  function recordingFetch(): { calls: Array<RequestInit | undefined>; fetchImpl: (input: string, init?: RequestInit) => Promise<Response> } {
    const calls: Array<RequestInit | undefined> = [];
    const fetchImpl = async (_input: string, init?: RequestInit): Promise<Response> => {
      calls.push(init);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };
    return { calls, fetchImpl };
  }
  const request = { model: 'm', messages: [] };

  it('derives Bearer and x-api-key from apiKey when no resolved headers are given', async () => {
    const { calls, fetchImpl } = recordingFetch();
    const client: UpstreamClient = { baseUrl: 'http://localhost:4000/v1', model: 'm', apiKey: 'sk-legacy', protocol: 'openai', fetchImpl };
    await forwardOpenAIRequest(client, request as never);
    const headers = calls[0]?.headers as Record<string, string>;
    assert.equal(headers.Authorization, 'Bearer sk-legacy');
    assert.equal(headers['x-api-key'], 'sk-legacy');
  });

  it('prefers resolved headers over apiKey when both are given', async () => {
    const { calls, fetchImpl } = recordingFetch();
    const client: UpstreamClient = {
      baseUrl: 'http://localhost:4000/v1',
      model: 'm',
      apiKey: 'sk-legacy',
      headers: { Authorization: 'Bearer sk-resolved' },
      protocol: 'openai',
      fetchImpl,
    };
    await forwardOpenAIRequest(client, request as never);
    const headers = calls[0]?.headers as Record<string, string>;
    assert.equal(headers.Authorization, 'Bearer sk-resolved');
    assert.equal(headers['x-api-key'], undefined);
  });
});
