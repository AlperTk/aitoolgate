/**
 * DOM-stubbed coverage for the live stream's per-result status presentation
 * (dashboard/js/live-view.mjs): a tool.result with ok:false renders the "fail"
 * status (a distinct .badge-fail tone), a successful result keeps "ok", an
 * unpaired call keeps the "pending" placeholder, and orphan result rows (no
 * matching tool.call) also surface "fail" when ok is false.
 *
 * Mirrors tests/dashboard-tool-description.test.ts: createDomStub() + the
 * materialized stream/filter elements, an injected globalThis.fetch, and async
 * completion drained via the microtask queue (no timers/sleeps). Each test file
 * runs in its own process, so one installed stub never leaks.
 */
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createDomStub, DomStub } from './dom-stub';

/* Non-literal specifier keeps this compiling cleanly; resolves relative to
   dist/tests/ -> ../../dashboard at runtime. */
const base = '../..' + '/dashboard';

const S: DomStub = createDomStub();
// Node has no window/location; the dashboard modules reference them defensively.
(globalThis as any).location = { hash: '' };
(globalThis as any).window = { confirm: () => true, scrollTo: () => {} };
// Materialize the stream + filter elements createCallRow / applyFilters resolve.
S.el('stream-list', 'ul');
S.el('stream-empty', 'div');
S.el('stream-count', 'span');
S.el('intervention-list', 'ul');
S.el('filter-tool', 'input');
S.el('filter-status', 'select');
S.el('filter-session', 'input');

let LV: any;
let ST: any;
before(async () => {
  (globalThis as any).fetch = (url: string): Promise<unknown> =>
    Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
  LV = await import(base + '/js/live-view.mjs');
  ST = (await import(base + '/js/state.mjs')).state;
});

// Each scenario starts from a clean stream (shared state persists across tests).
beforeEach(() => {
  S.byId('stream-list')!.children.length = 0;
  ST.callRows.clear();
  ST.orphanResultEntries.length = 0;
  ST.seenEventKeys.clear();
  ST.localCounts.calls = 0;
  ST.localCounts.results = 0;
  ST.localCounts.interventions = 0;
});

const callEv = (id: string, at: number, tool: string): Record<string, unknown> =>
  ({ type: 'tool.call', sessionKey: 'sess-' + id, toolName: tool, at, id });
const resultEv = (id: string, at: number, tool: string, ok: boolean): Record<string, unknown> =>
  ({ type: 'tool.result', sessionKey: 'sess-' + id, toolName: tool, at, toolCallId: id, id, ok, durationMs: 42 });

// The status cell (the .badge pill) inside a row's .row-main container.
function statusBadge(li: any): any {
  const main = li.children.find((c: any) => String(c.className || '').includes('row-main'));
  assert.ok(main, 'the row carries a .row-main container');
  const badge = main.children.find((c: any) => String(c.className || '').includes('badge'));
  assert.ok(badge, 'the row carries a .badge status cell');
  return badge;
}
function orphanRow(): any {
  const li = S.byId('stream-list')!.children.find((c: any) => String(c.className || '').includes('orphan-row'));
  assert.ok(li, 'the orphan row was added to the stream list');
  return li;
}

// A paired tool.result with ok:false renders the "fail" status.
test('a paired tool.result with ok:false renders the fail status', () => {
  const rs = LV.createCallRow(callEv('c-fail', 1000, 'read_file'));
  LV.updateCallRowWithResult(rs, resultEv('c-fail', 2000, 'read_file', false));
  assert.equal(rs.status, 'fail', 'the row state status is fail');
  assert.equal(rs.li.dataset.status, 'fail', 'the row dataset.status is fail');
});

// A paired tool.result with ok:true keeps rendering "ok".
test('a paired tool.result with ok:true keeps rendering ok', () => {
  const rs = LV.createCallRow(callEv('c-ok', 1000, 'read_file'));
  LV.updateCallRowWithResult(rs, resultEv('c-ok', 2000, 'read_file', true));
  assert.equal(rs.status, 'ok', 'the row state status is ok');
  assert.equal(rs.li.dataset.status, 'ok', 'the row dataset.status is ok');
});

// An unpaired (awaiting) call keeps the current "pending" placeholder.
test('an unpaired (awaiting) call keeps the pending placeholder', () => {
  const rs = LV.createCallRow(callEv('c-pending', 1000, 'read_file'));
  assert.equal(rs.status, 'pending', 'the row state status is pending');
  assert.equal(rs.li.dataset.status, 'pending', 'the row dataset.status is pending');
  const badge = statusBadge(rs.li);
  assert.equal(badge.textContent, 'pending', 'the status cell shows the pending placeholder');
  assert.ok(String(badge.className).includes('badge-pending'), 'the status cell keeps the pending badge tone');
});

// An orphan result row (result arrived with no matching call) with ok:false renders "fail".
test('an orphan tool.result with ok:false renders the fail status', () => {
  LV.createOrphanResultRow(resultEv('c-orphan-fail', 3000, 'read_file', false));
  const li = orphanRow();
  assert.equal(li.dataset.status, 'fail', 'the orphan row dataset.status is fail');
  const badge = statusBadge(li);
  assert.equal(badge.textContent, 'fail', 'the orphan status cell shows fail');
  assert.ok(String(badge.className).includes('badge-fail'), 'the orphan status cell uses the fail badge tone');
});

// An orphan result row with ok:true keeps rendering "ok".
test('an orphan tool.result with ok:true keeps rendering ok', () => {
  LV.createOrphanResultRow(resultEv('c-orphan-ok', 4000, 'read_file', true));
  const li = orphanRow();
  assert.equal(li.dataset.status, 'ok', 'the orphan row dataset.status is ok');
  const badge = statusBadge(li);
  assert.equal(badge.textContent, 'ok', 'the orphan status cell shows ok');
  assert.ok(String(badge.className).includes('badge-ok'), 'the orphan status cell keeps the ok badge tone');
});
