/**
 * Full-stack end-to-end integration test over REAL network calls:
 *   client → proxy → policy engine → telemetry bus → WebSocket broadcast
 *   AND REST endpoints (/api/stats, /api/events, /api/rules, /api/tool-results/:id),
 *   all sharing ONE server instance with an inline zero-dep mock upstream on 127.0.0.1.
 *
 * Exercises (in order):
 *   1. GET /health
 *   2. OpenAI path: POST /v1/chat/completions (non-streaming, tool-call)
 *   3. Anthropic path: POST /v1/messages (SSE streaming, tool-call extraction)
 *   4. Policy: REST-created rule fires live; intervention in /api/events
 *   5. Tool-result: GET /api/tool-results/:id returns raw content
 *   6. WebSocket: live events received by a pre-connected client
 *   7. Dashboard REST: /api/stats + /api/events reflect the traffic
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import * as net from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import type { AtgServer } from '../src/server/index';
import { startAtgServer, closeAtgServer } from './helpers';
import { createRuleStore } from '../src/api/ruleStore';
import type { TelemetryEvent } from '../src/telemetry/events';
import type { PolicyRule } from '../src/policy/ruleEngine';

// --- type guards ---------------------------------------------------------------
const isToolCall = (e: TelemetryEvent): e is Extract<TelemetryEvent, { type: 'tool.call' }> => e.type === 'tool.call';
const isToolResult = (e: TelemetryEvent): e is Extract<TelemetryEvent, { type: 'tool.result' }> => e.type === 'tool.result';
const isIntervention = (e: TelemetryEvent): e is Extract<TelemetryEvent, { type: 'policy.intervention' }> => e.type === 'policy.intervention';

// --- canned fixtures -----------------------------------------------------------
const ANTHROPIC_TOOL_CALL_RESPONSE = {
  id: 'msg-e2e-fs',
  type: 'message',
  role: 'assistant',
  model: 'claude-3-opus',
  content: [
    { type: 'text', text: 'Let me search.' },
    { type: 'tool_use', id: 'toolu_search_1', name: 'search_web', input: { query: 'hello world' } },
  ],
  stop_reason: 'tool_use',
  usage: { input_tokens: 10, output_tokens: 20 },
};
const ANTHROPIC_FINAL_RESPONSE = {
  id: 'msg-e2e-fs-final',
  type: 'message',
  role: 'assistant',
  model: 'claude-3-opus',
  content: [{ type: 'text', text: 'All done.' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 5, output_tokens: 8 },
};
/** Anthropic SSE stream carrying one tool_use block + turn usage, then message_stop. */
function anthropicSse(): string {
  return (
    `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'msg-sse', type: 'message', role: 'assistant', model: 'claude-3-opus', usage: { input_tokens: 10, output_tokens: 0 } } })}\n\n` +
    `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_sse_1', name: 'search_web' } })}\n\n` +
    `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"query":"sse-test"}' } })}\n\n` +
    `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n` +
    `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 15 } })}\n\n` +
    `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`
  );
}

// --- mock upstream -------------------------------------------------------------
interface MockUpstream {
  server: http.Server;
  port: number;
  requests: unknown[];
  setSequence(seq: Array<() => { status: number; headers: Record<string, string>; body: string }>): void;
  close(): Promise<void>;
}

async function createMockUpstream(initial: unknown): Promise<MockUpstream> {
  const requests: unknown[] = [];
  let seq: Array<() => { status: number; headers: Record<string, string>; body: string }> = [
    () => ({ status: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(initial) }),
  ];
  let callIdx = 0;
  const server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (chunk: Buffer) => { data += chunk; });
    req.on('end', () => {
      if (data !== '') {
        try { requests.push(JSON.parse(data)); } catch { /* non-JSON */ }
      }
      const entry = seq[Math.min(callIdx++, seq.length - 1)]();
      res.writeHead(entry.status, entry.headers);
      res.end(entry.body);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  if (addr === null || typeof addr !== 'object') throw new Error('mock upstream did not bind a port');
  return {
    server,
    port: addr.port,
    requests,
    setSequence(s) { seq = s; callIdx = 0; },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}


// --- raw WebSocket client (RFC6455) -------------------------------------------
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
interface WsClient { socket: net.Socket; readTextFrame(): Promise<{ opcode: number; payload: string }>; }

function connectAndHandshake(port: number): Promise<WsClient> {
  return new Promise((resolve, reject) => {
    const key = randomBytes(16).toString('base64');
    const expectedAccept = createHash('sha1').update(key + WS_GUID).digest('base64');
    const request =
      `GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
      `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`;
    const socket = net.connect({ host: '127.0.0.1', port });
    let acc = '';
    let done = false;
    let buf = Buffer.alloc(0);
    let rejected = false;
    const waiters: Array<(f: { opcode: number; payload: string }) => void> = [];
    const fail = (e: Error): void => { if (!rejected) { rejected = true; reject(e); } };
    const extract = (): { opcode: number; payload: string } | null => {
      if (buf.length < 2) return null;
      const opcode = buf[0] & 0x0f;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) { if (buf.length < off + 2) return null; len = buf.readUInt16BE(off); off += 2; }
      else if (len === 127) { if (buf.length < off + 8) return null; len = Number(buf.readBigUInt64BE(off)); off += 8; }
      if ((buf[1] & 0x80) !== 0) off += 4;
      if (buf.length < off + len) return null;
      const frame = { opcode, payload: buf.subarray(off, off + len).toString('utf8') };
      buf = buf.subarray(off + len);
      return frame;
    };
    const pump = (): void => {
      while (waiters.length > 0) {
        const frame = extract();
        if (frame === null) break;
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
          fail(new Error('unexpected Sec-WebSocket-Accept'));
          return;
        }
        buf = Buffer.from(acc.slice(idx + 4), 'binary');
        resolve({ socket, readTextFrame: () => new Promise((res) => { waiters.push(res); pump(); }) });
        return;
      }
      buf = Buffer.concat([buf, chunk]);
      pump();
    };
    socket.on('data', onData);
    socket.once('error', fail);
    socket.on('connect', () => socket.write(request));
  });
}

// --- poll helper ---------------------------------------------------------------
async function poll<T>(fn: () => T | undefined, timeoutMs: number, intervalMs = 25): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = fn();
    if (result !== undefined) return result;
    if (Date.now() >= deadline) throw new Error(`poll timed out after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

// --- THE TEST ------------------------------------------------------------------
test('e2e full stack: health + OpenAI + Anthropic SSE + policy + tool-results + WS + stats', async () => {
  // Shared rule store: REST writes here, the proxy's policy engine reads from it live.
  const ruleStore = createRuleStore();
  const upstream = await createMockUpstream(ANTHROPIC_TOOL_CALL_RESPONSE);
  let srv: AtgServer | undefined;
  let wsClient: WsClient | undefined;
  const events: TelemetryEvent[] = [];

  try {
    // Start the real server: protocol 'anthropic' so both OpenAI (translated) and Anthropic paths work.
    const { port, srv: startedSrv, atg } = await startAtgServer(
      {
        upstream: { baseUrl: `http://127.0.0.1:${upstream.port}/v1`, model: 'claude-3-opus', protocol: 'anthropic' },
        // Dynamic rules getter: re-evaluated on every request so REST-created rules fire live.
        policy: { rules: (() => ruleStore.list()) as unknown as PolicyRule[], sessionIdHeader: 'x-session-id' },
      },
      { ruleStore, ws: true },
    );
    srv = startedSrv;
    const unsub = atg.bus.subscribe((ev) => { events.push(ev); });

    // Connect the WebSocket client BEFORE any traffic is generated.
    wsClient = await connectAndHandshake(port);

    // --- Scenario 1: GET /health ---
    const healthRes = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(healthRes.status, 200);
    assert.deepEqual(await healthRes.json(), { status: 'ok' });

    // --- Scenario 2: OpenAI path (non-streaming tool call) ---
    const openaiBody = {
      model: 'claude-3-opus',
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Look it up, please.' },
      ],
      tools: [{ type: 'function', function: { name: 'search_web', description: 'Search the web.', parameters: { type: 'object', properties: { query: { type: 'string' } } } } }],
    };
    const oaRes = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(openaiBody),
    });
    assert.equal(oaRes.status, 200, 'OpenAI proxy response must be HTTP 200');
    const oaJson = (await oaRes.json()) as { choices?: { message?: { tool_calls?: { function?: { name?: string } }[] } }[] };
    const toolCalls = oaJson.choices?.[0]?.message?.tool_calls ?? [];
    assert.ok(toolCalls.some((tc) => tc.function?.name === 'search_web'), 'the search_web tool call must be in the OpenAI response');

    // Telemetry: the tool.call event is visible on the shared bus.
    await poll(() => events.find(isToolCall), 2_000);
    const toolCallEvent = events.find(isToolCall)!;
    assert.equal(toolCallEvent.toolName, 'search_web');

    // --- Scenario 3: Anthropic path (SSE streaming) ---
    // Switch the mock upstream to return an Anthropic SSE stream for the next request.
    upstream.setSequence([() => ({ status: 200, headers: { 'Content-Type': 'text/event-stream' }, body: anthropicSse() })]);
    const sseRes = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'claude-3-opus', stream: true, messages: [{ role: 'user', content: 'Stream a search.' }] }),
    });
    assert.equal(sseRes.status, 200, 'Anthropic SSE response must be HTTP 200');
    assert.match(sseRes.headers.get('content-type') ?? '', /text\/event-stream/);
    const sseText = await sseRes.text();
    assert.ok(sseText.includes('tool_use') && sseText.includes('search_web'), 'raw SSE pass-through carries the tool_use block');

    // The SSE extractor emitted a tool.call for the streamed tool_use block.
    await poll(() => events.filter(isToolCall).find((e) => e.id === 'toolu_sse_1'), 2_000);
    const sseToolCall = events.filter(isToolCall).find((e) => e.id === 'toolu_sse_1')!;
    assert.equal(sseToolCall.toolName, 'search_web');

    // --- Scenario 4: Policy via REST → intervention fires live ---
    // Create a rule via the REST API (toolName matcher + injectMessage action).
    const ruleSpec = {
      enabled: true,
      description: 'Inject guidance when search_web is called.',
      matcher: { type: 'toolName', toolName: 'search_web' },
      action: { type: 'injectMessage', content: 'Please stop repeating searches.' },
    };
    const ruleRes = await fetch(`http://127.0.0.1:${port}/api/rules`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ruleSpec),
    });
    assert.equal(ruleRes.status, 201, 'POST /api/rules must return 201');

    // Send a matching request through the proxy (the mock returns a search_web tool call again).
    upstream.setSequence([() => ({ status: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ANTHROPIC_TOOL_CALL_RESPONSE) })]);
    const policyRes = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(openaiBody),
    });
    assert.equal(policyRes.status, 200);
    await policyRes.arrayBuffer(); // drain so all emission completes

    // The intervention event is present on the shared bus.
    await poll(() => events.find(isIntervention), 2_000);
    const intervention = events.find(isIntervention)!;
    assert.equal(intervention.action, 'injectMessage');

    // The intervention is visible in GET /api/events.
    const eventsRes = await fetch(`http://127.0.0.1:${port}/api/events`);
    assert.equal(eventsRes.status, 200);
    const eventsBody = (await eventsRes.json()) as { events: TelemetryEvent[] };
    assert.ok(eventsBody.events.some(isIntervention), 'GET /api/events must contain the intervention event');

    // --- Scenario 5: Tool-result value via REST ---
    // Send a follow-up same-session request carrying the tool result back.
    const SESS = 'sess-e2e-fs';
    const followUpMessages = [
      ...openaiBody.messages,
      { role: 'assistant', content: null, tool_calls: [{ id: 'toolu_search_1', type: 'function', function: { name: 'search_web', arguments: '{"query":"hello world"}' } }] },
      { role: 'tool', tool_call_id: 'toolu_search_1', name: 'search_web', content: '<web-search-results>found!</web-search-results>' },
    ];
    const resultContent = '<web-search-results>found!</web-search-results>';
    upstream.setSequence([() => ({ status: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ANTHROPIC_FINAL_RESPONSE) })]);
    const tuRes = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-session-id': SESS },
      body: JSON.stringify({ model: 'claude-3-opus', messages: followUpMessages }),
    });
    assert.equal(tuRes.status, 200);
    await tuRes.arrayBuffer();

    // A real tool.result was emitted (paired from the earlier tool.call).
    await poll(() => events.find(isToolResult), 2_000);
    const toolResult = events.find(isToolResult)!;
    assert.equal(toolResult.toolCallId, 'toolu_search_1');

    // The raw value is retrievable over GET /api/tool-results/:id.
    const trRes = await fetch(`http://127.0.0.1:${port}/api/tool-results/toolu_search_1`);
    assert.equal(trRes.status, 200, 'GET /api/tool-results/:id must return 200');
    const trBody = (await trRes.json()) as { content: string; chars: number };
    assert.equal(trBody.content, resultContent, 'the raw tool-result content round-trips');
    assert.equal(trBody.chars, resultContent.length);

    // --- Scenario 6: WebSocket received live events (ID-matched, from the REAL client) ---
    // Drain the broadcast frames captured on the pre-connected ws:// client and assert the
    // ID-matched tool events arrived over the real connection (not just the in-process bus):
    //   a tool.call whose `id` is the specific tool-call id, paired by a tool.result
    //   whose `toolCallId` is that SAME id. `toolu_search_1` is the stable id carried by the
    //   OpenAI-path call (scenarios 2/4) AND resolved into the result (scenario 5).
    const SPECIFIC_TOOL_CALL_ID = 'toolu_search_1';
    let wsFoundCall = false;
    let wsFoundResult = false;
    for (let i = 0; i < 40 && !(wsFoundCall && wsFoundResult); i += 1) {
      try {
        const frame: { opcode: number; payload: string } = await Promise.race([
          wsClient!.readTextFrame(),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error('WS frame timeout')), 500)),
        ]);
        assert.equal(frame.opcode, 0x1, 'WS frames must be text (opcode 0x1)');
        const parsed = JSON.parse(frame.payload) as TelemetryEvent;
        if (isToolCall(parsed) && parsed.id === SPECIFIC_TOOL_CALL_ID) wsFoundCall = true;
        if (isToolResult(parsed) && parsed.toolCallId === SPECIFIC_TOOL_CALL_ID) wsFoundResult = true;
      } catch {
        break; // no more frames available
      }
    }
    assert.ok(
      wsFoundCall,
      `the WS client received a live tool.call broadcast frame for tool call ${SPECIFIC_TOOL_CALL_ID}`,
    );
    assert.ok(
      wsFoundResult,
      `the WS client received a live tool.result broadcast frame for tool call ${SPECIFIC_TOOL_CALL_ID}`,
    );

    // --- Scenario 7: Dashboard REST reflects the traffic ---
    const statsRes = await fetch(`http://127.0.0.1:${port}/api/stats`);
    assert.equal(statsRes.status, 200);
    const stats = (await statsRes.json()) as { totalCalls: number; topTools: { toolName: string; count: number }[]; interventions: unknown[] };
    assert.ok(stats.totalCalls >= 1, `stats.totalCalls should be >= 1, got ${stats.totalCalls}`);
    assert.ok(stats.topTools.some((t) => t.toolName === 'search_web'), 'topTools must include search_web');
    assert.ok(stats.interventions.length >= 1, 'stats must reflect the recorded intervention');

    // --- Scenario 8: BATCHED multi-tool-call turn — one assistant message with THREE distinct tool calls ---
    // A single buffered response carrying three tool calls (distinct ids + names) emits three tool.call
    // events in the SAME session; feeding all three results back in that session pairs them into three
    // tool.result events (ids 1:1, finite non-negative durations) and surfaces all three in /api/stats.
    const BATCH_SESS = 'sess-batch';
    const batchIds = ['toolu_batch_1', 'toolu_batch_2', 'toolu_batch_3'];
    const batchNames = ['batch_alpha', 'batch_beta', 'batch_gamma'];
    // Anthropic-shaped assistant message carrying THREE tool_use blocks (distinct ids + names), matching
    // the proxy's configured protocol ('anthropic') and the existing fixtures — so all three are observed.
    const batchCallResponse = {
      id: 'msg-e2e-batch', type: 'message', role: 'assistant', model: 'claude-3-opus',
      content: [
        { type: 'text', text: 'Batching three tools.' },
        ...batchIds.map((id, i) => ({ type: 'tool_use', id, name: batchNames[i], input: { n: i } })),
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 12, output_tokens: 30 },
    };
    upstream.setSequence([() => ({ status: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(batchCallResponse) })]);
    const batchRes = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-session-id': BATCH_SESS },
      body: JSON.stringify({ model: 'claude-3-opus', messages: [{ role: 'user', content: 'Batch three tools.' }] }),
    });
    assert.equal(batchRes.status, 200);
    await batchRes.arrayBuffer();
    // Filter by the three distinct fixture ids (robust regardless of how the session-key string is derived):
    // exactly three tool.call events, one per tool call, carrying those exact ids.
    await poll(() => (events.filter((e) => isToolCall(e) && batchIds.includes(e.id ?? '')).length === 3 ? true : undefined), 2_000);
    const batchCalls = events.filter((e): e is Extract<TelemetryEvent, { type: 'tool.call' }> => isToolCall(e) && batchIds.includes(e.id ?? ''));
    assert.equal(batchCalls.length, 3, 'exactly three tool.call events for the three batch tool-call ids');
    assert.deepEqual([...new Set(batchCalls.map((e) => e.id))].sort(), [...batchIds].sort(), 'the three call ids are the distinct fixture ids');

    // Feed all three results back in the SAME session → exactly three paired tool.result events.
    upstream.setSequence([() => ({ status: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ANTHROPIC_FINAL_RESPONSE) })]);
    const batchResultRes = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-session-id': BATCH_SESS },
      body: JSON.stringify({
        model: 'claude-3-opus',
        messages: [
          { role: 'user', content: 'Batch three tools.' },
          ...batchIds.map((id, i) => ({ role: 'tool', tool_call_id: id, name: batchNames[i], content: `result-${i}` })),
        ],
      }),
    });
    assert.equal(batchResultRes.status, 200);
    await batchResultRes.arrayBuffer();
    await poll(() => (events.filter((e) => isToolResult(e) && batchIds.includes(e.toolCallId ?? '')).length === 3 ? true : undefined), 2_000);
    const batchResultEvents = events.filter((e): e is Extract<TelemetryEvent, { type: 'tool.result' }> => isToolResult(e) && batchIds.includes(e.toolCallId ?? ''));
    assert.equal(batchResultEvents.length, 3, 'exactly three tool.result events for the batch session');
    assert.deepEqual([...new Set(batchResultEvents.map((e) => e.toolCallId))].sort(), [...batchIds].sort(), 'result ids match the call ids 1:1');
    for (const r of batchResultEvents) {
      assert.ok(typeof r.durationMs === 'number' && Number.isFinite(r.durationMs) && r.durationMs >= 0, `batch durationMs must be finite and >= 0, got ${r.durationMs}`);
    }
    // GET /api/stats per-tool metrics reflect all three calls (each has a resolved result with a duration).
    const batchStats = (await (await fetch(`http://127.0.0.1:${port}/api/stats`)).json()) as { topTools: { toolName: string; count: number; avgDurationMs?: number; maxDurationMs?: number }[] };
    for (const name of batchNames) {
      const entry = batchStats.topTools.find((t) => t.toolName === name);
      assert.ok(entry !== undefined, `topTools must include ${name}`);
      assert.ok(entry!.count >= 1, `${name} call count must be >= 1`);
      assert.ok(typeof entry!.avgDurationMs === 'number' && Number.isFinite(entry!.avgDurationMs), `${name} must carry duration metrics from its resolved result`);
    }

    // --- Scenario 9: ORPHAN pending tool call — issued but never resolved → stays pending (not dropped, no NaN) ---
    // A single request whose response carries a tool-call id that no later request ever feeds back a result
    // for: the tool.call event exists, NO tool.result is emitted for that id, and /api/stats shows the tool
    // with a call count but WITHOUT any completed-result duration metric.
    const ORPHAN_SESS = 'sess-orphan';
    const ORPHAN_ID = 'toolu_orphan_1';
    const ORPHAN_TOOL = 'orphan_tool';
    // Anthropic-shaped assistant message with a single tool_use block whose id is NEVER fed back a result.
    upstream.setSequence([() => ({ status: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      id: 'msg-e2e-orphan', type: 'message', role: 'assistant', model: 'claude-3-opus',
      content: [{ type: 'text', text: 'Making an orphan call.' }, { type: 'tool_use', id: ORPHAN_ID, name: ORPHAN_TOOL, input: {} }],
      stop_reason: 'tool_use',
      usage: { input_tokens: 8, output_tokens: 6 },
    }) })]);
    const orphanRes = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-session-id': ORPHAN_SESS },
      body: JSON.stringify({ model: 'claude-3-opus', messages: [{ role: 'user', content: 'Make an orphan call.' }] }),
    });
    assert.equal(orphanRes.status, 200);
    await orphanRes.arrayBuffer();
    await poll(() => events.find((e) => isToolCall(e) && e.id === ORPHAN_ID), 2_000);
    assert.ok(events.some((e) => isToolCall(e) && e.id === ORPHAN_ID), 'the orphan tool.call event exists (not silently dropped)');
    assert.equal(events.find((e) => isToolResult(e) && e.toolCallId === ORPHAN_ID), undefined, 'NO tool.result for the orphan id (stays pending, never NaN)');
    const orphanStats = (await (await fetch(`http://127.0.0.1:${port}/api/stats`)).json()) as { topTools: { toolName: string; count: number; avgDurationMs?: number; maxDurationMs?: number; totalDurationMs?: number }[] };
    const orphanEntry = orphanStats.topTools.find((t) => t.toolName === ORPHAN_TOOL);
    assert.ok(orphanEntry !== undefined, 'topTools must include the orphan tool');
    assert.ok(orphanEntry!.count >= 1, 'the orphan tool call count must be >= 1');
    assert.equal(orphanEntry!.avgDurationMs, undefined, 'the orphan tool has no completed-result duration metric');
    assert.equal(orphanEntry!.maxDurationMs, undefined, 'the orphan tool has no max-duration metric');

    // --- Scenario 10: TWO-session isolation — A's queued feedback never leaks into B; A's follow-up gets A's own ---
    // Session keys are derived per x-session-id token (see context.ts::sessionKeyFromHeaders +
    // session.ts::deriveSessionKey): different header tokens → different session keys → isolated feedback.
    // The REST rule from Scenario 4 (injectMessage on search_web) queues feedback under whichever session
    // produced the matching response. Session A produces it; session B (a fresh key) must NOT receive it.
    const SESS_A = 'sess-two-a';
    const SESS_B = 'sess-two-b';
    const A_INJECTED = 'Please stop repeating searches.'; // exact content of the Scenario 4 injectMessage action
    const baseMessages = [{ role: 'system', content: 'You are a helpful assistant.' }];
    // Session A turn 1: response carries a search_web tool call → the rule queues injectMessage feedback under A.
    upstream.setSequence([() => ({ status: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ANTHROPIC_TOOL_CALL_RESPONSE) })]);
    const aRes = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-session-id': SESS_A },
      body: JSON.stringify({ model: 'claude-3-opus', messages: [...baseMessages, { role: 'user', content: 'Session A turn 1' }] }),
    });
    assert.equal(aRes.status, 200);
    await aRes.arrayBuffer();
    // A fresh request under session B (different token → different derived key; its response has no matching tool call).
    upstream.setSequence([() => ({ status: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ANTHROPIC_FINAL_RESPONSE) })]);
    const bRes = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-session-id': SESS_B },
      body: JSON.stringify({ model: 'claude-3-opus', messages: [...baseMessages, { role: 'user', content: 'Session B turn 1' }] }),
    });
    assert.equal(bRes.status, 200);
    await bRes.arrayBuffer();
    // Session A follow-up: its queued feedback is drained onto THIS request and forwarded to the upstream.
    upstream.setSequence([() => ({ status: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ANTHROPIC_FINAL_RESPONSE) })]);
    const aFollowUpRes = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-session-id': SESS_A },
      body: JSON.stringify({ model: 'claude-3-opus', messages: [...baseMessages, { role: 'user', content: 'Session A turn 2' }] }),
    });
    assert.equal(aFollowUpRes.status, 200);
    await aFollowUpRes.arrayBuffer();

    // Assert on what the mock upstream ACTUALLY received (the real forwarded wire bodies recorded by createMockUpstream).
    const forwardedBodyOf = (needle: string): string | undefined => {
      const req = upstream.requests.find((r) => JSON.stringify(r).includes(needle));
      return req === undefined ? undefined : JSON.stringify(req);
    };
    const bForwarded = forwardedBodyOf('Session B turn 1');
    assert.ok(bForwarded !== undefined, 'session B request was forwarded to the upstream');
    assert.ok(!bForwarded!.includes(A_INJECTED), 'B must NOT contain A injected/blocked content');
    assert.ok(!bForwarded!.includes('Session A turn 1'), 'B must NOT contain any of A own turns');
    const aFollowUpForwarded = forwardedBodyOf('Session A turn 2');
    assert.ok(aFollowUpForwarded !== undefined, 'session A follow-up was forwarded to the upstream');
    assert.ok(aFollowUpForwarded!.includes(A_INJECTED), 'A follow-up MUST receive A own queued feedback');

    unsub();
  } finally {
    try { wsClient?.socket.destroy(); } catch { /* ignore */ }
    if (srv) await closeAtgServer(srv);
    await upstream.close();
  }
});
