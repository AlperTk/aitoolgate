import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPolicyStage } from '../src/policy/policyStage';
import { createRuleEngine, flagshipLoopRule } from '../src/policy/ruleEngine';
import type { PolicyAction, PolicyRule } from '../src/policy/ruleEngine';
import type { Action, PolicyMatcher } from '../src/policy/types';
import {
  createBlockAction,
  createHideToolAction,
  createInjectMessageAction,
} from '../src/policy/actions';
import { createToolNameMatcher } from '../src/policy/matchers';
import { createEventBus } from '../src/telemetry/event-bus';
import type { TelemetryEventBus } from '../src/telemetry/event-bus';
import type { TelemetryEvent, ToolCallEvent, InterventionEvent } from '../src/telemetry/events';
import type { Message } from '../src/session/session';
import type { RequestContext, ResponseContext } from '../src/ports/pipeline';
import type { ClientConfig, ModelConfig, SessionKey, ToolCall } from '../src/ports/domain';

/**
 * Tests for the policy stage's optional TELEMETRY emission (slice 6d-i). When a
 * {@link TelemetryEventBus} is wired via `createPolicyStage({ engine, bus })`,
 * the response phase publishes a {@link ToolCallEvent} per observed tool call and
 * both phases publish an {@link InterventionEvent} per applied rule effect. With
 * no bus the stage behaves EXACTLY as before (no emission, effects still applied).
 *
 * Fixtures mirror `tests/policy-stage.test.ts`: real rule engine, matchers, and
 * actions driven by request/response context shapes the `PipelineStage` expects.
 */

const CLIENT: ClientConfig = { apiKey: 'sk-test', name: 'test-client', model: 'gpt-test' };
const MODEL: ModelConfig = { id: 'm1', baseUrl: 'http://localhost:4000/v1', model: 'gpt-test' };

const SYSTEM: Message = { role: 'system', content: 'You are a helpful assistant.' };
const USER: Message = { role: 'user', content: 'Do the thing.' };

/** Build a {@link RequestContext}-shaped fixture. */
function makeRequest(messages: Message[], raw: unknown, sessionKey: SessionKey = { fingerprint: '' }): RequestContext {
  return { client: CLIENT, model: MODEL, sessionKey, messages, raw };
}

/** Build a {@link ResponseContext}-shaped fixture. */
function makeResponse(toolCalls: ToolCall[], sessionKey: SessionKey = { fingerprint: '' }): ResponseContext {
  return { client: CLIENT, model: MODEL, sessionKey, toolCalls, content: '', raw: null };
}

/** The message list for a run of `count` identical (tool + params + result) pairs. */
function loopMessages(count: number, toolName: string, paramsJson: string, result: string): Message[] {
  const messages: Message[] = [SYSTEM, USER];
  for (let i = 0; i < count; i += 1) {
    const id = `c${i + 1}`;
    messages.push({ role: 'assistant', tool_calls: [{ id, function: { name: toolName, arguments: paramsJson } }] });
    messages.push({ role: 'tool', tool_call_id: id, content: result });
  }
  return messages;
}

/** A matcher that always fires with a fixed Match. */
function alwaysMatch(): PolicyMatcher {
  return { matches: () => ({ matched: true, reason: 'always matches' }) };
}

/** A matcher that never fires. */
function neverMatch(): PolicyMatcher {
  return { matches: () => null };
}

/** Build a concrete {@link PolicyRule}; `extra` lets tests override fields. */
function ruleOf(id: string, action: Action, matcher: PolicyMatcher, extra: Partial<PolicyRule> = {}): PolicyRule {
  return { id, enabled: true, action: action as PolicyAction, matcher, ...extra };
}

/** A {@link TelemetryEventBus} that records every emitted event, for assertions. */
function capturingBus(): { bus: TelemetryEventBus; events: TelemetryEvent[] } {
  const bus = createEventBus();
  const events: TelemetryEvent[] = [];
  // Synchronous capture: emit dispatches handlers in-order within the same turn.
  bus.subscribe((event) => {
    events.push(event);
  });
  return { bus, events };
}

/** Narrow the captured event array to just tool-call events. */
function toolCallEvents(events: TelemetryEvent[]): ToolCallEvent[] {
  return events.filter((event): event is ToolCallEvent => event.type === 'tool.call');
}

/** Narrow the captured event array to just intervention events. */
function interventionEvents(events: TelemetryEvent[]): InterventionEvent[] {
  return events.filter((event): event is InterventionEvent => event.type === 'policy.intervention');
}

/** The tool names present on a raw provider request's top-level `tools` array. */
function toolNamesOf(raw: unknown): string[] {
  if (typeof raw !== 'object' || raw === null) return [];
  const tools = (raw as Record<string, unknown>).tools;
  if (!Array.isArray(tools)) return [];
  const names: string[] = [];
  for (const tool of tools) {
    if (typeof tool !== 'object' || tool === null) continue;
    const fn = (tool as Record<string, unknown>).function;
    const name =
      typeof fn === 'object' && fn !== null
        ? (fn as Record<string, unknown>).name
        : (tool as Record<string, unknown>).name;
    if (typeof name === 'string') names.push(name);
  }
  return names;
}

// --- response-phase ToolCallEvent -------------------------------------------

test('response phase: each observed tool call emits a ToolCallEvent with correct toolName + sessionKey', async () => {
  const key: SessionKey = { fingerprint: 'fp-events' };
  const calls: ToolCall[] = [
    { id: 'c1', name: 'bash', arguments: { cmd: 'curl https://example.com' } },
    { id: 'c2', name: 'read', arguments: { path: '/tmp/x' } },
  ];
  const { bus, events } = capturingBus();
  const stage = createPolicyStage({ engine: createRuleEngine([]), bus });

  await stage.onResponse!(makeResponse(calls, key));

  const toolCalls = toolCallEvents(events);
  assert.equal(toolCalls.length, 2, 'one ToolCallEvent per observed tool call');
  assert.deepEqual(
    toolCalls.map((event) => event.toolName),
    ['bash', 'read'],
  );
  assert.ok(toolCalls.every((event) => event.sessionKey === 'fp-events'), 'the response-derived session key is used');
  assert.deepEqual(toolCalls[0].args, { cmd: 'curl https://example.com' });
  assert.deepEqual(toolCalls[1].args, { path: '/tmp/x' });
  assert.ok(toolCalls.every((event) => typeof event.at === 'number'), 'each event carries an epoch timestamp');
});

// --- InterventionEvent (request phase, flagship loop) -----------------------

test('request phase: the flagship loop rule emits an InterventionEvent with its action + ruleId', async () => {
  const { bus, events } = capturingBus();
  const stage = createPolicyStage({ engine: createRuleEngine([flagshipLoopRule()]), bus });
  const ctx = makeRequest(loopMessages(4, 'bash', '{"cmd":"curl"}', 'ok'), { model: 'gpt-test' });

  await stage.onRequest!(ctx);

  const interventions = interventionEvents(events);
  assert.equal(interventions.length, 1, 'exactly one intervention for the firing loop rule');
  assert.equal(interventions[0].ruleId, 'flagship-loop-rule');
  assert.equal(interventions[0].action, 'injectMessage');
  assert.equal(typeof interventions[0].detail, 'string');
  assert.ok(interventions[0].detail!.length > 0, 'the intervention carries a short human-readable detail');
  assert.ok(interventions[0].sessionKey.length > 0, 'the request-derived session key is recorded');
  assert.ok(typeof interventions[0].at === 'number', 'the intervention carries an epoch timestamp');
});

// --- InterventionEvent (response phase, block) -----------------------------

test('response phase: a block rule emits an InterventionEvent alongside the observed tool call', async () => {
  const key: SessionKey = { fingerprint: 'fp-block-events' };
  const { bus, events } = capturingBus();
  const stage = createPolicyStage({
    engine: createRuleEngine([
      ruleOf('block-bash', createBlockAction({ reason: 'forbidden' }), createToolNameMatcher({ toolName: 'bash' })),
    ]),
    bus,
  });

  await stage.onResponse!(makeResponse([{ id: 'c1', name: 'bash', arguments: { cmd: 'rm -rf /' } }], key));

  const interventions = interventionEvents(events);
  assert.equal(interventions.length, 1, 'exactly one intervention for the firing block rule');
  assert.equal(interventions[0].ruleId, 'block-bash');
  assert.equal(interventions[0].action, 'block');
  assert.equal(interventions[0].sessionKey, 'fp-block-events', 'the response-derived session key is used');
  assert.equal(typeof interventions[0].detail, 'string');
  assert.ok(/block/i.test(interventions[0].detail!), 'the block detail mentions blocking');

  // The observed tool call was also published in the same response phase.
  assert.equal(toolCallEvents(events).length, 1, 'the offending call is observed before being dropped');
  assert.equal(toolCallEvents(events)[0].toolName, 'bash');
});

// --- no bus: identical behavior --------------------------------------------

test('no bus: a non-match request/response are returned unchanged (identical to the bus-less stage)', async () => {
  const stage = createPolicyStage({
    engine: createRuleEngine([
      ruleOf('never', createInjectMessageAction({ content: 'should not appear' }), neverMatch()),
    ]),
    // No `bus` provided: nothing is emitted and nothing is subscribed.
  });

  const raw = { model: 'gpt-test' };
  const requestMessages: Message[] = [SYSTEM, USER];
  const requestOut = await stage.onRequest!(makeRequest(requestMessages, raw));
  assert.deepEqual(requestOut.messages, requestMessages, 'request messages are unchanged on a non-match');
  assert.equal(requestOut.raw, raw, 'request raw is unchanged on a non-match');

  const calls: ToolCall[] = [{ id: 'c1', name: 'read', arguments: {} }];
  const responseOut = await stage.onResponse!(makeResponse(calls));
  assert.deepEqual(responseOut.toolCalls, calls, 'response tool calls are unchanged on a non-match');
  assert.equal(responseOut.content, '', 'response content is unchanged on a non-match');
});

test('no bus: a matching effect is still applied exactly as before (no emission side effects)', async () => {
  const stage = createPolicyStage({
    engine: createRuleEngine([
      ruleOf('hide-bash', createHideToolAction({ toolNames: ['bash'] }), alwaysMatch()),
    ]),
    // No `bus`: effects apply; nothing is emitted.
  });
  const raw = { model: 'gpt-test', tools: [{ function: { name: 'bash' } }, { function: { name: 'read' } }] };

  const out = await stage.onRequest!(makeRequest([SYSTEM, USER], raw));

  const names = toolNamesOf(out.raw);
  assert.ok(!names.includes('bash'), 'the hideTool effect still applies with no bus wired');
  assert.ok(names.includes('read'), 'unmatched tools remain available');
});
