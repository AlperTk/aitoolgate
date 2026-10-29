import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type AtgServer } from '../src/server/index';
import { closeAtgServer } from './helpers';
import { createRuleStore } from '../src/api/ruleStore';
import { createApiProviderStore } from '../src/api/providerStore';
import { serializeAuthState } from '../src/providers/auth/deviceOAuth';

interface Captured {
  url: string;
  headers: Record<string, string>;
}

/** Recording fetch injected as the upstream fetch: captures outgoing headers and answers 200 with a chat completion. */
function recordingFetch(captured: Captured[]): (input: string, init?: RequestInit) => Promise<Response> {
  return async (input: string, init?: RequestInit): Promise<Response> => {
    captured.push({ url: String(input), headers: { ...((init?.headers ?? {}) as Record<string, string>) } });
    const body = JSON.stringify({
      id: 'chatcmpl-test',
      object: 'chat.completion',
      created: 1,
      model: 'm',
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
    return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
}

interface ActiveRow {
  baseUrl: string;
  adapterId?: string;
  authType?: 'apiKey' | 'deviceOAuth';
  apiKey?: string | null;
  authState?: string | null;
}

async function startWithActiveRow(row: ActiveRow, captured: Captured[]): Promise<{ port: number; srv: AtgServer }> {
  const store = createApiProviderStore();
  store.add({
    name: 'active',
    baseUrl: row.baseUrl,
    model: 'm',
    apiKey: row.apiKey ?? null,
    protocol: 'openai',
    ...(row.adapterId !== undefined ? { adapterId: row.adapterId } : {}),
    ...(row.authType !== undefined ? { authType: row.authType } : {}),
    authState: row.authState ?? null,
    isActive: true,
    createdAt: Date.now(),
  });
  const srv = createServer(
    0,
    { upstream: { baseUrl: 'http://127.0.0.1:1/v1', model: 'm', protocol: 'openai', fetchImpl: recordingFetch(captured) } },
    { ruleStore: createRuleStore(), ws: false, apiProviderStore: store },
  );
  await new Promise<void>((resolve, reject) => {
    if (srv.listening) resolve();
    else {
      srv.once('listening', () => resolve());
      srv.once('error', reject);
    }
  });
  const addr = srv.address();
  if (addr === null || typeof addr !== 'object') throw new Error('server did not bind a TCP port');
  return { port: addr.port, srv };
}

function chat(port: number, messages: Array<{ role: string; content: string }>): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'any', messages }),
  });
}

const COPILOT_TOKEN = 'gho_wiring_test_token';

test('copilot active provider: Copilot Authorization and x-initiator reach the upstream', async () => {
  const captured: Captured[] = [];
  const { port, srv } = await startWithActiveRow(
    {
      baseUrl: 'https://api.githubcopilot.com',
      adapterId: 'copilot',
      authType: 'deviceOAuth',
      authState: serializeAuthState({ accessToken: COPILOT_TOKEN }),
    },
    captured,
  );
  try {
    const res = await chat(port, [{ role: 'user', content: 'hi' }]);
    const text = await res.text();
    assert.equal(res.status, 200);
    assert.equal(captured.length, 1);
    assert.equal(captured[0].url, 'https://api.githubcopilot.com/chat/completions');
    assert.equal(captured[0].headers.Authorization, `Bearer ${COPILOT_TOKEN}`);
    assert.equal(captured[0].headers['x-initiator'], 'user');
    assert.equal(captured[0].headers['Openai-Intent'], 'conversation-edits');
    assert.ok(!text.includes(COPILOT_TOKEN), 'raw token must not appear in the response');
  } finally {
    await closeAtgServer(srv);
  }
});

test('copilot x-initiator is agent when the last message is not from the user', async () => {
  const captured: Captured[] = [];
  const { port, srv } = await startWithActiveRow(
    {
      baseUrl: 'https://api.githubcopilot.com',
      adapterId: 'copilot',
      authType: 'deviceOAuth',
      authState: serializeAuthState({ accessToken: COPILOT_TOKEN }),
    },
    captured,
  );
  try {
    const res = await chat(port, [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ]);
    await res.text();
    assert.equal(res.status, 200);
    assert.equal(captured[0].headers['x-initiator'], 'agent');
  } finally {
    await closeAtgServer(srv);
  }
});

test('copilot enterprise host resolves to the copilot-api endpoint', async () => {
  const captured: Captured[] = [];
  const { port, srv } = await startWithActiveRow(
    {
      baseUrl: 'https://github.example.com',
      adapterId: 'copilot',
      authType: 'deviceOAuth',
      authState: serializeAuthState({ accessToken: COPILOT_TOKEN }),
    },
    captured,
  );
  try {
    const res = await chat(port, [{ role: 'user', content: 'hi' }]);
    await res.text();
    assert.equal(captured[0].url, 'https://copilot-api.github.example.com/chat/completions');
  } finally {
    await closeAtgServer(srv);
  }
});

test('generic active provider keeps static headers and sends no Copilot decoration', async () => {
  const captured: Captured[] = [];
  const { port, srv } = await startWithActiveRow(
    { baseUrl: 'http://127.0.0.1:1/v1', adapterId: 'generic', authType: 'apiKey', apiKey: 'sk-generic' },
    captured,
  );
  try {
    const res = await chat(port, [{ role: 'user', content: 'hi' }]);
    await res.text();
    assert.equal(res.status, 200);
    assert.equal(captured[0].headers.Authorization, 'Bearer sk-generic');
    assert.equal(captured[0].headers['x-api-key'], 'sk-generic');
    assert.equal(captured[0].headers['x-initiator'], undefined);
    assert.equal(captured[0].headers['Openai-Intent'], undefined);
  } finally {
    await closeAtgServer(srv);
  }
});

test('unknown adapterId falls back to the generic adapter', async () => {
  const captured: Captured[] = [];
  const { port, srv } = await startWithActiveRow(
    { baseUrl: 'http://127.0.0.1:1/v1', adapterId: 'does-not-exist', authType: 'apiKey', apiKey: 'sk-fallback' },
    captured,
  );
  try {
    const res = await chat(port, [{ role: 'user', content: 'hi' }]);
    await res.text();
    assert.equal(res.status, 200);
    assert.equal(captured[0].headers.Authorization, 'Bearer sk-fallback');
    assert.equal(captured[0].headers['x-initiator'], undefined);
  } finally {
    await closeAtgServer(srv);
  }
});
