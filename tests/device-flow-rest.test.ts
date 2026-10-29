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
) {
  const gh = mockGitHub(routes);
  const handler = createApiHandler({
    ruleStore: createRuleStore(),
    collector: createCollector({ bus: createEventBus() }),
    apiProviderStore: store,
    deviceFlow: { fetch: gh.fetch, registry: createDeviceFlowRegistry() },
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

  test('poll done with entitlement ok creates and activates the copilot provider without authState in the response', async () => {
    await withDeviceApi(
      {
        'https://github.com/login/device/code': DEVICE_CODE_ROUTE,
        [TOKEN_URL]: { status: 200, body: { access_token: ACCESS_TOKEN } },
        [ENTITLEMENT_URL]: { status: 200, body: { chat_enabled: true } },
      },
      async (base, store) => {
        const flowId = await startFlow(base);
        const polled = await post(base, '/api/api-providers/device-flow/poll', { flowId });
        assert.equal(polled.status, 200);
        assert.equal(polled.json.status, 'done');
        const provider = polled.json.provider as Record<string, unknown>;
        assert.equal(provider.adapterId, 'copilot');
        assert.equal(provider.authType, 'deviceOAuth');
        assert.equal(provider.isActive, true);
        assert.equal('authState' in provider, false);
        assert.equal(polled.text.includes('authState'), false);
        assert.equal(polled.text.includes(ACCESS_TOKEN), false);
        assert.equal(polled.text.includes(DEVICE_CODE), false);

        const stored = store.list().filter((p) => p.adapterId === 'copilot');
        assert.equal(stored.length, 1);
        assert.equal(stored[0].isActive, true);
        assert.equal(store.getActive()?.id, stored[0].id);
        assert.equal(parseAuthState(stored[0].authState)?.accessToken, ACCESS_TOKEN);
      },
    );
  });

  test('a second successful login updates the existing copilot row instead of adding one', async () => {
    const store = createApiProviderStore();
    await withDeviceApi(
      {
        'https://github.com/login/device/code': DEVICE_CODE_ROUTE,
        [TOKEN_URL]: { status: 200, body: { access_token: ACCESS_TOKEN } },
        [ENTITLEMENT_URL]: { status: 200, body: { chat_enabled: true } },
      },
      async (base) => {
        for (let i = 0; i < 2; i++) {
          const flowId = await startFlow(base);
          const polled = await post(base, '/api/api-providers/device-flow/poll', { flowId });
          assert.equal(polled.json.status, 'done');
        }
      },
      store,
    );
    assert.equal(store.list().filter((p) => p.adapterId === 'copilot').length, 1);
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
