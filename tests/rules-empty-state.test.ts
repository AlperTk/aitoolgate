/**
 * DOM-stubbed behaviour test for the policy-rules list empty state
 * (dashboard/js/rules.mjs: renderRules()). The list's `#rule-empty` element is
 * toggled via its `hidden` attribute; dashboard/css/rules.css forces
 * `.empty-lg[hidden] { display: none }` so the block is truly hidden whenever
 * >=1 rule exists and visible at zero. This test guards the JS half of that
 * contract (the value written into `#rule-empty.hidden`) across counts.
 */
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createDomStub, DomStub } from './dom-stub';

const base = '../..' + '/dashboard';

const S: DomStub = createDomStub();
const LIST = S.el('rule-list', 'ul');
const EMPTY = S.el('rule-empty', 'div');

let R: any;
before(async () => {
  R = await import(base + '/js/rules.mjs');
});
beforeEach(() => {
  LIST.children.length = 0;
  EMPTY.hidden = false;
  EMPTY.textContent = '';
});

const spec = (id: string, enabled: boolean): any => ({
  id,
  enabled,
  description: 'Rule ' + id,
  matcher: { type: 'loop' },
  action: { type: 'block' },
});

test('D1 empty state is HIDDEN when at least one rule exists', () => {
  R.renderRules([spec('r1', true)]);
  assert.equal(EMPTY.hidden, true, '#rule-empty hidden with 1 rule');
  assert.equal(LIST.children.length, 1, 'one rule card rendered');
  R.renderRules([spec('r1', true), spec('r2', false)]);
  assert.equal(EMPTY.hidden, true, 'still hidden with 2 rules');
  assert.equal(LIST.children.length, 2);
});

test('D1 empty state is VISIBLE at zero rules', () => {
  R.renderRules([]);
  assert.equal(EMPTY.hidden, false, '#rule-empty shown at zero rules');
  assert.equal(LIST.children.length, 0, 'no rule cards');
});

test('D1 toggling correctly re-renders as the rule count crosses zero both ways', () => {
  R.renderRules([spec('r1', true)]);
  assert.equal(EMPTY.hidden, true);
  R.renderRules([]);
  assert.equal(EMPTY.hidden, false, 'becomes visible once all rules are gone');
  R.renderRules([spec('r1', false)]); // a disabled (is-disabled) rule still counts
  assert.equal(EMPTY.hidden, true, 'becomes hidden again once any rule exists');
});

test('D1 non-array inputs (null/undefined) show the empty state without throwing', () => {
  R.renderRules(null);
  assert.equal(EMPTY.hidden, false, 'null input → empty state visible');
  assert.equal(LIST.children.length, 0, 'no rule cards rendered');
  R.renderRules(undefined);
  assert.equal(EMPTY.hidden, false, 'undefined input → empty state visible');
  assert.equal(LIST.children.length, 0);
  R.renderRules(spec('r1', true)); // a single spec object (not wrapped in an array)
  assert.equal(EMPTY.hidden, false, 'non-array single spec treated as zero rules');
  assert.equal(LIST.children.length, 0);
});
