import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRuleFromSpec, buildMatcher, validateSpec, describeRule } from '../src/api/ruleSpec';
import { createAlwaysMatcher, ALWAYS_MATCHER_BRAND } from '../src/policy/matchers';
import type { AlwaysMatcher } from '../src/policy/matchers';
import type { RuleSpec } from '../src/api/ruleSpec';
import { createFakeModel, oaiCanned, startProxy } from './helpers';

/**
 * End-to-end regression tests for the unconditional "always" matcher:
 * `{ enabled: true, matcher: { type: 'always' }, action: { type: 'hideTool', toolNames: ['task'] } }`
 * must fire on EVERY request phase — including a FRESH turn-1 inbound request
 * that carries no prior 'task' call in its history — so the forwarded upstream
 * request omits the hidden tool from its tool definitions AND strips any
 * in-message references to it.
 */

const HIDDEN = 'task';
const KEPT = 'web_search';

// ---------------------------------------------------------------------------
// Spec-level unit assertions (validate / build / describe)
// ---------------------------------------------------------------------------

test('spec: validateSpec accepts a rule whose matcher is { type: "always" }', () => {
  const spec: RuleSpec = { enabled: true, matcher: { type: 'always' }, action: { type: 'hideTool', toolNames: [HIDDEN] } };
  assert.equal(validateSpec(spec), null);
});

test('spec: buildMatcher constructs an unconditional matcher from { type: "always" }', () => {
  const matcher = buildMatcher({ type: 'always' });
  // Unconditional: never returns null, even for an empty/fresh context.
  assert.notStrictEqual(matcher.matches(emptyRequestContext()), null);
  // ...and carries the "always" brand so describeRule can recognize it.
  assert.equal((matcher as AlwaysMatcher)[ALWAYS_MATCHER_BRAND], true);
  // Same identity contract as the dedicated factory.
  assert.notStrictEqual(createAlwaysMatcher().matches(emptyRequestContext()), null);
});

test('spec: describeRule renders an always-matcher rule back as { type: "always" }', () => {
  const rule = buildRuleFromSpec({
    enabled: true,
    description: 'hide task on every request',
    matcher: { type: 'always' },
    action: { type: 'hideTool', toolNames: [HIDDEN] },
  });
  const described = describeRule(rule);
  assert.deepEqual(described.matcher, { type: 'always' });
  assert.equal(described.enabled, true);
});

// ---------------------------------------------------------------------------
// Helpers (mirror tests/e2e-hideTool.test.ts)
// ---------------------------------------------------------------------------

const OAI_CANNED = oaiCanned('chatcmpl-always');

/** A minimal RequestContext-shaped PolicyContext with an empty message list. */
function emptyRequestContext() {
  return {
    client: { apiKey: 'sk-test', name: 'test-client', model: 'gpt-4o-mini' },
    model: { id: 'm1', baseUrl: 'http://localhost:4000/v1', model: 'gpt-4o-mini' },
    sessionKey: { fingerprint: 'fp-always' },
    messages: [],
    raw: null,
  };
}

/** The tool definitions a fresh inbound request advertises (hidden + kept). */
function openAiTools(): unknown[] {
  return [
    { type: 'function', function: { name: HIDDEN, parameters: { type: 'object' } } },
    { type: 'function', function: { name: KEPT, parameters: { type: 'object' } } },
  ];
}

/** Collect the advertised tool names from a forwarded upstream body (OpenAI shape). */
function forwardedToolNames(forwarded: unknown): string[] {
  const body = forwarded as Record<string, unknown>;
  if (!Array.isArray(body.tools)) return [];
  return body.tools
    .map((tool) => {
      if (typeof tool !== 'object' || tool === null) return undefined;
      const record = tool as Record<string, unknown>;
      const fn = typeof record.function === 'object' && record.function !== null ? (record.function as Record<string, unknown>) : {};
      if (typeof fn.name === 'string') return fn.name;
      return typeof record.name === 'string' ? record.name : undefined;
    })
    .filter((name): name is string => typeof name === 'string');
}

// ---------------------------------------------------------------------------
// End-to-end: FRESH turn-1 request (no prior 'task' call) → 'task' excluded
// ---------------------------------------------------------------------------

test('e2e always+hideTool: a FRESH turn-1 request forwards upstream WITHOUT the hidden "task" tool', async () => {
  const fakeModel = await createFakeModel(OAI_CANNED);
  let proxy: Awaited<ReturnType<typeof startProxy>> | undefined;
  try {
    // The rule is built from the JSON spec (not an inline matcher), proving the
    // full validate → build → engine → apply chain for `{ type: 'always' }`.
    const rule = buildRuleFromSpec({
      enabled: true,
      description: `hide ${HIDDEN} on every request`,
      matcher: { type: 'always' },
      action: { type: 'hideTool', toolNames: [HIDDEN] },
    });
    proxy = await startProxy({
      upstream: { baseUrl: `http://127.0.0.1:${fakeModel.port}/v1`, model: 'gpt-4o-mini', protocol: 'openai' },
      policy: { rules: [rule] },
    });

    // A FRESH inbound request: only a user message, NO prior 'task' call in history.
    const res = await fetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'Do something.' }],
        tools: openAiTools(),
      }),
    });
    assert.equal(res.status, 200);
    await res.json();

    const forwarded = fakeModel.requests[0];
    assert.ok(forwarded !== undefined, 'the upstream received a forwarded request');

    // The hidden tool must be absent from the forwarded tool definitions...
    const names = forwardedToolNames(forwarded);
    assert.ok(!names.includes(HIDDEN), `'${HIDDEN}' must be excluded from the forwarded tools`);
    // ...while the non-hidden tool still survives.
    assert.ok(names.includes(KEPT), `'${KEPT}' should still be present in the forwarded tools`);
    // No reference to the hidden tool survives anywhere in the forwarded body.
    assert.ok(!JSON.stringify(forwarded).includes(`"${HIDDEN}"`), 'no reference to the hidden tool may remain');
  } finally {
    if (proxy) await proxy.server.close();
    await fakeModel.close();
  }
});
