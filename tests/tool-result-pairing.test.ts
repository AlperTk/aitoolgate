/**
 * Cross-request tool-call pairing + streaming capture scenarios.
 *
 * These exercise the FULL chain (client request -> proxy -> telemetry bus -> collector +
 * shared tracker) to prove that tool-call DURATION populates reliably and NO call is left
 * stuck pending across protocols and stream/non-stream mixes:
 *   S-B  multi-tool turn with results spread across MULTIPLE mixed streamed/non-streamed
 *        OpenAI follow-ups (#call == #result == N, no row pending, per-tool duration stats).
 *   S-C  Anthropic STREAMED issue of >=3 tool_use blocks followed by tool_result follow-ups
 *        (M1: native content_block_* capture; every call carries tokens; every result has
 *        a real toolName + measured duration; per-tool stats defined).
 *   S-D  inconsistent/absent x-session-id between issue and resolution (M2: cross-session
 *        id fallback so nothing is permanently unresolved).
 *   S-E  existing non-stream paths (Anthropic + OpenAI) remain green.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startAtgServer, closeAtgServer } from './helpers';
import type { FetchLike, UpstreamClient } from '../src/proxy/upstream';
import type { TelemetryEvent } from '../src/telemetry/events';

const isToolCall = (e: TelemetryEvent): e is Extract<TelemetryEvent, { type: 'tool.call' }> => e.type === 'tool.call';
const isToolResult = (e: TelemetryEvent): e is Extract<TelemetryEvent, { type: 'tool.result' }> => e.type === 'tool.result';

// --- response builders ---------------------------------------------------------
/** A non-streaming JSON upstream Response. */
function jsonRes(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
/** A streaming SSE upstream Response (byte-for-byte pass-through). */
function sseRes(text: string): Response {
  const enc = new TextEncoder();
  return new Response(
    new ReadableStream({ start: (c) => { c.enqueue(enc.encode(text)); c.close(); } }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
  );
}
/** A final OpenAI SSE answer (no tool calls). */
const FINAL_OPENAI_SSE = 'data: {"choices":[{"delta":{"content":"done"}}]}\n\ndata: [DONE]\n\n';
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
/** An OpenAI assistant turn that issued a single tool call (history for pairing). */
function asstCall(id: string, name: string): Record<string, unknown> {
  return { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: '{}' } }] };
}
/** An OpenAI role:'tool' result message (the resolved artifact). */
function toolRes(id: string, name: string, content: string): Record<string, unknown> {
  return { role: 'tool', tool_call_id: id, name, content };
}

async function post(port: number, path: string, body: Record<string, unknown>, extraHeaders?: Record<string, string>): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(extraHeaders ?? {}) };
  return fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
function openaiUpstream(fetchImpl: FetchLike): UpstreamClient {
  return { baseUrl: 'http://127.0.0.1:9999/v1', model: 'gpt-4o-mini', protocol: 'openai', fetchImpl };
}
function anthropicUpstream(fetchImpl: FetchLike): UpstreamClient {
  return { baseUrl: 'http://127.0.0.1:9999/v1', model: 'claude-3-opus', protocol: 'anthropic', fetchImpl };
}

// --- S-B: multi-tool turn across MIXED streamed/non-streamed follow-ups -------
test('S-B: a multi-tool turn spreads results over mixed stream/non-stream follow-ups with no row left pending', async () => {
  // One response turn issues THREE distinct tool calls (+ upstream usage).
  const callBody = {
    id: 'chatcmpl-sb', object: 'chat.completion', created: 1700000000, model: 'gpt-4o-mini',
    choices: [{
      index: 0,
      message: {
        role: 'assistant', content: null,
        tool_calls: [
          { id: 'sb_1', type: 'function', function: { name: 'tool_a', arguments: '{}' } },
          { id: 'sb_2', type: 'function', function: { name: 'tool_b', arguments: '{}' } },
          { id: 'sb_3', type: 'function', function: { name: 'tool_c', arguments: '{}' } },
        ],
      },
      finish_reason: 'tool_calls',
    }],
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
  };
  const baseMsgs = [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: 'Do three different things.' },
  ];
  const SESS = 'sess-multi';
  const { port, srv, atg } = await startAtgServer(
    {
      upstream: openaiUpstream(seqFetch([
        jsonRes(callBody), // Req1 (non-stream) -> issues sb_1..sb_3
        sseRes(FINAL_OPENAI_SSE), // Req2 (streamed) -> resolves sb_1
        jsonRes(FINAL_OPENAI_JSON), // Req3 (non-stream) -> resolves sb_2
        sseRes(FINAL_OPENAI_SSE), // Req4 (streamed) -> resolves sb_3
      ])),
    },
    { ws: false },
  );
  const events: TelemetryEvent[] = [];
  const unsub = atg.bus.subscribe((ev) => { events.push(ev); });
  try {
    // Req1 (non-stream): the model issues three tool calls in ONE turn.
    await post(port, '/v1/chat/completions', { model: 'gpt-4o-mini', messages: baseMsgs, stream: false }, { 'x-session-id': SESS });
    await sleep(25); // let the measured issue->result duration be strictly positive

    // Req2 (STREAMED follow-up) feeds back result for sb_1.
    await post(port, '/v1/chat/completions', {
      model: 'gpt-4o-mini', stream: true,
      messages: [...baseMsgs, asstCall('sb_1', 'tool_a'), toolRes('sb_1', 'tool_a', 'result-a')],
    }, { 'x-session-id': SESS });
    await sleep(25);

    // Req3 (NON-STREAM follow-up) feeds back result for sb_2 (re-sending sb_1 is a no-op).
    await post(port, '/v1/chat/completions', {
      model: 'gpt-4o-mini', stream: false,
      messages: [
        ...baseMsgs,
        asstCall('sb_1', 'tool_a'), toolRes('sb_1', 'tool_a', 'result-a'),
        asstCall('sb_2', 'tool_b'), toolRes('sb_2', 'tool_b', 'result-b'),
      ],
    }, { 'x-session-id': SESS });
    await sleep(25);

    // Req4 (STREAMED follow-up) feeds back result for sb_3.
    const res4 = await post(port, '/v1/chat/completions', {
      model: 'gpt-4o-mini', stream: true,
      messages: [
        ...baseMsgs,
        asstCall('sb_1', 'tool_a'), toolRes('sb_1', 'tool_a', 'result-a'),
        asstCall('sb_2', 'tool_b'), toolRes('sb_2', 'tool_b', 'result-b'),
        asstCall('sb_3', 'tool_c'), toolRes('sb_3', 'tool_c', 'result-c'),
      ],
    }, { 'x-session-id': SESS });
    await res4.text();
    await sleep(25);

    // #call == #result == 3; each batch tool.call carries a DISTINCT stable id plus the full
    // normalized turn tokens, and every result carries a real toolName and a positive duration.
    const calls = events.filter(isToolCall);
    assert.equal(calls.length, 3, 'exactly three tool.call events observed');
    assert.ok(
      calls.every((c) => typeof c.id === 'string' && c.id !== ''),
      'every batch tool.call carries a stable non-empty id',
    );
    assert.equal(new Set(calls.map((c) => c.id)).size, 3, 'sibling batch tool.calls never share an identical id');
    assert.ok(
      calls.every((c) => c.tokens !== undefined && c.tokens.input === 10 && c.tokens.output === 20 && c.tokens.total === 30),
      'every batch tool.call carries the normalized turn tokens (input/output/total)',
    );
    const results = events.filter(isToolResult);
    assert.equal(results.length, 3, 'exactly three tool.result events observed (#call == #result)');
    assert.ok(results.every((r) => typeof r.durationMs === 'number' && r.durationMs > 0), 'every result has a positive durationMs');
    assert.ok(results.every((r) => typeof r.toolName === 'string' && r.toolName !== ''), 'every result carries a real toolName (M4)');

    // No issued call remains stuck pending after the final request.
    assert.equal(atg.tracker.pendingCount(), 0, 'no row left pending after the final follow-up');

    // The collector aggregates non-zero global duration AND per-tool duration stats for EVERY involved tool.
    const summary = atg.collector.summary();
    assert.ok(summary.totalDurationMs !== undefined && summary.totalDurationMs > 0, 'summary.totalDurationMs > 0');
    assert.ok(summary.avgDurationMs !== undefined && summary.avgDurationMs > 0, 'summary.avgDurationMs > 0');
    for (const name of ['tool_a', 'tool_b', 'tool_c']) {
      const t = summary.topTools.find((tt) => tt.toolName === name);
      assert.ok(t, `topTools includes ${name}`);
      assert.ok(typeof t.avgDurationMs === 'number' && t.avgDurationMs > 0, `${name}.avgDurationMs defined (>0)`);
      assert.ok(typeof t.maxDurationMs === 'number' && t.maxDurationMs > 0, `${name}.maxDurationMs defined (>0)`);
    }
  } finally {
    unsub();
    await closeAtgServer(srv);
  }
});

// --- S-C: Anthropic STREAMED issue (M1) followed by tool_result follow-ups -----
test('S-C: an Anthropic streamed turn of >=3 tool_use blocks pairs into real tool.results with tokens + toolName', async () => {
  const frames: Array<{ event: string; data: Record<string, unknown> }> = [
    { event: 'message_start', data: { type: 'message_start', message: { id: 'msg_c', type: 'message', role: 'assistant', content: [], model: 'claude-3-opus', usage: { input_tokens: 30 } } } },
    { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Three tools:' } } },
    { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
    { event: 'content_block_start', data: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_c1', name: 'search_web' } } },
    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"que' } } },
    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: 'ry":"hello"}' } } },
    { event: 'content_block_stop', data: { type: 'content_block_stop', index: 1 } },
    { event: 'content_block_start', data: { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_c2', name: 'get_weather' } } },
    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"city":"Paris"}' } } },
    { event: 'content_block_stop', data: { type: 'content_block_stop', index: 2 } },
    { event: 'content_block_start', data: { type: 'content_block_start', index: 3, content_block: { type: 'tool_use', id: 'toolu_c3', name: 'fetch_url' } } },
    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 3, delta: { type: 'input_json_delta', partial_json: '{"url":"https://example.com"}' } } },
    { event: 'content_block_stop', data: { type: 'content_block_stop', index: 3 } },
    { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 60 } } },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ];
  const baseMsgs = [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: 'Do three different things.' },
  ];
  const SESS = 'sess-stream-c';
  // Req1 (streamed): native Anthropic frames above. Req2 (non-stream): resolves all three via tool_result blocks.
  const { port, srv, atg } = await startAtgServer(
    {
      upstream: anthropicUpstream(seqFetch([
        sseRes(anthropicSse(frames)),
        jsonRes({ id: 'msg_c_done', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'done' }] }),
      ])),
    },
    { ws: false },
  );
  const events: TelemetryEvent[] = [];
  const unsub = atg.bus.subscribe((ev) => { events.push(ev); });
  try {
    const resN = await post(port, '/v1/messages', { model: 'claude-3-opus', messages: baseMsgs, stream: true }, { 'x-session-id': SESS });
    assert.equal(resN.status, 200, 'the streamed Anthropic request must be HTTP 200');
    await resN.text(); // drain the SSE so the extractor finalizes + records the tool_use calls
    await sleep(25);

    // Req2 (non-stream follow-up) feeds back the three tool_result blocks in the same session.
    await post(port, '/v1/messages', {
      model: 'claude-3-opus', stream: false,
      messages: [
        ...baseMsgs,
        {
          role: 'assistant', content: [
            { type: 'tool_use', id: 'toolu_c1', name: 'search_web', input: { query: 'hello' } },
            { type: 'tool_use', id: 'toolu_c2', name: 'get_weather', input: { city: 'Paris' } },
            { type: 'tool_use', id: 'toolu_c3', name: 'fetch_url', input: { url: 'https://example.com' } },
          ],
        },
        {
          role: 'user', content: [
            { type: 'tool_result', tool_use_id: 'toolu_c1', content: '<web-results>' },
            { type: 'tool_result', tool_use_id: 'toolu_c2', content: 'sunny 20C' },
            { type: 'tool_result', tool_use_id: 'toolu_c3', content: '<page>' },
          ],
        },
      ],
    }, { 'x-session-id': SESS });
    await sleep(25);

    // Three streamed tool.call events were captured from the NATIVE frames (today this yields zero).
    const calls = events.filter(isToolCall);
    assert.equal(calls.length, 3, 'three tool.call events captured from the native Anthropic stream');
    for (const c of calls) {
      assert.ok(typeof c.id === 'string' && c.id !== '', 'each streamed tool.call carries its stable tool_use id');
      assert.ok(
        c.tokens !== undefined && (c.tokens.input ?? 0) > 0 && (c.tokens.output ?? 0) > 0 && (c.tokens.total ?? 0) > 0,
        'each streamed tool.call carries the turn tokens (input/output/total)',
      );
    }
    // All calls in one streamed turn share ONE turn-level `at` so token dedup stays correct.
    assert.equal(new Set(calls.map((c) => c.at)).size, 1, 'every tool.call in the streamed turn shares one turn-level `at`');

    // Three tool.results resolve with positive duration AND a real toolName.
    const results = events.filter(isToolResult);
    assert.equal(results.length, 3, 'three tool.result events resolved from the streamed issue');
    assert.ok(results.every((r) => typeof r.durationMs === 'number' && r.durationMs > 0), 'every result has a positive durationMs');
    assert.ok(results.every((r) => typeof r.toolName === 'string' && r.toolName !== ''), 'every result carries a real toolName (M4)');
    assert.equal(atg.tracker.pendingCount(), 0, 'no row left pending after the follow-up');

    // The turn's tokens are counted EXACTLY ONCE despite three tool.call events sharing one `at`.
    const summary = atg.collector.summary();
    assert.equal(summary.totalInputTokens, 30, 'input tokens counted once for the whole turn');
    assert.equal(summary.totalOutputTokens, 60, 'output tokens counted once for the whole turn');
    assert.equal(summary.totalTokens, 90, 'turn tokens counted exactly once (no over-count)');
    assert.ok(summary.totalDurationMs !== undefined && summary.totalDurationMs > 0, 'non-zero total duration across the three results');
    for (const name of ['search_web', 'get_weather', 'fetch_url']) {
      const t = summary.topTools.find((tt) => tt.toolName === name);
      assert.ok(t, `topTools includes ${name}`);
      assert.ok(typeof t.avgDurationMs === 'number' && t.avgDurationMs > 0, `${name}.avgDurationMs defined (>0)`);
      assert.ok(typeof t.maxDurationMs === 'number' && t.maxDurationMs > 0, `${name}.maxDurationMs defined (>0)`);
    }
  } finally {
    unsub();
    await closeAtgServer(srv);
  }
});

// --- S-D: inconsistent / absent x-session-id between issue and resolution (M2) --
test('S-D: diverging or absent x-session-id cannot strand an issued call (cross-session id fallback)', async () => {
  const callBody = {
    id: 'chatcmpl-sd', object: 'chat.completion', created: 1700000000, model: 'gpt-4o-mini',
    choices: [{
      index: 0,
      message: {
        role: 'assistant', content: null,
        tool_calls: [
          { id: 'sd_1', type: 'function', function: { name: 'tool_d1', arguments: '{}' } },
          { id: 'sd_2', type: 'function', function: { name: 'tool_d2', arguments: '{}' } },
          { id: 'sd_3', type: 'function', function: { name: 'tool_d3', arguments: '{}' } },
        ],
      },
      finish_reason: 'tool_calls',
    }],
    usage: { prompt_tokens: 8, completion_tokens: 16, total_tokens: 24 },
  };
  const baseMsgs = [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: 'Do three different things.' },
  ];
  const ISSUE_SESSION = 'X'; // the issuing request's session key
  const { port, srv, atg } = await startAtgServer(
    {
      upstream: openaiUpstream(seqFetch([
        jsonRes(callBody), // Req1 (non-stream, session X) -> issues sd_1..sd_3 under session X
        jsonRes(FINAL_OPENAI_JSON), // Req2 (non-stream, NO header -> session '') -> resolves sd_1 + sd_2 via fallback
        sseRes(FINAL_OPENAI_SSE), // Req3 (streamed, DIVERGING header Y -> session Y) -> resolves sd_3 via fallback
      ])),
    },
    { ws: false },
  );
  const events: TelemetryEvent[] = [];
  const unsub = atg.bus.subscribe((ev) => { events.push(ev); });
  try {
    // Req1 issues all three under session 'X'.
    await post(port, '/v1/chat/completions', { model: 'gpt-4o-mini', messages: baseMsgs, stream: false }, { 'x-session-id': ISSUE_SESSION });
    await sleep(25);

    // Req2 carries NO x-session-id (session key '') but feeds back results for sd_1 + sd_2.
    await post(port, '/v1/chat/completions', {
      model: 'gpt-4o-mini', stream: false,
      messages: [
        ...baseMsgs,
        asstCall('sd_1', 'tool_d1'), toolRes('sd_1', 'tool_d1', 'r1'),
        asstCall('sd_2', 'tool_d2'), toolRes('sd_2', 'tool_d2', 'r2'),
      ],
    });
    await sleep(25);

    // Req3 uses a DIVERGING x-session-id ('Y' !== 'X') and feeds back the result for sd_3.
    const res3 = await post(port, '/v1/chat/completions', {
      model: 'gpt-4o-mini', stream: true,
      messages: [...baseMsgs, asstCall('sd_3', 'tool_d3'), toolRes('sd_3', 'tool_d3', 'r3')],
    }, { 'x-session-id': 'Y' });
    await res3.text();
    await sleep(25);

    // All three resolve despite the header mismatch; none is left pending.
    assert.equal(events.filter(isToolCall).length, 3, 'three tool.call events observed');
    const results = events.filter(isToolResult);
    assert.equal(results.length, 3, 'all three results resolved despite the diverging/absent session key');
    assert.ok(results.every((r) => typeof r.durationMs === 'number' && r.durationMs > 0), 'every result has a positive durationMs');
    assert.ok(results.every((r) => typeof r.toolName === 'string' && r.toolName !== ''), 'every result carries a real toolName (M4)');
    assert.equal(atg.tracker.pendingCount(), 0, 'no call stranded by a diverging or absent session key');

    const summary = atg.collector.summary();
    assert.ok(summary.totalDurationMs !== undefined && summary.totalDurationMs > 0, 'summary.totalDurationMs > 0');
    assert.ok(summary.avgDurationMs !== undefined && summary.avgDurationMs > 0, 'summary.avgDurationMs > 0');
    for (const name of ['tool_d1', 'tool_d2', 'tool_d3']) {
      const t = summary.topTools.find((tt) => tt.toolName === name);
      assert.ok(t, `topTools includes ${name}`);
      assert.ok(typeof t.avgDurationMs === 'number' && t.avgDurationMs > 0, `${name}.avgDurationMs defined (>0)`);
      assert.ok(typeof t.maxDurationMs === 'number' && t.maxDurationMs > 0, `${name}.maxDurationMs defined (>0)`);
    }
  } finally {
    unsub();
    await closeAtgServer(srv);
  }
});

// --- S-E: existing NON-STREAM paths remain green --------------------------------
test('S-E (openai non-stream): issue + result pairing is unchanged', async () => {
  const callBody = {
    id: 'chatcmpl-sea', object: 'chat.completion', created: 1700000000, model: 'gpt-4o-mini',
    choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: 'sea_1', type: 'function', function: { name: 'search_web', arguments: '{}' } }] }, finish_reason: 'tool_calls' }],
    usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
  };
  const baseMsgs = [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: 'Look it up, please.' },
  ];
  const SESS = 'sess-sea';
  const { port, srv, atg } = await startAtgServer(
    { upstream: openaiUpstream(seqFetch([jsonRes(callBody), jsonRes(FINAL_OPENAI_JSON)])) },
    { ws: false },
  );
  const events: TelemetryEvent[] = [];
  const unsub = atg.bus.subscribe((ev) => { events.push(ev); });
  try {
    await post(port, '/v1/chat/completions', { model: 'gpt-4o-mini', messages: baseMsgs, stream: false }, { 'x-session-id': SESS });
    await sleep(25);
    await post(port, '/v1/chat/completions', {
      model: 'gpt-4o-mini', stream: false,
      messages: [...baseMsgs, asstCall('sea_1', 'search_web'), toolRes('sea_1', 'search_web', '<web-results>')],
    }, { 'x-session-id': SESS });
    await sleep(25);

    assert.equal(events.filter(isToolCall).length, 1, 'the non-stream request emitted one tool.call');
    const results = events.filter(isToolResult);
    assert.equal(results.length, 1, 'the follow-up resolved into one real tool.result');
    assert.ok(results[0] && typeof results[0].durationMs === 'number' && results[0].durationMs > 0, 'durationMs is measured and positive');
    assert.ok(results[0] && typeof results[0].toolName === 'string' && results[0].toolName === 'search_web', 'toolName present on the result');
    assert.equal(atg.tracker.pendingCount(), 0, 'no row left pending');
  } finally {
    unsub();
    await closeAtgServer(srv);
  }
});

test('S-E (anthropic non-stream): issue + result pairing is unchanged', async () => {
  const callBody = {
    id: 'msg_seb', type: 'message', role: 'assistant', model: 'claude-3-opus',
    content: [
      { type: 'text', text: 'Running tools.' },
      { type: 'tool_use', id: 'seb_1', name: 'get_weather', input: { city: 'Paris' } },
      { type: 'tool_use', id: 'seb_2', name: 'search_web', input: { query: 'x' } },
    ],
    stop_reason: 'tool_use',
    usage: { input_tokens: 5, output_tokens: 15 },
  };
  const baseMsgs = [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: 'Check the weather and search for x.' },
  ];
  const SESS = 'sess-seb';
  const { port, srv, atg } = await startAtgServer(
    { upstream: anthropicUpstream(seqFetch([jsonRes(callBody), jsonRes({ id: 'msg_seb_done', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'done' }] })])) },
    { ws: false },
  );
  const events: TelemetryEvent[] = [];
  const unsub = atg.bus.subscribe((ev) => { events.push(ev); });
  try {
    await post(port, '/v1/messages', { model: 'claude-3-opus', messages: baseMsgs, stream: false }, { 'x-session-id': SESS });
    await sleep(25);
    await post(port, '/v1/messages', {
      model: 'claude-3-opus', stream: false,
      messages: [
        ...baseMsgs,
        {
          role: 'assistant', content: [
            { type: 'tool_use', id: 'seb_1', name: 'get_weather', input: { city: 'Paris' } },
            { type: 'tool_use', id: 'seb_2', name: 'search_web', input: { query: 'x' } },
          ],
        },
        {
          role: 'user', content: [
            { type: 'tool_result', tool_use_id: 'seb_1', content: 'sunny 20C' },
            { type: 'tool_result', tool_use_id: 'seb_2', content: '<web-results>' },
          ],
        },
      ],
    }, { 'x-session-id': SESS });
    await sleep(25);

    assert.equal(events.filter(isToolCall).length, 2, 'the non-stream Anthropic request emitted two tool.calls');
    const results = events.filter(isToolResult);
    assert.equal(results.length, 2, 'the follow-up resolved into two real tool.results');
    assert.ok(results.every((r) => typeof r.durationMs === 'number' && r.durationMs > 0), 'every result has a positive durationMs');
    assert.ok(results.every((r) => typeof r.toolName === 'string' && r.toolName !== ''), 'every result carries a real toolName (M4)');
    assert.equal(atg.tracker.pendingCount(), 0, 'no row left pending');
  } finally {
    unsub();
    await closeAtgServer(srv);
  }
});

// --- S-F: batch turn whose tool calls lack (or duplicate) upstream ids ------------------
// Verifies the stable-id contract end-to-end: an id-less call gets the deterministic
// `${sessionKey}#${at}#${index}` fallback and a colliding duplicate upstream id gets a
// monotonic suffix, so NO two siblings in the batch ever share an identical id (even
// though the non-streaming response carried no provider-supplied ids to pair results on).
test('S-F: a batch turn with missing/duplicate upstream tool ids still yields distinct synthesized ids', async () => {
  const callBody = {
    id: 'chatcmpl-sf', object: 'chat.completion', created: 1700000000, model: 'gpt-4o-mini',
    choices: [{
      index: 0,
      message: {
        role: 'assistant', content: null,
        tool_calls: [
          { type: 'function', function: { name: 'tool_a', arguments: '{}' } }, // no id -> synthetic fallback
          { id: 'dup', type: 'function', function: { name: 'tool_b', arguments: '{}' } }, // first 'dup'
          { id: 'dup', type: 'function', function: { name: 'tool_c', arguments: '{}' } }, // duplicate 'dup'
        ],
      },
      finish_reason: 'tool_calls',
    }],
    usage: { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 },
  };
  const SESS = 'sess-sf';
  const { port, srv, atg } = await startAtgServer(
    { upstream: openaiUpstream(seqFetch([jsonRes(callBody), jsonRes(FINAL_OPENAI_JSON)])) },
    { ws: false },
  );
  const events: TelemetryEvent[] = [];
  const unsub = atg.bus.subscribe((ev) => { events.push(ev); });
  try {
    await post(port, '/v1/chat/completions', { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'Do three things.' }], stream: false }, { 'x-session-id': SESS });

    const calls = events.filter(isToolCall);
    assert.equal(calls.length, 3, 'the batch turn emitted all three tool.call events');
    assert.ok(calls.every((c) => typeof c.id === 'string' && c.id !== ''), 'every tool.call carries a non-empty stable id');
    assert.equal(new Set(calls.map((c) => c.id)).size, 3, 'sibling tool.calls never share an identical id despite missing/duplicate upstream ids');

    const byName = (name: string): Extract<TelemetryEvent, { type: 'tool.call' }> =>
      calls.find((c) => c.toolName === name)!;
    assert.equal(byName('tool_b').id, 'dup', 'the first call carrying the upstream id keeps it verbatim');
    assert.equal(byName('tool_c').id, 'dup~1', 'a colliding duplicate upstream id gets a monotonic suffix');
    assert.equal(
      byName('tool_a').id,
      `${SESS}#${calls[0].at}#0`,
      'an id-less call gets a deterministic ${sessionKey}#${at}#${index} fallback id',
    );
    assert.ok(
      calls.every((c) => c.tokens !== undefined && c.tokens.input === 5 && c.tokens.output === 6 && c.tokens.total === 11),
      'every sibling still carries the normalized turn tokens (input/output/total)',
    );
  } finally {
    unsub();
    await closeAtgServer(srv);
  }
});

// --- tool.call description: taken from the request's `tools` array (by name) ---
// A request whose `tools` array carries descriptions produces tool.call events that
// carry the matching description (matched by the tool call's name). An unknown tool
// name (absent from the request's tools) yields NO description field at all.

const descByName = (calls: TelemetryEvent[], name: string): Extract<TelemetryEvent, { type: 'tool.call' }> | undefined =>
  calls.filter(isToolCall).find((c) => c.toolName === name);

// OpenAI wire shape: tools[i].function.{ name, description }.
test('tool.call carries the request-provided description (OpenAI function shape); unknown tools omit it', async () => {
  const callBody = {
    id: 'chatcmpl-dsc', object: 'chat.completion', created: 1700000000, model: 'gpt-4o-mini',
    choices: [{
      index: 0,
      message: {
        role: 'assistant', content: null,
        tool_calls: [
          { id: 'dsc_1', type: 'function', function: { name: 'search_web', arguments: '{"q":"x"}' } },
          { id: 'dsc_2', type: 'function', function: { name: 'mystery_tool', arguments: '{}' } },
        ],
      },
      finish_reason: 'tool_calls',
    }],
    usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
  };
  const reqTools = [
    { type: 'function', function: { name: 'search_web', description: 'Search the web for information.' } },
    { type: 'function', function: { name: 'get_weather', description: 'Get the current weather.' } },
  ];
  const SESS = 'sess-dsc';
  const { port, srv, atg } = await startAtgServer(
    { upstream: openaiUpstream(seqFetch([jsonRes(callBody), jsonRes(FINAL_OPENAI_JSON)])) },
    { ws: false },
  );
  const events: TelemetryEvent[] = [];
  const unsub = atg.bus.subscribe((ev) => { events.push(ev); });
  try {
    await post(port, '/v1/chat/completions', {
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'Search for x.' }],
      tools: reqTools,
      stream: false,
    }, { 'x-session-id': SESS });
    await sleep(25);

    const calls = events.filter(isToolCall);
    assert.equal(calls.length, 2, 'two tool.call events observed');
    const search = descByName(calls, 'search_web');
    assert.ok(search, 'search_web tool.call present');
    assert.equal(search?.description, 'Search the web for information.', 'the matched tool carries the request-provided description');
    const mystery = descByName(calls, 'mystery_tool');
    assert.ok(mystery, 'mystery_tool tool.call present (absent from the request tools)');
    assert.equal(mystery?.description, undefined, 'an unknown tool name yields no description');
    assert.ok(!('description' in mystery), 'no description key at all on the unknown tool call');
  } finally {
    unsub();
    await closeAtgServer(srv);
  }
});

// Anthropic wire shape: tools[i].{ name, description } (top-level, no `function` wrapper).
test('tool.call carries the request-provided description (Anthropic top-level shape); unknown tools omit it', async () => {
  const callBody = {
    id: 'msg_dsc', type: 'message', role: 'assistant', model: 'claude-3-opus',
    content: [
      { type: 'text', text: 'Searching.' },
      { type: 'tool_use', id: 'adsc_1', name: 'search_web', input: { q: 'x' } },
      { type: 'tool_use', id: 'adsc_2', name: 'mystery_tool', input: {} },
    ],
    stop_reason: 'tool_use',
    usage: { input_tokens: 5, output_tokens: 15 },
  };
  const reqTools = [
    { name: 'search_web', description: 'Search the web (Anthropic).' },
    { name: 'get_weather', description: 'Get the weather (Anthropic).' },
  ];
  const SESS = 'sess-adsc';
  const { port, srv, atg } = await startAtgServer(
    { upstream: anthropicUpstream(seqFetch([jsonRes(callBody), jsonRes({ id: 'msg_dsc_done', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'done' }] })])) },
    { ws: false },
  );
  const events: TelemetryEvent[] = [];
  const unsub = atg.bus.subscribe((ev) => { events.push(ev); });
  try {
    await post(port, '/v1/messages', {
      model: 'claude-3-opus',
      messages: [{ role: 'user', content: 'Search for x.' }],
      tools: reqTools,
      stream: false,
    }, { 'x-session-id': SESS });
    await sleep(25);

    const calls = events.filter(isToolCall);
    assert.equal(calls.length, 2, 'two tool.call events observed');
    const search = descByName(calls, 'search_web');
    assert.ok(search, 'search_web tool.call present');
    assert.equal(search?.description, 'Search the web (Anthropic).', 'the matched tool carries the request-provided description');
    const mystery = descByName(calls, 'mystery_tool');
    assert.ok(mystery, 'mystery_tool tool.call present (absent from the request tools)');
    assert.equal(mystery?.description, undefined, 'an unknown tool name yields no description');
    assert.ok(!('description' in mystery), 'no description key at all on the unknown tool call');
  } finally {
    unsub();
    await closeAtgServer(srv);
  }
});

// --- tool.call description on the STREAMED (SSE) path: same request-`tools` lookup --------
// The streamed extractor (telemetry/stream-extract.ts) is handed the request's raw body
// (requestCtx.raw) so each tool.call it emits from an SSE stream carries the request-provided
// tool description matched by the call's name — mirroring the buffered (proxy/context.ts)
// path. Unknown tool names (absent from the request tools) omit the field entirely.

test('STREAMED OpenAI: tool.call carries the request-provided description; unknown tools omit it', async () => {
  // OpenAI-shaped SSE stream issuing two tool calls: search_web (has a request description)
  // and mystery_tool (absent from the request tools -> no description field at all).
  const sseBody =
    'data: ' + JSON.stringify({ choices: [{ delta: { role: 'assistant', content: null, tool_calls: [{ index: 0, id: 'ssd_1', type: 'function', function: { name: 'search_web', arguments: '{"q":' } }] } }] }) + '\n\n' +
    'data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"x"}' } }] } }] }) + '\n\n' +
    'data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 1, id: 'ssd_2', type: 'function', function: { name: 'mystery_tool', arguments: '{}' } }] } }] }) + '\n\n' +
    'data: [DONE]\n\n';
  const reqTools = [
    { type: 'function', function: { name: 'search_web', description: 'Search the web (streamed OpenAI).' } },
    { type: 'function', function: { name: 'get_weather', description: 'Get the weather (streamed OpenAI).' } },
  ];
  const SESS = 'sess-ssd';
  const { port, srv, atg } = await startAtgServer(
    { upstream: openaiUpstream(seqFetch([sseRes(sseBody), jsonRes(FINAL_OPENAI_JSON)])) },
    { ws: false },
  );
  const events: TelemetryEvent[] = [];
  const unsub = atg.bus.subscribe((ev) => { events.push(ev); });
  try {
    const res = await post(port, '/v1/chat/completions', {
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'Search for x.' }],
      tools: reqTools,
      stream: true,
    }, { 'x-session-id': SESS });
    assert.equal(res.status, 200, 'the streamed OpenAI request must be HTTP 200');
    await res.text(); // drain the SSE so the extractor finalises + emits the tool.call events
    await sleep(25);

    const calls = events.filter(isToolCall);
    assert.equal(calls.length, 2, 'two streamed tool.call events observed');
    const search = descByName(calls, 'search_web');
    assert.ok(search, 'search_web streamed tool.call present');
    assert.equal(search?.description, 'Search the web (streamed OpenAI).', 'the matched tool carries the request-provided description');
    const mystery = descByName(calls, 'mystery_tool');
    assert.ok(mystery, 'mystery_tool streamed tool.call present (absent from the request tools)');
    assert.ok(!('description' in mystery), 'no description key at all on the unknown tool call');
  } finally {
    unsub();
    await closeAtgServer(srv);
  }
});

test('STREAMED Anthropic: tool.call carries the request-provided description; unknown tools omit it', async () => {
  // Native Anthropic SSE stream issuing two tool_use blocks: search_web (has a request
  // description) and mystery_tool (absent from the request tools -> no description field).
  const frames: Array<{ event: string; data: Record<string, unknown> }> = [
    { event: 'message_start', data: { type: 'message_start', message: { id: 'msg_sadsc', type: 'message', role: 'assistant', content: [], model: 'claude-3-opus', usage: { input_tokens: 20 } } } },
    { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Calling.' } } },
    { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
    { event: 'content_block_start', data: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'asd_1', name: 'search_web' } } },
    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"q":"x"}' } } },
    { event: 'content_block_stop', data: { type: 'content_block_stop', index: 1 } },
    { event: 'content_block_start', data: { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'asd_2', name: 'mystery_tool' } } },
    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{}' } } },
    { event: 'content_block_stop', data: { type: 'content_block_stop', index: 2 } },
    { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 40 } } },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ];
  const reqTools = [
    { name: 'search_web', description: 'Search the web (streamed Anthropic).' },
    { name: 'get_weather', description: 'Get the weather (streamed Anthropic).' },
  ];
  const SESS = 'sess-sadsc';
  const { port, srv, atg } = await startAtgServer(
    { upstream: anthropicUpstream(seqFetch([sseRes(anthropicSse(frames)), jsonRes({ id: 'msg_sadsc_done', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'done' }] })])) },
    { ws: false },
  );
  const events: TelemetryEvent[] = [];
  const unsub = atg.bus.subscribe((ev) => { events.push(ev); });
  try {
    const res = await post(port, '/v1/messages', {
      model: 'claude-3-opus',
      messages: [{ role: 'user', content: 'Search for x.' }],
      tools: reqTools,
      stream: true,
    }, { 'x-session-id': SESS });
    assert.equal(res.status, 200, 'the streamed Anthropic request must be HTTP 200');
    await res.text(); // drain the SSE so the extractor finalises + emits the tool.call events
    await sleep(25);

    const calls = events.filter(isToolCall);
    assert.equal(calls.length, 2, 'two streamed tool.call events observed');
    const search = descByName(calls, 'search_web');
    assert.ok(search, 'search_web streamed tool.call present');
    assert.equal(search?.description, 'Search the web (streamed Anthropic).', 'the matched tool carries the request-provided description');
    const mystery = descByName(calls, 'mystery_tool');
    assert.ok(mystery, 'mystery_tool streamed tool.call present (absent from the request tools)');
    assert.ok(!('description' in mystery), 'no description key at all on the unknown tool call');
  } finally {
    unsub();
    await closeAtgServer(srv);
  }
});

// --- S-G: ok field reflects is_error in BOTH emission paths (streamed + buffered) --
test('S-G: tool.result ok field reflects is_error in both streamed and buffered emission paths', async () => {
  // Req1 (buffered) issues two tool calls.
  const callBody = {
    id: 'msg_sga', type: 'message', role: 'assistant', model: 'claude-3-opus',
    content: [
      { type: 'text', text: 'Running tools.' },
      { type: 'tool_use', id: 'sga_1', name: 'test_tool', input: {} },
      { type: 'tool_use', id: 'sga_2', name: 'test_tool2', input: {} },
    ],
    stop_reason: 'tool_use',
  };
  // Text-only Anthropic SSE (no tool calls) for the streamed follow-up.
  const textOnlyFrames: Array<{ event: string; data: Record<string, unknown> }> = [
    { event: 'message_start', data: { type: 'message_start', message: { id: 'msg_sga_2', type: 'message', role: 'assistant', content: [], model: 'claude-3-opus', usage: { input_tokens: 10 } } } },
    { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } } },
    { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
    { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } } },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ];
  const baseMsgs = [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: 'Test the tools.' },
  ];
  const asstMsg = {
    role: 'assistant', content: [
      { type: 'text', text: 'Running tools.' },
      { type: 'tool_use', id: 'sga_1', name: 'test_tool', input: {} },
      { type: 'tool_use', id: 'sga_2', name: 'test_tool2', input: {} },
    ],
  };
  const SESS = 'sess-sga';
  const { port, srv, atg } = await startAtgServer(
    {
      upstream: anthropicUpstream(seqFetch([
        jsonRes(callBody),
        sseRes(anthropicSse(textOnlyFrames)),
        jsonRes({ id: 'msg_sga_3', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'done' }] }),
      ])),
    },
    { ws: false },
  );
  const events: TelemetryEvent[] = [];
  const unsub = atg.bus.subscribe((ev) => { events.push(ev); });
  try {
    // Req1 (buffered): issues two tool calls.
    await post(port, '/v1/messages', { model: 'claude-3-opus', messages: baseMsgs, stream: false }, { 'x-session-id': SESS });
    await sleep(25);

    // Req2 (STREAMED follow-up): feeds back is_error result for sga_1.
    const res2 = await post(port, '/v1/messages', {
      model: 'claude-3-opus', stream: true,
      messages: [
        ...baseMsgs, asstMsg,
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'sga_1', content: 'Error: something went wrong', is_error: true }] },
      ],
    }, { 'x-session-id': SESS });
    await res2.text();
    await sleep(25);

    // Req3 (BUFFERED follow-up): feeds back normal result for sga_2.
    await post(port, '/v1/messages', {
      model: 'claude-3-opus', stream: false,
      messages: [
        ...baseMsgs, asstMsg,
        { role: 'user', content: [
          { type: 'tool_result', tool_use_id: 'sga_1', content: 'Error: something went wrong', is_error: true },
          { type: 'tool_result', tool_use_id: 'sga_2', content: 'Success: all good' },
        ] },
      ],
    }, { 'x-session-id': SESS });
    await sleep(25);

    // Two tool.call events (both issued in Req1).
    const calls = events.filter(isToolCall);
    assert.equal(calls.length, 2, 'two tool.call events observed');

    // Two tool.result events: one per resolved call.
    const results = events.filter(isToolResult);
    assert.equal(results.length, 2, 'two tool.result events observed');

    // The is_error result (emitted via the STREAMED path) has ok === false.
    const failResult = results.find((r) => r.toolCallId === 'sga_1');
    assert.ok(failResult, 'sga_1 result present');
    assert.equal(failResult?.ok, false, 'is_error result has ok === false (emitted via streamed path)');

    // The normal result (emitted via the BUFFERED path) has ok === true.
    const okResult = results.find((r) => r.toolCallId === 'sga_2');
    assert.ok(okResult, 'sga_2 result present');
    assert.equal(okResult?.ok, true, 'normal result has ok === true (emitted via buffered path)');

    assert.equal(atg.tracker.pendingCount(), 0, 'no row left pending');
  } finally {
    unsub();
    await closeAtgServer(srv);
  }
});

// --- S-H: the OpenAI wire has NO native error flag — content alone indicates the failure -------
// A `role:'tool'` message whose content leads with an error marker (and carries no other flag)
// must emit a tool.result with ok:false, while a normal sibling result in the same turn stays
// ok:true.
const OAI_FAIL_CONTENT = "Error executing tool activate_project: ProjectNotFoundError: Project 'nonexistent-project-xyz' not found: Not a valid project name or directory. Existing project names: ['opencode-sandbox']";

test('S-H: an OpenAI role:"tool" result with a leading error marker yields ok:false; a normal sibling yields ok:true', async () => {
  const callBody = {
    id: 'chatcmpl-sha', object: 'chat.completion', created: 1700000000, model: 'gpt-4o-mini',
    choices: [{
      index: 0,
      message: {
        role: 'assistant', content: null,
        tool_calls: [
          { id: 'sha_1', type: 'function', function: { name: 'activate_project', arguments: '{}' } },
          { id: 'sha_2', type: 'function', function: { name: 'read_file', arguments: '{}' } },
        ],
      },
      finish_reason: 'tool_calls',
    }],
    usage: { prompt_tokens: 6, completion_tokens: 12, total_tokens: 18 },
  };
  const baseMsgs = [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: 'Activate the project, then read the file.' },
  ];
  const SESS = 'sess-sha';
  const { port, srv, atg } = await startAtgServer(
    { upstream: openaiUpstream(seqFetch([jsonRes(callBody), jsonRes(FINAL_OPENAI_JSON)])) },
    { ws: false },
  );
  const events: TelemetryEvent[] = [];
  const unsub = atg.bus.subscribe((ev) => { events.push(ev); });
  try {
    await post(port, '/v1/chat/completions', { model: 'gpt-4o-mini', messages: baseMsgs, stream: false }, { 'x-session-id': SESS });
    await sleep(25);

    // Req2 feeds back BOTH results: a failing one (only the content indicates the failure) and a normal one.
    await post(port, '/v1/chat/completions', {
      model: 'gpt-4o-mini', stream: false,
      messages: [
        ...baseMsgs,
        asstCall('sha_1', 'activate_project'), toolRes('sha_1', 'activate_project', OAI_FAIL_CONTENT),
        asstCall('sha_2', 'read_file'), toolRes('sha_2', 'read_file', 'file contents here'),
      ],
    }, { 'x-session-id': SESS });
    await sleep(25);

    assert.equal(events.filter(isToolCall).length, 2, 'two tool.call events observed');
    const results = events.filter(isToolResult);
    assert.equal(results.length, 2, 'two tool.result events observed');

    const failResult = results.find((r) => r.toolCallId === 'sha_1');
    assert.ok(failResult, 'the failing result is present');
    assert.equal(failResult?.ok, false, 'an OpenAI result whose content leads with an error marker has ok === false');
    assert.equal(failResult?.toolName, 'activate_project', 'the failing result carries the real toolName');

    const okResult = results.find((r) => r.toolCallId === 'sha_2');
    assert.ok(okResult, 'the normal result is present');
    assert.equal(okResult?.ok, true, 'a normal OpenAI result has ok === true');

    assert.equal(atg.tracker.pendingCount(), 0, 'no row left pending');
  } finally {
    unsub();
    await closeAtgServer(srv);
  }
});

// --- S-H2: an UNFLAGGED Anthropic tool_result whose content leads with an error marker ---------
// `is_error` is absent, but the content alone indicates the failure → still ok:false.
test('S-H2: an unflagged Anthropic tool_result with a leading error marker yields ok:false', async () => {
  const callBody = {
    id: 'msg_shb', type: 'message', role: 'assistant', model: 'claude-3-opus',
    content: [
      { type: 'text', text: 'Running the tests.' },
      { type: 'tool_use', id: 'shb_1', name: 'run_test', input: {} },
    ],
    stop_reason: 'tool_use',
  };
  const baseMsgs = [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: 'Run the tests.' },
  ];
  const SESS = 'sess-shb';
  const { port, srv, atg } = await startAtgServer(
    {
      upstream: anthropicUpstream(seqFetch([
        jsonRes(callBody),
        jsonRes({ id: 'msg_shb_done', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'done' }] }),
      ])),
    },
    { ws: false },
  );
  const events: TelemetryEvent[] = [];
  const unsub = atg.bus.subscribe((ev) => { events.push(ev); });
  try {
    await post(port, '/v1/messages', { model: 'claude-3-opus', messages: baseMsgs, stream: false }, { 'x-session-id': SESS });
    await sleep(25);

    // Req2 feeds back a tool_result with NO is_error flag; only the content indicates the failure.
    await post(port, '/v1/messages', {
      model: 'claude-3-opus', stream: false,
      messages: [
        ...baseMsgs,
        { role: 'assistant', content: [{ type: 'text', text: 'Running the tests.' }, { type: 'tool_use', id: 'shb_1', name: 'run_test', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'shb_1', content: 'Error: assertion failed at line 42' }] },
      ],
    }, { 'x-session-id': SESS });
    await sleep(25);

    const results = events.filter(isToolResult);
    assert.equal(results.length, 1, 'one tool.result event observed');
    assert.equal(results[0]?.ok, false, 'an unflagged Anthropic result with a leading error marker has ok === false');
    assert.equal(results[0]?.toolName, 'run_test', 'the result carries the real toolName');
    assert.equal(atg.tracker.pendingCount(), 0, 'no row left pending');
  } finally {
    unsub();
    await closeAtgServer(srv);
  }
});
