/**
 * Coverage for the provider model-list probe: OpenAI/Anthropic request shape, upstream failures
 * as `ok:false`, body validation, and that the raw apiKey never appears in any result.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildModelsUrl, parseProbeBody, probeProvider } from '../src/api/providerProbe';

const KEY = 'sk-secret-probe-key-123';

interface Captured {
  url: string;
  headers: Record<string, string>;
  signal: AbortSignal | undefined;
}

function fakeFetch(respond: () => Response | Promise<Response>, captured: Captured[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    captured.push({ url: String(input), headers, signal: init?.signal ?? undefined });
    return respond();
  }) as typeof fetch;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

test('OpenAI success: Bearer auth, /v1/models, sorted unique ids', async () => {
  const captured: Captured[] = [];
  const fetchImpl = fakeFetch(
    () => json({ data: [{ id: 'gpt-4o' }, { id: 'gpt-3.5' }, { id: 'gpt-4o' }, { nope: 1 }] }),
    captured,
  );
  const result = await probeProvider({ protocol: 'openai', baseUrl: 'https://api.example.com', apiKey: KEY }, fetchImpl);
  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.deepEqual(result.models, ['gpt-3.5', 'gpt-4o']);
  assert.equal(typeof result.latencyMs, 'number');
  assert.equal(captured[0].url, 'https://api.example.com/v1/models');
  assert.equal(captured[0].headers.Authorization, `Bearer ${KEY}`);
  assert.ok(captured[0].signal instanceof AbortSignal);
  assert.equal(JSON.stringify(result).includes(KEY), false);
});

test('Anthropic success sends x-api-key and anthropic-version headers', async () => {
  const captured: Captured[] = [];
  const fetchImpl = fakeFetch(() => json({ data: [{ id: 'claude-x' }] }), captured);
  const result = await probeProvider({ protocol: 'anthropic', baseUrl: 'https://anthropic.example/v1/', apiKey: KEY }, fetchImpl);
  assert.equal(result.ok, true);
  assert.deepEqual(result.models, ['claude-x']);
  assert.equal(captured[0].url, 'https://anthropic.example/v1/models');
  assert.equal(captured[0].headers['x-api-key'], KEY);
  assert.equal(captured[0].headers['anthropic-version'], '2023-06-01');
  assert.equal(captured[0].headers.Authorization, undefined);
});

test('401 yields ok:false with status and no key in the error', async () => {
  const fetchImpl = fakeFetch(() => new Response('bad key ' + KEY, { status: 401 }));
  const result = await probeProvider({ protocol: 'openai', baseUrl: 'https://api.example.com', apiKey: KEY }, fetchImpl);
  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
  assert.deepEqual(result.models, []);
  assert.equal(JSON.stringify(result).includes(KEY), false);
});

test('network error yields ok:false and redacts the key from the message', async () => {
  const fetchImpl = fakeFetch(() => {
    throw new Error(`connect failed for ${KEY}`);
  });
  const result = await probeProvider({ protocol: 'openai', baseUrl: 'https://api.example.com', apiKey: KEY }, fetchImpl);
  assert.equal(result.ok, false);
  assert.equal(result.status, undefined);
  assert.equal(JSON.stringify(result).includes(KEY), false);
});

test('timeout yields ok:false with a timeout error', async () => {
  const fetchImpl = fakeFetch(
    (): Promise<Response> =>
      new Promise((_resolve, reject) => {
        setTimeout(() => reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' })), 5);
      }),
  );
  const result = await probeProvider({ protocol: 'anthropic', baseUrl: 'https://api.example.com', apiKey: null }, fetchImpl, 1000);
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /timed out after 1000ms/);
});

test('no key: probes without auth headers and reports that no key was sent', async () => {
  const captured: Captured[] = [];
  const fetchImpl = fakeFetch(() => new Response('', { status: 403 }), captured);
  const result = await probeProvider({ protocol: 'openai', baseUrl: 'http://localhost:11434', apiKey: null }, fetchImpl);
  assert.equal(captured[0].url, 'http://localhost:11434/v1/models');
  assert.equal(captured[0].headers.Authorization, undefined);
  assert.equal(result.status, 403);
  assert.match(result.error ?? '', /no API key sent/);
});

test('buildModelsUrl does not double /v1', () => {
  assert.equal(buildModelsUrl('https://h.example/v1'), 'https://h.example/v1/models');
  assert.equal(buildModelsUrl('https://h.example/v1/'), 'https://h.example/v1/models');
  assert.equal(buildModelsUrl('https://h.example/'), 'https://h.example/v1/models');
});

test('invalid probe bodies are rejected (route maps these to 400)', () => {
  assert.equal(parseProbeBody(null).ok, false);
  assert.equal(parseProbeBody({ baseUrl: 'https://x.example' }).ok, false);
  assert.equal(parseProbeBody({ protocol: 'gemini', baseUrl: 'https://x.example' }).ok, false);
  assert.equal(parseProbeBody({ protocol: 'openai' }).ok, false);
  assert.equal(parseProbeBody({ protocol: 'openai', baseUrl: '   ' }).ok, false);
  assert.equal(parseProbeBody({ protocol: 'openai', baseUrl: 'ftp://x.example' }).ok, false);
  assert.equal(parseProbeBody({ protocol: 'openai', baseUrl: 'https://x.example', apiKey: 5 }).ok, false);
});

test('valid probe body normalizes an empty apiKey to null and keeps id', () => {
  const parsed = parseProbeBody({ protocol: 'anthropic', baseUrl: ' https://x.example ', apiKey: '  ', id: 'p1' });
  assert.deepEqual(parsed, { ok: true, protocol: 'anthropic', baseUrl: 'https://x.example', apiKey: null, id: 'p1' });
});
