import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createDeviceOAuthAuth,
  parseAuthState,
  serializeAuthState,
  type DeviceFlow,
} from '../src/providers/auth/deviceOAuth';

const CLIENT_ID = 'test-client-id';

interface Call {
  url: string;
  init: RequestInit;
}

function mockFetch(responses: Array<{ status?: number; body: unknown } | { throws: string }>): {
  fetch: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const queue = [...responses];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    const next = queue.shift();
    if (!next) throw new Error('unexpected fetch call');
    if ('throws' in next) throw new TypeError(next.throws);
    return new Response(JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

const FLOW: DeviceFlow = {
  deviceCode: 'dev-code-123',
  userCode: 'ABCD-1234',
  verificationUri: 'https://github.com/login/device',
  interval: 5,
  expiresIn: 900,
};

const START_BODY = {
  device_code: 'dev-code-123',
  user_code: 'ABCD-1234',
  verification_uri: 'https://github.com/login/device',
  interval: 5,
  expires_in: 900,
};

test('startDeviceFlow returns device-code fields and posts to github.com', async () => {
  const m = mockFetch([{ body: START_BODY }]);
  const auth = createDeviceOAuthAuth({ clientId: CLIENT_ID, fetch: m.fetch });
  const res = await auth.startDeviceFlow();
  assert.deepEqual(res, { ok: true, flow: FLOW });
  assert.equal(m.calls[0].url, 'https://github.com/login/device/code');
  assert.equal(m.calls[0].init.method, 'POST');
  const body = JSON.parse(String(m.calls[0].init.body));
  assert.equal(body.client_id, CLIENT_ID);
  assert.equal(body.scope, 'read:user');
});

test('createDeviceOAuthAuth without a non-empty clientId fails clearly without fetching', async () => {
  const m = mockFetch([]);
  const blank = await createDeviceOAuthAuth({ clientId: '  ', fetch: m.fetch }).startDeviceFlow();
  assert.equal(blank.ok, false);
  if (!blank.ok) assert.equal(blank.error.code, 'invalid_client_id');
  const missing = await createDeviceOAuthAuth({ fetch: m.fetch } as unknown as { clientId: string }).pollDeviceFlow(FLOW);
  assert.equal(missing.status, 'error');
  if (missing.status === 'error') assert.equal(missing.error.code, 'invalid_client_id');
  assert.equal(m.calls.length, 0);
});

test('enterprise githubDomain accepts host or base URL', async () => {
  const m = mockFetch([{ body: START_BODY }, { body: START_BODY }]);
  const auth = createDeviceOAuthAuth({ clientId: CLIENT_ID, githubDomain: 'https://Company.ghe.com/', fetch: m.fetch });
  await auth.startDeviceFlow();
  const auth2 = createDeviceOAuthAuth({ clientId: CLIENT_ID, githubDomain: 'company.ghe.com', fetch: m.fetch });
  await auth2.startDeviceFlow();
  assert.equal(m.calls[0].url, 'https://company.ghe.com/login/device/code');
  assert.equal(m.calls[1].url, 'https://company.ghe.com/login/device/code');
});

test('invalid githubDomain yields typed error without fetching', async () => {
  const m = mockFetch([]);
  const auth = createDeviceOAuthAuth({ clientId: CLIENT_ID, githubDomain: 'not a host/x', fetch: m.fetch });
  const res = await auth.startDeviceFlow();
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error.code, 'invalid_domain');
  assert.equal(m.calls.length, 0);
});

test('startDeviceFlow maps OAuth error and network failure to typed errors', async () => {
  const m = mockFetch([{ status: 400, body: { error: 'unauthorized_client' } }, { throws: 'fetch failed' }]);
  const auth = createDeviceOAuthAuth({ clientId: CLIENT_ID, fetch: m.fetch });
  const oauthErr = await auth.startDeviceFlow();
  assert.equal(oauthErr.ok, false);
  if (!oauthErr.ok) assert.equal(oauthErr.error.code, 'unauthorized_client');
  const netErr = await auth.startDeviceFlow();
  assert.equal(netErr.ok, false);
  if (!netErr.ok) assert.equal(netErr.error.code, 'network_error');
});

test('startDeviceFlow rejects incomplete response', async () => {
  const m = mockFetch([{ body: { device_code: 'x' } }]);
  const res = await createDeviceOAuthAuth({ clientId: CLIENT_ID, fetch: m.fetch }).startDeviceFlow();
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error.code, 'invalid_response');
});

test('pollDeviceFlow: pending then done with token', async () => {
  const m = mockFetch([{ body: { error: 'authorization_pending' } }, { body: { access_token: 'gho_TOKEN' } }]);
  const auth = createDeviceOAuthAuth({ clientId: CLIENT_ID, fetch: m.fetch });
  const first = await auth.pollDeviceFlow(FLOW);
  assert.deepEqual(first, { status: 'pending', interval: 5 });
  const second = await auth.pollDeviceFlow(FLOW);
  assert.deepEqual(second, { status: 'done', state: { accessToken: 'gho_TOKEN' } });
  assert.equal(m.calls[0].url, 'https://github.com/login/oauth/access_token');
  const body = JSON.parse(String(m.calls[0].init.body));
  assert.equal(body.device_code, 'dev-code-123');
  assert.equal(body.grant_type, 'urn:ietf:params:oauth:grant-type:device_code');
});

test('pollDeviceFlow: slow_down increases interval by 5 seconds', async () => {
  const m = mockFetch([{ body: { error: 'slow_down', interval: 10 } }]);
  const res = await createDeviceOAuthAuth({ clientId: CLIENT_ID, fetch: m.fetch }).pollDeviceFlow(FLOW);
  assert.deepEqual(res, { status: 'slow_down', interval: 10 });
});

test('pollDeviceFlow: expired and denied are typed results', async () => {
  const m = mockFetch([{ body: { error: 'expired_token' } }, { body: { error: 'access_denied' } }]);
  const auth = createDeviceOAuthAuth({ clientId: CLIENT_ID, fetch: m.fetch });
  assert.deepEqual(await auth.pollDeviceFlow(FLOW), { status: 'expired' });
  assert.deepEqual(await auth.pollDeviceFlow(FLOW), { status: 'denied' });
});

test('pollDeviceFlow: unknown error, network failure, and non-JSON are error results', async () => {
  const res = new Response('<html>', { status: 502 });
  const badJson = (async () => res) as typeof fetch;
  const m = mockFetch([{ body: { error: 'incorrect_client_credentials' } }, { throws: 'socket hang up' }]);
  const auth = createDeviceOAuthAuth({ clientId: CLIENT_ID, fetch: m.fetch });
  const unknown = await auth.pollDeviceFlow(FLOW);
  assert.equal(unknown.status, 'error');
  if (unknown.status === 'error') assert.equal(unknown.error.code, 'incorrect_client_credentials');
  const net = await auth.pollDeviceFlow(FLOW);
  assert.equal(net.status, 'error');
  if (net.status === 'error') assert.equal(net.error.code, 'network_error');
  const nonJson = await createDeviceOAuthAuth({ clientId: CLIENT_ID, fetch: badJson }).pollDeviceFlow(FLOW);
  assert.equal(nonJson.status, 'error');
  if (nonJson.status === 'error') assert.equal(nonJson.error.code, 'invalid_response');
});

test('resolveHeaders: token yields Bearer only; missing token yields no headers', () => {
  const auth = createDeviceOAuthAuth({ clientId: CLIENT_ID });
  assert.deepEqual(auth.resolveHeaders({ apiKey: 'gho_TOKEN' }), { Authorization: 'Bearer gho_TOKEN' });
  assert.deepEqual(auth.resolveHeaders({ apiKey: null }), {});
  assert.deepEqual(auth.resolveHeaders({ apiKey: '' }), {});
});

test('resolveAuthStateHeaders: state with token yields header; missing or malformed yields none', () => {
  const auth = createDeviceOAuthAuth({ clientId: CLIENT_ID });
  const raw = serializeAuthState({ accessToken: 'gho_TOKEN' });
  assert.deepEqual(auth.resolveAuthStateHeaders(raw), { Authorization: 'Bearer gho_TOKEN' });
  assert.deepEqual(auth.resolveAuthStateHeaders(null), {});
  assert.deepEqual(auth.resolveAuthStateHeaders('{oops'), {});
});

test('serialize/parse authState round-trips', () => {
  const state = { accessToken: 'gho_TOKEN' };
  const raw = serializeAuthState(state);
  assert.equal(typeof raw, 'string');
  assert.deepEqual(parseAuthState(raw), state);
});

test('parseAuthState returns null for malformed input without throwing', () => {
  const malformed = [
    undefined,
    null,
    '',
    'not json',
    '[]',
    'null',
    '{"accessToken":"gho_TOKEN"}',
    '{"v":2,"accessToken":"gho_TOKEN"}',
    '{"v":1}',
    '{"v":1,"accessToken":""}',
    '{"v":1,"accessToken":42}',
  ];
  for (const raw of malformed) {
    assert.equal(parseAuthState(raw as string | null | undefined), null, `expected null for ${String(raw)}`);
  }
});
