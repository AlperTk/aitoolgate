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
import { startAtgServer, closeAtgServer } from './helpers';
import { createRuleStore } from '../src/api/ruleStore';
import type { FetchLike, UpstreamClient } from '../src/proxy/upstream';
import type { TelemetryEvent } from '../src/telemetry/events';
import { createToolNameMatcher } from '../src/policy/matchers/index';
import { createInjectMessageAction } from '../src/policy/actions/index';
import type { PolicyAction, PolicyRule } from '../src/policy/ruleEngine';

// Type guards keep captured events fully typed without fragile casts.
const isToolCall = (e: TelemetryEvent): e is Extract<TelemetryEvent, { type: 'tool.call' }> => e.type === 'tool.call';
const isToolResult = (e: TelemetryEvent): e is Extract<TelemetryEvent, { type: 'tool.result' }> => e.type === 'tool.result';
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
async function post(port: number, body: Record<string, unknown>, extraHeaders?: Record<string, string>): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(extraHeaders ?? {}) };
  return fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body) });
}
/** Multi-turn non-streaming upstream: returns `bodies[i]` on the i-th call (last body repeats). */
function turnFetch(bodies: unknown[]): FetchLike {
  let i = 0;
  return async () => new Response(JSON.stringify(bodies[Math.min(i++, bodies.length - 1)]), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
/** Multi-turn SSE upstream: returns `texts[i]` (as an event-stream) on the i-th call (last text repeats). */
function sseTurnFetch(texts: string[]): FetchLike {
  const enc = new TextEncoder();
  let i = 0;
  return async () =>
    new Response(
      new ReadableStream({ start: (c) => { c.enqueue(enc.encode(texts[Math.min(i++, texts.length - 1)])); c.close(); } }),
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    );
}
/** OpenAI SSE stream carrying ONE tool call (id X) followed by a turn-level `usage` chunk, then `[DONE]`. */
function sseCallWithUsage(): string {
  const delta = (d: unknown): string => `data: ${JSON.stringify({ choices: [{ delta: d }] })}\n\n`;
  return (
    delta({ tool_calls: [{ index: 0, id: 'call_stream_metrics', function: { name: 'search_web' } }] }) +
    delta({ tool_calls: [{ index: 0, function: { arguments: '{"query":"stream"}' } }] }) +
    `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 } })}\n\n` +
    'data: [DONE]\n\n'
  );
}
/** OpenAI SSE stream carrying TWO tool calls in one turn (same turn-level `at`) + a `usage` chunk. */
function sseTwoCallsWithUsage(): string {
  const delta = (d: unknown): string => `data: ${JSON.stringify({ choices: [{ delta: d }] })}\n\n`;
  return (
    delta({ tool_calls: [{ index: 0, id: 'call_a', function: { name: 'search_web' } }] }) +
    delta({ tool_calls: [{ index: 0, function: { arguments: '{"query":"a"}' } }] }) +
    delta({ tool_calls: [{ index: 1, id: 'call_b', function: { name: 'search_web' } }] }) +
    delta({ tool_calls: [{ index: 1, function: { arguments: '{"query":"b"}' } }] }) +
    `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 } })}\n\n` +
    'data: [DONE]\n\n'
  );
}
/** OpenAI SSE stream carrying only a final text answer (no tool calls, no usage). */
function sseFinalAnswer(): string {
  const delta = (content: string): string => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
  return delta('all ') + delta('done') + 'data: [DONE]\n\n';
}
interface StatsSummary { totalCalls: number; totalResults: number; topTools: { toolName: string; count: number }[]; interventions: unknown[]; }
async function stats(port: number): Promise<StatsSummary> {
  const res = await fetch(`http://127.0.0.1:${port}/api/stats`);
  assert.equal(res.status, 200, 'GET /api/stats must be HTTP 200');
  return res.json() as Promise<StatsSummary>;
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
  const { port, srv, atg } = await startAtgServer(
    { upstream: upstream(jsonFetch(CANNED_COMPLETION)), policy: { rules: [rule] } },
    { ruleStore: createRuleStore(), ws: true },
  );
  const events: TelemetryEvent[] = [];
  const unsub = atg.bus.subscribe((ev) => {
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
    await closeAtgServer(srv);
  }
});

// --- Test 2: WebSocket broadcasts live telemetry ---------------------------
test('WebSocket receives live telemetry events broadcast from the shared bus', async () => {
  const { port, srv, atg } = await startAtgServer({ upstream: upstream(jsonFetch(CANNED_COMPLETION)) }, { ws: true });
  const client = await connectAndHandshake(port);
  try {
    assert.ok(atg.ws.size >= 1, 'the handshaked socket counts as an open WS client');
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
    await closeAtgServer(srv);
  }
});

// --- Test 3: streaming SSE pass-through emits tool-call telemetry --------
test('streaming request emits tool-call telemetry via the SSE extractor', async () => {
  const { port, srv, atg } = await startAtgServer({ upstream: upstream(sseFetch(sseText())) }, { ws: false });
  const events: TelemetryEvent[] = [];
  const unsub = atg.bus.subscribe((ev) => {
    events.push(ev);
  });
  try {
    const res = await post(port, { ...chatBody(), stream: true });
    assert.equal(res.status, 200, 'the streaming response must be HTTP 200');
    assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/, 'response content-type must be event-stream');
    const text = await res.text();
    assert.ok(text.includes('search_web') && text.includes('[DONE]'), 'raw SSE pass-through reaches the client unchanged');

    // The passthrough extractor emitted the streamed tool.call onto the shared bus.
    assert.ok(events.some((e) => isToolCall(e) && e.toolName === 'search_web'), 'SSE extractor emitted a tool.call event');
    // Gap B: a lone streaming request emits NO synthetic tool.result — the real result is paired
    // later (via the tracker) when the client resends with a matching role:'tool' message.
    assert.ok(!events.some(isToolResult), 'no synthetic tool.result is emitted by a lone streaming request');
    // The extracted call (carrying its SSE id) was recorded into the shared tracker for later pairing.
    assert.ok(atg.tracker.pendingCount() >= 1, 'the streamed tool call was recorded into the shared tracker');

    // Stats reflect the streaming call too.
    const s = await stats(port);
    assert.ok(s.totalCalls >= 1, `stats should reflect the streaming call, got ${s.totalCalls}`);
    assert.ok(s.topTools.some((t) => t.toolName === 'search_web'), 'topTools should include search_web');
  } finally {
    unsub();
    await closeAtgServer(srv);
  }
});

// --- Test 4: default-server /api/events reflects a proxied tool call -----
test('GET /api/events via the default server returns the tool.call emitted by a proxied request', async () => {
  // Default server options: only the upstream is pointed at a fake model that returns a single
  // tool_call; every other mount option (rule store, ws) stays at its default.
  const { port, srv } = await startAtgServer({ upstream: upstream(jsonFetch(CANNED_COMPLETION)) });
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
    await closeAtgServer(srv);
  }
});

// --- Test 5: tool-call metrics end-to-end (call → real result → collector) --
const CALL_BODY = {
  id: 'chatcmpl-e2e-metrics-n',
  object: 'chat.completion',
  created: 1700000000,
  model: 'gpt-4o-mini',
  choices: [
    { index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_e2e_metrics', type: 'function', function: { name: 'search_web', arguments: '{"query":"metrics"}' } }] }, finish_reason: 'tool_calls' },
  ],
  usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 },
};
const FINAL_BODY = {
  id: 'chatcmpl-e2e-metrics-n1',
  object: 'chat.completion',
  created: 1700000000,
  model: 'gpt-4o-mini',
  choices: [{ index: 0, message: { role: 'assistant', content: 'all done' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
};
const METRICS_SESSION = 'sess-e2e-metrics';
const TOOL_RESULT_CONTENT = '<web-search-results>';

test('two successive same-session requests produce a real tool.result paired from the tool.call', async () => {
  // One server → one shared bus/collector/tracker. Request N makes the model issue a tool call
  // (stable id + upstream usage); request N+1 (same session) feeds back the matching role:'tool'
  // result, which is paired against the recorded issue into a REAL tool.result.
  const { port, srv, atg } = await startAtgServer({ upstream: upstream(turnFetch([CALL_BODY, FINAL_BODY])) }, { ws: false });
  const events: TelemetryEvent[] = [];
  const unsub = atg.bus.subscribe((ev) => {
    events.push(ev);
  });
  try {
    const resN = await post(port, { ...chatBody(), stream: false }, { 'x-session-id': METRICS_SESSION });
    assert.equal(resN.status, 200, 'request N must be HTTP 200');
    await resN.arrayBuffer();

    const call = events.find(isToolCall);
    assert.ok(call, 'request N emitted a tool.call event');
    assert.equal(call.id, 'call_e2e_metrics', 'the tool.call carries the stable tool-call id');
    assert.ok(call.tokens !== undefined && (call.tokens.total ?? 0) > 0, 'the tool.call carries turn tokens from the upstream usage');

    // Advance the clock so the measured issue→result duration is strictly positive (deterministic).
    await new Promise((r) => setTimeout(r, 40));

    const bodyN1: Record<string, unknown> = {
      ...chatBody(),
      stream: false,
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Look it up, please.' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'call_e2e_metrics', type: 'function', function: { name: 'search_web', arguments: '{"query":"metrics"}' } }] },
        { role: 'tool', tool_call_id: 'call_e2e_metrics', content: TOOL_RESULT_CONTENT },
      ],
    };
    const resN1 = await post(port, bodyN1, { 'x-session-id': METRICS_SESSION });
    assert.equal(resN1.status, 200, 'request N+1 must be HTTP 200');
    await resN1.arrayBuffer();

    // A REAL tool.result was emitted (not synthetic), linked to the issued tool-call id.
    const result = events.find(isToolResult);
    assert.ok(result, 'request N+1 emitted a real tool.result event paired from the tool.call');
    assert.equal(result.toolCallId, 'call_e2e_metrics', 'the tool.result links to the issued tool-call id');
    assert.ok(typeof result.durationMs === 'number' && result.durationMs > 0, 'durationMs is measured and strictly positive');
    assert.ok(result.chars !== undefined && result.chars === TOOL_RESULT_CONTENT.length, 'chars reflects the result payload size');

    // The shared collector aggregates non-zero duration and token totals.
    const summary = atg.collector.summary();
    assert.ok(summary.totalDurationMs !== undefined && summary.totalDurationMs > 0, 'collector summary reports non-zero totalDurationMs');
    assert.ok(summary.totalTokens !== undefined && summary.totalTokens > 0, 'collector summary reports non-zero token totals');
    // Per-tool response-token fields reflect the resolved result's payload size (est = round(chars/4)).
    const topSW = summary.topTools.find((t) => t.toolName === 'search_web');
    assert.ok(topSW, 'topTools includes search_web');
    assert.equal(topSW.resolvedCount, 1, 'resolvedCount reflects one resolved result');
    assert.equal(topSW.totalResponseTokens, Math.round(TOOL_RESULT_CONTENT.length / 4), 'totalResponseTokens = round(chars/4) for the resolved result');
  } finally {
    unsub();
    await closeAtgServer(srv);
  }
});

// --- Test 6: STREAMING tool-call metrics end-to-end ------------------------
// A pure-streaming two-request same-session scenario that must behave like the non-stream
// case above (Test 5): request N is a streamed response whose SSE carries one tool call
// (id X) plus a turn-level `usage` chunk; request N+1 is ALSO streamed and carries the
// matching tool result, which the request-phase resolution pairs into a REAL tool.result.
const STREAM_METRICS_SESSION = 'sess-e2e-stream-metrics';
const STREAM_TOOL_RESULT = '<web-search-results-stream>';

test('two successive same-session STREAMING requests produce a real tool.result paired from the streamed tool.call', async () => {
  // Request N → SSE with one tool call + usage; request N+1 → SSE final answer (no calls).
  const { port, srv, atg } = await startAtgServer(
    { upstream: upstream(sseTurnFetch([sseCallWithUsage(), sseFinalAnswer()])) },
    { ws: false },
  );
  const events: TelemetryEvent[] = [];
  const unsub = atg.bus.subscribe((ev) => {
    events.push(ev);
  });
  try {
    const resN = await post(port, { ...chatBody(), stream: true }, { 'x-session-id': STREAM_METRICS_SESSION });
    assert.equal(resN.status, 200, 'streaming request N must be HTTP 200');
    assert.match(resN.headers.get('content-type') ?? '', /text\/event-stream/, 'request N must be streamed');
    await resN.text();

    // The streamed tool.call carries its stable id AND the turn tokens parsed from the stream.
    const call = events.find(isToolCall);
    assert.ok(call, 'request N emitted a streamed tool.call event');
    assert.equal(call.id, 'call_stream_metrics', 'the streamed tool.call carries the stable tool-call id');
    assert.ok(
      call.tokens !== undefined &&
        (call.tokens.input ?? 0) > 0 &&
        (call.tokens.output ?? 0) > 0 &&
        (call.tokens.total ?? 0) > 0,
      'the streamed tool.call carries turn tokens parsed from the stream usage chunk',
    );

    // Advance the clock so the measured issue→result duration is strictly positive (deterministic).
    await new Promise((r) => setTimeout(r, 40));

    // Request N+1 (also streamed) feeds back the matching role:'tool' result in the same session.
    const bodyN1: Record<string, unknown> = {
      ...chatBody(),
      stream: true,
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Look it up, please.' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'call_stream_metrics', type: 'function', function: { name: 'search_web', arguments: '{"query":"stream"}' } }] },
        { role: 'tool', tool_call_id: 'call_stream_metrics', name: 'search_web', content: STREAM_TOOL_RESULT },
      ],
    };
    const resN1 = await post(port, bodyN1, { 'x-session-id': STREAM_METRICS_SESSION });
    assert.equal(resN1.status, 200, 'streaming request N+1 must be HTTP 200');
    await resN1.text();

    // A REAL tool.result was emitted, linked to the issued id, with a measured duration + chars.
    const result = events.find(isToolResult);
    assert.ok(result, 'request N+1 emitted a real tool.result event paired from the streamed tool.call');
    assert.equal(result.toolCallId, 'call_stream_metrics', 'the tool.result links to the issued tool-call id');
    assert.ok(typeof result.durationMs === 'number' && result.durationMs > 0, 'durationMs is measured and strictly positive');
    assert.ok(result.chars !== undefined && result.chars === STREAM_TOOL_RESULT.length, 'chars reflects the result payload size');

    // The shared collector now exposes non-zero duration AND token totals for the streaming session.
    const summary = atg.collector.summary();
    assert.ok(summary.totalDurationMs !== undefined && summary.totalDurationMs > 0, 'collector reports non-zero totalDurationMs');
    assert.ok(summary.avgDurationMs !== undefined && summary.avgDurationMs > 0, 'collector reports non-zero avgDurationMs');
    assert.ok(summary.totalInputTokens !== undefined && summary.totalInputTokens > 0, 'collector reports non-zero totalInputTokens');
    assert.ok(summary.totalOutputTokens !== undefined && summary.totalOutputTokens > 0, 'collector reports non-zero totalOutputTokens');
    assert.ok(summary.totalTokens !== undefined && summary.totalTokens > 0, 'collector reports non-zero totalTokens');
    const top = summary.topTools.find((t) => t.toolName === 'search_web');
    assert.ok(top, 'topTools includes search_web');
    assert.ok(top.avgDurationMs !== undefined && top.avgDurationMs > 0, 'per-tool avgDurationMs > 0');
    assert.ok(top.maxDurationMs !== undefined && top.maxDurationMs > 0, 'per-tool maxDurationMs > 0');
    // Per-tool response-token fields reflect the streaming result's payload size (est = round(chars/4)).
    assert.equal(top.resolvedCount, 1, 'resolvedCount reflects one resolved streaming result');
    assert.equal(top.totalResponseTokens, Math.round(STREAM_TOOL_RESULT.length / 4), 'totalResponseTokens = round(chars/4) for the streaming result');
  } finally {
    unsub();
    await closeAtgServer(srv);
  }
});

// --- Test 7: multi-call streamed turn dedups tokens via a shared `at` ------
test('a streamed turn with multiple tool calls is counted as ONE token turn (no over-count)', async () => {
  // Two tool calls in ONE streamed response share one turn-level `at`; even though the usage chunk
  // arrives after the first call is finalized, the shared `at` makes the collector count the turn's
  // usage exactly once. Request N+1 feeds back BOTH results so both resolve into real tool.results.
  const { port, srv, atg } = await startAtgServer(
    { upstream: upstream(sseTurnFetch([sseTwoCallsWithUsage(), sseFinalAnswer()])) },
    { ws: false },
  );
  const events: TelemetryEvent[] = [];
  const unsub = atg.bus.subscribe((ev) => {
    events.push(ev);
  });
  try {
    const resN = await post(port, { ...chatBody(), stream: true }, { 'x-session-id': STREAM_METRICS_SESSION });
    assert.equal(resN.status, 200, 'streaming request N must be HTTP 200');
    await resN.text();

    // Both streamed calls are emitted and, crucially, share a single turn-level `at`.
    const calls = events.filter(isToolCall);
    assert.equal(calls.length, 2, 'the streamed turn emitted both tool.call events');
    assert.ok(
      new Set(calls.map((c) => c.at)).size === 1,
      'every tool.call in the streamed turn shares one turn-level `at` (for token dedup)',
    );

    await new Promise((r) => setTimeout(r, 40));

    // Request N+1 feeds back BOTH matching role:'tool' results in the same session (also streamed).
    const bodyN1: Record<string, unknown> = {
      ...chatBody(),
      stream: true,
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Look it up, please.' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'call_a', type: 'function', function: { name: 'search_web', arguments: '{"query":"a"}' } }] },
        { role: 'tool', tool_call_id: 'call_a', name: 'search_web', content: '<result-a>' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'call_b', type: 'function', function: { name: 'search_web', arguments: '{"query":"b"}' } }] },
        { role: 'tool', tool_call_id: 'call_b', name: 'search_web', content: '<result-b>' },
      ],
    };
    const resN1 = await post(port, bodyN1, { 'x-session-id': STREAM_METRICS_SESSION });
    assert.equal(resN1.status, 200, 'streaming request N+1 must be HTTP 200');
    await resN1.text();

    // Both pending issued calls resolve into REAL tool.results.
    assert.equal(events.filter(isToolResult).length, 2, 'both streamed tool calls resolved into real tool.results');
    assert.ok(events.every((e) => !isToolResult(e) || (typeof e.durationMs === 'number' && e.durationMs > 0)), 'every result carries a positive durationMs');

    // The turn's tokens are counted exactly once despite two tool.call events sharing one `at`.
    const summary = atg.collector.summary();
    assert.equal(summary.totalCalls, 2, 'collector observed both streamed tool calls');
    assert.equal(summary.totalTokens, 19, 'the multi-call turn contributes its token usage exactly once (no over-count)');
    assert.equal(summary.totalInputTokens, 12, 'input tokens counted once for the whole turn');
    assert.equal(summary.totalOutputTokens, 7, 'output tokens counted once for the whole turn');
    assert.ok(summary.totalDurationMs !== undefined && summary.totalDurationMs > 0, 'non-zero total duration across the two results');
    const top = summary.topTools.find((t) => t.toolName === 'search_web');
    assert.ok(top, 'topTools includes search_web');
    assert.equal(top.count, 2, 'search_web count reflects both streamed calls');
    assert.ok(top.avgDurationMs !== undefined && top.avgDurationMs > 0, 'per-tool avgDurationMs > 0');
    assert.ok(top.maxDurationMs !== undefined && top.maxDurationMs > 0, 'per-tool maxDurationMs > 0');
    // Per-tool response-token fields reflect both resolved results (each '<result-x>' = 10 chars → 3 est tokens).
    assert.equal(top.resolvedCount, 2, 'resolvedCount reflects two resolved results');
    assert.equal(top.totalResponseTokens, Math.round('<result-a>'.length / 4) + Math.round('<result-b>'.length / 4), 'totalResponseTokens = sum of estimated tokens for both results');
  } finally {
    unsub();
    await closeAtgServer(srv);
  }
});

// --- Test 8: turn with NO upstream usage -> token-less call, chars-carrying result -----
test('a turn whose response has no upstream usage emits a token-less tool.call but a chars-carrying tool.result', async () => {
  // Intentionally NO `usage` field on either response body.
  const NO_USAGE_CALL = {
    id: 'chatcmpl-no-usage', object: 'chat.completion', created: 1700000000, model: 'gpt-4o-mini',
    choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: 'no_usage_1', type: 'function', function: { name: 'search_web', arguments: '{"query":"x"}' } }] }, finish_reason: 'tool_calls' }],
  };
  const NO_USAGE_FINAL = {
    id: 'chatcmpl-no-usage-final', object: 'chat.completion', created: 1700000000, model: 'gpt-4o-mini',
    choices: [{ index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }],
  };
  const SESS = 'sess-no-usage';
  const RESULT_CONTENT = '<no-usage-results>';
  const { port, srv, atg } = await startAtgServer(
    { upstream: upstream(turnFetch([NO_USAGE_CALL, NO_USAGE_FINAL])) },
    { ws: false },
  );
  const events: TelemetryEvent[] = [];
  const unsub = atg.bus.subscribe((ev) => { events.push(ev); });
  try {
    const resN = await post(port, { ...chatBody(), stream: false }, { 'x-session-id': SESS });
    assert.equal(resN.status, 200, 'request N must be HTTP 200');
    await resN.arrayBuffer();

    // The tool.call carries its stable id but NO tokens (the upstream reported none).
    const call = events.find(isToolCall);
    assert.ok(call, 'request N emitted a tool.call event');
    assert.equal(call.id, 'no_usage_1', 'the tool.call carries its stable id even without usage');
    assert.ok(call.tokens === undefined, 'a turn with no upstream usage carries NO tokens on the tool.call');

    // Advance the clock so the measured issue->result duration is strictly positive (deterministic).
    await new Promise((r) => setTimeout(r, 40));

    const bodyN1: Record<string, unknown> = {
      ...chatBody(),
      stream: false,
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Look it up, please.' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'no_usage_1', type: 'function', function: { name: 'search_web', arguments: '{"query":"x"}' } }] },
        { role: 'tool', tool_call_id: 'no_usage_1', name: 'search_web', content: RESULT_CONTENT },
      ],
    };
    const resN1 = await post(port, bodyN1, { 'x-session-id': SESS });
    assert.equal(resN1.status, 200, 'request N+1 must be HTTP 200');
    await resN1.arrayBuffer();

    // The paired REAL tool.result still carries chars (payload size) despite the turn having no tokens.
    const result = events.find(isToolResult);
    assert.ok(result, 'request N+1 emitted a real tool.result event paired from the tool.call');
    assert.equal(result.toolCallId, 'no_usage_1', 'the tool.result links to the issued tool-call id');
    assert.ok(typeof result.durationMs === 'number' && result.durationMs > 0, 'durationMs is measured and strictly positive');
    assert.equal(result.chars, RESULT_CONTENT.length, 'chars reflects the result payload size even when the turn had no tokens');
  } finally {
    unsub();
    await closeAtgServer(srv);
  }
});

// --- Test 9: streamed OpenAI turn REQUESTS token usage + carries merged tokens ----------
test('a streamed OpenAI turn requests upstream token usage (stream_options.include_usage) and carries merged tokens', async () => {
  // A fetch that RECORDS the forwarded request body then delegates to the canned usage-carrying SSE.
  let forwarded: Record<string, unknown> | undefined;
  const baseFetch = sseFetch(sseCallWithUsage());
  const recordingFetch: FetchLike = async (url: string, init?: RequestInit): Promise<Response> => {
    try {
      forwarded = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    } catch {
      /* ignore non-JSON body */
    }
    return baseFetch(url, init);
  };
  const { port, srv, atg } = await startAtgServer({ upstream: upstream(recordingFetch) }, { ws: false });
  const events: TelemetryEvent[] = [];
  const unsub = atg.bus.subscribe((ev) => { events.push(ev); });
  try {
    const res = await post(port, { ...chatBody(), stream: true }, { 'x-session-id': 'sess-usage-req' });
    assert.equal(res.status, 200, 'the streaming request must be HTTP 200');
    await res.text();

    // The proxy REQUESTED token usage from the upstream via stream_options.include_usage.
    assert.ok(forwarded !== undefined, 'the streamed request was forwarded to the upstream');
    assert.equal(
      (forwarded!.stream_options as Record<string, unknown> | undefined)?.include_usage,
      true,
      'the streamed request sets stream_options.include_usage=true so the upstream reports per-turn usage',
    );

    // The extracted call carries the merged turn tokens read from the trailing usage chunk.
    const call = events.find(isToolCall);
    assert.ok(call, 'a streamed tool.call was emitted');
    assert.ok(
      call.tokens !== undefined && call.tokens.input === 12 && call.tokens.output === 7 && call.tokens.total === 19,
      'the streamed tool.call carries the merged turn tokens (normalized input/output/total) from the upstream usage chunk',
    );
  } finally {
    unsub();
    await closeAtgServer(srv);
  }
});

// --- Test 10: response-based token estimates for two distinct tools -----------
test('two distinct tools with different payload sizes yield correct per-tool response-token fields', async () => {
  // A non-streaming upstream returns a completion carrying TWO tool calls (different names);
  // the next same-session request feeds back both results so both resolve into real tool.results.
  const CALL_BODY_10 = {
    id: 'chatcmpl-two-tools', object: 'chat.completion', created: 1700000000, model: 'gpt-4o-mini',
    choices: [{
      index: 0, message: { role: 'assistant', content: null, tool_calls: [
        { id: 'tt_call_a', type: 'function', function: { name: 'search_web', arguments: '{"query":"x"}' } },
        { id: 'tt_call_b', type: 'function', function: { name: 'read_file', arguments: '{"path":"/a.txt"}' } },
      ]},
      finish_reason: 'tool_calls',
    }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
  const FINAL_BODY_10 = {
    id: 'chatcmpl-two-tools-final', object: 'chat.completion', created: 1700000000, model: 'gpt-4o-mini',
    choices: [{ index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
  };
  const SESS_10 = 'sess-two-tools';
  // Short result (7 chars → round(7/4)=2) for search_web; long result (21 chars → round(21/4)=5) for read_file.
  const SHORT_RESULT = '<short>';
  const LONG_RESULT = '<much-longer-payload>';
  const expectedShortTokens = Math.round(SHORT_RESULT.length / 4);   // 2
  const expectedLongTokens = Math.round(LONG_RESULT.length / 4);     // 5

  const { port, srv, atg } = await startAtgServer(
    { upstream: upstream(turnFetch([CALL_BODY_10, FINAL_BODY_10])) },
    { ws: false },
  );
  const events: TelemetryEvent[] = [];
  const unsub = atg.bus.subscribe((ev) => { events.push(ev); });
  try {
    const resN = await post(port, { ...chatBody(), stream: false }, { 'x-session-id': SESS_10 });
    assert.equal(resN.status, 200, 'request N must be HTTP 200');
    await resN.arrayBuffer();

    // Both tool calls were emitted (distinct names).
    const calls = events.filter(isToolCall);
    assert.equal(calls.length, 2, 'two distinct tool.call events were emitted');

    await new Promise((r) => setTimeout(r, 40));

    // Request N+1 feeds back both results in the same session.
    const bodyN1: Record<string, unknown> = {
      ...chatBody(),
      stream: false,
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Look it up.' },
        { role: 'assistant', content: null, tool_calls: [
          { id: 'tt_call_a', type: 'function', function: { name: 'search_web', arguments: '{"query":"x"}' } },
          { id: 'tt_call_b', type: 'function', function: { name: 'read_file', arguments: '{"path":"/a.txt"}' } },
        ]},
        { role: 'tool', tool_call_id: 'tt_call_a', name: 'search_web', content: SHORT_RESULT },
        { role: 'tool', tool_call_id: 'tt_call_b', name: 'read_file', content: LONG_RESULT },
      ],
    };
    const resN1 = await post(port, bodyN1, { 'x-session-id': SESS_10 });
    assert.equal(resN1.status, 200, 'request N+1 must be HTTP 200');
    await resN1.arrayBuffer();

    // Both tools resolved into real tool.results with their respective payload sizes.
    const results = events.filter(isToolResult);
    assert.equal(results.length, 2, 'both tool calls resolved into real tool.results');

    const summary = atg.collector.summary();
    const topSW = summary.topTools.find((t) => t.toolName === 'search_web');
    assert.ok(topSW, 'topTools includes search_web');
    assert.equal(topSW.resolvedCount, 1, 'search_web resolvedCount is 1');
    assert.equal(topSW.totalResponseTokens, expectedShortTokens, `search_web totalResponseTokens = ${expectedShortTokens} (short payload)`);

    const topRF = summary.topTools.find((t) => t.toolName === 'read_file');
    assert.ok(topRF, 'topTools includes read_file');
    assert.equal(topRF.resolvedCount, 1, 'read_file resolvedCount is 1');
    assert.equal(topRF.totalResponseTokens, expectedLongTokens, `read_file totalResponseTokens = ${expectedLongTokens} (long payload)`);

    // The call-turn totalTokens is still present in the global summary.
    assert.ok(summary.totalTokens !== undefined && summary.totalTokens > 0, 'totalTokens from call-turn is still present in the summary');
  } finally {
    unsub();
    await closeAtgServer(srv);
  }
});
