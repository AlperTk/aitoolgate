/**
 * End-to-end: a batched turn (one response with MULTIPLE tool calls) omits
 * per-call tokens from EVERY emitted tool.call event on BOTH telemetry paths,
 * surfacing the turn's total exactly once via the whole-turn turn.usage event,
 * and /api/stats still counts the turn exactly once (the collector dedups tokens
 * per (sessionKey, at)).
 *  - Buffered (non-streaming) path: batched tool.calls omit per-call tokens and
 *    the whole-turn turn.usage is emitted once carrying the turn's total.
 *  - SSE path: batched tool.calls are emitted at stream end WITHOUT per-call
 *    tokens; the merged turn usage is carried by the whole-turn turn.usage
 *    (a stream with no usage frame emits no turn.usage — "omit, don't fabricate").
 *  - A single-call turn is unchanged: its one tool.call carries the turn tokens.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startAtgServer, closeAtgServer } from './helpers';
import type { FetchLike, UpstreamClient } from '../src/proxy/upstream';
import type { TelemetryEvent } from '../src/telemetry/events';

const isToolCall = (e: TelemetryEvent): e is Extract<TelemetryEvent, { type: 'tool.call' }> => e.type === 'tool.call';
const isTurnUsage = (e: TelemetryEvent): e is Extract<TelemetryEvent, { type: 'turn.usage' }> => e.type === 'turn.usage';

function upstream(fetchImpl: FetchLike): UpstreamClient {
  return { baseUrl: 'http://127.0.0.1:9999/v1', model: 'gpt-4o-mini', protocol: 'openai', fetchImpl };
}
function jsonFetch(canned: unknown): FetchLike {
  return async () => new Response(JSON.stringify(canned), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
function sseFetch(text: string): FetchLike {
  const enc = new TextEncoder();
  return async () =>
    new Response(
      new ReadableStream({ start: (c) => { c.enqueue(enc.encode(text)); c.close(); } }),
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    );
}
const delta = (d: unknown): string => `data: ${JSON.stringify({ choices: [{ delta: d }] })}\n\n`;
function chatBody(): Record<string, unknown> {
  return {
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: 'Look it up, please.' }],
    tools: [
      { type: 'function', function: { name: 'search_web', description: 'Search the web.', parameters: { type: 'object', properties: { query: { type: 'string' } } } } },
    ],
  };
}
async function post(port: number, body: Record<string, unknown>): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}
async function stats(port: number): Promise<{ totalInputTokens: number; totalOutputTokens: number; totalTokens: number }> {
  const res = await fetch(`http://127.0.0.1:${port}/api/stats`);
  assert.equal(res.status, 200, 'GET /api/stats must be HTTP 200');
  return res.json() as Promise<{ totalInputTokens: number; totalOutputTokens: number; totalTokens: number }>;
}

// E-A: buffered batched turn — batched tool.calls omit per-call tokens, the whole-turn
// turn.usage carries the turn's total once, and /api/stats counts the turn exactly once.
test('E-A: buffered batched turn — tool.calls omit per-call tokens; turn.usage carries the turn total; stats count it once', async () => {
  const canned = {
    id: 'chatcmpl-batch-a',
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
            { id: 'call_a', type: 'function', function: { name: 'search_web', arguments: '{"query":"a"}' } },
            { id: 'call_b', type: 'function', function: { name: 'search_web', arguments: '{"query":"b"}' } },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
  };
  const { port, srv, atg } = await startAtgServer({ upstream: upstream(jsonFetch(canned)) }, { ws: false });
  const events: TelemetryEvent[] = [];
  const unsub = atg.bus.subscribe((ev) => { events.push(ev); });
  try {
    const res = await post(port, chatBody());
    assert.equal(res.status, 200, 'the proxied response must be HTTP 200');
    await res.arrayBuffer(); // drain the body so all bus emission has completed

    const calls = events.filter(isToolCall);
    assert.equal(calls.length, 2, 'both batched tool.calls were emitted');
    assert.equal(new Set(calls.map((c) => c.at)).size, 1, 'every tool.call in the turn shares one turn-level `at`');
    for (const call of calls) {
      assert.equal(
        call.tokens,
        undefined,
        `the batched call ${call.id} omits per-call tokens (the turn.usage carries the turn's total)`,
      );
    }
    const turnUsages = events.filter(isTurnUsage);
    assert.equal(turnUsages.length, 1, 'the whole-turn turn.usage is emitted once');
    assert.equal(turnUsages[0].tokens.total, 30, 'the turn.usage carries the full turn total tokens');
    assert.equal(turnUsages[0].tokens.input, 10, 'the turn.usage carries the full turn input tokens');
    assert.equal(turnUsages[0].tokens.output, 20, 'the turn.usage carries the full turn output tokens');

    const s = await stats(port);
    assert.equal(s.totalInputTokens, 10, 'stats counts the turn input tokens exactly once');
    assert.equal(s.totalOutputTokens, 20, 'stats counts the turn output tokens exactly once');
    assert.equal(s.totalTokens, 30, 'stats counts the turn total tokens exactly once');
  } finally {
    unsub();
    await closeAtgServer(srv);
  }
});

// E-B: SSE batched turn — batched tool.calls (all of them, not just the last) are emitted at
// stream end WITHOUT per-call tokens; the merged turn usage rides on the whole-turn turn.usage;
// the stats still count the turn once.
test('E-B: SSE batched turn — tool.calls omit per-call tokens; turn.usage carries the merged usage; stats count it once', async () => {
  const sse =
    delta({ tool_calls: [{ index: 0, id: 'call_a', function: { name: 'search_web' } }] }) +
    delta({ tool_calls: [{ index: 0, function: { arguments: '{"query":"a"}' } }] }) +
    delta({ tool_calls: [{ index: 1, id: 'call_b', function: { name: 'search_web' } }] }) +
    delta({ tool_calls: [{ index: 1, function: { arguments: '{"query":"b"}' } }] }) +
    `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } })}\n\n` +
    'data: [DONE]\n\n';
  const { port, srv, atg } = await startAtgServer({ upstream: upstream(sseFetch(sse)) }, { ws: false });
  const events: TelemetryEvent[] = [];
  const unsub = atg.bus.subscribe((ev) => { events.push(ev); });
  try {
    const res = await post(port, { ...chatBody(), stream: true });
    assert.equal(res.status, 200, 'the streaming response must be HTTP 200');
    assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/, 'response content-type must be event-stream');
    const text = await res.text(); // drain the stream so the extractor flushes (finish) at stream end
    assert.ok(text.includes('call_a') && text.includes('[DONE]'), 'the raw SSE pass-through reaches the client');

    const calls = events.filter(isToolCall);
    assert.equal(calls.length, 2, 'both batched streamed tool.calls were emitted');
    assert.equal(new Set(calls.map((c) => c.at)).size, 1, 'every tool.call in the turn shares one turn-level `at`');
    for (const call of calls) {
      assert.equal(
        call.tokens,
        undefined,
        `the batched call ${call.id} omits per-call tokens (the turn.usage carries the merged usage)`,
      );
    }
    const turnUsages = events.filter(isTurnUsage);
    assert.equal(turnUsages.length, 1, 'the whole-turn turn.usage is emitted once');
    assert.equal(turnUsages[0].tokens.total, 30, 'the turn.usage carries the merged turn usage total');

    const s = await stats(port);
    assert.equal(s.totalInputTokens, 10, 'stats counts the turn input tokens exactly once');
    assert.equal(s.totalOutputTokens, 20, 'stats counts the turn output tokens exactly once');
    assert.equal(s.totalTokens, 30, 'stats counts the turn total tokens exactly once');
  } finally {
    unsub();
    await closeAtgServer(srv);
  }
});

// E-C: single-call turn unchanged — one tool.call carries the tokens + one
// turn.usage, and the stats count the turn once.
test('E-C: single-call turn unchanged — one tool.call carries the tokens; stats count it once', async () => {
  const canned = {
    id: 'chatcmpl-batch-c',
    object: 'chat.completion',
    created: 1700000000,
    model: 'gpt-4o-mini',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call_s', type: 'function', function: { name: 'search_web', arguments: '{"query":"s"}' } }],
        },
        finish_reason: 'tool_calls',
      },
    ],
    usage: { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 },
  };
  const { port, srv, atg } = await startAtgServer({ upstream: upstream(jsonFetch(canned)) }, { ws: false });
  const events: TelemetryEvent[] = [];
  const unsub = atg.bus.subscribe((ev) => { events.push(ev); });
  try {
    const res = await post(port, chatBody());
    assert.equal(res.status, 200, 'the proxied response must be HTTP 200');
    await res.arrayBuffer();

    const calls = events.filter(isToolCall);
    assert.equal(calls.length, 1, 'the single tool.call was emitted');
    assert.ok(calls[0].tokens !== undefined && calls[0].tokens.input === 5 && calls[0].tokens.total === 11,
      'the call carries the turn tokens');
    assert.equal(events.filter(isTurnUsage).length, 1, 'the whole-turn turn.usage is emitted');

    const s = await stats(port);
    assert.equal(s.totalTokens, 11, 'stats counts the single-call turn exactly once');
  } finally {
    unsub();
    await closeAtgServer(srv);
  }
});
