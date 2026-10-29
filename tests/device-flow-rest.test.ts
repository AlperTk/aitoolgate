/**
 * Copilot device-login REST routes: start/poll drive the GitHub device-code flow via a mock fetch,
 * the entitlement check gates activation, and no response body leaks device_code or tokens.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApiHandler } from '../src/api/http';
import { createRuleStore } from '../src/api/ruleStore';
import { createApiProviderStore, type ApiProviderStore } from '../src/api/providerStore';
import type { ApiProvider } from '../src/api/providerSpec';
import { createDeviceFlowRegistry } from '../src/api/deviceFlowRegistry';
import { createCollector } from '../src/telemetry/collector';
import { createEventBus } from '../src/telemetry/event-bus';
import { parseAuthState } from '../src/providers/auth/deviceOAuth';

const DEVICE_CODE = 'DEVICE-CODE-SECRET-123';
const ACCESS_TOKEN = 'gho_ACCESS-TOKEN-SECRET-456';

type Route = { status: number; body: unknown };

/** Mock fetch keyed by URL; records every call so tests can assert the request shape. */
function mockGitHub(routes: Record<string, Route>) {
  const calls: { url: string; body: string | undefined }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: typeof init?.body === 'string' ? init.body : undefined });
    const route = routes[url];
    if (route === undefined) throw new Error(`unexpected fetch ${url}`);
    return new Response(JSON.stringify(route.body), {
      status: route.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, calls };
}

const DEVICE_CODE_ROUTE: Route = {
  status: 200,
  body: {
    device_code: DEVICE_CODE,
    user_code: 'ABCD-1234',
    verification_uri: 'https://github.com/login/device',
    interval: 5,
    expires_in: 900,
  },
};
const TOKEN_URL = 'https://github.com/login/oauth/access_token';
const ENTITLEMENT_URL = 'https://api.github.com/copilot_internal/user';

async function withDeviceApi(
  routes: Record<string, Route>,
  run: (base: string, store: ApiProviderStore, calls: { url: string; body: string | undefined }[]) => Promise<void>,
  store: ApiProviderStore = createApiProviderStore(),
  liveApply: (active: unknown) => void = () => {},
) {
  const gh = mockGitHub(routes);
  const handler = createApiHandler({
    ruleStore: createRuleStore(),
    collector: createCollector({ bus: createEventBus() }),
    apiProviderStore: store,
    deviceFlow: { fetch: gh.fetch, registry: createDeviceFlowRegistry() },
    applyActiveProvider: liveApply as (active: ApiProvider | undefined) => void,
  });
  const srv = http.createServer((req, res) => {
    void (async () => {
      const handled = await handler(req, res);
      if (!handled) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not_found' }));
      }
    })();
  });
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', () => resolve()));
  const port = (srv.address() as AddressInfo).port;
  try {
    await run(`http://127.0.0.1:${port}`, store, gh.calls);
  } finally {
    srv.closeAllConnections();
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }
}

async function post(base: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text, json: JSON.parse(text) as Record<string, unknown> };
}

async function startFlow(base: string): Promise<string> {
  const started = await post(base, '/api/api-providers/device-flow/start');
  assert.equal(started.status, 200);
  return started.json.flowId as string;
}

describe('device-flow REST routes', () => {
  test('start returns flowId, userCode, verificationUri, interval, expiresIn and never the device_code', async () => {
    await withDeviceApi({ [`https://github.com/login/device/code`]: DEVICE_CODE_ROUTE }, async (base) => {
      const started = await post(base, '/api/api-providers/device-flow/start');
      assert.equal(started.status, 200);
      assert.deepEqual(Object.keys(started.json).sort(), ['expiresIn', 'flowId', 'interval', 'userCode', 'verificationUri']);
      assert.equal(started.json.userCode, 'ABCD-1234');
      assert.equal(started.json.verificationUri, 'https://github.com/login/device');
      assert.equal(started.json.interval, 5);
      assert.equal(started.json.expiresIn, 900);
      assert.equal(typeof started.json.flowId, 'string');
      assert.equal(started.text.includes(DEVICE_CODE), false);
    });
  });

  test('start maps an upstream failure to 502 JSON error', async () => {
    await withDeviceApi(
      { 'https://github.com/login/device/code': { status: 500, body: { message: 'boom' } } },
      async (base) => {
        const started = await post(base, '/api/api-providers/device-flow/start');
        assert.equal(started.status, 502);
        assert.equal(typeof started.json.error, 'string');
      },
    );
  });

  test('poll returns pending with the flow interval', async () => {
    await withDeviceApi(
      {
        'https://github.com/login/device/code': DEVICE_CODE_ROUTE,
        [TOKEN_URL]: { status: 200, body: { error: 'authorization_pending' } },
      },
      async (base) => {
        const flowId = await startFlow(base);
        const polled = await post(base, '/api/api-providers/device-flow/poll', { flowId });
        assert.equal(polled.status, 200);
        assert.deepEqual(polled.json, { status: 'pending', interval: 5 });
        assert.equal(polled.text.includes(DEVICE_CODE), false);
      },
    );
  });

  test('poll done is authorized-but-unsaved: no store write, no live-apply, and only a pendingId is returned', async () => {
    const store = createApiProviderStore();
    const applied: unknown[] = [];
    await withDeviceApi(
      {
        'https://github.com/login/device/code': DEVICE_CODE_ROUTE,
        [TOKEN_URL]: { status: 200, body: { access_token: ACCESS_TOKEN } },
        [ENTITLEMENT_URL]: { status: 200, body: { chat_enabled: true } },
      },
      async (base) => {
        const flowId = await startFlow(base);
        const polled = await post(base, '/api/api-providers/device-flow/poll', { flowId });
        assert.equal(polled.status, 200);
        assert.equal(polled.json.status, 'done');
        assert.equal(typeof polled.json.pendingId, 'string');
        assert.equal('provider' in polled.json, false);
        assert.equal(polled.text.includes('authState'), false);
        assert.equal(polled.text.includes(ACCESS_TOKEN), false);
        assert.equal(polled.text.includes(DEVICE_CODE), false);
      },
      store,
      (active) => applied.push(active),
    );
    assert.equal(store.size(), 0);
    assert.equal(applied.length, 0);
  });

  test('confirm persists the copilot provider once with the chosen model and fires live-apply once', async () => {
    const store = createApiProviderStore();
    const applied: unknown[] = [];
    await withDeviceApi(
      {
        'https://github.com/login/device/code': DEVICE_CODE_ROUTE,
        [TOKEN_URL]: { status: 200, body: { access_token: ACCESS_TOKEN } },
        [ENTITLEMENT_URL]: { status: 200, body: { chat_enabled: true } },
      },
      async (base) => {
        const flowId = await startFlow(base);
        const polled = await post(base, '/api/api-providers/device-flow/poll', { flowId });
        const confirmed = await post(base, '/api/api-providers/device-flow/confirm', {
          pendingId: polled.json.pendingId,
          model: 'gpt-4o',
        });
        assert.equal(confirmed.status, 200);
        const provider = confirmed.json.provider as Record<string, unknown>;
        assert.equal(provider.adapterId, 'copilot');
        assert.equal(provider.authType, 'deviceOAuth');
        assert.equal(provider.model, 'gpt-4o');
        assert.equal(provider.isActive, true);
        assert.equal('authState' in provider, false);
        assert.equal(confirmed.text.includes(ACCESS_TOKEN), false);

        const stored = store.list().filter((p) => p.adapterId === 'copilot');
        assert.equal(stored.length, 1);
        assert.equal(stored[0].model, 'gpt-4o');
        assert.equal(stored[0].isActive, true);
        assert.equal(store.getActive()?.id, stored[0].id);
        assert.equal(parseAuthState(stored[0].authState)?.accessToken, ACCESS_TOKEN);

        const again = await post(base, '/api/api-providers/device-flow/confirm', {
          pendingId: polled.json.pendingId,
          model: 'gpt-4o',
        });
        assert.equal(again.status, 404);
      },
      store,
      (active) => applied.push(active),
    );
    assert.equal(store.list().filter((p) => p.adapterId === 'copilot').length, 1);
    assert.equal(applied.length, 1);
  });

  test('confirm with a custom name stores the trimmed name; omitted or blank name keeps GitHub Copilot', async () => {
    const store = createApiProviderStore();
    await withDeviceApi(
      {
        'https://github.com/login/device/code': DEVICE_CODE_ROUTE,
        [TOKEN_URL]: { status: 200, body: { access_token: ACCESS_TOKEN } },
        [ENTITLEMENT_URL]: { status: 200, body: { chat_enabled: true } },
      },
      async (base) => {
        const flowId = await startFlow(base);
        const polled = await post(base, '/api/api-providers/device-flow/poll', { flowId });
        const confirmed = await post(base, '/api/api-providers/device-flow/confirm', {
          pendingId: polled.json.pendingId,
          model: 'gpt-4o',
          name: '  My Copilot  ',
        });
        assert.equal(confirmed.status, 200);
        assert.equal((confirmed.json.provider as Record<string, unknown>).name, 'My Copilot');

        const flowId2 = await startFlow(base);
        const polled2 = await post(base, '/api/api-providers/device-flow/poll', { flowId: flowId2 });
        const blank = await post(base, '/api/api-providers/device-flow/confirm', {
          pendingId: polled2.json.pendingId,
          model: 'gpt-4o',
          name: '   ',
        });
        assert.equal(blank.status, 200);
        assert.equal((blank.json.provider as Record<string, unknown>).name, 'GitHub Copilot');
      },
      store,
    );
    assert.deepEqual(store.list().filter((p) => p.adapterId === 'copilot').map((p) => p.name).sort(), ['GitHub Copilot', 'My Copilot']);
  });

  test('confirm without a name stores GitHub Copilot as the default', async () => {
    const store = createApiProviderStore();
    await withDeviceApi(
      {
        'https://github.com/login/device/code': DEVICE_CODE_ROUTE,
        [TOKEN_URL]: { status: 200, body: { access_token: ACCESS_TOKEN } },
        [ENTITLEMENT_URL]: { status: 200, body: { chat_enabled: true } },
      },
      async (base) => {
        const flowId = await startFlow(base);
        const polled = await post(base, '/api/api-providers/device-flow/poll', { flowId });
        const confirmed = await post(base, '/api/api-providers/device-flow/confirm', {
          pendingId: polled.json.pendingId,
          model: 'gpt-4o',
        });
        assert.equal(confirmed.status, 200);
        assert.equal((confirmed.json.provider as Record<string, unknown>).name, 'GitHub Copilot');
      },
      store,
    );
    assert.equal(store.list()[0]?.name, 'GitHub Copilot');
  });

  test('confirm rejects a non-string name with 400 and writes nothing', async () => {
    const store = createApiProviderStore();
    await withDeviceApi(
      {
        'https://github.com/login/device/code': DEVICE_CODE_ROUTE,
        [TOKEN_URL]: { status: 200, body: { access_token: ACCESS_TOKEN } },
        [ENTITLEMENT_URL]: { status: 200, body: { chat_enabled: true } },
      },
      async (base) => {
        const flowId = await startFlow(base);
        const polled = await post(base, '/api/api-providers/device-flow/poll', { flowId });
        const bad = await post(base, '/api/api-providers/device-flow/confirm', {
          pendingId: polled.json.pendingId,
          model: null,
          name: 42,
        });
        assert.equal(bad.status, 400);
        assert.equal(typeof bad.json.error, 'string');
      },
      store,
    );
    assert.equal(store.size(), 0);
  });

  test('confirm with model null stores From Request (null model)', async () => {
    const store = createApiProviderStore();
    await withDeviceApi(
      {
        'https://github.com/login/device/code': DEVICE_CODE_ROUTE,
        [TOKEN_URL]: { status: 200, body: { access_token: ACCESS_TOKEN } },
        [ENTITLEMENT_URL]: { status: 200, body: { chat_enabled: true } },
      },
      async (base) => {
        const flowId = await startFlow(base);
        const polled = await post(base, '/api/api-providers/device-flow/poll', { flowId });
        const confirmed = await post(base, '/api/api-providers/device-flow/confirm', {
          pendingId: polled.json.pendingId,
          model: null,
        });
        assert.equal(confirmed.status, 200);
        assert.equal((confirmed.json.provider as Record<string, unknown>).model, null);
      },
      store,
    );
    assert.equal(store.list()[0]?.model, null);
  });

  test('each confirm without providerId adds a new copilot provider; distinct names coexist', async () => {
    const store = createApiProviderStore();
    await withDeviceApi(
      {
        'https://github.com/login/device/code': DEVICE_CODE_ROUTE,
        [TOKEN_URL]: { status: 200, body: { access_token: ACCESS_TOKEN } },
        [ENTITLEMENT_URL]: { status: 200, body: { chat_enabled: true } },
      },
      async (base) => {
        for (const name of ['Copilot A', 'Copilot B']) {
          const flowId = await startFlow(base);
          const polled = await post(base, '/api/api-providers/device-flow/poll', { flowId });
          assert.equal(polled.json.status, 'done');
          const confirmed = await post(base, '/api/api-providers/device-flow/confirm', { pendingId: polled.json.pendingId, model: 'gpt-4o', name });
          assert.equal(confirmed.status, 200);
        }
      },
      store,
    );
    const copilot = store.list().filter((p) => p.adapterId === 'copilot');
    assert.deepEqual(copilot.map((p) => p.name).sort(), ['Copilot A', 'Copilot B']);
    assert.equal(copilot.filter((p) => p.isActive).length, 1);
    assert.equal(store.getActive()?.name, 'Copilot B');
  });

  test('confirm with providerId re-logs in only that copilot row', async () => {
    const store = createApiProviderStore();
    await withDeviceApi(
      {
        'https://github.com/login/device/code': DEVICE_CODE_ROUTE,
        [TOKEN_URL]: { status: 200, body: { access_token: ACCESS_TOKEN } },
        [ENTITLEMENT_URL]: { status: 200, body: { chat_enabled: true } },
      },
      async (base) => {
        const ids: string[] = [];
        for (const name of ['Copilot A', 'Copilot B']) {
          const flowId = await startFlow(base);
          const polled = await post(base, '/api/api-providers/device-flow/poll', { flowId });
          const confirmed = await post(base, '/api/api-providers/device-flow/confirm', { pendingId: polled.json.pendingId, model: 'gpt-4o', name });
          assert.equal(confirmed.status, 200);
          ids.push((confirmed.json.provider as Record<string, unknown>).id as string);
        }
        const flowId = await startFlow(base);
        const polled = await post(base, '/api/api-providers/device-flow/poll', { flowId });
        const relogin = await post(base, '/api/api-providers/device-flow/confirm', {
          pendingId: polled.json.pendingId,
          model: 'o3',
          providerId: ids[0],
        });
        assert.equal(relogin.status, 200);
        assert.equal((relogin.json.provider as Record<string, unknown>).id, ids[0]);
      },
      store,
    );
    const copilot = store.list().filter((p) => p.adapterId === 'copilot');
    assert.equal(copilot.length, 2);
    assert.equal(copilot.find((p) => p.name === 'Copilot B')?.model, 'gpt-4o');
    assert.equal(copilot.find((p) => p.name === 'Copilot A')?.model, 'o3');
  });

  test('confirm with an unknown providerId is 404 and writes nothing', async () => {
    const store = createApiProviderStore();
    await withDeviceApi(
      {
        'https://github.com/login/device/code': DEVICE_CODE_ROUTE,
        [TOKEN_URL]: { status: 200, body: { access_token: ACCESS_TOKEN } },
        [ENTITLEMENT_URL]: { status: 200, body: { chat_enabled: true } },
      },
      async (base) => {
        const flowId = await startFlow(base);
        const polled = await post(base, '/api/api-providers/device-flow/poll', { flowId });
        const missing = await post(base, '/api/api-providers/device-flow/confirm', {
          pendingId: polled.json.pendingId,
          model: null,
          providerId: 'no-such-id',
        });
        assert.equal(missing.status, 404);
        assert.deepEqual(missing.json, { error: 'not_found' });
      },
      store,
    );
    assert.equal(store.size(), 0);
  });

  test('confirm with a non-string providerId is 400 and writes nothing', async () => {
    const store = createApiProviderStore();
    await withDeviceApi(
      {
        'https://github.com/login/device/code': DEVICE_CODE_ROUTE,
        [TOKEN_URL]: { status: 200, body: { access_token: ACCESS_TOKEN } },
        [ENTITLEMENT_URL]: { status: 200, body: { chat_enabled: true } },
      },
      async (base) => {
        const flowId = await startFlow(base);
        const polled = await post(base, '/api/api-providers/device-flow/poll', { flowId });
        const bad = await post(base, '/api/api-providers/device-flow/confirm', {
          pendingId: polled.json.pendingId,
          model: null,
          providerId: 42,
        });
        assert.equal(bad.status, 400);
        assert.equal(typeof bad.json.error, 'string');
      },
      store,
    );
    assert.equal(store.size(), 0);
  });

  test('confirm rejects unknown pendingId with 404 and an apiKey with 400 without writing', async () => {
    const store = createApiProviderStore();
    await withDeviceApi(
      {
        'https://github.com/login/device/code': DEVICE_CODE_ROUTE,
        [TOKEN_URL]: { status: 200, body: { access_token: ACCESS_TOKEN } },
        [ENTITLEMENT_URL]: { status: 200, body: { chat_enabled: true } },
      },
      async (base) => {
        const unknown = await post(base, '/api/api-providers/device-flow/confirm', { pendingId: 'nope', model: null });
        assert.equal(unknown.status, 404);
        assert.deepEqual(unknown.json, { error: 'not_found' });

        const flowId = await startFlow(base);
        const polled = await post(base, '/api/api-providers/device-flow/poll', { flowId });
        const withKey = await post(base, '/api/api-providers/device-flow/confirm', {
          pendingId: polled.json.pendingId,
          model: null,
          apiKey: 'ghp_pasted',
        });
        assert.equal(withKey.status, 400);
        assert.equal(withKey.text.includes('ghp_pasted'), false);
        const missing = await post(base, '/api/api-providers/device-flow/confirm', { model: null });
        assert.equal(missing.status, 400);
      },
      store,
    );
    assert.equal(store.size(), 0);
  });

  test('a pendingId expires after its TTL and confirm returns 410', async (t) => {
    t.mock.timers.enable({ apis: ['Date'] });
    const store = createApiProviderStore();
    await withDeviceApi(
      {
        'https://github.com/login/device/code': DEVICE_CODE_ROUTE,
        [TOKEN_URL]: { status: 200, body: { access_token: ACCESS_TOKEN } },
        [ENTITLEMENT_URL]: { status: 200, body: { chat_enabled: true } },
      },
      async (base) => {
        const flowId = await startFlow(base);
        const polled = await post(base, '/api/api-providers/device-flow/poll', { flowId });
        t.mock.timers.tick(10 * 60_000 + 1);
        const expired = await post(base, '/api/api-providers/device-flow/confirm', {
          pendingId: polled.json.pendingId,
          model: null,
        });
        assert.equal(expired.status, 410);
        assert.equal(typeof expired.json.error, 'string');
      },
      store,
    );
    assert.equal(store.size(), 0);
  });

  test('entitlement blocked returns 403, creates no provider, and drops the flow', async () => {
    const store = createApiProviderStore();
    await withDeviceApi(
      {
        'https://github.com/login/device/code': DEVICE_CODE_ROUTE,
        [TOKEN_URL]: { status: 200, body: { access_token: ACCESS_TOKEN } },
        [ENTITLEMENT_URL]: { status: 200, body: { chat_enabled: false } },
      },
      async (base) => {
        const flowId = await startFlow(base);
        const polled = await post(base, '/api/api-providers/device-flow/poll', { flowId });
        assert.equal(polled.status, 403);
        assert.equal(typeof polled.json.error, 'string');
        assert.equal(polled.text.includes(ACCESS_TOKEN), false);
        assert.equal(polled.text.includes(DEVICE_CODE), false);

        const again = await post(base, '/api/api-providers/device-flow/poll', { flowId });
        assert.equal(again.status, 404);
      },
      store,
    );
    assert.equal(store.size(), 0);
  });

  test('unknown flowId returns 404', async () => {
    await withDeviceApi({}, async (base) => {
      const polled = await post(base, '/api/api-providers/device-flow/poll', { flowId: 'no-such-flow' });
      assert.equal(polled.status, 404);
      assert.deepEqual(polled.json, { error: 'not_found' });
    });
  });

  test('poll rejects a body without a flowId with 400', async () => {
    await withDeviceApi({}, async (base) => {
      const polled = await post(base, '/api/api-providers/device-flow/poll', {});
      assert.equal(polled.status, 400);
      assert.equal(typeof polled.json.error, 'string');
    });
  });

  test('expired device code drops the flow and returns the status', async () => {
    await withDeviceApi(
      {
        'https://github.com/login/device/code': DEVICE_CODE_ROUTE,
        [TOKEN_URL]: { status: 200, body: { error: 'expired_token' } },
      },
      async (base) => {
        const flowId = await startFlow(base);
        const polled = await post(base, '/api/api-providers/device-flow/poll', { flowId });
        assert.deepEqual(polled.json, { status: 'expired' });
        const again = await post(base, '/api/api-providers/device-flow/poll', { flowId });
        assert.equal(again.status, 404);
      },
    );
  });

  test('the device_code is sent to GitHub on poll but never appears in any response body', async () => {
    await withDeviceApi(
      {
        'https://github.com/login/device/code': DEVICE_CODE_ROUTE,
        [TOKEN_URL]: { status: 200, body: { error: 'authorization_pending' } },
      },
      async (base, _store, calls) => {
        const started = await post(base, '/api/api-providers/device-flow/start');
        const polled = await post(base, '/api/api-providers/device-flow/poll', { flowId: started.json.flowId });
        assert.equal(started.text.includes(DEVICE_CODE), false);
        assert.equal(polled.text.includes(DEVICE_CODE), false);
        const tokenCall = calls.find((c) => c.url === TOKEN_URL);
        assert.ok(tokenCall?.body?.includes(DEVICE_CODE));
      },
    );
  });
});

describe('device-flow registry', () => {
  test('entries expire after expires_in and are swept lazily', () => {
    let clock = 1_000;
    const registry = createDeviceFlowRegistry({ now: () => clock, createId: () => 'flow-1' });
    const flowId = registry.start({
      deviceCode: DEVICE_CODE,
      userCode: 'ABCD-1234',
      verificationUri: 'https://github.com/login/device',
      interval: 5,
      expiresIn: 10,
    });
    assert.equal(flowId, 'flow-1');
    assert.equal(registry.get(flowId)?.deviceCode, DEVICE_CODE);
    clock += 10_001;
    assert.equal(registry.get(flowId), undefined);
    assert.equal(registry.size(), 0);
    assert.equal(registry.delete(flowId), false);
  });
});

const COPILOT_MODELS_URL = 'https://api.githubcopilot.com/models';
const MODEL_LIST = { data: [{ id: 'gpt-4o' }, { id: 'claude-3.5' }, { id: 'gpt-4o' }] };

/** Stub only https upstream calls (the Copilot models list); the local test client passes through. */
async function withModelsUpstream(
  respond: () => Response,
  run: (upstream: { url: string; auth: string | undefined }[]) => Promise<void>,
): Promise<void> {
  const realFetch = globalThis.fetch;
  const upstream: { url: string; auth: string | undefined }[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (!url.startsWith('https://')) return realFetch(input, init);
    upstream.push({ url, auth: (init?.headers as Record<string, string> | undefined)?.Authorization });
    return respond();
  }) as typeof fetch;
  try {
    await run(upstream);
  } finally {
    globalThis.fetch = realFetch;
  }
}

const LOGIN_ROUTES: Record<string, Route> = {
  'https://github.com/login/device/code': DEVICE_CODE_ROUTE,
  [TOKEN_URL]: { status: 200, body: { access_token: ACCESS_TOKEN } },
  [ENTITLEMENT_URL]: { status: 200, body: { chat_enabled: true } },
};

/** Drive start + poll to an authorized-but-unsaved pendingId. */
async function completeLogin(base: string): Promise<string> {
  const flowId = await startFlow(base);
  const polled = await post(base, '/api/api-providers/device-flow/poll', { flowId });
  assert.equal(polled.json.status, 'done');
  return polled.json.pendingId as string;
}

describe('device-flow pending model list', () => {
  test('probe by pendingId returns sorted model ids, persists nothing, and keeps the pending login confirmable', async () => {
    const store = createApiProviderStore();
    await withModelsUpstream(
      () => new Response(JSON.stringify(MODEL_LIST), { status: 200, headers: { 'Content-Type': 'application/json' } }),
      async (upstream) => {
        await withDeviceApi(LOGIN_ROUTES, async (base) => {
          const pendingId = await completeLogin(base);
          const listed = await post(base, '/api/api-providers/probe', { pendingId });
          assert.equal(listed.status, 200);
          assert.deepEqual(Object.keys(listed.json), ['models']);
          assert.deepEqual(listed.json.models, ['claude-3.5', 'gpt-4o']);
          assert.equal(listed.text.includes(ACCESS_TOKEN), false);
          assert.equal(listed.text.includes('authState'), false);
          assert.equal(upstream.length, 1);
          assert.equal(upstream[0].url, COPILOT_MODELS_URL);
          assert.equal(upstream[0].auth, `Bearer ${ACCESS_TOKEN}`);
          assert.equal(store.size(), 0);

          const again = await post(base, '/api/api-providers/probe', { pendingId });
          assert.equal(again.status, 200);

          const confirmed = await post(base, '/api/api-providers/device-flow/confirm', { pendingId, model: 'gpt-4o' });
          assert.equal(confirmed.status, 200);
          assert.equal(store.size(), 1);
        }, store);
      },
    );
  });

  test('probe by unknown pendingId is 404 and never calls upstream', async () => {
    await withModelsUpstream(
      () => new Response('{}', { status: 200 }),
      async (upstream) => {
        await withDeviceApi({}, async (base) => {
          const res = await post(base, '/api/api-providers/probe', { pendingId: 'nope' });
          assert.equal(res.status, 404);
          assert.equal(typeof res.json.error, 'string');
          assert.equal(upstream.length, 0);
        });
      },
    );
  });

  test('probe by expired pendingId is 410 and never calls upstream', async () => {
    await withModelsUpstream(
      () => new Response('{}', { status: 200 }),
      async (upstream) => {
        await withDeviceApi(LOGIN_ROUTES, async (base) => {
          const pendingId = await completeLogin(base);
          const realNow = Date.now;
          Date.now = () => realNow() + 11 * 60_000;
          try {
            const res = await post(base, '/api/api-providers/probe', { pendingId });
            assert.equal(res.status, 410);
          } finally {
            Date.now = realNow;
          }
          assert.equal(upstream.length, 0);
        });
      },
    );
  });

  test('upstream model-list failure is a JSON error status without the token in the body', async () => {
    await withModelsUpstream(
      () => new Response(JSON.stringify({ message: 'denied' }), { status: 401, headers: { 'Content-Type': 'application/json' } }),
      async () => {
        await withDeviceApi(LOGIN_ROUTES, async (base) => {
          const pendingId = await completeLogin(base);
          const res = await post(base, '/api/api-providers/probe', { pendingId });
          assert.equal(res.status, 401);
          assert.equal(typeof res.json.error, 'string');
          assert.equal(res.text.includes(ACCESS_TOKEN), false);
        });
      },
    );
  });
});
