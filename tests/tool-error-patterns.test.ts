/**
 * Tool-result failure detection: the built-in leading-error-marker heuristic stays
 * correct by default, and user-supplied regex patterns (the `TOOL_ERROR_PATTERNS` env
 * var) are ADDITIVE — they catch a failure the heuristic misses without disabling the
 * heuristic. Covers the config parsing, the pure detection helpers, and the full
 * request→telemetry chain (emitted `tool.result.ok`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startAtgServer, closeAtgServer } from './helpers';
import type { FetchLike, UpstreamClient } from '../src/proxy/upstream';
import type { TelemetryEvent } from '../src/telemetry/events';
import { loadConfig } from '../config/config';
import { isErrorResultContent, isErrorResultContentByPatterns } from '../src/telemetry/protocol-common';

const isToolResult = (e: TelemetryEvent): e is Extract<TelemetryEvent, { type: 'tool.result' }> => e.type === 'tool.result';

// --- Unit: config parsing (valid / invalid / empty) ----------------------------
test('TOOL_ERROR_PATTERNS: a comma-separated list is parsed into trimmed, non-empty regex strings', () => {
  const cfg = loadConfig({ TOOL_ERROR_PATTERNS: '^Error executing tool,   ^BOOM: ,foo' } as NodeJS.ProcessEnv);
  assert.deepEqual(cfg.toolErrorPatterns, ['^Error executing tool', '^BOOM:', 'foo']);
});

test('TOOL_ERROR_PATTERNS: unset / blank / empty-comma entries all yield an empty pattern list', () => {
  assert.deepEqual(loadConfig({} as NodeJS.ProcessEnv).toolErrorPatterns, []);
  assert.deepEqual(loadConfig({ TOOL_ERROR_PATTERNS: '' } as NodeJS.ProcessEnv).toolErrorPatterns, []);
  assert.deepEqual(loadConfig({ TOOL_ERROR_PATTERNS: '   ' } as NodeJS.ProcessEnv).toolErrorPatterns, []);
  assert.deepEqual(loadConfig({ TOOL_ERROR_PATTERNS: ', ,,' } as NodeJS.ProcessEnv).toolErrorPatterns, []);
});

test('TOOL_ERROR_PATTERNS: an invalid regex string is stored as-is (validation is deferred to use-time)', () => {
  const cfg = loadConfig({ TOOL_ERROR_PATTERNS: '(unclosed' } as NodeJS.ProcessEnv);
  assert.deepEqual(cfg.toolErrorPatterns, ['(unclosed']);
});

// --- Unit: the default heuristic still fires (independent of any patterns) ------
test('the built-in leading-error-marker heuristic still fires on its own', () => {
  assert.equal(
    isErrorResultContent("Error executing tool activate_project: ProjectNotFoundError: not found"),
    true,
    'the exact MCP error string is caught by the default heuristic',
  );
  assert.equal(isErrorResultContent('Error: something went wrong'), true, 'Error: marker is caught');
  assert.equal(isErrorResultContent('Internal server error: 500'), true, 'internal server error is caught');
  assert.equal(isErrorResultContent('file contents here'), false, 'normal content is not flagged');
  assert.equal(isErrorResultContent('we handled the error gracefully'), false, 'mid-text "error" is not flagged');
});

// --- Unit: user patterns are ADDITIVE to the default heuristic ------------------
test('user patterns are additive: they catch what the heuristic misses and never disable it', () => {
  const patterns = ['^BOOM:'];
  // pattern-only match — the built-in heuristic alone does NOT flag it
  assert.equal(isErrorResultContent('BOOM: something went wrong'), false, 'heuristic alone does not match BOOM:');
  assert.equal(isErrorResultContentByPatterns('BOOM: something went wrong', patterns), true, 'user pattern matches');
  // case-insensitive
  assert.equal(isErrorResultContentByPatterns('boom: something went wrong', patterns), true, 'patterns are case-insensitive');
  // normal content matches neither
  assert.equal(isErrorResultContentByPatterns('file contents here', patterns), false, 'no pattern / heuristic match');
  // an invalid pattern is skipped (never throws) and simply does not match
  assert.equal(isErrorResultContentByPatterns('BOOM: something', ['(unclosed', '^BOOM:']), true, 'valid pattern still matches alongside an invalid one');
  assert.equal(isErrorResultContentByPatterns('anything at all', ['(unclosed']), false, 'an invalid pattern is skipped, not a crash');
  assert.equal(isErrorResultContentByPatterns('anything at all', []), false, 'no patterns -> false');
});

// --- E2E helpers (same shape as tool-result-pairing.test.ts) -------------------
const OAI_FAIL_CONTENT =
  "Error executing tool activate_project: ProjectNotFoundError: Project 'nonexistent-project-xyz' not found: Not a valid project name or directory. Existing project names: ['opencode-sandbox']";
const FINAL_OPENAI_JSON = {
  id: 'chatcmpl-final', object: 'chat.completion', created: 1700000000, model: 'gpt-4o-mini',
  choices: [{ index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }],
};
function jsonRes(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
function seqFetch(responses: Response[]): FetchLike {
  let i = 0;
  return async () => responses[Math.min(i++, responses.length - 1)];
}
function openaiUpstream(fetchImpl: FetchLike): UpstreamClient {
  return { baseUrl: 'http://127.0.0.1:9999/v1', model: 'gpt-4o-mini', protocol: 'openai', fetchImpl };
}
function asstCall(id: string, name: string): Record<string, unknown> {
  return { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: '{}' } }] };
}
function toolRes(id: string, name: string, content: string): Record<string, unknown> {
  return { role: 'tool', tool_call_id: id, name, content };
}
async function post(port: number, path: string, body: Record<string, unknown>, extraHeaders?: Record<string, string>): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(extraHeaders ?? {}) };
  return fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// --- E2E (DEFAULTS, no config set): the exact user string -> ok:false ----------
test('e2e DEFAULTS: an OpenAI role:"tool" result carrying the exact MCP error string yields ok:false; a normal sibling yields ok:true', async () => {
  delete process.env.TOOL_ERROR_PATTERNS; // ensure the heuristic-only default
  const callBody = {
    id: 'chatcmpl-tea', object: 'chat.completion', created: 1700000000, model: 'gpt-4o-mini',
    choices: [{
      index: 0,
      message: {
        role: 'assistant', content: null,
        tool_calls: [
          { id: 'tea_1', type: 'function', function: { name: 'activate_project', arguments: '{}' } },
          { id: 'tea_2', type: 'function', function: { name: 'read_file', arguments: '{}' } },
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
  const SESS = 'sess-tea';
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
      messages: [
        ...baseMsgs,
        asstCall('tea_1', 'activate_project'), toolRes('tea_1', 'activate_project', OAI_FAIL_CONTENT),
        asstCall('tea_2', 'read_file'), toolRes('tea_2', 'read_file', 'file contents here'),
      ],
    }, { 'x-session-id': SESS });
    await sleep(25);

    const results = events.filter(isToolResult);
    assert.equal(results.length, 2, 'two tool.result events observed');
    const failResult = results.find((r) => r.toolCallId === 'tea_1');
    assert.ok(failResult, 'the failing result is present');
    assert.equal(failResult?.ok, false, 'the exact MCP error string has ok === false under DEFAULTS (built-in heuristic)');
    assert.equal(failResult?.toolName, 'activate_project', 'the failing result carries the real toolName');
    const okResult = results.find((r) => r.toolCallId === 'tea_2');
    assert.ok(okResult, 'the normal result is present');
    assert.equal(okResult?.ok, true, 'a normal OpenAI result has ok === true under DEFAULTS');
    assert.equal(atg.tracker.pendingCount(), 0, 'no row left pending');
  } finally {
    unsub();
    await closeAtgServer(srv);
  }
});

// --- E2E (user pattern, env-set): a pattern-only match -> ok:false -------------
test('e2e USER PATTERN (env-set): a result matching ONLY a user pattern yields ok:false; a normal result yields ok:true', async () => {
  process.env.TOOL_ERROR_PATTERNS = '^ProjectNotFound';
  // A failure that does NOT match the built-in heuristic (it does not lead with "Error")
  // but DOES match the user-supplied pattern.
  const USER_ONLY_FAIL = "ProjectNotFound: Project 'nope' not found";
  const callBody = {
    id: 'chatcmpl-teb', object: 'chat.completion', created: 1700000000, model: 'gpt-4o-mini',
    choices: [{
      index: 0,
      message: {
        role: 'assistant', content: null,
        tool_calls: [
          { id: 'teb_1', type: 'function', function: { name: 'activate_project', arguments: '{}' } },
          { id: 'teb_2', type: 'function', function: { name: 'read_file', arguments: '{}' } },
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
  const SESS = 'sess-teb';
  const { port, srv, atg } = await startAtgServer(
    { upstream: openaiUpstream(seqFetch([jsonRes(callBody), jsonRes(FINAL_OPENAI_JSON)])) },
    { ws: false },
  );
  const events: TelemetryEvent[] = [];
  const unsub = atg.bus.subscribe((ev) => { events.push(ev); });
  try {
    assert.equal(isErrorResultContent(USER_ONLY_FAIL), false, 'the user-only content is NOT caught by the built-in heuristic');
    await post(port, '/v1/chat/completions', { model: 'gpt-4o-mini', messages: baseMsgs, stream: false }, { 'x-session-id': SESS });
    await sleep(25);
    await post(port, '/v1/chat/completions', {
      model: 'gpt-4o-mini', stream: false,
      messages: [
        ...baseMsgs,
        asstCall('teb_1', 'activate_project'), toolRes('teb_1', 'activate_project', USER_ONLY_FAIL),
        asstCall('teb_2', 'read_file'), toolRes('teb_2', 'read_file', 'file contents here'),
      ],
    }, { 'x-session-id': SESS });
    await sleep(25);

    const results = events.filter(isToolResult);
    assert.equal(results.length, 2, 'two tool.result events observed');
    const failResult = results.find((r) => r.toolCallId === 'teb_1');
    assert.ok(failResult, 'the user-pattern result is present');
    assert.equal(failResult?.ok, false, 'a result matching only a user pattern has ok === false');
    const okResult = results.find((r) => r.toolCallId === 'teb_2');
    assert.ok(okResult, 'the normal result is present');
    assert.equal(okResult?.ok, true, 'a normal result has ok === true');
    assert.equal(atg.tracker.pendingCount(), 0, 'no row left pending');
  } finally {
    delete process.env.TOOL_ERROR_PATTERNS;
    unsub();
    await closeAtgServer(srv);
  }
});
