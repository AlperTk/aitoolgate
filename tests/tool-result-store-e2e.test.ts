/**
 * Integration test: process a real tool result THROUGH the proxy (client request -> proxy ->
 * tracker -> shared store), then retrieve its RAW content over `GET /api/tool-results/:id`.
 * Also asserts the WebSocket {@link ToolResultEvent} remains METADATA-ONLY — no raw content is
 * added to the event or the WS JSON frame (the REST endpoint is the sole carrier of the payload).
 * Mirrors tests/parallel-tool-result-id.test.ts and tests/e2e-integration.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startAtgServer, closeAtgServer } from './helpers';
import type { FetchLike, UpstreamClient } from '../src/proxy/upstream';
import type { TelemetryEvent } from '../src/telemetry/events';
import { MAX_TOOL_RESULT_CONTENT_CHARS } from '../src/proxy/context';

const isToolResult = (e: TelemetryEvent): e is Extract<TelemetryEvent, { type: 'tool.result' }> => e.type === 'tool.result';

// --- response builders ---------------------------------------------------------
/** A non-streaming JSON upstream Response. */
function jsonRes(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
/** Upstream whose N-th fetch returns the N-th prebuilt Response (last repeats when exhausted). */
function seqFetch(responses: Response[]): FetchLike {
  let i = 0;
  return async () => responses[Math.min(i++, responses.length - 1)];
}
/** An OpenAI assistant tool-call message (history for pairing). */
function asstCall(id: string, name: string, args: Record<string, unknown> = {}): Record<string, unknown> {
  return { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] };
}
/** An OpenAI role:'tool' result message (the resolved artifact whose content is stored). */
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

test('a processed tool result is retrievable over GET /api/tool-results/:id and the WS event stays metadata-only', async () => {
  const TOOL = 'bash';
  const SESS = 'sess-tr-store';
  const SHORT = 'short-result-content';
  const LONG = 'longresultpayload'.repeat(2_000); // > MAX_TOOL_RESULT_CONTENT_CHARS (34,000 chars)
  const ids = ['tr_short', 'tr_long'];

  const callBody = {
    id: 'chatcmpl-tr', object: 'chat.completion', created: 1700000000, model: 'gpt-4o-mini',
    choices: [{
      index: 0,
      message: {
        role: 'assistant', content: null,
        tool_calls: [
          { id: ids[0], type: 'function', function: { name: TOOL, arguments: JSON.stringify({ cmd: 'ls' }) } },
          { id: ids[1], type: 'function', function: { name: TOOL, arguments: JSON.stringify({ cmd: 'cat big.txt' }) } },
        ],
      },
      finish_reason: 'tool_calls',
    }],
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
  };
  const finalJson = {
    id: 'chatcmpl-final', object: 'chat.completion', created: 1700000000, model: 'gpt-4o-mini',
    choices: [{ index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }],
  };
  const baseMsgs = [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: 'Run two commands.' },
  ];

  const { port, srv, atg } = await startAtgServer(
    { upstream: openaiUpstream(seqFetch([jsonRes(callBody), jsonRes(finalJson)])) },
    { ws: false },
  );
  const events: TelemetryEvent[] = [];
  const unsub = atg.bus.subscribe((ev) => { events.push(ev); });
  try {
    // Req1: the model issues two tool calls in one turn.
    await post(port, '/v1/chat/completions', { model: 'gpt-4o-mini', messages: baseMsgs, stream: false }, { 'x-session-id': SESS });
    await sleep(25);

    // Req2: one follow-up carries both tool results (same session) -> resolved + stored.
    const followUps: Record<string, unknown>[] = [
      asstCall(ids[0], TOOL),
      toolRes(ids[0], TOOL, SHORT),
      asstCall(ids[1], TOOL),
      toolRes(ids[1], TOOL, LONG),
    ];
    await post(port, '/v1/chat/completions', { model: 'gpt-4o-mini', stream: false, messages: [...baseMsgs, ...followUps] }, { 'x-session-id': SESS });
    await sleep(25);

    // Both results were resolved into the SHARED store (full chain: proxy -> tracker -> store).
    assert.equal(atg.toolResultStore.size(), 2, 'the shared store holds both processed results');
    const shortStored = atg.toolResultStore.get(ids[0]);
    assert.ok(shortStored !== undefined, 'short result is stored under its stable id');
    assert.equal(shortStored!.id, ids[0]);
    assert.equal(shortStored!.content, SHORT, 'short result content round-trips fully');
    assert.equal(shortStored!.chars, SHORT.length, 'chars reflects the full payload length');

    const longStored = atg.toolResultStore.get(ids[1]);
    assert.ok(longStored !== undefined, 'long result is stored under its stable id');
    assert.equal(longStored!.content.length, MAX_TOOL_RESULT_CONTENT_CHARS, 'long content is capped to the configured bound');
    assert.equal(longStored!.content, LONG.slice(0, MAX_TOOL_RESULT_CONTENT_CHARS));
    assert.equal(longStored!.chars, LONG.length, 'chars reflects the FULL (uncapped) payload length');

    // Retrievable over the REST endpoint (200 { content, chars }).
    const gotShort = await fetch(`http://127.0.0.1:${port}/api/tool-results/${ids[0]}`);
    assert.equal(gotShort.status, 200);
    assert.match(gotShort.headers.get('content-type') ?? '', /application\/json/);
    const shortBody = (await gotShort.json()) as { content: string; chars: number };
    assert.equal(shortBody.content, SHORT);
    assert.equal(shortBody.chars, SHORT.length);

    const gotLong = await fetch(`http://127.0.0.1:${port}/api/tool-results/${ids[1]}`);
    assert.equal(gotLong.status, 200);
    const longBody = (await gotLong.json()) as { content: string; chars: number };
    assert.equal(longBody.content.length, MAX_TOOL_RESULT_CONTENT_CHARS);
    assert.equal(longBody.chars, LONG.length);

    // Unknown id -> 404 { error:'not_found' }.
    const gotMissing = await fetch(`http://127.0.0.1:${port}/api/tool-results/does-not-exist`);
    assert.equal(gotMissing.status, 404);
    assert.deepEqual(await gotMissing.json(), { error: 'not_found' });

    // The WS ToolResultEvent stays METADATA-ONLY: no raw content on the event or its JSON frame.
    const results = events.filter(isToolResult);
    assert.equal(results.length, 2, 'both processed results emitted a tool.result event');
    for (const r of results) {
      assert.ok(!('content' in r), 'the tool.result event carries NO raw-content field');
      assert.ok(typeof r.durationMs === 'number' && r.durationMs > 0, 'durationMs still present (metadata unchanged)');
      assert.equal(r.toolName, TOOL, 'toolName still present (metadata unchanged)');
      assert.equal(r.id, r.toolCallId, 'stable id == toolCallId (unchanged)');
      const frame = JSON.stringify(r); // exactly what the WS broadcasts to clients
      assert.ok(!frame.includes(SHORT), 'WS frame does not embed the short payload');
      assert.ok(!frame.includes(LONG.slice(0, 32)), 'WS frame does not embed the long payload');
    }
  } finally {
    unsub();
    await closeAtgServer(srv);
  }
});
