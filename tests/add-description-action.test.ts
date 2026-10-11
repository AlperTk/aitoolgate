import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSpec, buildRuleFromSpec, buildAction, type RuleSpec, type ActionSpec } from '../src/api/ruleSpec';
import { createRuleEngine, type PolicyAction, type PolicyRule } from '../src/policy/ruleEngine';
import { createAddDescriptionAction, ACTION_STRATEGIES, type ActionEffect } from '../src/policy/actions';
import { createPolicyStage } from '../src/policy/policyStage';
import type { RequestContext } from '../src/ports/pipeline';

/**
 * Unit tests for the `addDescription` policy action: its wire spec validates and
 * round-trips through the spec-build path, and when a rule matches a tool call it
 * sets that tool's description on the outgoing request's `tools` array in BOTH
 * provider shapes (OpenAI `tools[i].function.description` and Anthropic top-level
 * `tools[i].description`). No tools array / no matching entry is a graceful no-op.
 */

const CLIENT = { apiKey: 'sk-test', name: 'test-client', model: 'gpt-test' };
const MODEL = { id: 'm1', baseUrl: 'http://localhost:4000/v1', model: 'gpt-test' };
const SESSION_KEY = { fingerprint: 'fp-test' };
const DESCRIPTION = 'Runs a shell command.';

/** An assistant message carrying a single `bash` tool call (drives the matcher). */
const bashCall = {
  role: 'assistant',
  tool_calls: [{ id: 'c1', type: 'function', function: { name: 'bash', arguments: '{}' } }],
};

/** A {@link RequestContext}-shaped policy context whose `raw` is the given provider body. */
function makeRequest(raw: unknown): RequestContext {
  return {
    client: CLIENT,
    model: MODEL,
    sessionKey: SESSION_KEY,
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Do it.' },
      bashCall,
    ],
    raw,
  };
}

/** A request context with NO tool call in history — the tool is only OFFERED in raw.tools. */
function makeOfferedRequest(raw: unknown): RequestContext {
  return {
    client: CLIENT,
    model: MODEL,
    sessionKey: SESSION_KEY,
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Do it.' },
    ],
    raw,
  };
}

/** An `addDescription` rule spec. */
function addDescriptionSpec(): RuleSpec {
  return {
    enabled: true,
    matcher: { type: 'toolName', toolName: 'bash' },
    action: { type: 'addDescription', description: DESCRIPTION },
  };
}

// --- spec validation --------------------------------------------------------

test('a rule spec with addDescription + description is valid', () => {
  assert.equal(validateSpec(addDescriptionSpec()), null);
});

test('an addDescription spec missing its description is rejected', () => {
  const spec = {
    enabled: true,
    matcher: { type: 'toolName', toolName: 'bash' },
    action: { type: 'addDescription' },
  };
  assert.match(validateSpec(spec)!, /description/);
});

test('an unknown action type is rejected', () => {
  const spec = { enabled: true, matcher: { type: 'always' }, action: { type: 'nope' } };
  assert.match(validateSpec(spec)!, /unknown action type/);
});

// --- spec round-trips through the spec-build path + engine -----------------

test('buildRuleFromSpec + engine: a matching tool call yields an addDescription effect', () => {
  const rule = buildRuleFromSpec(addDescriptionSpec());
  const result = createRuleEngine([rule]).evaluate(makeRequest(null));
  assert.equal(result.effects.length, 1);
  assert.deepEqual(result.effects[0], { type: 'addDescription', description: DESCRIPTION, toolNames: ['bash'] });
});

test('buildAction builds an addDescription action; a missing description throws', () => {
  const action = buildAction({ type: 'addDescription', description: DESCRIPTION }) as PolicyAction;
  assert.equal(action.name, 'addDescription');
  assert.throws(() => buildAction({ type: 'addDescription' } as unknown as ActionSpec));
});

// --- request mutation: OpenAI shape (through the policy stage) ------------

test('matching a tool call sets the description on an OpenAI-shaped request tools entry', () => {
  const rule: PolicyRule = buildRuleFromSpec(addDescriptionSpec());
  const stage = createPolicyStage({ engine: createRuleEngine([rule]) });
  const ctx = makeRequest({
    tools: [
      { type: 'function', function: { name: 'bash', parameters: { type: 'object' } } },
      { type: 'function', function: { name: 'other', parameters: { type: 'object' } } },
    ],
  });
  stage.onRequest!(ctx);

  const tools = (ctx.raw as { tools: { function: Record<string, unknown> }[] }).tools;
  assert.equal(tools[0].function.description, DESCRIPTION);
  assert.equal(tools[1].function.description, undefined, 'the unmatched tool is untouched');
});

// --- request mutation: Anthropic shape (through the policy stage) ---------

test('matching a tool call sets the description on an Anthropic-shaped request tools entry', () => {
  const rule: PolicyRule = buildRuleFromSpec(addDescriptionSpec());
  const stage = createPolicyStage({ engine: createRuleEngine([rule]) });
  const ctx = makeRequest({
    tools: [
      { name: 'bash', input_schema: { type: 'object' } },
      { name: 'other', input_schema: { type: 'object' } },
    ],
  });
  stage.onRequest!(ctx);

  const tools = (ctx.raw as { tools: Record<string, unknown>[] }).tools;
  assert.equal(tools[0].description, DESCRIPTION);
  assert.equal(tools[1].description, undefined, 'the unmatched tool is untouched');
});

// --- request mutation: tool only OFFERED in raw.tools (no call) ------------

test('a tool only OFFERED in raw.tools (no call) has its description set (OpenAI shape)', () => {
  const rule: PolicyRule = buildRuleFromSpec(addDescriptionSpec());
  const stage = createPolicyStage({ engine: createRuleEngine([rule]) });
  const ctx = makeOfferedRequest({
    tools: [
      { type: 'function', function: { name: 'bash', parameters: { type: 'object' } } },
      { type: 'function', function: { name: 'other', parameters: { type: 'object' } } },
    ],
  });
  stage.onRequest!(ctx);

  const tools = (ctx.raw as { tools: { function: Record<string, unknown> }[] }).tools;
  assert.equal(tools[0].function.description, DESCRIPTION, 'the offered bash tool has its description set');
  assert.equal(tools[1].function.description, undefined, 'the unmatched tool is untouched');
});

test('a tool only OFFERED in raw.tools (no call) has its description set (Anthropic shape)', () => {
  const rule: PolicyRule = buildRuleFromSpec(addDescriptionSpec());
  const stage = createPolicyStage({ engine: createRuleEngine([rule]) });
  const ctx = makeOfferedRequest({
    tools: [
      { name: 'bash', input_schema: { type: 'object' } },
      { name: 'other', input_schema: { type: 'object' } },
    ],
  });
  stage.onRequest!(ctx);

  const tools = (ctx.raw as { tools: Record<string, unknown>[] }).tools;
  assert.equal(tools[0].description, DESCRIPTION, 'the offered bash tool has its description set');
  assert.equal(tools[1].description, undefined, 'the unmatched tool is untouched');
});

// --- no-op: no tools array -------------------------------------------------

test('no throw and no change when the request has no tools array', () => {
  const effect: ActionEffect = { type: 'addDescription', description: DESCRIPTION, toolNames: ['bash'] };
  // (i) `tools` field entirely absent.
  const absent = makeRequest({ messages: [] });
  assert.doesNotThrow(() => ACTION_STRATEGIES.addDescription.applyRequest(absent, effect));
  assert.ok(!('tools' in (absent.raw as object)));
  // (ii) `tools` present but null.
  const nulled = makeRequest({ messages: [], tools: null });
  assert.doesNotThrow(() => ACTION_STRATEGIES.addDescription.applyRequest(nulled, effect));
  assert.equal((nulled.raw as { tools: unknown }).tools, null);
});

// --- no-op: tools array present but no matching entry ---------------------

test('no throw and no new entries when no tools entry matches the targeted name', () => {
  const effect: ActionEffect = { type: 'addDescription', description: DESCRIPTION, toolNames: ['bash'] };
  const ctx = makeRequest({ tools: [{ name: 'other', input_schema: { type: 'object' } }] });
  assert.doesNotThrow(() => ACTION_STRATEGIES.addDescription.applyRequest(ctx, effect));
  const tools = (ctx.raw as { tools: Record<string, unknown>[] }).tools;
  assert.equal(tools[0].description, undefined);
  assert.equal(tools.length, 1, 'no new tools entries are created');
});

// --- apply with no targeted tool name is a no-op --------------------------

test('createAddDescriptionAction.apply returns null when the match targets no tool name', () => {
  const action = createAddDescriptionAction({ description: DESCRIPTION }) as PolicyAction;
  assert.equal(action.apply({} as RequestContext), null);
  assert.equal(action.apply({} as RequestContext, { matched: true, reason: 'always' }), null);
});
