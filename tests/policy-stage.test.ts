import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPolicyStage } from '../src/policy/policyStage';
import { createRuleEngine, flagshipLoopRule } from '../src/policy/ruleEngine';
import type { PolicyAction, PolicyRule } from '../src/policy/ruleEngine';
import type { Action, PolicyMatcher } from '../src/policy/types';
import {
  createHideToolAction,
  createInjectMessageAction,
} from '../src/policy/actions';
import { createToolNameMatcher } from '../src/policy/matchers';
import { SessionFeedbackStore } from '../src/policy/feedbackStore';
import type { Message } from '../src/session/session';
import type { RequestContext, ResponseContext } from '../src/ports/pipeline';
import type { ClientConfig, ModelConfig, SessionKey, ToolCall } from '../src/ports/domain';

/**
 * Tests for the policy pipeline stage (`createPolicyStage`). Uses the REAL rule
 * engine, matchers, actions, and feedback store; request/response context
 * fixtures mirror the shapes the proxy / `PipelineStage` expect (see
 * `src/proxy/context.ts`, `tests/rule-engine.test.ts`).
 */

const CLIENT: ClientConfig = { apiKey: 'sk-test', name: 'test-client', model: 'gpt-test' };
const MODEL: ModelConfig = { id: 'm1', baseUrl: 'http://localhost:4000/v1', model: 'gpt-test' };
/** The proxy surfaces a header-derived session key whose fingerprint is empty. */
const EMPTY_SESSION_KEY: SessionKey = { fingerprint: '' };

/** Shared OpenAI-style message prefix (system + first user message). */
const SYSTEM: Message = { role: 'system', content: 'You are a helpful assistant.' };
const USER: Message = { role: 'user', content: 'Do the thing.' };

/** Build a {@link RequestContext}-shaped fixture. */
function makeRequest(messages: Message[], raw: unknown, sessionKey: SessionKey = EMPTY_SESSION_KEY): RequestContext {
  return { client: CLIENT, model: MODEL, sessionKey, messages, raw };
}

/** Build a {@link ResponseContext}-shaped fixture. */
function makeResponse(toolCalls: ToolCall[], sessionKey: SessionKey = EMPTY_SESSION_KEY): ResponseContext {
  return { client: CLIENT, model: MODEL, sessionKey, toolCalls, content: '', raw: null };
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
  const messages: Message[] = [SYSTEM, USER];
  for (let i = 0; i < count; i += 1) {
    const id = `c${i + 1}`;
    messages.push(assistantCall(id, toolName, paramsJson));
    messages.push(toolResult(id, result));
  }
  return messages;
}

/** A matcher that always fires with a fixed {@link import('../src/policy/types').Match}. */
function alwaysMatch(): PolicyMatcher {
  return { matches: () => ({ matched: true, reason: 'always matches' }) };
}

/** A matcher that never fires. */
function neverMatch(): PolicyMatcher {
  return { matches: () => null };
}

/** Build a concrete {@link PolicyRule}; `extra` lets tests override `enabled`/`priority` etc. */
function ruleOf(id: string, action: Action, matcher: PolicyMatcher, extra: Partial<PolicyRule> = {}): PolicyRule {
  return { id, enabled: true, action: action as PolicyAction, matcher, ...extra };
}

/** Whether any message carries a string matching the given pattern in its text content. */
function hasMessageMatching(messages: unknown[], pattern: RegExp): boolean {
  return messages.some((message) => {
    if (message === null || typeof message !== 'object') return false;
    const content = (message as Record<string, unknown>).content;
    return typeof content === 'string' && pattern.test(content);
  });
}

// --- hideTool ----------------------------------------------------------------

test('hideTool: removes the named tools from the request tool list', async () => {
  const stage = createPolicyStage({
    engine: createRuleEngine([ruleOf('hide-bash', createHideToolAction({ toolNames: ['bash'] }), alwaysMatch())]),
  });
  const raw = {
    model: 'gpt-test',
    messages: [SYSTEM, USER],
    tools: [
      { type: 'function', function: { name: 'bash', description: 'run a shell command', parameters: {} } },
      { type: 'function', function: { name: 'read', parameters: {} } },
      { type: 'function', function: { name: 'write', parameters: {} } },
    ],
  };
  const ctx = makeRequest([SYSTEM, USER], raw);
  const processed = await stage.onRequest!(ctx);

  const names = ((processed.raw as { tools: { function?: { name?: string }; name?: string }[] }).tools ?? []).map(
    (tool) => tool.function?.name ?? tool.name,
  );
  assert.ok(!names.includes('bash'), 'bash should be hidden from the request');
  assert.ok(names.includes('read'), 'read should remain available');
  assert.ok(names.includes('write'), 'write should remain available');
});

/** The set of tool-definition names carried on a raw provider request body. */
function toolNamesOf(raw: unknown): string[] {
  const record = raw as { tools?: { function?: { name?: string }; name?: string }[] } | undefined;
  return (record?.tools ?? []).map((tool) => tool.function?.name ?? tool.name).filter((n): n is string => n !== undefined);
}

/** Type guard: a non-null, non-array object. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

test('hideTool: strips hidden-tool definitions AND their references from OpenAI message history', async () => {
  const stage = createPolicyStage({
    engine: createRuleEngine([ruleOf('hide-bash-refs', createHideToolAction({ toolNames: ['bash'] }), alwaysMatch())]),
  });
  const messages: Message[] = [
    SYSTEM,
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'bash-1', type: 'function', function: { name: 'bash', arguments: '{}' } },
        { id: 'read-1', type: 'function', function: { name: 'read', arguments: '{}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'bash-1', name: 'bash', content: 'out' },
    { role: 'tool', tool_call_id: 'read-1', name: 'read', content: 'in' },
    USER,
  ];
  const raw = {
    model: 'gpt-test',
    messages,
    tools: [{ type: 'function', function: { name: 'bash' } }, { type: 'function', function: { name: 'read' } }],
  };
  const processed = await stage.onRequest!(makeRequest(messages, raw));

  // Definitions: hidden removed, kept preserved.
  assert.ok(!toolNamesOf(processed.raw).includes('bash'), 'the bash definition is removed from tools');
  assert.ok(toolNamesOf(processed.raw).includes('read'), 'the read definition remains in tools');

  // References: the assistant's bash tool call is dropped; read is kept.
  const assistant = processed.messages.find((m) => isPlainRecord(m) && m.role === 'assistant');
  const remainingCalls = ((isPlainRecord(assistant) ? (assistant.tool_calls ?? []) : []) as { function?: { name?: string } }[])
    .map((call) => call.function?.name ?? '');
  assert.deepEqual(remainingCalls, ['read'], 'only the non-hidden tool call remains on the assistant message');

  // Results: the bash tool result is dropped; read's is kept.
  const results = processed.messages.filter((m) => isPlainRecord(m) && m.role === 'tool') as Record<string, unknown>[];
  assert.deepEqual(results.map((m) => (typeof m.name === 'string' ? m.name : '')), ['read'], 'the hidden tool result is dropped from history');
});

test('hideTool (Anthropic shape): strips tool_use blocks and their tool_result references', async () => {
  const stage = createPolicyStage({
    engine: createRuleEngine([ruleOf('hide-bash-refs-anth', createHideToolAction({ toolNames: ['bash'] }), alwaysMatch())]),
  });
  const messages: Message[] = [
    SYSTEM,
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'hi' },
        { type: 'tool_use', id: 'bash-1', name: 'bash', input: {} },
        { type: 'tool_use', id: 'read-1', name: 'read', input: {} },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'bash-1', content: 'out' },
        { type: 'tool_result', tool_use_id: 'read-1', content: 'in' },
      ],
    },
  ];
  const raw = { model: 'claude-test', messages, tools: [{ name: 'bash' }, { name: 'read' }] };
  const processed = await stage.onRequest!(makeRequest(messages, raw));

  assert.ok(!toolNamesOf(processed.raw).includes('bash'), 'the bash definition is removed from tools');
  assert.ok(toolNamesOf(processed.raw).includes('read'), 'the read definition remains in tools');

  const assistantContent = (processed.messages.find((m) => isPlainRecord(m) && m.role === 'assistant') as Record<string, unknown> | undefined)?.content;
  const remainingUse = ((Array.isArray(assistantContent) ? assistantContent : []) as Record<string, unknown>[])
    .filter((block) => block.type === 'tool_use')
    .map((block) => (typeof block.name === 'string' ? block.name : ''));
  assert.deepEqual(remainingUse, ['read'], 'only the non-hidden tool_use block remains');

  const userContent = (processed.messages.find((m) => isPlainRecord(m) && m.role === 'user') as Record<string, unknown> | undefined)?.content;
  const remainingResults = ((Array.isArray(userContent) ? userContent : []) as Record<string, unknown>[])
    .filter((block) => block.type === 'tool_result')
    .map((block) => (typeof block.tool_use_id === 'string' ? block.tool_use_id : ''));
  assert.deepEqual(remainingResults, ['read-1'], 'the hidden tool_result reference is dropped');
});

// --- injectMessage (loop feedback) -------------------------------------------

test('injectMessage (loop): a corrective message is injected into the request', async () => {
  const stage = createPolicyStage({ engine: createRuleEngine([flagshipLoopRule()]) });
  const original = loopMessages(4, 'bash', '{"cmd":"curl https://example.com"}', 'ok');
  assert.ok(!hasMessageMatching(original, /stuck|repeating/i), 'precondition: no corrective message yet');

  const ctx = makeRequest(original, { model: 'gpt-test' });
  const processed = await stage.onRequest!(ctx);

  assert.ok(
    hasMessageMatching(processed.messages, /stuck|repeating/i),
    'a corrective message should now be present in the request',
  );
  // The original (caller-provided) array is not mutated; a new list is returned.
  assert.equal(processed.messages.length, original.length + 1);
  assert.ok(!hasMessageMatching(original, /stuck|repeating/i), 'the caller-provided array stays unchanged');
});

// --- no match ----------------------------------------------------------------

test('no match: a request and a response that match nothing are returned unchanged', async () => {
  const feedback = new SessionFeedbackStore();
  const stage = createPolicyStage({
    engine: createRuleEngine([ruleOf('never', createInjectMessageAction({ content: 'should not appear' }), neverMatch())]),
    feedback,
  });

  const raw = { model: 'gpt-test', tools: [{ type: 'function', function: { name: 'bash' } }] };
  const requestMessages: Message[] = [SYSTEM, USER];
  const requestCtx = makeRequest(requestMessages, raw);
  const processedRequest = await stage.onRequest!(requestCtx);
  assert.deepEqual(processedRequest.messages, requestMessages, 'request messages are unchanged on a non-match');
  assert.equal(processedRequest.raw, raw, 'request raw is unchanged on a non-match');

  const calls: ToolCall[] = [{ id: 'c1', name: 'read', arguments: {} }];
  const responseCtx = makeResponse(calls);
  const processedResponse = await stage.onResponse!(responseCtx);
  assert.deepEqual(processedResponse.toolCalls, calls, 'response tool calls are unchanged on a non-match');
  assert.equal(processedResponse.content, '', 'response content is unchanged on a non-match');
  assert.equal(feedback.size(), 0, 'a non-match queues no feedback');
});
