/**
 * End-to-end integration test for the fully-wired mcp-manager HTTP server: it
 * mounts the REST API, the built-in WebSocket server, and the dashboard static
 * files onto the SAME server as the proxy routes, all sharing ONE telemetry bus
 * + collector. Uses raw `node:net` sockets for the RFC6455 WebSocket upgrade
 * (no `ws` library), and tears everything down in `afterEach` so the event loop
 * drains cleanly (no hang).
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as net from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from '../src/server/index';
import type { McmServer, McmServerHandle } from '../src/server/index';
import { flagshipLoopRule } from '../src/policy/ruleEngine';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

let server: McmServer | undefined;
const sockets = new Set<net.Socket>();

function track(socket: net.Socket): void {
  sockets.add(socket);
  socket.on('error', () => {}); // swallow error noise during teardown
}

/** Boot the wired server on an ephemeral port; returns the port + the `.mcm` handle. */
async function start(): Promise<{ port: number; mcm: McmServerHandle }> {
  // createServer(0) auto-listens internally (preserving existing behavior), so we
  // await the 'listening' event rather than calling listen(0) a second time.
  const srv = createServer(0);
  server = srv;
  await new Promise<void>((resolve) => {
    if (srv.listening) resolve();
    else srv.once('listening', () => resolve());
  });
  const addr = srv.address();
  if (addr === null || typeof addr !== 'object') throw new Error('server did not bind a TCP port');
  const mcm = srv.mcm;
  if (mcm === undefined) throw new Error('the server.mcm test handle was not attached');
  return { port: addr.port, mcm };
}

async function teardown(): Promise<void> {
  for (const s of [...sockets]) {
    try {
      s.destroy();
    } catch {
      // ignore
    }
  }
  sockets.clear();
  if (server) {
    const srv = server;
    server = undefined;
    try {
      srv.closeAllConnections();
    } catch {
      // ignore
    }
    await new Promise<void>((resolve, reject) => {
      srv.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

afterEach(async () => {
  await teardown();
});

// --- raw RFC6455 wire helpers (same protocol as tests/ws.test.ts) -----------

interface Handshake {
  socket: net.Socket;
  expectedAccept: string;
  leftover: Buffer;
}

/** Open a raw socket and perform the WebSocket upgrade handshake to `/ws`. */
function connectAndHandshake(port: number): Promise<Handshake> {
  return new Promise((resolve, reject) => {
    const key = randomBytes(16).toString('base64');
    const expectedAccept = createHash('sha1').update(key + WS_GUID).digest('base64');
    const request =
      `GET /ws HTTP/1.1\r\n` +
      `Host: 127.0.0.1:${port}\r\n` +
      `Upgrade: websocket\r\n` +
      `Connection: Upgrade\r\n` +
      `Sec-WebSocket-Key: ${key}\r\n` +
      `Sec-WebSocket-Version: 13\r\n` +
      `\r\n`;
    const socket = net.connect({ host: '127.0.0.1', port });
    track(socket);
    let acc = '';
    let settled = false;
    const onData = (chunk: Buffer) => {
      acc += chunk.toString('binary');
      const idx = acc.indexOf('\r\n\r\n');
      if (idx === -1 || settled) return;
      settled = true;
      socket.removeListener('data', onData);
      resolve({ socket, expectedAccept, leftover: Buffer.from(acc.slice(idx + 4), 'binary') });
    };
    socket.on('data', onData);
    socket.once('error', (err) => {
      if (!settled) reject(err);
    });
    socket.on('connect', () => {
      socket.write(request);
    });
  });
}

interface DecodedFrame {
  opcode: number;
  payload: string;
}

/** Read one server→client text frame, optionally seeded with leftover bytes. */
function readTextFrame(socket: net.Socket, initial?: Buffer): Promise<DecodedFrame> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let buffer = initial && initial.length > 0 ? Buffer.from(initial) : Buffer.alloc(0);
    const settle = (frame: DecodedFrame): void => {
      if (settled) return;
      settled = true;
      socket.removeListener('data', onData);
      resolve(frame);
    };
    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      socket.removeListener('data', onData);
      reject(err);
    };
    const extract = (): DecodedFrame | null => {
      if (buffer.length < 2) return null;
      const opcode = buffer[0] & 0x0f;
      const masked = (buffer[1] & 0x80) !== 0;
      let length = buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < offset + 2) return null;
        length = buffer.readUInt16BE(offset);
        offset += 2;
      } else if (length === 127) {
        if (buffer.length < offset + 8) return null;
        length = Number(buffer.readBigUInt64BE(offset));
        offset += 8;
      }
      if (masked) {
        if (buffer.length < offset + 4) return null;
        offset += 4;
      }
      if (buffer.length < offset + length) return null;
      const payload = buffer.subarray(offset, offset + length).toString('utf8');
      return { opcode, payload };
    };
    const pump = (): void => {
      const frame = extract();
      if (frame) settle(frame);
    };
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      pump();
    };
    socket.on('data', onData);
    socket.once('error', fail);
    pump();
  });
}

// --- tests -------------------------------------------------------------------

test('serves the dashboard index at GET / (text/html with an app marker)', async () => {
  const { port } = await start();
  const res = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/html/);
  const body = await res.text();
  assert.ok(body.includes('<html'), 'index should contain an HTML document');
  assert.ok(body.includes('mcp-manager'), 'index should contain the app marker');
});

test('serves the dashboard assets /app.js and /styles.css', async () => {
  const { port } = await start();
  const js = await fetch(`http://127.0.0.1:${port}/app.js`);
  assert.equal(js.status, 200);
  assert.match(js.headers.get('content-type') ?? '', /javascript/);
  const css = await fetch(`http://127.0.0.1:${port}/styles.css`);
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type') ?? '', /text\/css/);
});

test('regression: GET /health returns 200 {status:"ok"}', async () => {
  const { port } = await start();
  const res = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: 'ok' });
});

test('GET /api/stats reads the SHARED collector bus as JSON (numeric totals + topTools)', async () => {
  const { port, mcm } = await start();
  // Feed events on the SAME bus the proxy uses; the API's stats must reflect them.
  await mcm.bus.emit({ type: 'tool.call', sessionKey: 's1', toolName: 'bash', at: Date.now() });
  await mcm.bus.emit({ type: 'tool.result', sessionKey: 's1', toolName: 'bash', at: Date.now() });
  const res = await fetch(`http://127.0.0.1:${port}/api/stats`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /json/);
  const body = (await res.json()) as {
    totalCalls: unknown;
    totalResults: unknown;
    topTools: unknown[];
  };
  assert.equal(typeof body.totalCalls, 'number');
  assert.equal(typeof body.totalResults, 'number');
  assert.ok(Array.isArray(body.topTools), 'topTools must be an array');
  assert.equal(body.totalCalls, 1);
  assert.equal(body.totalResults, 1);
  assert.ok(
    body.topTools.some(
      (t) => typeof t === 'object' && t !== null && (t as { toolName?: unknown }).toolName === 'bash',
    ),
    'topTools should include the seeded tool',
  );
});

test('seeding a rule is reflected by GET /api/rules', async () => {
  const { port, mcm } = await start();
  const stored = mcm.ruleStore.add(flagshipLoopRule());
  assert.equal(stored.id, 'flagship-loop-rule');
  const res = await fetch(`http://127.0.0.1:${port}/api/rules`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as Array<{ id: string; enabled: boolean; matcher: { type: string } }>;
  assert.equal(body.length, 1);
  assert.equal(body[0].id, 'flagship-loop-rule');
  assert.equal(body[0].enabled, true);
  assert.equal(body[0].matcher.type, 'loop');
});

test('a WS client receives frames for events emitted on the SHARED bus (same bus as the proxy)', async () => {
  const { port, mcm } = await start();
  const h = await connectAndHandshake(port);
  try {
    assert.equal(mcm.ws.size, 1, 'the handshaked socket should count as an open client');
    // Emit on the SAME shared bus the proxy handler feeds; the WS must broadcast it.
    await mcm.bus.emit({
      type: 'policy.intervention',
      sessionKey: 's',
      ruleId: 'r',
      action: 'block',
      at: Date.now(),
    });
    const frame = await readTextFrame(h.socket, h.leftover);
    assert.equal(frame.opcode, 0x1, 'response should be a text frame (opcode 1)');
    const parsed = JSON.parse(frame.payload) as { type?: string; ruleId?: string; sessionKey?: string };
    assert.equal(parsed.type, 'policy.intervention');
    assert.equal(parsed.ruleId, 'r');
    assert.equal(parsed.sessionKey, 's');
  } finally {
    h.socket.destroy();
  }
});
