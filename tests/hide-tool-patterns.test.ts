import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveHiddenToolNames, hideToolStrategy } from '../src/policy/actions/hideTool';
import { validateSpec, buildAction } from '../src/api/ruleSpec';
import type { ActionEffect } from '../src/policy/actions';
import type { RequestContext } from '../src/ports/pipeline';

/**
 * Unit + action-level tests for the `hideTool` action's block-list vs
 * allow-list `toolNames` config:
 *
 *   - `resolveHiddenToolNames`: a block-list (no entry starts with `!`) hides the
 *     tools matching any entry's base pattern; an allow-list (any entry starts with
 *     `!`) keeps only the tools matching any entry's base pattern and hides everything
 *     else (the union of all base patterns). Exact names and globs both work; only
 *     names actually present in the request's tool definitions are hidden.
 *   - spec validation: `toolNames` must be a non-empty array of non-empty strings; a
 *     lone `!` (an empty base pattern) is rejected.
 *   - resolution flow (action-level): the CONCRETE resolved names are stripped from
 *     BOTH `raw.tools` (definitions) and message references, in BOTH provider shapes
 *     (OpenAI + Anthropic) — for a block-list and for an allow-list (single + multi).
 */

// --- resolution: block-list (no entry starts with !) -----------------------

test('resolveHiddenToolNames: a block-list (single prefix glob) hides only the matching tools', () => {
  const available = ['serena_get_node', 'serena_read_node', 'bash', 'read', 'webfetch'];
  assert.deepEqual(resolveHiddenToolNames(['serena_*'], available), ['serena_get_node', 'serena_read_node']);
});

test('resolveHiddenToolNames: a block-list of exact names hides exactly those (backward compatible)', () => {
  assert.deepEqual(resolveHiddenToolNames(['bash'], ['bash', 'read']), ['bash']);
});

test('resolveHiddenToolNames: a block-list with several entries is OR-combined', () => {
  const available = ['serena_get_node', 'webfetch', 'bash', 'read'];
  assert.deepEqual(resolveHiddenToolNames(['serena_*', 'webfetch'], available), ['serena_get_node', 'webfetch']);
});

test('resolveHiddenToolNames: a block-list is a no-op when nothing matches', () => {
  assert.deepEqual(resolveHiddenToolNames(['missing'], ['bash', 'read']), [], 'a pattern matching no present tool is a no-op');
});

test('resolveHiddenToolNames: an empty pattern list hides nothing (backward compatible)', () => {
  assert.deepEqual(resolveHiddenToolNames([], ['bash']), [], 'no patterns => nothing hidden');
});

// --- resolution: allow-list (at least one entry starts with !) ------------

test('resolveHiddenToolNames: a single negated entry is an allow-list (keeps only the match, hides the rest)', () => {
  const available = ['serena_get_node', 'serena_read_node', 'bash', 'webfetch'];
  assert.deepEqual(resolveHiddenToolNames(['!serena_*'], available), ['bash', 'webfetch']);
});

test('resolveHiddenToolNames: a single negated exact-name entry keeps only that exact name', () => {
  const available = ['bash', 'read', 'webfetch'];
  assert.deepEqual(resolveHiddenToolNames(['!bash'], available), ['read', 'webfetch']);
});

test('resolveHiddenToolNames: multiple negated entries keep the UNION of all base patterns and hide the rest', () => {
  const available = ['graphify_foo', 'graphify_bar', 'serena_get_node', 'bash', 'webfetch'];
  assert.deepEqual(resolveHiddenToolNames(['!graphify_*', '!serena_*'], available), ['bash', 'webfetch']);
});

test('resolveHiddenToolNames: mixed entries are treated as an allow-list (keep-set = union of all base patterns)', () => {
  // One negated entry flips the whole list into allow-list mode; the keep-set is the
  // union of ALL base patterns (graphify_* and the exact name webfetch).
  const available = ['graphify_foo', 'webfetch', 'serena_get_node', 'bash'];
  assert.deepEqual(resolveHiddenToolNames(['!graphify_*', 'webfetch'], available), ['serena_get_node', 'bash']);
});

// --- spec validation --------------------------------------------------------

function hideToolSpec(toolNames: unknown) {
  return { enabled: true, matcher: { type: 'always' }, action: { type: 'hideTool', toolNames } };
}

test('validateSpec accepts a hideTool spec with block-list and allow-list toolNames', () => {
  assert.equal(validateSpec(hideToolSpec(['bash'])), null);
  assert.equal(validateSpec(hideToolSpec(['serena_*'])), null);
  assert.equal(validateSpec(hideToolSpec(['serena_*', 'webfetch'])), null);
  assert.equal(validateSpec(hideToolSpec(['!serena_*'])), null);
  assert.equal(validateSpec(hideToolSpec(['!graphify_*', '!serena_*'])), null);
});

test('validateSpec rejects a hideTool spec with a missing, non-array, or empty toolNames', () => {
  const missing = { enabled: true, matcher: { type: 'always' }, action: { type: 'hideTool' } };
  assert.match(validateSpec(missing)!, /toolNames/);
  assert.match(validateSpec(hideToolSpec([]))!, /non-empty/);
});

test('validateSpec rejects a hideTool spec with non-string toolNames entries', () => {
  assert.match(validateSpec(hideToolSpec([1]))!, /strings/);
});

test('validateSpec rejects a hideTool spec with an empty-string entry or a lone ! (empty base pattern)', () => {
  assert.match(validateSpec(hideToolSpec(['ok', '']))!, /non-empty/);
  assert.match(validateSpec(hideToolSpec(['!']))!, /non-empty/);
  assert.match(validateSpec(hideToolSpec(['ok', '!']))!, /non-empty/);
});

test('buildAction throws for an invalid hideTool toolNames (empty array / lone !) and builds a valid one', () => {
  assert.throws(() => buildAction({ type: 'hideTool', toolNames: [] }));
  assert.throws(() => buildAction({ type: 'hideTool', toolNames: ['!'] }));
  const action = buildAction({ type: 'hideTool', toolNames: ['!graphify_*', '!serena_*'] });
  assert.equal(action.name, 'hideTool');
});

// --- resolution flow: concrete names stripped from tools AND messages -------

const CLIENT = { apiKey: 'sk-test', name: 'test-client', model: 'gpt-test' };
const MODEL = { id: 'm1', baseUrl: 'http://localhost:4000/v1', model: 'gpt-test' };
const SESSION_KEY = { fingerprint: 'fp-test' };

function makeRequest(messages: unknown[], raw: unknown): RequestContext {
  return { client: CLIENT, model: MODEL, sessionKey: SESSION_KEY, messages, raw };
}

function hideEffect(toolNames: string[]): ActionEffect {
  return { type: 'hideTool', toolNames };
}

/** Apply a hideTool effect (via the strategy) to a request context. */
function applyHide(ctx: RequestContext, toolNames: string[]): void {
  hideToolStrategy.applyRequest(ctx, hideEffect(toolNames));
}

/** The tool-definition names on a raw provider request body (BOTH shapes). */
function toolNamesOf(raw: unknown): string[] {
  const record = raw as { tools?: unknown[] } | undefined;
  const out: string[] = [];
  for (const tool of record?.tools ?? []) {
    if (tool === null || typeof tool !== 'object') continue;
    const t = tool as Record<string, unknown>;
    const fn = typeof t.function === 'object' && t.function !== null ? (t.function as Record<string, unknown>) : undefined;
    if (typeof fn?.name === 'string') out.push(fn.name);
    else if (typeof t.name === 'string') out.push(t.name);
  }
  return out;
}

/** The assistant tool-call (OpenAI) / tool_use (Anthropic) names referenced in a request's messages. */
function referencedToolNames(ctx: RequestContext): string[] {
  const out: string[] = [];
  for (const message of ctx.messages) {
    if (message === null || typeof message !== 'object') continue;
    const m = message as Record<string, unknown>;
    if (Array.isArray(m.tool_calls)) {
      for (const call of m.tool_calls) {
        if (call === null || typeof call !== 'object') continue;
        const c = call as Record<string, unknown>;
        const fn = typeof c.function === 'object' && c.function !== null ? (c.function as Record<string, unknown>) : undefined;
        if (typeof fn?.name === 'string') out.push(fn.name);
      }
    }
    if (Array.isArray(m.content)) {
      for (const block of m.content) {
        if (block !== null && typeof block === 'object' && (block as Record<string, unknown>).type === 'tool_use') {
          const name = (block as Record<string, unknown>).name;
          if (typeof name === 'string') out.push(name);
        }
      }
    }
  }
  return out;
}

test('resolution flow (OpenAI): a block-list serena_* strips the CONCRETE matching tools AND their message references', () => {
  const ctx = makeRequest(
    [
      { role: 'system', content: 'You are a helpful assistant.' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'c-serena', type: 'function', function: { name: 'serena_get_node', arguments: '{}' } },
          { id: 'c-bash', type: 'function', function: { name: 'bash', arguments: '{}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'c-serena', name: 'serena_get_node', content: 'out' },
      { role: 'tool', tool_call_id: 'c-bash', name: 'bash', content: 'out' },
      { role: 'user', content: 'Go again.' },
    ],
    {
      model: 'gpt-test',
      tools: [
        { type: 'function', function: { name: 'serena_get_node', parameters: {} } },
        { type: 'function', function: { name: 'serena_read_node', parameters: {} } },
        { type: 'function', function: { name: 'bash', parameters: {} } },
        { type: 'function', function: { name: 'webfetch', parameters: {} } },
      ],
    },
  );
  applyHide(ctx, ['serena_*']);

  // Definitions: BOTH serena_* tools removed; bash + webfetch kept.
  assert.deepEqual(toolNamesOf(ctx.raw), ['bash', 'webfetch']);
  // Message references: the serena_* call + its result removed; bash call + result kept.
  assert.deepEqual(referencedToolNames(ctx), ['bash']);
  assert.ok(!JSON.stringify(ctx).includes('serena_'), 'no serena_* reference remains anywhere in the request');
});

test('resolution flow (OpenAI): a single negated entry (!serena_*) is an allow-list that keeps only serena_* and hides the rest', () => {
  const ctx = makeRequest(
    [
      { role: 'system', content: 'You are a helpful assistant.' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'c-serena', type: 'function', function: { name: 'serena_get_node', arguments: '{}' } },
          { id: 'c-bash', type: 'function', function: { name: 'bash', arguments: '{}' } },
          { id: 'c-web', type: 'function', function: { name: 'webfetch', arguments: '{}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'c-serena', name: 'serena_get_node', content: 'out' },
      { role: 'tool', tool_call_id: 'c-bash', name: 'bash', content: 'out' },
      { role: 'user', content: 'Go again.' },
    ],
    {
      model: 'gpt-test',
      tools: [
        { type: 'function', function: { name: 'serena_get_node', parameters: {} } },
        { type: 'function', function: { name: 'bash', parameters: {} } },
        { type: 'function', function: { name: 'webfetch', parameters: {} } },
      ],
    },
  );
  applyHide(ctx, ['!serena_*']);

  // Definitions: everything EXCEPT serena_* is hidden.
  assert.deepEqual(toolNamesOf(ctx.raw), ['serena_get_node']);
  // Message references: bash + webfetch removed; serena_* kept.
  assert.deepEqual(referencedToolNames(ctx), ['serena_get_node']);
});

test('resolution flow (OpenAI): a multi-negated allow-list (!graphify_*, !serena_*) keeps the union of graphify_* + serena_* and hides the rest', () => {
  const ctx = makeRequest(
    [
      { role: 'system', content: 'You are a helpful assistant.' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'c-graphify', type: 'function', function: { name: 'graphify_foo', arguments: '{}' } },
          { id: 'c-serena', type: 'function', function: { name: 'serena_get_node', arguments: '{}' } },
          { id: 'c-bash', type: 'function', function: { name: 'bash', arguments: '{}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'c-graphify', name: 'graphify_foo', content: 'out' },
      { role: 'tool', tool_call_id: 'c-serena', name: 'serena_get_node', content: 'out' },
      { role: 'tool', tool_call_id: 'c-bash', name: 'bash', content: 'out' },
      { role: 'user', content: 'Go again.' },
    ],
    {
      model: 'gpt-test',
      tools: [
        { type: 'function', function: { name: 'graphify_foo', parameters: {} } },
        { type: 'function', function: { name: 'graphify_bar', parameters: {} } },
        { type: 'function', function: { name: 'serena_get_node', parameters: {} } },
        { type: 'function', function: { name: 'bash', parameters: {} } },
        { type: 'function', function: { name: 'webfetch', parameters: {} } },
      ],
    },
  );
  applyHide(ctx, ['!graphify_*', '!serena_*']);

  // Definitions: the keep-set (graphify_* + serena_*) remains; bash + webfetch hidden.
  assert.deepEqual(toolNamesOf(ctx.raw), ['graphify_foo', 'graphify_bar', 'serena_get_node']);
  // Message references: the bash call + result removed; graphify_foo + serena_get_node kept.
  assert.deepEqual(referencedToolNames(ctx), ['graphify_foo', 'serena_get_node']);
  assert.ok(!JSON.stringify(ctx).includes('"bash"'), 'no bash reference remains anywhere in the request');
});

test('resolution flow (Anthropic shape): a block-list serena_* resolves and strips tools AND references', () => {
  const ctx = makeRequest(
    [
      { role: 'system', content: 'You are a helpful assistant.' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'hi' },
          { type: 'tool_use', id: 'tu-serena', name: 'serena_get_node', input: {} },
          { type: 'tool_use', id: 'tu-bash', name: 'bash', input: {} },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tu-serena', content: 'out' },
          { type: 'tool_result', tool_use_id: 'tu-bash', content: 'out' },
        ],
      },
    ],
    {
      model: 'claude-test',
      tools: [
        { name: 'serena_get_node', input_schema: {} },
        { name: 'serena_read_node', input_schema: {} },
        { name: 'bash', input_schema: {} },
        { name: 'webfetch', input_schema: {} },
      ],
    },
  );
  applyHide(ctx, ['serena_*']);

  // Definitions (Anthropic shape): BOTH serena_* tools removed; bash + webfetch kept.
  assert.deepEqual(toolNamesOf(ctx.raw), ['bash', 'webfetch']);
  // References: the serena_* tool_use + its tool_result removed; bash kept.
  assert.deepEqual(referencedToolNames(ctx), ['bash']);
  assert.ok(!JSON.stringify(ctx).includes('serena_'), 'no serena_* reference remains anywhere in the request');
});

test('resolution flow (Anthropic shape): a single negated entry (!serena_*) is an allow-list that keeps only serena_* and hides the rest', () => {
  const ctx = makeRequest(
    [
      { role: 'system', content: 'You are a helpful assistant.' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'hi' },
          { type: 'tool_use', id: 'tu-serena', name: 'serena_get_node', input: {} },
          { type: 'tool_use', id: 'tu-bash', name: 'bash', input: {} },
          { type: 'tool_use', id: 'tu-web', name: 'webfetch', input: {} },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tu-serena', content: 'out' },
          { type: 'tool_result', tool_use_id: 'tu-bash', content: 'out' },
          { type: 'tool_result', tool_use_id: 'tu-web', content: 'out' },
        ],
      },
    ],
    {
      model: 'claude-test',
      tools: [
        { name: 'serena_get_node', input_schema: {} },
        { name: 'bash', input_schema: {} },
        { name: 'webfetch', input_schema: {} },
      ],
    },
  );
  applyHide(ctx, ['!serena_*']);

  // Definitions (Anthropic shape): everything EXCEPT serena_* is hidden.
  assert.deepEqual(toolNamesOf(ctx.raw), ['serena_get_node']);
  // References: the bash + webfetch tool_use + tool_result removed; serena_* kept.
  assert.deepEqual(referencedToolNames(ctx), ['serena_get_node']);
});

test('resolution flow: a block-list pattern matching no present tool is a no-op (tools + messages preserved)', () => {
  const raw = {
    model: 'gpt-test',
    tools: [{ type: 'function', function: { name: 'bash', parameters: {} } }],
  };
  const messages = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c-bash', function: { name: 'bash', arguments: '{}' } }] },
  ];
  const ctx = makeRequest(messages, raw);
  applyHide(ctx, ['missing_*']);
  assert.deepEqual(toolNamesOf(ctx.raw), ['bash'], 'no tool is hidden');
  assert.deepEqual(referencedToolNames(ctx), ['bash'], 'no reference is removed');
  assert.equal(ctx.messages, messages, 'the messages array is left untouched (identity preserved)');
});
