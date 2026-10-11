/**
 * WS-URL derivation for dashboard/js/transport.mjs — the core of the "point the
 * dashboard at a WebSocket target" fix. Resolution precedence (documented in the
 * module): an explicit ?ws= query param (if present) beats a truthy
 * window.ATG_WS_URL global, which beats the same-origin /ws default. Only an
 * absolute ws:/wss: URL with a valid host is honored as an override; anything
 * empty/malformed/wrong-scheme falls back to the same-origin default without
 * throwing. A valid override also bypasses the same-origin gate inside connectWS
 * (cross-origin or a non-http origin such as file:); the default stays gated.
 *
 * There is NO DOM/browser test infra here (zero-dependency vanilla-JS dashboard
 * served RAW, not part of the TS build), so the .mjs module is loaded under Node
 * with minimal global stubs (document/window/location/WebSocket), mirroring
 * tests/parallel-dashboard-dedup.test.ts. Imported via a non-literal specifier
 * (keeps this file compiling cleanly; resolves relative to dist/tests/). No real
 * network connection is required.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

/* ---- minimal global stubs ---------------------------------------------- */
class FakeEl {
  className = ''; title = ''; textContent = ''; hidden = false;
  private _c = new Set<string>();
  get classList() {
    const c = this._c;
    return {
      toggle(t: string, f?: boolean): boolean { const want = f === undefined ? !c.has(t) : !!f; if (want) c.add(t); else c.delete(t); return want; },
      add(...t: string[]): void { t.forEach((x) => c.add(x)); },
      remove(...t: string[]): void { t.forEach((x) => c.delete(x)); },
      contains(t: string): boolean { return c.has(t); },
    };
  }
}
const registry = new Map<string, FakeEl>();
let installed = false;
function installDomStub(): void {
  if (installed) return;
  (globalThis as unknown as { document: unknown }).document = {
    getElementById(id: string): FakeEl { let e = registry.get(id); if (!e) { e = new FakeEl(); registry.set(id, e); } return e; },
    createElement(_tag: string): FakeEl { return new FakeEl(); },
  };
  installed = true;
}
// Captured WebSocket instances, reset per scenario.
const sockets: any[] = [];
class FakeWebSocket {
  readonly url: any; readyState = 1; // OPEN-ish
  onopen: any = null; onmessage: any = null; onerror: any = null; onclose: any = null;
  constructor(url: any) { this.url = url; sockets.push(this); }
  close(): void { this.readyState = 3; }
  send(): void { /* no-op */ }
}
(FakeWebSocket as any).OPEN = 1; (FakeWebSocket as any).CONNECTING = 0;
(FakeWebSocket as any).CLOSING = 2; (FakeWebSocket as any).CLOSED = 3;

type Loc = { protocol: string; hostname: string; port: string; host: string; pathname?: string; search: string };
// Reset location/window/WebSocket to a known baseline (defaults http://host:8787) and clear captures.
function setLocation(loc: Partial<Loc>): void {
  (globalThis as unknown as Record<string, unknown>).location = Object.assign(
    { protocol: 'http:', hostname: 'host', port: '8787', host: 'host:8787', search: '' } satisfies Partial<Loc>, loc,
  );
  (globalThis as unknown as Record<string, unknown>).window = {}; // fresh per scenario
  (globalThis as unknown as Record<string, unknown>).WebSocket = FakeWebSocket;
  sockets.length = 0;
}
/** Import the real dashboard transport + state modules under the stubs. */
async function loadDashboard(): Promise<{ connectWS: any; resolveWsUrl: any; state: any }> {
  installDomStub();
  const base = '../..' + '/dashboard'; // non-literal specifier -> Promise<any>, no TS module resolution
  const t = await import(base + '/js/transport.mjs');
  const st = await import(base + '/js/state.mjs');
  (globalThis as unknown as Record<string, unknown>).WebSocket = FakeWebSocket;
  return { connectWS: (t as any).connectWS, resolveWsUrl: (t as any).resolveWsUrl, state: (st as any).state };
}
/** Clear shared runtime WS/timer state so each scenario starts clean. */
function resetRuntime(state: any): void {
  state.ws = null; state.reconnectTimer = null; state.keepaliveTimer = null;
  state.eventsPollTimer = null; state.wsLastInboundAt = 0;
}

/* ---- core derivation: default ------------------------------------------ */
test('D1: no override on http origin derives ws://host:port/ws', async () => {
  const { resolveWsUrl } = await loadDashboard();
  setLocation({ protocol: 'http:', hostname: 'host', port: '8787', host: 'host:8787', search: '' });
  assert.equal(resolveWsUrl(), 'ws://host:8787/ws');
});
test('D2: no override on https origin derives wss://host/ws', async () => {
  const { resolveWsUrl } = await loadDashboard();
  setLocation({ protocol: 'https:', hostname: 'host', port: '', host: 'host', search: '' });
  assert.equal(resolveWsUrl(), 'wss://host/ws');
});

/* ---- core derivation: base-path-aware default ------------------------------ */
test('D7: sub-path with .html filename derives the in-directory ws target', async () => {
  const { resolveWsUrl } = await loadDashboard();
  setLocation({ protocol: 'http:', hostname: 'host', port: '8787', host: 'host:8787', pathname: '/aitoolgate/index.html', search: '' });
  assert.equal(resolveWsUrl(), 'ws://host:8787/aitoolgate/ws');
});
test('D8: sub-path with trailing slash derives the in-directory ws target', async () => {
  const { resolveWsUrl } = await loadDashboard();
  setLocation({ protocol: 'http:', hostname: 'host', port: '8787', host: 'host:8787', pathname: '/aitoolgate/', search: '' });
  assert.equal(resolveWsUrl(), 'ws://host:8787/aitoolgate/ws');
});
test('D9: root /index.html still derives /ws (root unchanged)', async () => {
  const { resolveWsUrl } = await loadDashboard();
  setLocation({ protocol: 'http:', hostname: 'host', port: '8787', host: 'host:8787', pathname: '/index.html', search: '' });
  assert.equal(resolveWsUrl(), 'ws://host:8787/ws');
});
test('D10: explicit ?ws= override wins over the base-path-aware default (regression guard)', async () => {
  const { resolveWsUrl } = await loadDashboard();
  setLocation({ protocol: 'http:', hostname: 'host', port: '8787', host: 'host:8787', pathname: '/aitoolgate/index.html', search: '?ws=ws://custom:9999/my-ws' });
  assert.equal(resolveWsUrl(), 'ws://custom:9999/my-ws');
});

/* ---- core derivation: ?ws= query param wins ---------------------------- */
test('D3: ?ws= absolute ws override wins over the default', async () => {
  const { resolveWsUrl } = await loadDashboard();
  setLocation({ protocol: 'http:', host: 'host:8787', search: '?ws=ws://x:9/svc' });
  assert.equal(resolveWsUrl(), 'ws://x:9/svc');
});
test('D4: ?ws= absolute wss override wins over the default', async () => {
  const { resolveWsUrl } = await loadDashboard();
  setLocation({ protocol: 'http:', host: 'host:8787', search: '?ws=wss://remote.example/gateway' });
  assert.equal(resolveWsUrl(), 'wss://remote.example/gateway');
});

/* ---- core derivation: window.ATG_WS_URL wins when no param ------------ */
test('D5: window.ATG_WS_URL wins over the default when no ?ws param is present', async () => {
  const { resolveWsUrl } = await loadDashboard();
  setLocation({ protocol: 'http:', host: 'host:8787', search: '' });
  (globalThis as unknown as Record<string, unknown>).window = { ATG_WS_URL: 'ws://override-host:1234/proxy' };
  assert.equal(resolveWsUrl(), 'ws://override-host:1234/proxy');
});
test('D6: ?ws= param beats window.ATG_WS_URL when both are present', async () => {
  const { resolveWsUrl } = await loadDashboard();
  setLocation({ protocol: 'http:', host: 'host:8787', search: '?ws=ws://from-param:5/a' });
  (globalThis as unknown as Record<string, unknown>).window = { ATG_WS_URL: 'ws://from-global:6/b' };
  assert.equal(resolveWsUrl(), 'ws://from-param:5/a');
});

/* ---- validation & fallback --------------------------------------------- */
test('F1: malformed / wrong-scheme / empty overrides fall back to the same-origin default', async () => {
  const { resolveWsUrl } = await loadDashboard();
  const cases: string[] = [
    '?ws=http://x:1/y', // right-shaped but http, not ws
    '?ws=https://x:1/y', // https (not wss)
    '?ws=not-a-url',     // unparseable
    '?ws=',             // empty value
    '?ws=foo',          // relative, not absolute
    '?ws=//x/y',        // protocol-relative: unparseable without a base URL
  ];
  for (const search of cases) {
    setLocation({ protocol: 'http:', host: 'host:8787', search });
    assert.equal(resolveWsUrl(), 'ws://host:8787/ws', `expected default for search="${search}"`);
  }
});
test('F2: invalid window.ATG_WS_URL falls back to the same-origin default', async () => {
  const { resolveWsUrl } = await loadDashboard();
  setLocation({ protocol: 'http:', host: 'host:8787', search: '' });
  for (const bad of ['http://x:1/y', 'garbage not a url', '', 'foo']) {
    (globalThis as unknown as Record<string, unknown>).window = { ATG_WS_URL: bad };
    assert.equal(resolveWsUrl(), 'ws://host:8787/ws', `expected default for ATG_WS_URL=${JSON.stringify(bad)}`);
  }
});

/* ---- connectWS: gate bypass for valid overrides, intact for default ---- */
test('C1: cross-origin ?ws= override bypasses the same-origin gate and opens the exact URL', async () => {
  const { connectWS, state } = await loadDashboard(); resetRuntime(state);
  setLocation({ protocol: 'http:', hostname: 'host', port: '8787', host: 'host:8787', search: '?ws=wss://remote.example/gw' });
  connectWS();
  assert.equal(sockets.length, 1, 'a socket was created (gate bypassed)');
  assert.equal(sockets[0].url, 'wss://remote.example/gw');
});
test('C2: from file:// with a valid override opens it (gate bypassed despite a non-http origin)', async () => {
  const { connectWS, state } = await loadDashboard(); resetRuntime(state);
  setLocation({ protocol: 'file:', hostname: '', port: '', host: '', search: '?ws=ws://tunnel.local:9/ws' });
  connectWS();
  assert.equal(sockets.length, 1, 'a socket was created despite file: origin');
  assert.equal(sockets[0].url, 'ws://tunnel.local:9/ws');
});
test('C3: from file:// with NO override still skips opening (default gate intact -> polling only)', async () => {
  const { connectWS, state } = await loadDashboard(); resetRuntime(state);
  setLocation({ protocol: 'file:', hostname: '', port: '', host: '', search: '' });
  connectWS();
  assert.equal(sockets.length, 0, 'no socket opened on a non-same-origin default');
  assert.equal(state.ws, null, 'state.ws left untouched (relies on polling)');
});
test('C4: invalid ?ws= override does NOT crash connectWS and falls back to the (gated) default', async () => {
  const { connectWS, state } = await loadDashboard(); resetRuntime(state);
  setLocation({ protocol: 'file:', hostname: '', port: '', host: '', search: '?ws=not-a-url' });
  let threw = false;
  try { connectWS(); } catch (_e) { threw = true; }
  assert.equal(threw, false, 'connectWS must not throw on a bad override');
  assert.equal(sockets.length, 0, 'invalid override -> same-origin default -> gated out on file:');
});
