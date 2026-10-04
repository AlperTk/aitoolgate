import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveSessionKey } from '../src/session/session';
import type { Message } from '../src/session/session';

const SYSTEM = 'You are a helpful assistant.';
const FIRST_USER = 'What is the weather in Paris?';

/** The stable prefix: a system message plus the first user message. */
function prefixMessages(): Message[] {
  return [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: FIRST_USER },
  ];
}

/** The same conversation after further turns have been appended. */
function grownMessages(): Message[] {
  return [
    ...prefixMessages(),
    { role: 'assistant', content: 'Let me check the weather.' },
    { role: 'tool', content: 'Sunny, 18C', tool_call_id: 'c1' },
    { role: 'user', content: 'Thanks — what about tomorrow?' },
  ];
}

test('same system + same first user message → same key; appended turns do not change it', () => {
  const base = deriveSessionKey({ messages: prefixMessages() });
  const grown = deriveSessionKey({ messages: grownMessages() });
  assert.equal(grown.fingerprint, base.fingerprint);
  assert.equal(grown.token, undefined);
});

test('different first user message → different key', () => {
  const a = deriveSessionKey({
    messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: 'A' }],
  });
  const b = deriveSessionKey({
    messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: 'B' }],
  });
  assert.notEqual(a.fingerprint, b.fingerprint);
});

test('different system prompt → different key', () => {
  const a = deriveSessionKey({
    messages: [{ role: 'system', content: 'SYSTEM-1' }, { role: 'user', content: FIRST_USER }],
  });
  const b = deriveSessionKey({
    messages: [{ role: 'system', content: 'SYSTEM-2' }, { role: 'user', content: FIRST_USER }],
  });
  assert.notEqual(a.fingerprint, b.fingerprint);
});

test('token provided → key derived from the token and different from the content fingerprint', () => {
  const withToken = deriveSessionKey({ messages: prefixMessages(), token: 'tok-123' });
  const withoutToken = deriveSessionKey({ messages: prefixMessages() });
  assert.equal(withToken.token, 'tok-123');
  assert.equal(withoutToken.token, undefined);
  assert.notEqual(withToken.fingerprint, withoutToken.fingerprint);
  // stable for the same token regardless of the messages
  const withTokenAgain = deriveSessionKey({ messages: grownMessages(), token: 'tok-123' });
  assert.equal(withTokenAgain.fingerprint, withToken.fingerprint);
});

test('token precedence: same messages, different tokens → different keys', () => {
  const a = deriveSessionKey({ messages: prefixMessages(), token: 'tok-A' });
  const b = deriveSessionKey({ messages: prefixMessages(), token: 'tok-B' });
  assert.notEqual(a.fingerprint, b.fingerprint);
  assert.equal(a.token, 'tok-A');
  assert.equal(b.token, 'tok-B');
});

test('empty or absent token → falls back to the content fingerprint', () => {
  const empty = deriveSessionKey({ messages: prefixMessages(), token: '' });
  const absent = deriveSessionKey({ messages: prefixMessages() });
  assert.equal(empty.fingerprint, absent.fingerprint);
  assert.equal(empty.token, undefined);
  assert.equal(absent.token, undefined);
});

test('no system message → key is the fingerprint of the first user message alone', () => {
  const noSystem = deriveSessionKey({ messages: [{ role: 'user', content: 'Hello' }] });
  const withSystem = deriveSessionKey({
    messages: [{ role: 'system', content: 'S' }, { role: 'user', content: 'Hello' }],
  });
  assert.equal(
    noSystem.fingerprint,
    deriveSessionKey({ messages: [{ role: 'user', content: 'Hello' }] }).fingerprint,
  );
  assert.notEqual(noSystem.fingerprint, withSystem.fingerprint);
});

test('no user message at all → deterministic key (including the empty list)', () => {
  const systemOnly = deriveSessionKey({ messages: [{ role: 'system', content: 'S' }] });
  assert.equal(
    systemOnly.fingerprint,
    deriveSessionKey({ messages: [{ role: 'system', content: 'S' }] }).fingerprint,
  );
  const emptyList = deriveSessionKey({ messages: [] });
  assert.equal(emptyList.fingerprint, deriveSessionKey({ messages: [] }).fingerprint);
  assert.notEqual(systemOnly.fingerprint, emptyList.fingerprint);
});
