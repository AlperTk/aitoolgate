import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRuleEngine } from '../src/policy/ruleEngine';
import type { PolicyAction, PolicyRule } from '../src/policy/ruleEngine';
import type { PolicyContext, PolicyMatcher } from '../src/policy/types';
import { createRuleStore } from '../src/api/ruleStore';

/** A trivial matcher that always fires with a fixed {@link Match}. */
const always: PolicyMatcher = { matches: () => ({ matched: true, reason: 'test' }) };

/** A trivial no-op action that produces no effect. */
const noop: PolicyAction = { name: 'noop', apply: () => null };

/** Build a concrete {@link PolicyRule} whose action emits an identifiable block effect keyed by `id`. */
function mkRule(id: string, matcher: PolicyMatcher = always): PolicyRule {
  return {
    id,
    enabled: true,
    matcher,
    action: { name: `act:${id}`, apply: () => ({ type: 'hideTool', toolNames: [id] }) },
  };
}

/** A context that satisfies the engine; our fixtures ignore it. */
const ctx = {} as PolicyContext;

// --- RuleStore CRUD ---------------------------------------------------------

test('add stores a copy and assigns a unique id when id is missing/empty', () => {
  const store = createRuleStore();
  assert.equal(store.size(), 0);

  const assigned = store.add(mkRule('')); // empty id -> a unique one is generated
  assert.ok(assigned.id.length > 0);
  assert.notEqual(assigned.id, '');
  assert.equal(store.size(), 1);
  assert.ok(store.get(assigned.id));

  // a provided non-empty id is preserved
  const kept = store.add(mkRule('kept'));
  assert.equal(kept.id, 'kept');
  assert.equal(store.size(), 2);

  // distinct unique ids are generated for each empty-id add
  const a = store.add(mkRule(''));
  const b = store.add(mkRule(''));
  assert.notEqual(a.id, b.id);
});

test('get returns the stored rule (a copy); unknown id yields undefined', () => {
  const store = createRuleStore({ initial: [mkRule('r')] });
  const found = store.get('r');
  assert.ok(found);
  assert.equal(found!.id, 'r');
  assert.equal(found!.enabled, true);
  assert.equal(store.get('missing'), undefined);
});

test('update merges scalar fields and can replace matcher/action; unknown id yields undefined', () => {
  const store = createRuleStore({ initial: [mkRule('r')] });
  assert.equal(store.get('r')!.enabled, true);

  const updated = store.update('r', { enabled: false, description: 'now desc' })!;
  assert.equal(updated.enabled, false);
  assert.equal(updated.description, 'now desc');
  assert.equal(updated.id, 'r');

  // replacing the matcher AND action works, and prior updates persist
  const neverMatch: PolicyMatcher = { matches: () => null };
  const finalRule = store.update('r', { matcher: neverMatch, action: noop })!;
  assert.equal(finalRule.matcher, neverMatch);
  assert.equal(finalRule.action, noop);
  assert.equal(finalRule.enabled, false); // persisted from the earlier update

  assert.equal(store.update('missing', { enabled: false }), undefined);
});

test('remove removes a rule (false when absent); size tracks correctly', () => {
  const store = createRuleStore({ initial: [mkRule('a'), mkRule('b')] });
  assert.equal(store.size(), 2);
  assert.equal(store.remove('a'), true);
  assert.equal(store.remove('a'), false); // already gone
  assert.equal(store.remove('zzz'), false); // never existed
  assert.equal(store.size(), 1);
  assert.ok(store.get('b'));
  assert.equal(store.get('a'), undefined);
});

test('reset restores the initial state (empty when no initial was provided)', () => {
  const seeded = createRuleStore({ initial: [mkRule('a'), mkRule('b')] });
  seeded.remove('a');
  seeded.add(mkRule('c'));
  assert.deepEqual(seeded.list().map((rule) => rule.id), ['b', 'c']);
  seeded.reset();
  assert.deepEqual(seeded.list().map((rule) => rule.id), ['a', 'b']);

  const empty = createRuleStore();
  empty.add(mkRule('x'));
  assert.equal(empty.size(), 1);
  empty.reset();
  assert.equal(empty.size(), 0);
  assert.equal(empty.list().length, 0);
});

test('list returns a copy: mutating the returned array or element does not affect the store', () => {
  const store = createRuleStore({ initial: [mkRule('a'), mkRule('b')] });
  const snapshot = store.list();
  assert.equal(snapshot.length, 2);

  // mutating the returned ARRAY -> store unaffected
  snapshot.push(mkRule('ghost'));
  assert.equal(store.size(), 2);
  assert.deepEqual(store.list().map((rule) => rule.id), ['a', 'b']);

  // mutating a returned ELEMENT -> store unaffected
  const single = store.get('a')!;
  single.enabled = false;
  assert.equal(store.get('a')!.enabled, true);
});

test('add stores a copy: mutating the returned rule does not corrupt the store', () => {
  const store = createRuleStore();
  const stored = store.add(mkRule('c'));
  stored.enabled = false;
  assert.equal(store.get('c')!.enabled, true);
});

// --- dynamic engine (rules source as a getter) -----------------------------

test('dynamic engine reflects runtime add/remove through a getter rules source', () => {
  const store = createRuleStore(); // no initial
  const engine = createRuleEngine(() => store.list());

  // empty store -> nothing applied
  const emptyResult = engine.evaluate(ctx);
  assert.equal(emptyResult.effects.length, 0);
  assert.equal(emptyResult.applied.length, 0);
  assert.equal(emptyResult.matches.length, 0);

  // add a rule -> it now applies
  store.add(mkRule('r1'));
  const withRule = engine.evaluate(ctx);
  assert.ok(withRule.applied.some((entry) => entry.ruleId === 'r1'));
  assert.ok(withRule.matches.some((entry) => entry.ruleId === 'r1'));
  assert.equal(withRule.effects.length, 1);

  // remove it -> nothing again
  store.remove('r1');
  const afterRemove = engine.evaluate(ctx);
  assert.equal(afterRemove.effects.length, 0);
  assert.equal(afterRemove.applied.length, 0);
  assert.ok(!afterRemove.applied.some((entry) => entry.ruleId === 'r1'));
});

test('an array rules source still evaluates its rules (backward compatible)', () => {
  const engine = createRuleEngine([mkRule('a')]);
  const result = engine.evaluate(ctx);
  assert.ok(result.applied.some((entry) => entry.ruleId === 'a'));
  assert.ok(result.matches.some((entry) => entry.ruleId === 'a'));
  assert.equal(result.effects.length, 1);
});

test('a matched rule whose action is a no-op appears in matches but contributes no effect/applied entry', () => {
  const engine = createRuleEngine([{ id: 'n', enabled: true, matcher: always, action: noop }]);
  const result = engine.evaluate(ctx);
  assert.ok(result.matches.some((entry) => entry.ruleId === 'n'));
  assert.equal(result.effects.length, 0);
  assert.equal(result.applied.length, 0);
});
