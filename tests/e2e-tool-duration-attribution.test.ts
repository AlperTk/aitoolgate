/**
 * End-to-end PER-CALL DURATION attribution (batched + interleaved / out-of-order).
 *
 * These scenarios prove the call→result span is measured per call (matched by stable id),
 * never collapsed onto one shared batch value and never fabricated as a spread:
 *   D-A  full-HTTP e2e: one buffered turn issues THREE calls; their results then arrive
 *        INTERLEAVED across two later follow-up requests (c first, then a+b together).
 *        c gets strictly its own smaller span; co-arriving a+b share an EQUAL span; the
 *        re-sent already-resolved c does not double-emit; per-tool aggregates follow.
 *   D-B  deterministic (injected clock): runThroughPipeline end-to-end — issue at t=1000,
 *        resolve c alone at t=2500 (duration 1500), then a+b together at t=4000 (3000 each).
 *   D-C  streamed OpenAI turn under an injected clock: sibling calls observed at different
 *        stream times keep ONE shared turn-level event `at` (token dedup) while the tracker
 *        records each call's OWN first-observation time, so later resolution yields distinct
 *        exact per-call spans regardless of result message order.
 *   D-D  same for the NATIVE Anthropic stream path (tool_use blocks finalized at stream end).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startMcmServer, closeMcmServer } from './helpers';
import type { FetchLike, UpstreamClient, UpstreamResult } from '../src/proxy/upstream';
import { resolveAndEmitToolResults, runThroughPipeline } from '../src/proxy/context';
import type { Pipeline, PipelineStage, RequestContext, ResponseContext, ResultContext } from '../src/ports/pipeline';
import { createToolMetricsTracker } from '../src/telemetry/toolMetrics';
import { createSseToolCallExtractor } from '../src/telemetry/stream-extract';
import type { TelemetryEvent } from '../src/telemetry/events';

const isToolCall = (e: TelemetryEvent): e is Extract<TelemetryEvent, { type: 'tool.call' }> => e.type === 'tool.call';
const isToolResult = (e: TelemetryEvent): e is Extract<TelemetryEvent, { type: 'tool.result' }> => e.type === 'tool.result';

// --- response builders ---------------------------------------------------------
/** A non-streaming JSON upstream Response. */
function jsonRes(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
/** A final OpenAI JSON answer (no tool calls). */
const FINAL_OPENAI_JSON = {
  id: 'chatcmpl-final', object: 'chat.completion', created: 1700000000, model: 'gpt-4o-mini',
  choices: [{ index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }],
};
/** Build NATIVE Anthropic SSE text from a list of { event, data } frames. */
function anthropicSse(frames: Array<{ event: string; data: Record<string, unknown> }>): string {
  return frames.map((f) => `event: ${f.event}\ndata: ${JSON.stringify(f.data)}\n\n`).join('');
}
/** Upstream whose N-th fetch returns the N-th prebuilt Response (last repeats when exhausted). */
function seqFetch(responses: Response[]): FetchLike {
  let i = 0;
  return async () => responses[Math.min(i++, responses.length - 1)];
}
/** An OpenAI assistant turn that issued one tool call (history for pairing). */
function asstCall(id: string, name: string): Record<string, unknown> {
  return { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: '{}' } }] };
}
/** An OpenAI role:'tool' result message (the resolved artifact). */
function toolRes(id: string, name: string, content: string): Record<string, unknown> {
  return { role: 'tool', tool_call_id: id, name, content };
}
/** A controllable monotonic-style clock for deterministic timing. */
function makeClock(start = 0): { now: () => number; set: (value: number) => void } {
  let t = start;
  return { now: () => t, set: (value: number): void => { t = value; } };
}

async function post(port: number, path: string, body: Record<string, unknown>, extraHeaders?: Record<string, string>): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(extraHeaders ?? {}) };
  return fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
function openaiUpstream(fetchImpl: FetchLike): UpstreamClient {
  return { baseUrl: 'http://127.0.0.1:9999/v1', model: 'gpt-4o-mini', protocol: 'openai', fetchImpl };
}

// --- D-A: full-HTTP batched turn with INTERLEAVED follow-up resolutions -------
test('D-A: batched same-turn calls resolved across interleaved follow-ups get per-id durations, not one shared value', async () => {
  // One buffered turn issues THREE distinct tool calls (shared issue time); the results then
  // arrive INTERLEAVED across two later requests: c first, then a+b TOGETHER.
  const callBody = {
    id: 'chatcmpl-da', object: 'chat.completion', created: 1700000000, model: 'gpt-4o-mini',
    choices: [{
      index: 0,
      message: {
        role: 'assistant', content: null,
        tool_calls: [
          { id: 'da_c', type: 'function', function: { name: 'tool_c', arguments: '{}' } },
          { id: 'da_a', type: 'function', function: { name: 'tool_a', arguments: '{}' } },
          { id: 'da_b', type: 'function', function: { name: 'tool_b', arguments: '{}' } },
        ],
      },
      finish_reason: 'tool_calls',
    }],
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
  };
  const baseMsgs = [{ role: 'user', content: 'Do three things.' }];
  const SESS = 'sess-da';
  const { port, srv, mcm } = await startMcmServer(
    { upstream: openaiUpstream(seqFetch([jsonRes(callBody), jsonRes(FINAL_OPENAI_JSON), jsonRes(FINAL_OPENAI_JSON)])) },
    { ws: false },
  );
  const events: TelemetryEvent[] = [];
  const unsub = mcm.bus.subscribe((ev) => { events.push(ev); });
  try {
    // Req1: the model issues all three calls in ONE turn.
    await (await post(port, '/v1/chat/completions', { model: 'gpt-4o-mini', messages: baseMsgs, stream: false }, { 'x-session-id': SESS })).text();
    await sleep(40);

    // Req2: ONLY tool_c's result comes back (interleaved: the FIRST-issued-order-last call resolves first).
    await (await post(port, '/v1/chat/completions', {
      model: 'gpt-4o-mini', stream: false,
      messages: [...baseMsgs, asstCall('da_c', 'tool_c'), toolRes('da_c', 'tool_c', 'rc')],
    }, { 'x-session-id': SESS })).text();
    await sleep(40);

    // Req3: tool_a + tool_b come back TOGETHER (re-sending the already-resolved da_c is a no-op).
    await (await post(port, '/v1/chat/completions', {
      model: 'gpt-4o-mini', stream: false,
      messages: [
        ...baseMsgs,
        asstCall('da_c', 'tool_c'), toolRes('da_c', 'tool_c', 'rc'),
        asstCall('da_a', 'tool_a'), toolRes('da_a', 'tool_a', 'ra'),
        asstCall('da_b', 'tool_b'), toolRes('da_b', 'tool_b', 'rb'),
      ],
    }, { 'x-session-id': SESS })).text();
    await sleep(40);

    const calls = events.filter(isToolCall);
    assert.equal(calls.length, 3, 'the batch turn emitted exactly three tool.call events');
    const results = events.filter(isToolResult);
    assert.equal(results.length, 3, 'exactly three tool.results (the re-sent da_c resolves only once)');

    const durOf = (id: string): number => Number(results.find((r) => r.toolCallId === id)?.durationMs);
    const dC = durOf('da_c');
    const dA = durOf('da_a');
    const dB = durOf('da_b');
    assert.ok(dC > 0 && dA > 0 && dB > 0, 'every per-call duration is positive');
    assert.ok(dC < dA, 'the interleaved-first result has a STRICTLY SMALLER span than the later batch');
    assert.equal(dB, dA, 'co-arriving same-request results share an EQUAL span (parallel run — not a fabricated spread)');
    assert.ok(
      results.every((r) => typeof r.id === 'string' && r.id !== '' && r.id === r.toolCallId),
      'every tool.result keeps its stable unique id (dashboard dedup contract preserved)',
    );

    // The collector aggregates follow the per-call attribution exactly.
    const summary = mcm.collector.summary();
    assert.equal(summary.totalDurationMs, dC + 2 * dA, 'global total duration equals the sum of the three per-call spans');
    const statFor = (name: string) => summary.topTools.find((tt) => tt.toolName === name);
    assert.equal(statFor('tool_c')?.avgDurationMs, dC, 'tool_c aggregate reflects its own earlier span');
    assert.equal(statFor('tool_a')?.avgDurationMs, dA, 'tool_a aggregate reflects its own later span');
    assert.equal(statFor('tool_b')?.avgDurationMs, dA, 'tool_b matches tool_a (equal parallel co-arrival)');

    assert.equal(mcm.tracker.pendingCount(), 0, 'no row left pending after the final follow-up');
  } finally {
    unsub();
    await closeMcmServer(srv);
  }
});

// --- D-B: deterministic per-call spans through runThroughPipeline (injected clock) ---
test('D-B: runThroughPipeline attributes exact per-call durations under an injected clock (batched + out-of-order)', async () => {
  const clock = makeClock(1000);
  const now = clock.now;
  const SESS = 'sess-dc';
  const events: TelemetryEvent[] = [];
  const bus = { emit: (event: TelemetryEvent): void => { events.push(event); } };
  const tracker = createToolMetricsTracker({ now });

  // A pass-through pipeline (no stages) so ONLY the centralized telemetry runs.
  const pipeline: Pipeline = {
    use: (): Pipeline => pipeline,
    get stages(): readonly PipelineStage[] { return []; },
    handleRequest: async (ctx: RequestContext): Promise<RequestContext> => ctx,
    handleResponse: async (ctx: ResponseContext): Promise<ResponseContext> => ctx,
    handleResult: async (ctx: ResultContext): Promise<ResultContext> => ctx,
  };
  const forward = (body: unknown) => async (): Promise<UpstreamResult> => ({ status: 200, ok: true, body });
  const makeCtx = (messages: unknown[]): RequestContext => ({
    client: { apiKey: 'user-key', name: 'default', model: 'm-dc' },
    model: { id: 'm-dc', baseUrl: 'http://upstream.test/v1', model: 'm-dc' },
    sessionKey: { fingerprint: '', token: SESS },
    messages,
    raw: { messages },
  });

  // t=1000: one turn issues THREE calls (shared issue time, all recorded at 1000).
  const callBody = {
    id: 'chatcmpl-dc', object: 'chat.completion', created: 1700000000, model: 'gpt-4o-mini',
    choices: [{
      index: 0,
      message: {
        role: 'assistant', content: null,
        tool_calls: [
          { id: 'dc_c', type: 'function', function: { name: 'tool_c', arguments: '{}' } },
          { id: 'dc_a', type: 'function', function: { name: 'tool_a', arguments: '{}' } },
          { id: 'dc_b', type: 'function', function: { name: 'tool_b', arguments: '{}' } },
        ],
      },
      finish_reason: 'tool_calls',
    }],
    usage: { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 },
  };
  clock.set(1000);
  await runThroughPipeline(pipeline, makeCtx([]), forward(callBody), { bus, tracker, now });

  // t=2500: ONLY dc_c's result arrives (interleaved-first resolution).
  clock.set(2500);
  await runThroughPipeline(
    pipeline,
    makeCtx([asstCall('dc_c', 'tool_c'), toolRes('dc_c', 'tool_c', 'rc')]),
    forward(FINAL_OPENAI_JSON),
    { bus, tracker, now },
  );

  // t=4000: dc_a + dc_b arrive TOGETHER (re-sending the resolved dc_c is a no-op).
  clock.set(4000);
  await runThroughPipeline(
    pipeline,
    makeCtx([
      asstCall('dc_c', 'tool_c'), toolRes('dc_c', 'tool_c', 'rc'),
      asstCall('dc_a', 'tool_a'), toolRes('dc_a', 'tool_a', 'ra'),
      asstCall('dc_b', 'tool_b'), toolRes('dc_b', 'tool_b', 'rb'),
    ]),
    forward(FINAL_OPENAI_JSON),
    { bus, tracker, now },
  );

  const calls = events.filter(isToolCall);
  assert.equal(calls.length, 3, 'the batch turn emitted exactly three tool.call events');
  assert.ok(calls.every((c) => c.at === 1000), 'every batch tool.call carries the shared turn-level issue `at` (1000)');
  assert.ok(calls.every((c) => c.tokens !== undefined && c.tokens.input === 5 && c.tokens.output === 6 && c.tokens.total === 11),
    'every batch tool.call carries the normalized turn tokens');
  assert.equal(new Set(calls.map((c) => c.id)).size, 3, 'sibling batch calls carry distinct stable ids');

  const results = events.filter(isToolResult);
  assert.equal(results.length, 3, 'exactly three tool.results (no double-resolution of the re-sent dc_c)');
  assert.equal(results[0].toolCallId, 'dc_c', 'the interleaved-first result resolves first, in arrival order not message position');
  assert.equal(results[0].durationMs, 1500, 'dc_c span = 2500 - 1000 (exact per-call measurement)');
  assert.equal(results[0].at, 2500, 'dc_c result event carries its own arrival time');
  for (const expected of [
    { id: 'dc_a', durationMs: 3000, at: 4000 },
    { id: 'dc_b', durationMs: 3000, at: 4000 },
  ]) {
    const r = results.find((x) => x.toolCallId === expected.id);
    assert.ok(r, `${expected.id} resolved`);
    assert.equal(r.durationMs, expected.durationMs, `${expected.id} span = ${expected.at} - 1000 (equal co-arrival, no fabrication)`);
    assert.equal(r.at, expected.at, `${expected.id} result event carries its own arrival time`);
    assert.equal(r.id, expected.id, `${expected.id} keeps its stable unique result id`);
    assert.equal(r.toolName, `tool_${expected.id.slice(3)}`, `${expected.id} surfaces a real toolName`);
  }
  assert.equal(tracker.pendingCount(), 0, 'no row left pending after the final request');
});

// --- D-C: streamed OpenAI turn — per-call first-observation spans (injected clock) ---
test('D-C: the streamed extractor records each call OWN first-observation time; exact per-call spans on resolution', async () => {
  const clock = makeClock(1000);
  const now = clock.now;
  const SESS = 'sess-dc-stream';
  const events: TelemetryEvent[] = [];
  const bus = { emit: (event: TelemetryEvent): void => { events.push(event); } };
  const tracker = createToolMetricsTracker({ now });
  const extractor = createSseToolCallExtractor(bus, SESS, undefined, tracker, now);

  const delta = (d: unknown): string => `data: ${JSON.stringify({ choices: [{ delta: d }] })}\n\n`;
  // Sibling calls observed at DIFFERENT stream times within one batched/interleaved turn.
  clock.set(1000);
  extractor.write(Buffer.from(delta({ tool_calls: [{ index: 0, id: 'st_a', function: { name: 'tool_a' } }] })));
  clock.set(1400);
  extractor.write(Buffer.from(delta({ tool_calls: [{ index: 0, function: { arguments: '{"q":1}' } }] })));
  clock.set(1600);
  extractor.write(Buffer.from(delta({ tool_calls: [{ index: 1, id: 'st_b', function: { name: 'tool_b' } }] })));
  clock.set(1700);
  extractor.write(Buffer.from(delta({ tool_calls: [{ index: 1, function: { arguments: '{}' } }] })));
  // Trailing usage chunk + [DONE] finalize the turn.
  clock.set(1800);
  extractor.end(Buffer.from(
    `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 } })}\n\ndata: [DONE]\n\n`,
  ));
  await sleep(25); // let the Transform flush (and finish) process the final lines.

  // BOTH emitted events share ONE turn-level `at` (token-turn dedup invariant); the TRACKER
  // records each call's OWN first-observation time. Tokens reflect usage observed UP TO each
  // call's emission: the trailing OpenAI usage chunk arrives AFTER the first call is already
  // finalised, so the earlier call omits not-yet-observed usage (never fabricated) while the
  // last-finalised call carries the full normalised turn usage ("omit, don't fabricate").
  const calls = events.filter(isToolCall);
  assert.equal(calls.length, 2, 'both streamed tool.calls were captured');
  assert.equal(new Set(calls.map((c) => c.at)).size, 1, 'every tool.call in the streamed turn shares one turn-level `at`');
  const callA = calls.find((c) => c.id === 'st_a')!;
  const callB = calls.find((c) => c.id === 'st_b')!;
  assert.equal(callA.tokens, undefined, 'the earlier-finalised call omits not-yet-observed trailing usage (never fabricated)');
  assert.ok(
    callB.tokens !== undefined && callB.tokens.input === 5 && callB.tokens.output === 6 && callB.tokens.total === 11,
    'the last-finalised call carries the full normalised turn tokens',
  );
  assert.deepEqual(
    new Set(calls.map((c) => c.id)),
    new Set(['st_a', 'st_b']),
    'sibling streamed calls keep their stable upstream ids',
  );
  assert.equal(tracker.pendingCount(), 2, 'both streamed calls are pending for later pairing');

  // t=5000: BOTH results arrive in ONE request — listed b-first (position-independent pairing).
  clock.set(5000);
  const requestCtx: RequestContext = {
    client: { apiKey: 'user-key', name: 'default', model: 'm-dc' },
    model: { id: 'm-dc', baseUrl: 'http://upstream.test/v1', model: 'm-dc' },
    sessionKey: { fingerprint: '', token: SESS },
    messages: [toolRes('st_b', 'tool_b', 'rb'), toolRes('st_a', 'tool_a', 'ra')],
    raw: {},
  };
  resolveAndEmitToolResults(tracker, bus, requestCtx, now);

  const results = events.filter(isToolResult);
  assert.equal(results.length, 2, 'both streamed calls resolved into real tool.results');
  assert.equal(results[0].toolCallId, 'st_b', 'results emit in message order; pairing is by id, not position');
  assert.equal(results[0].durationMs, 3400, 'st_b span = 5000 - 1600 (its OWN first-observation time)');
  assert.equal(results[1].toolCallId, 'st_a', 'st_a paired despite being listed second');
  assert.equal(results[1].durationMs, 4000, 'st_a span = 5000 - 1000 (its OWN first-observation time)');
  assert.ok(results.every((r) => r.at === 5000), 'every result event carries the shared request arrival time');
  assert.ok(results.every((r) => r.id === r.toolCallId && typeof r.toolName === 'string' && r.toolName !== ''),
    'every result keeps its stable unique id and a real toolName');
  assert.equal(tracker.pendingCount(), 0, 'no row left pending after resolution');

  // Empty-batch safety: a stream with NO tool calls records nothing and emits nothing.
  const emptyEvents: TelemetryEvent[] = [];
  const emptyBus = { emit: (event: TelemetryEvent): void => { emptyEvents.push(event); } };
  const emptyTracker = createToolMetricsTracker({ now });
  const emptyExtractor = createSseToolCallExtractor(emptyBus, SESS, undefined, emptyTracker, now);
  clock.set(6000);
  emptyExtractor.end(Buffer.from(delta({ content: 'all done' }) + 'data: [DONE]\n\n'));
  await sleep(25);
  assert.equal(emptyEvents.length, 0, 'a call-free stream emits no tool.call events');
  assert.equal(emptyTracker.pendingCount(), 0, 'a call-free stream records nothing pending');
});

// --- D-D: NATIVE Anthropic streamed turn — per-call spans (injected clock) -------
test('D-D: native Anthropic streamed tool_use blocks each keep their own issue→result span under an injected clock', async () => {
  const clock = makeClock(1000);
  const now = clock.now;
  const SESS = 'sess-dc-anth';
  const events: TelemetryEvent[] = [];
  const bus = { emit: (event: TelemetryEvent): void => { events.push(event); } };
  const tracker = createToolMetricsTracker({ now });
  const extractor = createSseToolCallExtractor(bus, SESS, undefined, tracker, now);

  const frames: Array<{ event: string; data: Record<string, unknown> }> = [
    { event: 'content_block_start', data: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'an_a', name: 'tool_a' } } },
    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"x":' } } },
    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '1}' } } },
    { event: 'content_block_start', data: { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'an_b', name: 'tool_b' } } },
    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"y":2}' } } },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ];
  // The two tool_use blocks are observed at DIFFERENT stream times within one turn.
  clock.set(1000);
  extractor.write(Buffer.from(anthropicSse(frames.slice(0, 1))));
  clock.set(1100);
  extractor.write(Buffer.from(anthropicSse(frames.slice(1, 3))));
  clock.set(1800);
  extractor.write(Buffer.from(anthropicSse(frames.slice(3, 5))));
  clock.set(2900);
  extractor.write(Buffer.from(anthropicSse(frames.slice(5))));
  clock.set(3000);
  extractor.end();
  await sleep(25); // flush finalises the accumulated tool_use calls (shared turn-level `at`).

  const calls = events.filter(isToolCall);
  assert.equal(calls.length, 2, 'both native tool_use blocks were captured as tool.call events');
  assert.equal(new Set(calls.map((c) => c.at)).size, 1, 'every tool.call in the streamed turn shares one turn-level `at`');
  assert.deepEqual(new Set(calls.map((c) => c.id)), new Set(['an_a', 'an_b']), 'sibling tool_use blocks keep their stable ids');
  assert.equal(tracker.pendingCount(), 2, 'both streamed calls are pending for later pairing');

  // t=5000: BOTH results arrive in ONE request — listed an_b-first (position-independent).
  clock.set(5000);
  const requestCtx: RequestContext = {
    client: { apiKey: 'user-key', name: 'default', model: 'm-dc' },
    model: { id: 'm-dc', baseUrl: 'http://upstream.test/v1', model: 'm-dc' },
    sessionKey: { fingerprint: '', token: SESS },
    messages: [{ role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'an_b', content: 'rb' },
      { type: 'tool_result', tool_use_id: 'an_a', content: 'ra' },
    ] }],
    raw: {},
  };
  resolveAndEmitToolResults(tracker, bus, requestCtx, now);

  const results = events.filter(isToolResult);
  assert.equal(results.length, 2, 'both streamed calls resolved into real tool.results');
  assert.equal(results[0].toolCallId, 'an_b', 'results emit in message order; pairing is by id, not position');
  assert.equal(results[0].durationMs, 3200, 'an_b span = 5000 - 1800 (its OWN first-observation time)');
  assert.equal(results[1].toolCallId, 'an_a', 'an_a paired despite being listed second');
  assert.equal(results[1].durationMs, 4000, 'an_a span = 5000 - 1000 (its OWN first-observation time)');
  assert.ok(results.every((r) => r.at === 5000), 'every result event carries the shared request arrival time');
  assert.equal(results[0].toolName, 'tool_b', 'an_b surfaces its real toolName');
  assert.equal(results[1].toolName, 'tool_a', 'an_a surfaces its real toolName');
  assert.equal(tracker.pendingCount(), 0, 'no row left pending after resolution');
});
