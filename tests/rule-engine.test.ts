import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createRuleEngine,
  flagshipLoopRule,
} from '../src/policy/ruleEngine';
import type { PolicyAction, PolicyRule } from '../src/policy/ruleEngine';
import {
  createHideToolAction,
  createInjectMessageAction,
} from '../src/policy/actions';
import { createToolNameMatcher } from '../src/policy/matchers';
import type { PolicyMatcher } from '../src/policy/types';
import type { Message } from '../src/session/session';
import type { RequestContext } from '../src/ports/pipeline';

/**
 * Tests for the policy rule engine (`createRuleEngine`) and the flagship
 * `flagshipLoopRule`. Fixtures mirror `tests/policy-matchers.test.ts`: real
 * matcher/action factories driven by {@link RequestContext}-shaped
 * {@link PolicyContext}s whose `messages` are OpenAI-style shapes.
 */

const CLIENT = { apiKey: 'sk-test', name: 'test-client', model: 'gpt-test' };
const MODEL = { id: 'm1', baseUrl: 'http://localhost:4000/v1', model: 'gpt-test' };
const SESSION_KEY = { fingerprint: 'fp-test' };

/** A shared OpenAI-style message prefix (system + first user message). */
function prefix(): Message[] {
  return [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: 'Do the thing.' },
  ];
}

/** Build a {@link RequestContext}-shaped {@link PolicyContext} carrying a message list. */
function makeRequest(messages: Message[]): RequestContext {
  return { client: CLIENT, model: MODEL, sessionKey: SESSION_KEY, messages, raw: null };
}

/** An assistant message with a single OpenAI-style tool call (arguments as a JSON string). */
function assistantCall(id: string, name: string, argumentsJson: string): Message {
  return { role: 'assistant', tool_calls: [{ id, function: { name, arguments: argumentsJson } }] };
}

/** A `role: "tool"` result paired back to a tool call by `tool_call_id`. */
function toolResult(id: string, content: string): Message {
  return { role: 'tool', tool_call_id: id, content };
}

/** The message list for a run of `count` identical (tool + params + result) pairs. */
function loopMessages(count: number, toolName: string, paramsJson: string, result: string): Message[] {
  const messages: Message[] = [...prefix()];
  for (let i = 0; i < count; i += 1) {
    const id = `c${i + 1}`;
    messages.push(assistantCall(id, toolName, paramsJson));
    messages.push(toolResult(id, result));
  }
  return messages;
}

/** A single `bash` tool call (arguments contain `curl`) with its result. */
function bashCall(): Message[] {
  return [
    ...prefix(),
    assistantCall('c1', 'bash', '{"cmd":"curl https://example.com"}'),
    toolResult('c1', 'ok'),
  ];
}

/** A trivial matcher that always fires with a fixed {@link Match}. */
function alwaysMatch(): PolicyMatcher {
  return { matches: () => ({ matched: true, reason: 'always matches' }) };
}

/** A trivial matcher that never fires. */
function neverMatch(): PolicyMatcher {
  return { matches: () => null };
}

/** Build a concrete {@link PolicyRule}; `extra` lets tests override `enabled`/`priority` etc. */
function ruleOf(
  id: string,
  action: PolicyAction,
  matcher: PolicyMatcher,
  extra: Partial<PolicyRule> = {},
): PolicyRule {
  return { id, enabled: true, action, matcher, ...extra };
}

// --- matching / non-matching -------------------------------------------------

test('a matching rule produces its effect; a non-matching rule produces none', () => {
  const engine = createRuleEngine([
    ruleOf(
      'matches-bash',
      createInjectMessageAction({ content: 'stop!' }) as PolicyAction,
      createToolNameMatcher({ toolName: 'bash' }),
    ),
    ruleOf(
      'skips-read',
      createHideToolAction({ toolNames: ['read'] }) as PolicyAction,
      createToolNameMatcher({ toolName: 'read' }),
    ),
  ]);
  const result = engine.evaluate(makeRequest(bashCall()));
  assert.equal(result.effects.length, 1);
  assert.equal(result.matches.length, 1);
  assert.deepEqual(result.effects[0], { type: 'injectMessage', role: 'user', content: 'stop!' });
  assert.equal(result.matches[0].ruleId, 'matches-bash');
  assert.equal(result.matches[0].match.matched, true);
});

// --- disabled rules are skipped ---------------------------------------------

test('disabled rules are skipped (no effect even if the matcher would match)', () => {
  const engine = createRuleEngine([
    ruleOf(
      'disabled-but-would-match',
      createInjectMessageAction({ content: 'should not appear' }) as PolicyAction,
      alwaysMatch(),
      { enabled: false },
    ),
  ]);
  const result = engine.evaluate(makeRequest(bashCall()));
  assert.equal(result.effects.length, 0);
  assert.equal(result.matches.length, 0);
});

// --- priority order ----------------------------------------------------------

test('priority order: effects and matches follow ascending priority (lower first)', () => {
  const engine = createRuleEngine([
    ruleOf(
      'hide-10',
      createHideToolAction({ toolNames: ['bash'] }) as PolicyAction,
      alwaysMatch(),
      { priority: 10 },
    ),
    ruleOf(
      'inject-5',
      createInjectMessageAction({ content: 'injected by inject-5' }) as PolicyAction,
      alwaysMatch(),
      { priority: 5 },
    ),
  ]);
  const result = engine.evaluate(makeRequest(bashCall()));
  // Array order is [block-10, inject-5], but evaluation order is by ascending priority.
  assert.deepEqual(result.matches.map((m) => m.ruleId), ['inject-5', 'hide-10']);
  assert.equal(result.effects.length, 2);
  assert.equal(result.effects[0].type, 'injectMessage');
  assert.equal(result.effects[1].type, 'hideTool');
});

test('priority ties are broken by original array order', () => {
  const engine = createRuleEngine([
    ruleOf(
      'first',
      createInjectMessageAction({ content: 'first' }) as PolicyAction,
      alwaysMatch(),
      { priority: 7 },
    ),
    ruleOf(
      'second',
      createHideToolAction({ toolNames: ['bash'] }) as PolicyAction,
      alwaysMatch(),
      { priority: 7 },
    ),
  ]);
  const result = engine.evaluate(makeRequest(bashCall()));
  assert.deepEqual(result.matches.map((m) => m.ruleId), ['first', 'second']);
  assert.equal(result.effects[0].type, 'injectMessage');
  assert.equal(result.effects[1].type, 'hideTool');
});

test('a missing priority sorts after any explicit priority (regardless of array position)', () => {
  // The no-priority rule is placed FIRST in the array, yet a rule with an
  // explicit `priority` exists → the explicit one runs first.
  const engine = createRuleEngine([
    ruleOf('no-priority', createHideToolAction({ toolNames: ['bash'] }) as PolicyAction, alwaysMatch()),
    ruleOf(
      'explicit-1',
      createInjectMessageAction({ content: 'early' }) as PolicyAction,
      alwaysMatch(),
      { priority: 1 },
    ),
  ]);
  const result = engine.evaluate(makeRequest(bashCall()));
  assert.deepEqual(result.matches.map((m) => m.ruleId), ['explicit-1', 'no-priority']);
  assert.equal(result.effects[0].type, 'injectMessage');
  assert.equal(result.effects[1].type, 'hideTool');
});

// --- flagship loop rule ------------------------------------------------------

test('flagshipLoopRule(): 4 consecutive identical calls → an injectMessage effect (loop detected)', () => {
  const ctx = makeRequest(loopMessages(4, 'bash', '{"cmd":"curl https://example.com"}', 'ok'));
  const result = createRuleEngine([flagshipLoopRule()]).evaluate(ctx);
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].ruleId, 'flagship-loop-rule');
  assert.equal(result.matches[0].match.matched, true);
  assert.equal(result.effects.length, 1);
  const effect = result.effects[0];
  assert.equal(effect.type, 'injectMessage');
  if (effect.type === 'injectMessage') {
    assert.equal(effect.role, 'user');
    assert.ok(/stuck|repeating/i.test(effect.content));
  }
});

test('flagshipLoopRule(): only 3 identical calls (default window=4) → no effect (no loop)', () => {
  const ctx = makeRequest(loopMessages(3, 'bash', '{"cmd":"curl https://example.com"}', 'ok'));
  const result = createRuleEngine([flagshipLoopRule()]).evaluate(ctx);
  assert.equal(result.effects.length, 0);
  assert.equal(result.matches.length, 0);
});

test('flagshipLoopRule(options): custom window/message/role are honored', () => {
  const rule = flagshipLoopRule({ window: 3, message: 'custom correction', role: 'system' });
  const ctx = makeRequest(loopMessages(3, 'bash', '{"a":1}', 'r'));
  const result = createRuleEngine([rule]).evaluate(ctx);
  assert.equal(result.effects.length, 1);
  const effect = result.effects[0];
  assert.equal(effect.type, 'injectMessage');
  if (effect.type === 'injectMessage') {
    assert.equal(effect.role, 'system');
    assert.equal(effect.content, 'custom correction');
  }
});
