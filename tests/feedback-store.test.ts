import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionFeedbackStore } from '../src/policy/feedbackStore';
import type { FeedbackMessage } from '../src/policy/feedbackStore';
import type { SessionKey } from '../src/ports/domain';

/** Build a feedback message with the given content and optional role. */
function msg(content: string, role: FeedbackMessage['role'] = 'user'): FeedbackMessage {
  return { role, content };
}

// --- queue / drain -----------------------------------------------------------

test('queue then drain returns queued messages in FIFO order and empties the queue', () => {
  const store = new SessionFeedbackStore();
  store.queue('s1', msg('first'));
  store.queue('s1', msg('second'));
  assert.deepEqual(store.drain('s1'), [msg('first'), msg('second')]);
  // a second drain finds nothing left
  assert.deepEqual(store.drain('s1'), []);
});

test('drain with no entries returns an empty array', () => {
  const store = new SessionFeedbackStore();
  assert.deepEqual(store.drain('missing'), []);
});

test('multiple queue calls for the same key accumulate in order', () => {
  const store = new SessionFeedbackStore();
  store.queue('s1', msg('a'));
  store.queue('s1', msg('b'));
  store.queue('s1', msg('c'));
  assert.deepEqual(store.drain('s1'), [msg('a'), msg('b'), msg('c')]);
});

// --- isolation between keys --------------------------------------------------

test('different keys are isolated (draining one does not affect another)', () => {
  const store = new SessionFeedbackStore();
  store.queue('a', msg('in-a'));
  store.queue('b', msg('in-b'));
  assert.deepEqual(store.drain('a'), [msg('in-a')]);
  assert.deepEqual(store.drain('b'), [msg('in-b')]);
  // each is now empty independently
  assert.deepEqual(store.drain('a'), []);
  assert.equal(store.has('b'), false);
});

// --- clear -------------------------------------------------------------------

test('clear removes entries; afterwards drain is [] and has is false', () => {
  const store = new SessionFeedbackStore();
  store.queue('s1', msg('x'));
  store.queue('s1', msg('y'));
  assert.equal(store.has('s1'), true);
  store.clear('s1');
  assert.deepEqual(store.drain('s1'), []);
  assert.equal(store.has('s1'), false);
  assert.equal(store.size('s1'), 0);
});

// --- SessionKey object vs fingerprint string ---------------------------------

test('passing a SessionKey behaves the same as passing its fingerprint string', () => {
  const store = new SessionFeedbackStore();
  const key: SessionKey = { fingerprint: 'fp-1' };
  store.queue(key, msg('via-key'));
  // the same entry is reachable through the plain fingerprint string
  assert.deepEqual(store.drain('fp-1'), [msg('via-key')]);
  // queued via the string, read back via a different SessionKey with the same fingerprint
  store.queue('fp-2', msg('via-string'));
  const key2: SessionKey = { fingerprint: 'fp-2', token: 'tok' };
  assert.deepEqual(store.drain(key2), [msg('via-string')]);
  assert.equal(store.has(key2), false);
});

// --- size / has / purgeAll ---------------------------------------------------

test('size() and has() reflect state correctly', () => {
  const store = new SessionFeedbackStore();
  assert.equal(store.size(), 0);
  assert.equal(store.has('s1'), false);
  store.queue('s1', msg('a'));
  store.queue('s1', msg('b'));
  store.queue('s2', msg('c'));
  assert.equal(store.has('s1'), true);
  assert.equal(store.size('s1'), 2);
  assert.equal(store.size('s2'), 1);
  assert.equal(store.size('none'), 0);
  assert.equal(store.size(), 3);
});

test('purgeAll clears every key (reset)', () => {
  const store = new SessionFeedbackStore();
  store.queue('a', msg('x'));
  store.queue('b', msg('y'));
  assert.equal(store.size(), 2);
  store.purgeAll();
  assert.equal(store.size(), 0);
  assert.deepEqual(store.drain('a'), []);
  assert.deepEqual(store.drain('b'), []);
  assert.equal(store.has('a'), false);
});
