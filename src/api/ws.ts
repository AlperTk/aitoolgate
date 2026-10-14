/** Dependency-free RFC6455 WebSocket SERVER built on Node built-ins (`node:http`, `node:crypto`): attaches an `'upgrade'` listener, does the `101` handshake, then speaks raw framing directly on the taken-over socket (unmasked server→client TEXT echo/telemetry frames + incremental masked/extended-length/fragmented client→server decoding; minimal close/ping control frames; no `ws` package). */
import type * as http from 'node:http';
import type { Duplex } from 'node:stream';
import { createHash } from 'node:crypto';
import type { TelemetryEventBus } from '../telemetry/event-bus';
import type { TelemetryEvent } from '../telemetry/events';

/** The RFC6455 magic GUID used to compute `Sec-WebSocket-Accept`. */
const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export interface WsOptions {
  /** Optional telemetry bus whose emitted events are broadcast to all open clients. */
  bus?: TelemetryEventBus;
}

export interface WsServer {
  /** Unsubscribe from the bus, close every open client, remove the upgrade listener. */
  close(): void;
  readonly size: number;
}

export function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const length = payload.length;
  let header: Buffer;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x7e; // 16-bit length marker; MASK bit stays clear (server→client frames are unmasked)
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 0x7f; // 64-bit length marker; MASK bit stays clear (server→client frames are unmasked)
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

export function encodeTextFrame(str: string): Buffer {
  return encodeFrame(0x1, Buffer.from(str, 'utf8'));
}

/** A fully-decoded incoming frame plus the number of wire bytes it consumed. */
interface IncomingFrame {
  fin: boolean;
  opcode: number;
  payload: Buffer;
  total: number;
}

/** Try to parse one complete frame at the start of `buf`, returning it plus bytes consumed; `null` when more `data` is still needed; tolerates masked/unmasked frames and 7/16/64-bit extended-length encodings. */
function parseFrame(buf: Buffer): IncomingFrame | null {
  if (buf.length < 2) return null;
  const first = buf[0];
  const fin = (first & 0x80) !== 0;
  const opcode = first & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let length = buf[1] & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buf.length < offset + 2) return null;
    length = buf.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    if (buf.length < offset + 8) return null;
    length = Number(buf.readBigUInt64BE(offset));
    offset += 8;
  }
  if (masked) {
    if (buf.length < offset + 4) return null;
    offset += 4; // the 4-byte masking key sits immediately before the payload
  }
  if (buf.length < offset + length) return null;
  const raw = buf.subarray(offset, offset + length);
  let payload: Buffer;
  if (masked) {
    const key = buf.subarray(offset - 4, offset);
    payload = Buffer.allocUnsafe(length);
    for (let i = 0; i < length; i++) payload[i] = raw[i] ^ key[i % 4];
  } else {
    payload = Buffer.from(raw);
  }
  return { fin, opcode, payload, total: offset + length };
}

/** Attach an RFC6455 WebSocket server to an existing `http.Server`: one `'upgrade'` listener drops non-WebSocket upgrades and takes over valid ones; the returned `WsServer` tracks open clients (`size`), broadcasts `options.bus` events as JSON text frames, and tears everything down via `close()`. */
export function createWsServer(server: http.Server, options?: WsOptions): WsServer {
  const clients = new Set<Duplex>();
  let busUnsubscribe: (() => void) | undefined;
  let closed = false;

  function takeOver(socket: Duplex, head: Buffer): void {
    if (closed || !socket.writable) {
      if (!closed) socket.destroy();
      return;
    }
    clients.add(socket);
    let buffer = head && head.length > 0 ? Buffer.from(head) : Buffer.alloc(0);
    let messageOpcode: number | null = null;
    let messagePayload = '';
    let cleanedUp = false;

    const write = (frame: Buffer): void => {
      if (!cleanedUp && !socket.destroyed) socket.write(frame);
    };

    const finish = (ackClose: boolean): void => {
      if (cleanedUp) return;
      cleanedUp = true;
      clients.delete(socket);
      try {
        if (ackClose) write(encodeFrame(8, Buffer.alloc(0))); // close ack (opcode 8)
        socket.end();
        socket.destroy();
      } catch {
        // ignore teardown errors
      }
    };

    /** Echo a received client TEXT frame back as `{ "echo": <parsedJson | rawString> }`. */
    const emitEcho = (raw: string): void => {
      let value: unknown;
      try {
        value = JSON.parse(raw);
      } catch {
        value = raw; // not parseable JSON — echo the raw string verbatim
      }
      write(encodeTextFrame(JSON.stringify({ echo: value })));
    };

    const handleFrame = (frame: IncomingFrame): void => {
      // Control frames (opcode >= 8) are never fragmented; handle immediately.
      if (frame.opcode >= 8) {
        switch (frame.opcode) {
          case 8: // close → acknowledge then tear this client down
            finish(true);
            break;
          case 9: // ping → reply pong carrying the same payload
            write(encodeFrame(0xa, frame.payload));
            break;
          case 10: // pong
          default:
            break;
        }
        return;
      }
      // Data frames (text 0x1 / binary 0x2 / continuation 0x0).
      const chunk = frame.payload.toString('utf8');
      if (frame.opcode === 1 || frame.opcode === 2) {
        messageOpcode = frame.opcode;
        messagePayload = chunk;
        if (frame.fin) {
          emitEcho(messagePayload);
          messageOpcode = null;
        }
      } else if (frame.opcode === 0) {
        if (messageOpcode !== null) messagePayload += chunk;
        if (frame.fin) {
          emitEcho(messagePayload);
          messageOpcode = null;
          messagePayload = '';
        }
      }
    };

    const onData = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const frame = parseFrame(buffer);
        if (frame === null) break; // wait for more data
        buffer = buffer.subarray(frame.total);
        handleFrame(frame);
        if (cleanedUp) break;
      }
    };

    socket.on('data', onData);
    socket.on('error', () => finish(false));
    socket.on('end', () => finish(false));
    socket.on('close', () => finish(false));

    if (head && head.length > 0) onData(head);
  }

  const onUpgrade = (req: http.IncomingMessage, socket: Duplex, head: Buffer): void => {
    if (closed) {
      socket.destroy();
      return;
    }
    const key = req.headers['sec-websocket-key'];
    const upgrade = req.headers.upgrade;
    const isWsUpgrade =
      typeof key === 'string' &&
      key.length > 0 &&
      typeof upgrade === 'string' &&
      upgrade.toLowerCase() === 'websocket';
    if (!isWsUpgrade) {
      socket.destroy(); // not a WebSocket upgrade — drop the connection
      return;
    }

    const accept = createHash('sha1').update(key + WEBSOCKET_GUID).digest('base64');
    const handshake =
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n` +
      '\r\n';
    try {
      socket.write(handshake);
    } catch {
      socket.destroy();
      return;
    }
    takeOver(socket, head);
  };

  server.on('upgrade', onUpgrade);

  if (options?.bus) {
    busUnsubscribe = options.bus.subscribe((event: TelemetryEvent) => {
      if (closed || clients.size === 0) return;
      const message = encodeTextFrame(JSON.stringify(event));
      for (const client of clients) {
        if (!client.destroyed) client.write(message);
      }
    });
  }

  return {
    close(): void {
      if (closed) return;
      closed = true;
      server.removeListener('upgrade', onUpgrade);
      if (busUnsubscribe) {
        busUnsubscribe();
        busUnsubscribe = undefined;
      }
      for (const client of [...clients]) {
        try {
          client.destroy();
        } catch {
          // ignore teardown errors
        }
      }
      clients.clear();
    },
    get size(): number {
      return clients.size;
    },
  };
}
