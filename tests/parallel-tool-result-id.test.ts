/**
 * N >= 3 PARALLEL same-name tool calls issued in ONE turn (same session) must pair into
 * N DISTINCT tool.result events, EACH carrying a stable `id` equal to its issuing call's
 * `id`. This is the exact contract the dashboard dedups on (`type|sessionKey|at|toolName|id`):
 * before the fix, tool.result events carried NO `id`, so N same-name same-turn results shared
 * an identical key and collapsed onto a single dashboard row (only the first resolved).
 *
 * Exercises the FULL chain (client request -> proxy -> bus -> tracker -> collector) over a
 * real server against a fake upstream, mirroring tests/tool-result-pairing.test.ts and
 * tests/e2e-integration.test.ts. Read via casts so the file COMPILES (and thus runs) both
 * before and after the backend adds `id` to ToolResultEvent; the runtime assertions are what
 * fail before / pass after.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type McmServer } from '../src/server/index';
import type { FetchLike, UpstreamClient } from '../src/proxy/upstream';
import type { TelemetryEvent } from '../src/telemetry/events';

type ServerOpts = Parameters<typeof createServer>[1];
type MountOpts = Parameters<typeof createServer>[2];

const isToolCall = (e: TelemetryEvent): e is Extract<TelemetryEvent, { type: 'tool.call' }> => e.type === 'tool.call';
const isToolResult = (e: TelemetryEvent): e is Extract<TelemetryEvent, { type: 'tool.result' }> => e.type === 'tool.result';
/** Read an event field that only exists post-fix, without forcing a pre-fix compile error. */
const field = <T>(ev: TelemetryEvent, name: string): T | undefined => (ev as unknown as Record<string, T | undefined>)[name];

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
/** Upstream whose N-th fetch returns the N-th prebuilt Response (last repeats when exhausted). */
function seqFetch(responses: Response[]): FetchLike {
  let i = 0;
  return async () => responses[Math.min(i++, responses.length - 1)];
}
/** An OpenAI assistant tool-call message (history for pairing). */
function asstCall(id: string, name: string, args: Record<string, unknown> = {}): Record<string, unknown> {
  return { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] };
}
/** An OpenAI role:'tool' result message (the resolved artifact). */
function toolRes(id: string, name: string, content: string): Record<string, unknown> {
  return { role: 'tool', tool_call_id: id, name, content };
}

// --- server lifecycle ----------------------------------------------------------
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
async function post(port: number, path: string, body: Record<string, unknown>, extraHeaders?: Record<string, string>): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(extraHeaders ?? {}) };
  return fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
function openaiUpstream(fetchImpl: FetchLike): UpstreamClient {
  return { baseUrl: 'http://127.0.0.1:9999/v1', model: 'gpt-4o-mini', protocol: 'openai', fetchImpl };
}

// --- N parallel same-name same-turn calls -> N distinct-id results --------------
test('N parallel same-name same-turn tool calls pair into N distinct stable-id tool.results', async () => {
  const N = 3;
  const TOOL = 'read_file';
  const SESS = 'sess-par-dash';
  const ids = ['par_1', 'par_2', 'par_3'];
  const callBody = {
    id: 'chatcmpl-par', object: 'chat.completion', created: 1700000000, model: 'gpt-4o-mini',
    choices: [{
      index: 0,
      message: {
        role: 'assistant', content: null,
        // THREE parallel calls, ALL the SAME tool name, in ONE turn.
        tool_calls: ids.map((id, i) => ({ id, type: 'function', function: { name: TOOL, arguments: JSON.stringify({ path: `f${i}` }) } })),
      },
      finish_reason: 'tool_calls',
    }],
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
  };
  const baseMsgs = [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: `Read ${N} files in parallel.` },
  ];
  const { port, srv, mcm } = await startServer(
    { upstream: openaiUpstream(seqFetch([jsonRes(callBody), jsonRes(FINAL_OPENAI_JSON)])) },
    { ws: false },
  );
  const events: TelemetryEvent[] = [];
  const unsub = mcm.bus.subscribe((ev) => { events.push(ev); });
  try {
    // Req1: the model issues N same-name tool calls in ONE turn.
    await post(port, '/v1/chat/completions', { model: 'gpt-4o-mini', messages: baseMsgs, stream: false }, { 'x-session-id': SESS });
    await sleep(25);

    // Req2: ONE follow-up request carries ALL N tool results (same session).
    const followUps: Record<string, unknown>[] = [];
    for (const id of ids) {
      followUps.push(asstCall(id, TOOL));
      followUps.push(toolRes(id, TOOL, `<content-${id}>`));
    }
    await post(port, '/v1/chat/completions', { model: 'gpt-4o-mini', stream: false, messages: [...baseMsgs, ...followUps] }, { 'x-session-id': SESS });
    await sleep(25);

    // The N issued calls carry N DISTINCT stable ids.
    const calls = events.filter(isToolCall);
    assert.equal(calls.length, N, 'exactly N tool.call events observed');
    assert.ok(calls.every((c) => typeof c.id === 'string' && c.id !== ''), 'every batch tool.call carries a stable non-empty id');
    assert.equal(new Set(calls.map((c) => c.id)).size, N, 'the N sibling batch tool.calls have N distinct ids');

    // The N results each carry a DISTINCT stable id EQUAL to their issuing call's id.
    const results = events.filter(isToolResult);
    assert.equal(results.length, N, 'exactly N tool.result events observed (#call == #result)');
    const callIds = new Set(calls.map((c) => c.id));
    assert.ok(
      results.every((r) => { const id = field<string>(r, 'id'); return typeof id === 'string' && id !== ''; }),
      'every tool.result carries a stable non-empty id (it was EMPTY before the fix)',
    );
    assert.equal(new Set(results.map((r) => field<string>(r, 'id'))).size, N, 'the N sibling tool.results have N distinct ids (no dashboard key collapse)');
    for (const r of results) {
      const rid = field<string>(r, 'id');
      assert.ok(callIds.has(rid), `tool.result id ${rid} equals an issued tool.call id`);
      assert.equal(rid, r.toolCallId, 'tool.result.id equals its toolCallId (the resolved entry id that matched the issued call)');
    }
    assert.ok(results.every((r) => typeof r.durationMs === 'number' && r.durationMs > 0), 'every result has a positive durationMs');
    assert.ok(results.every((r) => typeof r.toolName === 'string' && r.toolName !== ''), 'every result carries a real toolName');

    // No issued call remains stuck pending after the single follow-up.
    assert.equal(mcm.tracker.pendingCount(), 0, 'no row left pending after the single follow-up');
  } finally {
    unsub();
    await closeServer(srv);
  }
});
