/**
 * DOM-stubbed behaviour tests for the opt-in "Group by session" stream mode
 * (dashboard/js/live/view.mjs regroupStream + bindFilterEvents). Loads the real
 * ES modules under the in-memory DOM (tests/dom-stub.ts) and drives them through
 * the same change/click wiring the app uses. Covers: contiguous per-session
 * groups with headers, header counts under filters, collapse hiding rows,
 * toggling off restoring the flat newest-first list, headers excluded from the
 * "showing N of M" count, and the "(no session)" label.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createDomStub, FakeEl, DomStub } from '../dom-stub';

const base = '../../..' + '/dashboard';

const S: DomStub = createDomStub();
const SL = S.el('stream-list', 'ul');
S.el('intervention-list', 'ul');
const COUNT = S.el('stream-count', 'span');
S.el('stream-empty', 'div');
const FT = S.el('filter-tool', 'input');
S.el('filter-status', 'select');
S.el('filter-session', 'input');
const GROUP = S.el('group-by-session', 'input');
const HEAD = S.el('stream-head', 'div');

// localStorage stub, installed for this file only and restored in after().
const KEY = 'aitoolgate.groupBySession';
const store = new Map<string, string>();
let throwing = false;
const stubStorage = {
  getItem(k: string): string | null {
    if (throwing) throw new Error('denied');
    return store.has(k) ? store.get(k)! : null;
  },
  setItem(k: string, v: string): void {
    if (throwing) throw new Error('denied');
    store.set(k, String(v));
  },
};
const realDesc = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

let LV: any;
let ST: any;
let INITIAL_CHECKED = false;
let INITIAL_STATE = false;
before(async () => {
  Object.defineProperty(globalThis, 'localStorage', { value: stubStorage, configurable: true, writable: true });
  ST = (await import(base + '/js/core/state.mjs')).state;
  INITIAL_STATE = ST.groupBySession;
  LV = await import(base + '/js/live/view.mjs');
  LV.bindFilterEvents();
  INITIAL_CHECKED = GROUP.checked;
});
after(() => {
  if (realDesc) Object.defineProperty(globalThis, 'localStorage', realDesc);
  else delete (globalThis as any).localStorage;
});

test('fresh load: grouping is enabled by default and the toggle is checked', () => {
  assert.equal(INITIAL_STATE, true);
  assert.equal(INITIAL_CHECKED, true);
});

beforeEach(() => {
  SL.children.length = 0;
  COUNT.textContent = '';
  ST.callRows.clear();
  ST.orphanResultEntries.length = 0;
  ST.collapsedSessions.clear();
  ST.groupBySession = false;
  FT.value = '';
  GROUP.checked = false;
  store.clear();
  throwing = false;
});

test('no saved value: bind defaults to grouped and checkbox reflects it', () => {
  LV.bindFilterEvents();
  assert.equal(ST.groupBySession, true);
  assert.equal(GROUP.checked, true);
  assert.ok(SL.classList.contains('is-grouped'));
  assert.ok(HEAD.classList.contains('is-grouped'));
});

test('malformed saved value falls back to default true', () => {
  store.set(KEY, 'garbage');
  LV.bindFilterEvents();
  assert.equal(ST.groupBySession, true);
  assert.equal(GROUP.checked, true);
});

test('saved false is restored on bind: state, checkbox and classes reflect flat mode', () => {
  store.set(KEY, 'false');
  LV.bindFilterEvents();
  assert.equal(ST.groupBySession, false);
  assert.equal(GROUP.checked, false);
  assert.ok(!SL.classList.contains('is-grouped'));
  assert.ok(!HEAD.classList.contains('is-grouped'));
});

test('toggle persists true and false to storage', () => {
  toggleGroups(false);
  assert.equal(store.get(KEY), 'false');
  toggleGroups(true);
  assert.equal(store.get(KEY), 'true');
  assert.ok(SL.classList.contains('is-grouped'));
  assert.ok(HEAD.classList.contains('is-grouped'));
});

test('storage throwing does not break bind or toggle', () => {
  throwing = true;
  assert.doesNotThrow(() => LV.bindFilterEvents());
  assert.equal(ST.groupBySession, true);
  assert.doesNotThrow(() => toggleGroups(false));
  assert.equal(ST.groupBySession, false);
  assert.equal(GROUP.checked, false);
});

function addCall(id: string, session: string, tool: string): void {
  LV.createCallRow({ type: 'tool.call', id, sessionKey: session, toolName: tool, at: 1000 + Number(id.slice(1)) });
}
function heads(): FakeEl[] {
  return SL.children.filter((c) => c.classList.contains('stream-group-head'));
}
function headFor(session: string): FakeEl {
  const h = heads().find((x) => x.dataset.session === session);
  assert.ok(h, 'header exists for session ' + JSON.stringify(session));
  return h!;
}
function rowIds(): string[] {
  return SL.children.filter((c) => c.classList.contains('stream-row')).map((c) => c.dataset.callId);
}
// Dispatch a click on `target` through the stable #stream-list delegate (the stub has no bubbling).
function clickEl(target: FakeEl): void {
  ((SL as any)._listeners.click || []).slice().forEach((fn: any) => fn.call(SL, { target }));
}
function toggleGroups(on: boolean): void {
  GROUP.checked = on;
  GROUP.emit('change');
}
// Creates: c1 (sess a, read), c2 (sess b, read), c3 (sess a, write), c4 (no session, read).
// Newest-first flat order is therefore c4, c3, c2, c1.
function seed(): void {
  addCall('c1', 'a', 'read');
  addCall('c2', 'b', 'read');
  addCall('c3', 'a', 'write');
  addCall('c4', '', 'read');
}

test('grouping on: rows are contiguous per session, newest group first, with headers', () => {
  seed();
  toggleGroups(true);
  const seq = SL.children.map((c) => (c.classList.contains('stream-group-head') ? 'H:' + c.dataset.session : c.dataset.callId));
  assert.deepEqual(seq, ['H:', 'c4', 'H:a', 'c3', 'c1', 'H:b', 'c2']);
});

test('header count reflects filter-passing rows; hidden when none pass; not counted in showing N of M', () => {
  seed();
  toggleGroups(true);
  assert.equal(headFor('a').children[2].textContent, '2 executions');
  assert.equal(COUNT.textContent, '', 'no filter active -> no count text');

  FT.value = 'write';
  FT.emit('input');
  assert.equal(headFor('a').children[2].textContent, '1 execution');
  assert.equal(headFor('a').style.display, '');
  assert.equal(headFor('b').style.display, 'none', 'group with no passing rows hides its header');
  assert.equal(headFor('').style.display, 'none');
  assert.equal(COUNT.textContent, 'showing 1 of 4', 'headers are not counted in the total');
});

test('clicking a header toggles collapse: rows hidden (kept in DOM) and restored on second click', () => {
  seed();
  toggleGroups(true);
  clickEl(headFor('a').children[1]);
  assert.ok(ST.collapsedSessions.has('a'));
  const a = SL.children.filter((c) => c.classList.contains('stream-row') && c.dataset.session === 'a');
  assert.equal(a.length, 2, 'collapsed rows are still in the list');
  assert.ok(a.every((r) => r.classList.contains('is-collapsed')));
  assert.equal(headFor('a').children[0].getAttribute('aria-expanded'), 'false');

  clickEl(headFor('a').children[1]);
  assert.ok(!ST.collapsedSessions.has('a'));
  assert.ok(a.every((r) => !r.classList.contains('is-collapsed')));
});

test('toggling off removes headers, clears collapse, and restores newest-first flat order', () => {
  seed();
  toggleGroups(true);
  clickEl(headFor('a').children[1]);
  toggleGroups(false);
  assert.equal(heads().length, 0, 'no headers remain');
  assert.deepEqual(rowIds(), ['c4', 'c3', 'c2', 'c1'], 'flat newest-first order restored');
  assert.ok(SL.children.every((c) => !c.classList.contains('is-collapsed')));
});

test('rows without a session are grouped under the localized "(no session)" label', () => {
  seed();
  toggleGroups(true);
  const h = headFor('');
  assert.equal(h.children[1].textContent, '(no session)');
  assert.equal(h.children[1].title, '(no session)');
});

test('new rows arriving while grouped are placed into their session group', () => {
  seed();
  toggleGroups(true);
  addCall('c5', 'b', 'read');
  const seq = SL.children.map((c) => (c.classList.contains('stream-group-head') ? 'H:' + c.dataset.session : c.dataset.callId));
  assert.deepEqual(seq, ['H:b', 'c5', 'c2', 'H:', 'c4', 'H:a', 'c3', 'c1']);
  assert.equal(headFor('b').children[2].textContent, '2 executions');
});

test('a brand-new session call while grouped creates a group placed before all existing groups', () => {
  seed();
  toggleGroups(true);
  addCall('c0', 'z', 'read');
  const seq = SL.children.map((c) => (c.classList.contains('stream-group-head') ? 'H:' + c.dataset.session : c.dataset.callId));
  assert.deepEqual(seq, ['H:z', 'c0', 'H:', 'c4', 'H:a', 'c3', 'c1', 'H:b', 'c2']);
  assert.equal(headFor('z').children[2].textContent, '1 execution');
});

test('context-only session (zero tool rows) gets a group with its prompt/tools; a later row does not duplicate it', async () => {
  const ingest = await import(base + '/js/data/ingest.mjs');
  toggleGroups(true);
  ingest.ingestEvent({ type: 'session.context', sessionKey: 'ctx-only', systemPrompt: 'SYS-ONLY', tools: [{ name: 'shell' }], promptVersion: 1, at: 5000 });
  assert.equal(ST.collapsedSessions.has('ctx-only'), false);
  assert.equal(heads().filter((h) => h.dataset.session === 'ctx-only').length, 1);
  assert.equal(headFor('ctx-only').style.display, '', 'zero-row group header is visible');
  assert.equal(headFor('ctx-only').children[2].textContent, '0 executions');
  const ctx = () => SL.children.filter((c) => c.classList.contains('stream-group-context') && c.dataset.session === 'ctx-only');
  assert.equal(ctx().length, 1, 'session-level context block rendered');
  const html = (ctx()[0] as any).innerHTML as string;
  assert.ok(html.includes('SYS-ONLY'));
  assert.ok(html.includes('shell'));

  FT.value = 'read';
  FT.emit('input');
  assert.equal(heads().filter((h) => h.dataset.session === 'ctx-only').length, 0, 'tool filter hides zero-row session group');
  FT.value = '';
  FT.emit('input');

  addCall('c9', 'ctx-only', 'read');
  assert.equal(heads().filter((h) => h.dataset.session === 'ctx-only').length, 1, 'no duplicate group after a tool row');
  assert.equal(headFor('ctx-only').children[2].textContent, '1 execution');
  assert.equal(ctx().length, 1, 'context block still rendered once');
  assert.deepEqual(rowIds().filter((id) => id === 'c9'), ['c9']);
});

test('clicking the header label toggles collapse once; clicking the toggle button toggles once', () => {
  seed();
  toggleGroups(true);
  clickEl(headFor('b').children[1]);
  assert.ok(ST.collapsedSessions.has('b'));
  assert.equal(headFor('b').children[0].getAttribute('aria-expanded'), 'false');
  clickEl(headFor('b').children[1]);
  assert.ok(!ST.collapsedSessions.has('b'));
  clickEl(headFor('b').children[0]);
  assert.ok(ST.collapsedSessions.has('b'), 'button click toggles exactly once');
  assert.equal(headFor('b').children[0].getAttribute('aria-expanded'), 'false');
  assert.equal(headFor('b').children[2].textContent, '1 execution');
});

test('header singular/plural count: "1 execution" for one row, "N executions" otherwise', () => {
  seed();
  toggleGroups(true);
  assert.equal(headFor('b').children[2].textContent, '1 execution');
  assert.equal(headFor('a').children[2].textContent, '2 executions');
});

test('group usage summary: latest turn, distinct-turn session total, cache only when reported', async () => {
  const ingest: any = await import(base + '/js/data/ingest.mjs');
  const LV: any = await import(base + '/js/live/view.mjs');
  const F: any = await import(base + '/js/core/format.mjs');
  const fc = (n: number): string => F.formatCount(n);
  seed();
  toggleGroups(true);
  // session a: turns at 100 and 200 (cache 400 + 600); duplicate of turn 200 without cache keeps 600.
  ingest.ingestEvent({ type: 'turn.usage', sessionKey: 'a', at: 100, tokens: { total: 1000, cacheHitInput: 400 } });
  ingest.ingestEvent({ type: 'turn.usage', sessionKey: 'a', at: 200, tokens: { total: 1500, cacheHitInput: 600 } });
  LV.applyTurnUsageToRows({ type: 'turn.usage', sessionKey: 'a', at: 200, tokens: { total: 1500 } });
  // session b: one turn with no cache field -> no Cache Hit metric.
  ingest.ingestEvent({ type: 'turn.usage', sessionKey: 'b', at: 50, tokens: { total: 700 } });
  // session '' : reported cache 0 is valid and shown.
  ingest.ingestEvent({ type: 'turn.usage', sessionKey: '', at: 60, tokens: { total: 0, cacheHitInput: 0 } });
  assert.equal(
    headFor('a').children[3].textContent,
    'Latest turn: ' + fc(1500) + ' · Session total: ' + fc(2500) + ' · Cache Hit: ' + fc(1000)
  );
  assert.equal(
    headFor('b').children[3].textContent,
    'Latest turn: ' + fc(700) + ' · Session total: ' + fc(700)
  );
  assert.equal(
    headFor('').children[3].textContent,
    'Latest turn: ' + fc(0) + ' · Session total: ' + fc(0) + ' · Cache Hit: ' + fc(0)
  );
});
