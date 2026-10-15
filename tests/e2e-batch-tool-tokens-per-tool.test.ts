/**
 * End-to-end: per-tool token accounting for a batch (multi-tool-call) response.
 *
 * One response issues THREE tool calls (fetchBig / fetchMid / fetchSmall) whose tool
 * outputs have clearly different sizes (1600 / 400 / 48 chars). The client then resends
 * the three tool results; the proxy pairs each issued call with its result
 * (`resolveAndEmitToolResults`) and the collector attributes per-tool response-payload
 * tokens (round(chars/4)) that are TOOL-SPECIFIC — not duplicated/shared across tools —
 * on BOTH the buffered-JSON and SSE streaming paths. The turn-level token mass is
 * counted exactly ONCE (deduped per turn), not 3× duplicated per-call.
 *
 *   P-A  buffered-JSON path: request 1 is a canned batched JSON response; request 2
 *        resends the three tool results.
 *   P-B  SSE streaming path: request 1 is a canned SSE stream (multi tool-call deltas
 *        + a trailing usage frame); request 2 resends the three tool results.
 *
 * Assertion groups (per path, see {@link assertPerToolTokenAccounting}):
 *   (a) each tool.result reports its OWN chars + estimated tokens ≈ round(chars/4),
 *       distinct per tool;
 *   (b) GET /api/stats per-tool totalResponseTokens distinct + matches the estimate,
 *       resolvedCount = 1 each;
 *   (c) the turn's token mass is counted ONCE (global totals reconcile with the
 *       reported usage, not the sum of duplicated per-call tokens);
 *   (d) batched turns omit per-call tokens (every tool.call has no `tokens`; the
 *       whole-turn turn.usage carries the turn's mass once);
 *   (e) each tool.call carries a distinct per-call callTokens estimate (name + serialized
 *       arguments); the per-tool stats totalCallTokens sums it (one call per tool).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startAtgServer, closeAtgServer } from './helpers';
import type { FetchLike, UpstreamClient } from '../src/proxy/upstream';
import type { TelemetryEvent } from '../src/telemetry/events';
import type { CollectorSummary, TopTool } from '../src/telemetry/collector';
import { estimateCallTokens } from '../src/telemetry/tokenEstimate';

const isToolCall = (e: TelemetryEvent): e is Extract<TelemetryEvent, { type: 'tool.call' }> => e.type === 'tool.call';
const isToolResult = (e: TelemetryEvent): e is Extract<TelemetryEvent, { type: 'tool.result' }> => e.type === 'tool.result';
const isTurnUsage = (e: TelemetryEvent): e is Extract<TelemetryEvent, { type: 'turn.usage' }> => e.type === 'turn.usage';

// --- upstream helpers --------------------------------------------------------
function upstream(fetchImpl: FetchLike): UpstreamClient {
  return { baseUrl: 'http://127.0.0.1:9999/v1', model: 'gpt-4o-mini', protocol: 'openai', fetchImpl };
}
/** A non-streaming JSON upstream Response. */
function jsonRes(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
/** A canned SSE upstream Response (the client-facing content-type is set by the proxy pipe). */
function sseRes(text: string): Response {
  const enc = new TextEncoder();
  return new Response(
    new ReadableStream({ start: (c) => { c.enqueue(enc.encode(text)); c.close(); } }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
  );
}
/** An upstream whose N-th fetch returns the N-th prebuilt Response (last repeats when exhausted). */
function seqFetch(responses: Response[]): FetchLike {
  let i = 0;
  return async () => responses[Math.min(i++, responses.length - 1)];
}
const delta = (d: unknown): string => `data: ${JSON.stringify({ choices: [{ delta: d }] })}\n\n`;

// --- batch fixtures: three tools with clearly different output sizes --------
const BIG_CHARS = 1600; // round(1600/4) = 400 estimated tokens
const MID_CHARS = 400; //  round(400/4)  = 100
const SMALL_CHARS = 48; //  round(48/4)   = 12
const EXPECTED = [
  { name: 'fetchBig', chars: BIG_CHARS },
  { name: 'fetchMid', chars: MID_CHARS },
  { name: 'fetchSmall', chars: SMALL_CHARS },
];
const estTokens = (chars: number): number => Math.round(chars / 4);
// Per-tool argument payloads of clearly different sizes so the per-call CALL-TOKENS estimate
// (name + serialized arguments) is distinct per tool; request 1 issues them, request 2 resends.
const ARG_PAYLOAD: Record<string, string> = {
  fetchBig: JSON.stringify({ k: 'A'.repeat(400) }),
  fetchMid: JSON.stringify({ k: 'M'.repeat(100) }),
  fetchSmall: '{}',
};
const argForName = (name: string): string => ARG_PAYLOAD[name] ?? '{}';
// The batch turn's upstream-reported usage (prompt/completion/total), shared by every tool.call.
const TURN_INPUT = 10;
const TURN_OUTPUT = 20;
const TURN_TOTAL = 30;

function asstCall(id: string, name: string): Record<string, unknown> {
  return { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: argForName(name) } }] };
}
function toolRes(id: string, name: string, content: string): Record<string, unknown> {
  return { role: 'tool', tool_call_id: id, name, content };
}
function toolDefs(): unknown[] {
  return [
    { type: 'function', function: { name: 'fetchBig', description: 'Fetch the big payload.', parameters: { type: 'object', properties: {} } } },
    { type: 'function', function: { name: 'fetchMid', description: 'Fetch the medium payload.', parameters: { type: 'object', properties: {} } } },
    { type: 'function', function: { name: 'fetchSmall', description: 'Fetch the small payload.', parameters: { type: 'object', properties: {} } } },
  ];
}
function request1Body(): Record<string, unknown> {
  return {
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: 'Fetch the data, please.' }],
    tools: toolDefs(),
  };
}

/** Request 1 (buffered): a batched JSON response issuing the three tool calls. */
function batchJsonCanned(): unknown {
  return {
    id: 'chatcmpl-batch-per-tool',
    object: 'chat.completion',
    created: 1700000000,
    model: 'gpt-4o-mini',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'call_big', type: 'function', function: { name: 'fetchBig', arguments: argForName('fetchBig') } },
            { id: 'call_mid', type: 'function', function: { name: 'fetchMid', arguments: argForName('fetchMid') } },
            { id: 'call_small', type: 'function', function: { name: 'fetchSmall', arguments: argForName('fetchSmall') } },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
    usage: { prompt_tokens: TURN_INPUT, completion_tokens: TURN_OUTPUT, total_tokens: TURN_TOTAL },
  };
}
/** Request 1 (SSE): three tool-call deltas + a trailing usage frame + [DONE]. */
function batchSseText(): string {
  return (
    delta({ tool_calls: [{ index: 0, id: 'call_big', function: { name: 'fetchBig' } }] }) +
    delta({ tool_calls: [{ index: 0, function: { arguments: argForName('fetchBig') } }] }) +
    delta({ tool_calls: [{ index: 1, id: 'call_mid', function: { name: 'fetchMid' } }] }) +
    delta({ tool_calls: [{ index: 1, function: { arguments: argForName('fetchMid') } }] }) +
    delta({ tool_calls: [{ index: 2, id: 'call_small', function: { name: 'fetchSmall' } }] }) +
    delta({ tool_calls: [{ index: 2, function: { arguments: argForName('fetchSmall') } }] }) +
    `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: TURN_INPUT, completion_tokens: TURN_OUTPUT, total_tokens: TURN_TOTAL } })}\n\n` +
    'data: [DONE]\n\n'
  );
}
/** Request 2: the assistant tool_calls message plus the three tool results, in issued order. */
function toolResultsBody(): Record<string, unknown> {
  return {
    model: 'gpt-4o-mini',
    messages: [
      asstCall('call_big', 'fetchBig'),
      asstCall('call_mid', 'fetchMid'),
      asstCall('call_small', 'fetchSmall'),
      toolRes('call_big', 'fetchBig', 'B'.repeat(BIG_CHARS)),
      toolRes('call_mid', 'fetchMid', 'M'.repeat(MID_CHARS)),
      toolRes('call_small', 'fetchSmall', 'S'.repeat(SMALL_CHARS)),
    ],
  };
}
/** Request 2 upstream response: a final answer (no tool calls, no usage → no turn.usage). */
function finalJsonRes(): Response {
  return jsonRes({
    id: 'chatcmpl-final-per-tool',
    object: 'chat.completion',
    created: 1700000000,
    model: 'gpt-4o-mini',
    choices: [{ index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }],
  });
}

async function post(port: number, body: Record<string, unknown>): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    // One explicit session so request 1's issued calls and request 2's results share a session key.
    headers: { 'Content-Type': 'application/json', 'x-session-id': 'sess-per-tool' },
    body: JSON.stringify(body),
  });
}
async function stats(port: number): Promise<CollectorSummary> {
  const res = await fetch(`http://127.0.0.1:${port}/api/stats`);
  assert.equal(res.status, 200, 'GET /api/stats must be HTTP 200');
  return res.json() as Promise<CollectorSummary>;
}
function findTool(topTools: TopTool[], name: string): TopTool {
  const tool = topTools.find((t) => t.toolName === name);
  assert.notEqual(tool, undefined, `top-tools includes ${name}`);
  return tool as TopTool;
}

/**
 * The shared per-tool token-accounting assertions (groups a–c + the turn.usage count),
 * run against the events captured on the bus (the same source as the WS feed / GET /api/events)
 * and the live GET /api/stats view.
 */
async function assertPerToolTokenAccounting(port: number, events: TelemetryEvent[]): Promise<void> {
  // (a) Each tool.result event reports its OWN chars, and its estimated tokens ≈ round(chars/4),
  //     with the three values distinct per tool (tool-specific, not duplicated/shared).
  const results = events.filter(isToolResult);
  assert.equal(results.length, 3, 'all three batched tool.results were emitted');
  const resultByName = new Map(results.map((r) => [r.toolName, r]));
  for (const { name, chars } of EXPECTED) {
    const r = resultByName.get(name);
    assert.notEqual(r, undefined, `a tool.result for ${name} was emitted`);
    assert.equal(r!.chars, chars, `tool.result ${name} reports its own chars`);
    assert.equal(estTokens(r!.chars!), estTokens(chars), `tool.result ${name} estimated tokens ≈ round(chars/4)`);
  }
  assert.equal(new Set(results.map((r) => r.chars)).size, 3, 'the three per-tool char counts are distinct (not duplicated/shared)');

  // (b) GET /api/stats per-tool entries: totalResponseTokens is distinct per tool and matches the
  //     per-tool estimate; resolvedCount = 1 for each tool.
  const s = await stats(port);
  for (const { name, chars } of EXPECTED) {
    const tool = findTool(s.topTools, name);
    assert.equal(tool.totalResponseTokens, estTokens(chars), `stats ${name}.totalResponseTokens matches the per-tool estimate (tool-specific, not duplicated/shared)`);
    assert.equal(tool.resolvedCount, 1, `stats ${name}.resolvedCount = 1`);
  }
  assert.equal(new Set(EXPECTED.map(({ name }) => findTool(s.topTools, name).totalResponseTokens)).size, 3, 'the three per-tool totalResponseTokens values are distinct');

  // (c) Turn-level consistency: the turn's token mass is counted ONCE — the global totals reconcile
  //     with the reported usage (30), NOT the sum of the three duplicated per-call tokens (3 × 30 = 90).
  assert.equal(s.totalTokens, TURN_TOTAL, 'stats counts the turn token mass exactly once (reconciles with the reported usage.total, not 3× duplicated per-call)');
  assert.equal(s.totalInputTokens, TURN_INPUT, 'stats counts the turn input tokens exactly once');
  assert.equal(s.totalOutputTokens, TURN_OUTPUT, 'stats counts the turn output tokens exactly once');
  // The turn's token mass is attributed to each tool that invoked it (deduped per turn␟tool)…
  for (const { name } of EXPECTED) {
    assert.equal(findTool(s.topTools, name).totalTokens, TURN_TOTAL, `stats ${name}.totalTokens = the turn's token mass (once per tool)`);
  }

  // (d) Batched turns omit per-call tokens: every tool.call in the batch has NO `tokens` field
  //     (the turn's token mass is carried once by the whole-turn turn.usage, not duplicated on
  //     every per-call event).
  const calls = events.filter(isToolCall);
  assert.equal(calls.length, 3, 'all three batched tool.calls were emitted');
  for (const call of calls) {
    assert.equal(
      call.tokens,
      undefined,
      `tool.call ${call.id} omits per-call tokens (the batch turn.usage carries the turn's token mass once)`,
    );
  }

  // (e) Per-call CALL-TOKENS estimate: each tool.call carries a distinct per-call callTokens
  //     estimate (name + serialized arguments), and the per-tool aggregate totalCallTokens
  //     (GET /api/stats) sums it (one call per tool).
  const callByName = new Map(calls.map((c) => [c.toolName, c]));
  const callTokByName = new Map<string, number>();
  for (const { name } of EXPECTED) {
    const c = callByName.get(name);
    assert.notEqual(c, undefined, `a tool.call for ${name} was emitted`);
    const expected = estimateCallTokens(name, argForName(name));
    assert.equal(c!.callTokens, expected, `tool.call ${name} carries its per-call callTokens estimate (name + args)`);
    callTokByName.set(name, expected);
  }
  assert.equal(new Set([...callTokByName.values()]).size, 3, 'the three per-call callTokens estimates are distinct per tool');
  for (const { name } of EXPECTED) {
    assert.equal(findTool(s.topTools, name).totalCallTokens, callTokByName.get(name), `stats ${name}.totalCallTokens = the per-call estimate (one call per tool)`);
  }

  // Exactly one whole-turn turn.usage (request 1); request 2 (final answer, no usage) emits none.
  // It carries the turn's reported total (the sole authoritative source of the turn's token mass).
  const turnUsages = events.filter(isTurnUsage);
  assert.equal(turnUsages.length, 1, 'the whole-turn turn.usage is emitted exactly once (request 1 only)');
  assert.equal(turnUsages[0].tokens.total, TURN_TOTAL, 'the turn.usage carries the reported turn total');
  assert.equal(turnUsages[0].tokens.input, TURN_INPUT, 'the turn.usage carries the reported turn input');
  assert.equal(turnUsages[0].tokens.output, TURN_OUTPUT, 'the turn.usage carries the reported turn output');
}

// P-A: buffered-JSON batched turn — per-tool response tokens are tool-specific; the turn is counted once.
test('P-A: buffered-JSON batched turn — per-tool token accounting is tool-specific and the turn is counted once', async () => {
  const { port, srv, atg } = await startAtgServer(
    { upstream: upstream(seqFetch([jsonRes(batchJsonCanned()), finalJsonRes()])) },
    { ws: false },
  );
  const events: TelemetryEvent[] = [];
  const unsub = atg.bus.subscribe((ev) => { events.push(ev); });
  try {
    const res1 = await post(port, request1Body());
    assert.equal(res1.status, 200, 'request 1 (batched) must be HTTP 200');
    await res1.arrayBuffer(); // drain the body so all bus emission has completed

    const res2 = await post(port, toolResultsBody());
    assert.equal(res2.status, 200, 'request 2 (tool results) must be HTTP 200');
    await res2.arrayBuffer();

    await assertPerToolTokenAccounting(port, events);
  } finally {
    unsub();
    await closeAtgServer(srv);
  }
});

// P-B: SSE batched turn — per-tool response tokens are tool-specific; the turn is counted once.
test('P-B: SSE batched turn — per-tool token accounting is tool-specific and the turn is counted once', async () => {
  const { port, srv, atg } = await startAtgServer(
    { upstream: upstream(seqFetch([sseRes(batchSseText()), finalJsonRes()])) },
    { ws: false },
  );
  const events: TelemetryEvent[] = [];
  const unsub = atg.bus.subscribe((ev) => { events.push(ev); });
  try {
    const res1 = await post(port, { ...request1Body(), stream: true });
    assert.equal(res1.status, 200, 'request 1 (streamed batched) must be HTTP 200');
    assert.match(res1.headers.get('content-type') ?? '', /text\/event-stream/, 'request 1 must stream SSE');
    const text1 = await res1.text(); // drain the stream so the extractor flushes (finish) at stream end
    assert.ok(text1.includes('call_big') && text1.includes('[DONE]'), 'the raw SSE pass-through reaches the client');

    const res2 = await post(port, toolResultsBody());
    assert.equal(res2.status, 200, 'request 2 (tool results) must be HTTP 200');
    await res2.arrayBuffer();

    await assertPerToolTokenAccounting(port, events);
  } finally {
    unsub();
    await closeAtgServer(srv);
  }
});
