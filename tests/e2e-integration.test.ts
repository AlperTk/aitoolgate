/**
 * End-to-end integration test wiring the FULL chain on one server:
 *   client request -> proxy -> policy engine -> telemetry bus -> WebSocket broadcast
 *   AND the REST `/api/stats` endpoint, all sharing ONE telemetry bus + collector.
 * The upstream is mocked via `UpstreamClient.fetchImpl` (no second HTTP server); the
 * WebSocket client is a raw `node:net` socket doing the RFC6455 upgrade by hand (no
 * `ws` package), mirroring tests/server-integration.test.ts. Every server/socket is
 * torn down in `finally` so the event loop drains cleanly.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as net from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type McmServer } from '../src/server/index';
import { createRuleStore } from '../src/api/ruleStore';
import type { FetchLike, UpstreamClient } from '../src/proxy/upstream';
import type { TelemetryEvent } from '../src/telemetry/events';
import { createToolNameMatcher } from '../src/policy/matchers/index';
import { createInjectMessageAction } from '../src/policy/actions/index';
import type { PolicyAction, PolicyRule } from '../src/policy/ruleEngine';

type ServerOpts = Parameters<typeof createServer>[1];
type MountOpts = Parameters<typeof createServer>[2];

// Type guards keep captured events fully typed without fragile casts.
const isToolCall = (e: TelemetryEvent): e is Extract<TelemetryEvent, { type: 'tool.call' }> => e.type === 'tool.call';
const isIntervention = (e: TelemetryEvent): e is Extract<TelemetryEvent, { type: 'policy.intervention' }> => e.type === 'policy.intervention';

// --- canned fixtures -------------------------------------------------------------
const CANNED_COMPLETION = {
  id: 'chatcmpl-e2e-int',
  object: 'chat.completion',
  created: 1700000000,
  model: 'gpt-4o-mini',
  choices: [
    { index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'search_web', arguments: '{"query":"hello"}' } }] }, finish_reason: 'tool_calls' },
  ],
  usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
};
/** OpenAI SSE stream carrying one `search_web` tool call, then a `[DONE]` terminator. */
function sseText(): string {
  const chunk = (delta: unknown) => `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`;
  return (
    chunk({ tool_calls: [{ index: 0, id: 'call_1', function: { name: 'search_web' } }] }) +
    chunk({ tool_calls: [{ index: 0, function: { arguments: '{"query":"hello"}' } }] }) +
    'data: [DONE]\n\n'
  );
}
/** Non-streaming upstream: always returns a canned JSON OpenAI response. */
function jsonFetch(canned: unknown): FetchLike {
  return async () => new Response(JSON.stringify(canned), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
/** Streaming upstream: returns the given SSE text as a `text/event-stream` body. */
function sseFetch(text: string): FetchLike {
  const enc = new TextEncoder();
  return async () =>
    new Response(
      new ReadableStream({ start: (c) => { c.enqueue(enc.encode(text)); c.close(); } }),
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    );
}
function upstream(fetchImpl: FetchLike): UpstreamClient {
  return { baseUrl: 'http://127.0.0.1:9999/v1', model: 'gpt-4o-mini', protocol: 'openai', fetchImpl };
}
function chatBody(): Record<string, unknown> {
  return {
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Look it up, please.' },
    ],
    tools: [
      { type: 'function', function: { name: 'search_web', description: 'Search the web.', parameters: { type: 'object', properties: { query: { type: 'string' } } } } },
    ],
  };
}
async function post(port: number, body: Record<string, unknown>): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}
interface StatsSummary { totalCalls: number; totalResults: number; topTools: { toolName: string; count: number }[]; interventions: unknown[]; }
async function stats(port: number): Promise<StatsSummary> {
  const res = await fetch(`http://127.0.0.1:${port}/api/stats`);
  assert.equal(res.status, 200, 'GET /api/stats must be HTTP 200');
  return res.json() as Promise<StatsSummary>;
}

// --- server lifecycle -------------------------------------------------------------
async function startServer(opts: ServerOpts, mount?: MountOpts): Promise<{ port: number; srv: McmServer; mcm: NonNullable<McmServer['mcm']> }> {
  const srv = createServer(0, opts, mount); // auto-listens on an ephemeral port
  await new Promise<void>((resolve, reject) => {
    if (srv.listening) resolve();
    else {
      srv.once('listening', () => resolve());
      srv.once('error', reject);
    }
  });
  const addr = srv.address();
  if (addr === null || typeof addr !== 'object') throw new Error('server did not bind a TCP port');
  const mcm = srv.mcm;
  if (mcm === undefined) throw new Error('server.mcm test handle is missing');
  return { port: addr.port, srv, mcm };
}
async function closeServer(srv: McmServer): Promise<void> {
  try {
    srv.closeAllConnections();
  } catch {
    /* ignore */
  }
  await new Promise<void>((resolve) => {
    srv.close(() => resolve());
  });
}

// --- raw RFC6455 WebSocket client ----------------------------------------------
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
/** A handshaked WS client: read server->client text frames off one shared buffer. */
interface WsClient { socket: net.Socket; readTextFrame(): Promise<{ opcode: number; payload: string }>; }

/**
 * Open a raw socket, complete the `/ws` upgrade (validating the accept header), and return a
 * client whose readTextFrame() yields each broadcast frame. ONE persistent `data` listener
 * keeps the stream flowing so frames written during the request are not lost to a paused
 * socket, and frames are handed only to waiting readers (never dropped).
 */
function connectAndHandshake(port: number): Promise<WsClient> {
  return new Promise((resolve, reject) => {
    const key = randomBytes(16).toString('base64');
    const expectedAccept = createHash('sha1').update(key + WS_GUID).digest('base64');
    const request =
      `GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
      `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`;
    const socket = net.connect({ host: '127.0.0.1', port });
    let acc = ''; // pre-handshake bytes (the 101 response headers)
    let done = false; // handshake finished
    let buf = Buffer.alloc(0); // post-handshake byte buffer
    let rejected = false;
    const waiters: Array<(f: { opcode: number; payload: string }) => void> = [];
    const fail = (e: Error): void => {
      if (!rejected) {
        rejected = true;
        reject(e);
      }
    };
    /** Pop one complete frame off the buffer (advancing it), or null when incomplete. */
    const extract = (): { opcode: number; payload: string } | null => {
      if (buf.length < 2) return null;
      const opcode = buf[0] & 0x0f;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < off + 2) return null;
        len = buf.readUInt16BE(off);
        off += 2;
      } else if (len === 127) {
        if (buf.length < off + 8) return null;
        len = Number(buf.readBigUInt64BE(off));
        off += 8;
      }
      if ((buf[1] & 0x80) !== 0) off += 4; // never set on server frames, but stay general
      if (buf.length < off + len) return null;
      const frame = { opcode, payload: buf.subarray(off, off + len).toString('utf8') };
      buf = buf.subarray(off + len);
      return frame;
    };
    const pump = (): void => {
      while (waiters.length > 0) {
        const frame = extract();
        if (frame === null) break; // incomplete; wait for more bytes before delivering
        const waiter = waiters.shift();
        if (waiter === undefined) break;
        waiter(frame);
      }
    };
    const onData = (chunk: Buffer): void => {
      if (!done) {
        acc += chunk.toString('binary');
        const idx = acc.indexOf('\r\n\r\n');
        if (idx === -1) return;
        done = true;
        if (!acc.slice(0, idx).includes(`Sec-WebSocket-Accept: ${expectedAccept}`)) {
          socket.destroy();
          fail(new Error('unexpected Sec-WebSocket-Accept in the upgrade response'));
          return;
        }
        buf = Buffer.from(acc.slice(idx + 4), 'binary');
        resolve({
          socket,
          readTextFrame: () => new Promise((res) => {
            waiters.push(res);
            pump();
          }),
        });
        return;
      }
      buf = Buffer.concat([buf, chunk]);
      pump();
    };
    socket.on('data', onData); // single, never-removed listener keeps the stream flowing
    socket.once('error', fail);
    socket.on('connect', () => socket.write(request));
  });
}

// --- Test 1: request -> proxy -> policy -> telemetry -> stats --------------
test('full pipeline: request → proxy → policy → telemetry → stats', async () => {
  // Non-destructive intervention action: search_web stays in the response while the rule
  // still fires an intervention (a block would drop the tool call itself).
  const RULE_ID = 'e2e-inject-search-web';
  const rule: PolicyRule = {
    id: RULE_ID,
    enabled: true,
    description: 'Inject guidance when search_web is called.',
    matcher: createToolNameMatcher({ toolName: 'search_web' }),
    action: createInjectMessageAction({ role: 'user', content: 'Please stop repeating searches.' }) as PolicyAction,
  };
  const { port, srv, mcm } = await startServer(
    { upstream: upstream(jsonFetch(CANNED_COMPLETION)), policy: { rules: [rule] } },
    { ruleStore: createRuleStore(), ws: true },
  );
  const events: TelemetryEvent[] = [];
  const unsub = mcm.bus.subscribe((ev) => {
    events.push(ev);
  });
  try {
    const res = await post(port, { ...chatBody(), stream: false });
    assert.equal(res.status, 200, 'the proxied response must be HTTP 200');
    const body = (await res.json()) as { choices?: { message?: { tool_calls?: { function?: { name?: string } }[] } }[] };
    assert.ok((body.choices?.[0]?.message?.tool_calls ?? []).some((tc) => tc.function?.name === 'search_web'),
      'the search_web tool call remains in the returned response');

    // Telemetry captured on the SAME bus the proxy emitted onto.
    const toolCall = events.find(isToolCall);
    assert.ok(toolCall, 'the shared bus received a tool.call event');
    assert.equal(toolCall.toolName, 'search_web');
    assert.deepStrictEqual(toolCall.args, { query: 'hello' });

    // The policy engine recorded an intervention on that same shared bus.
    const intervention = events.find(isIntervention);
    assert.ok(intervention, 'the policy intervention was recorded on the shared bus');
    assert.equal(intervention.action, 'injectMessage');
    assert.equal(intervention.ruleId, RULE_ID);

    // The REST stats endpoint reads the SAME shared collector.
    const s = await stats(port);
    assert.ok(s.totalCalls >= 1, `stats.totalCalls should be >= 1, got ${s.totalCalls}`);
    assert.ok(s.topTools.some((t) => t.toolName === 'search_web'), 'topTools should include search_web');
    assert.ok(s.interventions.length >= 1, 'stats should reflect the recorded intervention');
  } finally {
    unsub();
    await closeServer(srv);
  }
});

// --- Test 2: WebSocket broadcasts live telemetry ---------------------------
test('WebSocket receives live telemetry events broadcast from the shared bus', async () => {
  const { port, srv, mcm } = await startServer({ upstream: upstream(jsonFetch(CANNED_COMPLETION)) }, { ws: true });
  const client = await connectAndHandshake(port);
  try {
    assert.ok(mcm.ws.size >= 1, 'the handshaked socket counts as an open WS client');
    // Non-streaming request -> proxy emits tool.call + tool.result onto the shared bus.
    const res = await post(port, chatBody());
    assert.equal(res.status, 200);
    await res.arrayBuffer(); // drain the body so all emission has completed

    // Read broadcast frames until we observe the tool.call event (it precedes the result).
    let found: Extract<TelemetryEvent, { type: 'tool.call' }> | undefined;
    for (let i = 0; i < 8 && !found; i += 1) {
      const frame = await client.readTextFrame();
      assert.equal(frame.opcode, 0x1, 'WS frames must be text frames (opcode 0x1)');
      const parsed = JSON.parse(frame.payload) as TelemetryEvent;
      if (isToolCall(parsed)) found = parsed;
    }
    assert.ok(found, 'the WS client received a tool.call broadcast frame');
    assert.equal(found.toolName, 'search_web');
  } finally {
    try {
      client.socket.destroy();
    } catch {
      /* ignore */
    }
    await closeServer(srv);
  }
});

// --- Test 3: streaming SSE pass-through emits tool-call telemetry --------
test('streaming request emits tool-call telemetry via the SSE extractor', async () => {
  const { port, srv, mcm } = await startServer({ upstream: upstream(sseFetch(sseText())) }, { ws: false });
  const events: TelemetryEvent[] = [];
  const unsub = mcm.bus.subscribe((ev) => {
    events.push(ev);
  });
  try {
    const res = await post(port, { ...chatBody(), stream: true });
    assert.equal(res.status, 200, 'the streaming response must be HTTP 200');
    assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/, 'response content-type must be event-stream');
    const text = await res.text();
    assert.ok(text.includes('search_web') && text.includes('[DONE]'), 'raw SSE pass-through reaches the client unchanged');

    // The passthrough extractor emitted both tool.call and tool.result on the bus.
    assert.ok(events.some((e) => isToolCall(e) && e.toolName === 'search_web'), 'SSE extractor emitted a tool.call event');
    assert.ok(events.some((e) => e.type === 'tool.result'), 'SSE extractor emitted a tool.result event');

    // Stats reflect the streaming call too.
    const s = await stats(port);
    assert.ok(s.totalCalls >= 1, `stats should reflect the streaming call, got ${s.totalCalls}`);
    assert.ok(s.topTools.some((t) => t.toolName === 'search_web'), 'topTools should include search_web');
  } finally {
    unsub();
    await closeServer(srv);
  }
});

// --- Test 4: default-server /api/events reflects a proxied tool call -----
test('GET /api/events via the default server returns the tool.call emitted by a proxied request', async () => {
  // Default server options: only the upstream is pointed at a fake model that returns a single
  // tool_call; every other mount option (rule store, ws) stays at its default.
  const { port, srv } = await startServer({ upstream: upstream(jsonFetch(CANNED_COMPLETION)) });
  try {
    const res = await post(port, { ...chatBody(), stream: false });
    assert.equal(res.status, 200, 'the proxied response must be HTTP 200');
    await res.arrayBuffer(); // drain the body so all bus emission has completed

    const eventsRes = await fetch(`http://127.0.0.1:${port}/api/events`);
    assert.equal(eventsRes.status, 200, 'GET /api/events must be HTTP 200');
    const body = (await eventsRes.json()) as { events: TelemetryEvent[] };
    assert.ok(Array.isArray(body.events), 'the response must carry an events array');
    const toolCall = body.events.find(isToolCall);
    assert.ok(toolCall !== undefined, 'GET /api/events must include the tool.call emitted by the proxied request');
    assert.equal(toolCall.toolName, 'search_web');
  } finally {
    await closeServer(srv);
  }
});
