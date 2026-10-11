/**
 * Exercises the real RFC6455 WebSocket server over RAW `node:net` sockets
 * (no `ws` library, no TS-global `WebSocket` type). Each test boots an
 * ephemeral `http.Server` (`listen(0)`) with `createWsServer`, drives the
 * wire protocol by hand, and tears everything down in `afterEach` so the
 * event loop drains.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import * as net from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { createWsServer } from '../src/api/ws';
import type { WsServer } from '../src/api/ws';
import { createEventBus } from '../src/telemetry/event-bus';
import type { TelemetryEventBus } from '../src/telemetry/event-bus';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

let server: http.Server | undefined;
let ws: WsServer | undefined;
const sockets = new Set<net.Socket>();

/** Register a socket so teardown always destroys it. Swallow error noise. */
function track(socket: net.Socket): void {
  sockets.add(socket);
  socket.on('error', () => {});
}

async function start(): Promise<{ port: number; bus: TelemetryEventBus }> {
  const srv = http.createServer();
  await srv.listen(0); // ephemeral port — never hang on an un-listened helper
  const addr = srv.address();
  if (addr === null || typeof addr === 'string') {
    throw new Error('server did not bind a TCP port');
  }
  const bus = createEventBus();
  ws = createWsServer(srv, { bus });
  server = srv;
  return { port: addr.port, bus };
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
  if (ws) {
    try {
      ws.close();
    } catch {
      // ignore
    }
    ws = undefined;
  }
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

// --- raw wire helpers --------------------------------------------------------

interface Handshake {
  socket: net.Socket;
  key: string;
  expectedAccept: string;
  head: string;
  leftover: Buffer;
}

/**
 * Open a `node:net` socket to the server and send a hand-written WebSocket
 * upgrade request; resolve once the full HTTP response head (`\r\n\r\n`) is
 * received. Returns the base64 `Sec-WebSocket-Key` + independently computed
 * expected `Sec-WebSocket-Accept`, plus any bytes already beyond the head.
 */
function connectAndHandshake(port: number): Promise<Handshake> {
  return new Promise((resolve, reject) => {
    const key = randomBytes(16).toString('base64');
    const expectedAccept = createHash('sha1').update(key + WS_GUID).digest('base64');
    const request =
      `GET / HTTP/1.1\r\n` +
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
      resolve({
        socket,
        key,
        expectedAccept,
        head: acc.slice(0, idx + 4),
        leftover: Buffer.from(acc.slice(idx + 4), 'binary'),
      });
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
  rest: Buffer;
}

/** Read one server→client frame (unmasked text in practice), waiting for `data`. */
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
      const masked = (buffer[1] & 0x80) !== 0; // tolerate the mask bit
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
      return { opcode, payload, rest: buffer.subarray(offset + length) };
    };
    const pump = (): void => {
      const frame = extract();
      if (frame) settle(frame);
    };
    const onData = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk]);
      pump();
    };
    socket.on('data', onData);
    socket.once('error', fail);
    pump();
  });
}

/** Build an RFC6455 MASKED client→server TEXT frame (FIN=1, opcode=1). */
function buildMaskedTextFrame(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  const length = payload.length;
  const mask = randomBytes(4);
  let header: Buffer;
  if (length < 126) {
    header = Buffer.from([0x81, 0x80 | length]);
  } else if (length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 0xfe;
    header.writeUInt16BE(length, 2);
    header[1] |= 0x80;
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 0xff;
    header.writeBigUInt64BE(BigInt(length), 2);
    header[1] |= 0x80;
  }
  const maskedPayload = Buffer.allocUnsafe(length);
  for (let i = 0; i < length; i++) maskedPayload[i] = payload[i] ^ mask[i % 4];
  return Buffer.concat([header, mask, maskedPayload]);
}

// --- tests -------------------------------------------------------------------

test('performs the RFC6455 101 handshake with a correct Sec-WebSocket-Accept', async () => {
  const { port } = await start();
  const h = await connectAndHandshake(port);
  try {
    assert.match(h.head, /HTTP\/1\.1 101/);
    assert.match(h.head, /Upgrade:\s*websocket/i);
    assert.match(h.head, /Connection:\s*Upgrade/i);
    const acceptMatch = /Sec-WebSocket-Accept:\s*([^\r\n]+)\r?\n/i.exec(h.head);
    assert.ok(acceptMatch, 'expected a Sec-WebSocket-Accept header in the response head');
    // Computed independently from the key + GUID — pin the exact expected value.
    assert.equal(acceptMatch[1], createHash('sha1').update(h.key + WS_GUID).digest('base64'));
  } finally {
    h.socket.destroy();
  }
});

test('echoes a masked client TEXT frame back as { echo: <parsed> }', async () => {
  const { port } = await start();
  const h = await connectAndHandshake(port);
  try {
    h.socket.write(buildMaskedTextFrame('{"hello":"world"}'));
    const frame = await readTextFrame(h.socket, h.leftover);
    assert.equal(frame.opcode, 0x1, 'response should be a text frame (opcode 1)');
    const parsed = JSON.parse(frame.payload) as { echo: unknown };
    assert.deepEqual(parsed.echo, { hello: 'world' });
  } finally {
    h.socket.destroy();
  }
});

test('broadcasts a telemetry event from the bus to connected clients', async () => {
  const { port, bus } = await start();
  const h = await connectAndHandshake(port);
  try {
    assert.equal(ws?.size ?? -1, 1, 'the handshaked socket should count as an open client');
    await bus.emit({ type: 'policy.intervention', sessionKey: 's', ruleId: 'r', action: 'hideTool', at: Date.now() });
    const frame = await readTextFrame(h.socket, h.leftover);
    const parsed = JSON.parse(frame.payload) as { type?: string; ruleId?: string; sessionKey?: string };
    assert.equal(parsed.type, 'policy.intervention');
    assert.equal(parsed.ruleId, 'r');
    assert.equal(parsed.sessionKey, 's');
  } finally {
    h.socket.destroy();
  }
});

// Regression: server→client frames whose payload exceeds 125 bytes use the 16-bit
// extended-length header, which MUST keep the RFC6455 MASK bit clear (unmasked). A set
// mask bit makes the frame malformed and unparseable by a spec-conformant reader, so the
// broadcast never delivers and the client hangs. Pin the correct unmasking for that path.
test('broadcasts a large (>125 byte) telemetry event correctly unmasked', async () => {
  const { port, bus } = await start();
  const h = await connectAndHandshake(port);
  try {
    const blob = 'x'.repeat(120);
    await bus.emit({ type: 'tool.call', sessionKey: 's', toolName: 'search_web', args: { data: blob }, at: Date.now() });
    const frame = await readTextFrame(h.socket, h.leftover);
    assert.equal(frame.opcode, 0x1, 'a large broadcast must still be a text frame (opcode 1)');
    const parsed = JSON.parse(frame.payload) as { type?: string; args?: { data?: string } };
    assert.equal(parsed.type, 'tool.call');
    assert.equal(parsed.args?.data?.length, blob.length, 'the large payload round-trips intact through the 16-bit length path');
  } finally {
    h.socket.destroy();
  }
});
