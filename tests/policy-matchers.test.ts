import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createToolNameMatcher,
  createArgPatternMatcher,
  createLoopDetector,
} from '../src/policy/matchers';
import type { Match } from '../src/policy/types';
import type { Message } from '../src/session/session';
import type { RequestContext } from '../src/ports/pipeline';

/**
 * Tests for the policy matchers (`toolName`, `argPattern`, and the flagship
 * `loopDetector`). Fixtures are built as {@link RequestContext}-shaped
 * {@link PolicyContext} objects whose `messages` are the OpenAI-style shapes the
 * matchers actually parse (assistant `tool_calls` + `role: "tool"` results).
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

/** A non-null {@link Match}, or fail the test. */
function expectMatch(match: Match | null, label: string): Match {
  if (match === null) assert.fail(`${label}: expected a Match, got null`);
  return match;
}

interface LoopOverride {
  index: number;
  paramsJson?: string;
  result?: string;
}

/**
 * The message list for a run of `count` (tool + params + result) pairs, prefixed
 * by the stable system + user prefix. `overrides` lets individual pairs differ.
 */
function loopMessages(
  count: number,
  toolName: string,
  paramsJson: string,
  result: string,
  overrides?: LoopOverride[],
): Message[] {
  const messages: Message[] = [...prefix()];
  for (let i = 0; i < count; i += 1) {
    const id = `c${i + 1}`;
    const override = overrides?.find((entry) => entry.index === i);
    messages.push(assistantCall(id, toolName, override?.paramsJson ?? paramsJson));
    messages.push(toolResult(id, override?.result ?? result));
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

// --- toolName ---------------------------------------------------------------

test('toolName: a bash tool call matches { toolName: "bash" }', () => {
  const match = expectMatch(createToolNameMatcher({ toolName: 'bash' }).matches(makeRequest(bashCall())), 'bash');
  assert.equal(match.matched, true);
  assert.deepEqual(match.details?.matchedToolNames, ['bash']);
});

test('toolName: { toolName: "read" } does not match a bash call → null', () => {
  assert.strictEqual(createToolNameMatcher({ toolName: 'read' }).matches(makeRequest(bashCall())), null);
});

test('toolName: { toolNames: ["bash","curl"] } matches a bash call', () => {
  const match = expectMatch(
    createToolNameMatcher({ toolNames: ['bash', 'curl'] }).matches(makeRequest(bashCall())),
    'bash-or-curl',
  );
  assert.equal(match.matched, true);
  assert.deepEqual(match.details?.matchedToolNames, ['bash']);
});

// --- argPattern -------------------------------------------------------------

test('argPattern: a bash call whose args contain "curl" matches { toolName: "bash", pattern: "curl" }', () => {
  const match = expectMatch(
    createArgPatternMatcher({ toolName: 'bash', pattern: 'curl' }).matches(makeRequest(bashCall())),
    'bash+curl',
  );
  assert.equal(match.matched, true);
  assert.equal(match.details?.toolName, 'bash');
});

test('argPattern: restricting to { toolName: "read" } skips the bash call → null', () => {
  assert.strictEqual(
    createArgPatternMatcher({ toolName: 'read', pattern: 'curl' }).matches(makeRequest(bashCall())),
    null,
  );
});

test('argPattern: a pattern absent from the args → null', () => {
  assert.strictEqual(
    createArgPatternMatcher({ toolName: 'bash', pattern: 'wget' }).matches(makeRequest(bashCall())),
    null,
  );
});

// --- loopDetector (flagship) ------------------------------------------------

test('loopDetector: 4 consecutive identical calls (same tool + params + result) match (default window=4)', () => {
  const match = expectMatch(
    createLoopDetector().matches(makeRequest(loopMessages(4, 'bash', '{"cmd":"curl https://example.com"}', 'ok'))),
    '4-identical',
  );
  assert.equal(match.matched, true);
  assert.equal(match.details?.toolName, 'bash');
  assert.equal(match.details?.window, 4);
  assert.equal(match.details?.runLength, 4);
});

test('loopDetector: only 3 identical calls (window=4) → null', () => {
  assert.strictEqual(
    createLoopDetector().matches(makeRequest(loopMessages(3, 'bash', '{"cmd":"curl https://example.com"}', 'ok'))),
    null,
  );
});

test('loopDetector: an intervening non-identical call breaks the run → null (requireConsecutive default)', () => {
  const match = createLoopDetector().matches(
    makeRequest(
      loopMessages(4, 'bash', '{"cmd":"curl https://example.com"}', 'ok', [
        { index: 2, paramsJson: '{"cmd":"curl https://other.example.com"}' },
      ]),
    ),
  );
  assert.strictEqual(match, null);
});

test('loopDetector: 4 identical tool names but different params → null (normalized param identity)', () => {
  const match = createLoopDetector().matches(
    makeRequest(
      loopMessages(4, 'bash', '{"cmd":"a"}', 'ok', [
        { index: 1, paramsJson: '{"cmd":"b"}' },
        { index: 2, paramsJson: '{"cmd":"c"}' },
        { index: 3, paramsJson: '{"cmd":"d"}' },
      ]),
    ),
  );
  assert.strictEqual(match, null);
});

test('loopDetector: 4 identical tool + params but different results → null (normalized result identity)', () => {
  const match = createLoopDetector().matches(
    makeRequest(
      loopMessages(4, 'bash', '{"cmd":"curl https://example.com"}', 'ok', [
        { index: 1, result: 'r1' },
        { index: 2, result: 'r2' },
        { index: 3, result: 'r3' },
      ]),
    ),
  );
  assert.strictEqual(match, null);
});

test('loopDetector: window: 3 → 3 consecutive identical calls match', () => {
  const match = expectMatch(
    createLoopDetector({ window: 3 }).matches(makeRequest(loopMessages(3, 'bash', '{"cmd":"curl https://example.com"}', 'ok'))),
    'window-3',
  );
  assert.equal(match.matched, true);
  assert.equal(match.details?.window, 3);
  assert.equal(match.details?.runLength, 3);
});

test('loopDetector: requireConsecutive: false → a non-adjacent run of 4 identical calls matches', () => {
  // 4 identical calls followed by one different, so the run is NOT at the tail.
  const messages = loopMessages(5, 'bash', '{"cmd":"curl https://example.com"}', 'ok', [
    { index: 4, paramsJson: '{"cmd":"different"}' },
  ]);
  const match = expectMatch(createLoopDetector({ requireConsecutive: false }).matches(makeRequest(messages)), 'requireConsecutive-false');
  assert.equal(match.matched, true);
  assert.equal(match.details?.window, 4);
  assert.equal(match.details?.runLength, 4);
  // …whereas the default (requireConsecutive: true) requires the run at the tail.
  assert.strictEqual(createLoopDetector().matches(makeRequest(messages)), null);
});

test('loopDetector: reordered args keys match under paramIdentity "normalized" but not "exact"', () => {
  const messages = loopMessages(4, 'bash', '{"a":1,"b":2}', 'ok', [
    { index: 2, paramsJson: '{"b":2,"a":1}' },
  ]);
  const normalized = expectMatch(
    createLoopDetector({ paramIdentity: 'normalized' }).matches(makeRequest(messages)),
    'normalized',
  );
  assert.equal(normalized.matched, true);
  assert.strictEqual(createLoopDetector({ paramIdentity: 'exact' }).matches(makeRequest(messages)), null);
});
