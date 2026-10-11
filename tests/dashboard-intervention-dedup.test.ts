/**
 * DOM-stubbed behaviour tests for the intervention-log dedup in
 * dashboard/js/live-view.mjs's addInterventionRow(). Loads the real ES modules
 * under a minimal in-memory DOM (tests/dom-stub.ts) and drives addInterventionRow()
 * directly (as ingestEvent does for a policy.intervention frame). Verifies the
 * "one row per session" rule: a repeated sessionKey updates that session's
 * EXISTING row in place (to the latest event, keeping its position) instead of
 * prepending a new <li>; a new sessionKey gets a new row; empty/absent
 * sessionKeys keep the per-event behavior (each still gets its own row). The
 * row's four fixed-order cells (time | rule | action | detail) and the
 * state.interventionRowData record both reflect the LATEST event.
 *
 * (Companion to dashboard-stream-filters.test.ts D2 and
 * dashboard-export-blob.test.ts D3, which build intervention rows via a manual
 * fixture and do not exercise addInterventionRow's dedup.)
 */
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createDomStub, FakeEl, DomStub } from './dom-stub';

/* Non-literal specifier keeps this compiling cleanly; resolves relative to
   dist/tests/ -> ../../dashboard at runtime (identical trick to the reference
   specs). */
const base = '../..' + '/dashboard';

/* Shared DOM fixture (one process per test file). */
const S: DomStub = createDomStub();
const IV = S.el('intervention-list', 'ul');
S.el('stream-list', 'ul'); // read by trimCallData() when a new row is prepended
const IE = S.el('intervention-empty', 'div'); // addInterventionRow hides it

let M: { lv: any; dom: any; state: any };
before(async () => {
  const lv = await import(base + '/js/live-view.mjs');
  const dom = await import(base + '/js/dom.mjs');
  const st = await import(base + '/js/state.mjs');
  M = { lv, dom, state: st.state };
});

// Drive the REAL addInterventionRow() with a policy.intervention event.
function iv(ev: { sessionKey?: string; ruleId: string; action: string; detail?: string; at: number }): void {
  M.lv.addInterventionRow({ type: 'policy.intervention', ...ev });
}
// The intervention rows present in the log.
function rows(): FakeEl[] {
  return IV.children.filter((c: FakeEl) => c.classList.contains('stream-row'));
}
function rowForSession(sk: string): FakeEl {
  const found = IV.children.find((c: FakeEl) => c.dataset.session === sk);
  assert.ok(found, 'expected a row for session ' + sk);
  return found!;
}

beforeEach(() => {
  IV.children.length = 0;
  IE.hidden = false;
  M.state.callRows.clear();
  M.state.orphanResultEntries.length = 0;
  M.state.interventionsBySession.clear();
  M.state.interventionRowData.clear();
  M.state.interventionRowBySession.clear();
  M.state.timeRange = { mode: 'all' };
});

test('D4 a: N same-sessionKey events collapse to ONE row reflecting the LATEST event', () => {
  const at1 = 1000, at2 = 2000, at3 = 3000;
  iv({ sessionKey: 'sess-A', ruleId: 'r1', action: 'hideTool', detail: 'first', at: at1 });
  iv({ sessionKey: 'sess-A', ruleId: 'r2', action: 'hideTool', detail: 'second', at: at2 });
  iv({ sessionKey: 'sess-A', ruleId: 'r3', action: 'rewriteArgs', detail: 'third', at: at3 });
  // Exactly one <li> for the session + one record + one dedup-map entry.
  assert.equal(IV.children.length, 1, 'exactly one <li> for the same sessionKey');
  assert.equal(rows().length, 1);
  assert.equal(M.state.interventionRowData.size, 1, 'one record for the single row');
  assert.equal(M.state.interventionRowBySession.size, 1, 'one dedup-map entry for the session');
  // The single row's four cells reflect the LATEST event (fixed cell order).
  const li = IV.children[0];
  const cells = li.children;
  assert.equal(cells.length, 4, 'four fixed cells: time | rule | action | detail');
  assert.ok(cells[0].classList.contains('iv-time'), 'cell 1 is the time cell');
  assert.equal(cells[0].textContent, M.dom.fmtTime(at3), 'time cell shows the latest at');
  assert.ok(cells[1].classList.contains('iv-rule'), 'cell 2 is the rule cell');
  assert.equal(cells[1].textContent, 'r3', 'rule cell shows the latest ruleId');
  assert.ok(cells[2].classList.contains('iv-action'), 'cell 3 is the action cell');
  assert.equal(cells[2].textContent, 'rewriteArgs', 'action cell shows the latest action');
  assert.ok(cells[3].classList.contains('iv-detail'), 'cell 4 is the detail cell');
  assert.equal(cells[3].textContent, 'third', 'detail cell shows the latest detail');
  // dataset + record are in sync with the latest event.
  assert.equal(li.dataset.session, 'sess-A');
  assert.deepEqual(M.state.interventionRowData.get(li), {
    ruleId: 'r3', action: 'rewriteArgs', at: at3, detail: 'third', sessionKey: 'sess-A'
  });
});

test('D4 b: two distinct sessionKeys (each with >=2 events) -> exactly TWO rows, one per session', () => {
  iv({ sessionKey: 'sess-A', ruleId: 'r1', action: 'hideTool', detail: 'a1', at: 1000 });
  iv({ sessionKey: 'sess-A', ruleId: 'r2', action: 'hideTool', detail: 'a2', at: 2000 });
  iv({ sessionKey: 'sess-B', ruleId: 'r3', action: 'hideTool', detail: 'b1', at: 1500 });
  iv({ sessionKey: 'sess-B', ruleId: 'r4', action: 'hideTool', detail: 'b2', at: 2500 });
  // One row per session (not one per event).
  assert.equal(IV.children.length, 2, 'one row per sessionKey');
  assert.equal(rows().length, 2);
  assert.equal(M.state.interventionRowData.size, 2);
  assert.equal(M.state.interventionRowBySession.size, 2);
  // Each session's row reflects ITS latest event.
  const a = rowForSession('sess-A');
  assert.equal(a.children[1].textContent, 'r2', 'sess-A row shows its latest ruleId');
  assert.equal(a.children[3].textContent, 'a2', 'sess-A row shows its latest detail');
  const b = rowForSession('sess-B');
  assert.equal(b.children[1].textContent, 'r4', 'sess-B row shows its latest ruleId');
  assert.equal(b.children[3].textContent, 'b2', 'sess-B row shows its latest detail');
  // A later session's row is on top, but the earlier session's row is NOT
  // re-prepended — it keeps its position (in-place update, not a new <li>).
  assert.equal(IV.children[0], b, 'the most-recently-created session row is on top');
  assert.equal(IV.children[1], a, 'the earlier session row keeps its position (not re-prepended)');
});

test('D4 c: an empty/absent sessionKey keeps the per-event behavior (own row, no dedup)', () => {
  iv({ sessionKey: '', ruleId: 'r1', action: 'hideTool', detail: 'e1', at: 1000 }); // empty string
  iv({ ruleId: 'r2', action: 'hideTool', detail: 'e2', at: 2000 });                 // absent (undefined)
  iv({ sessionKey: 'sess-A', ruleId: 'r3', action: 'hideTool', detail: 'n1', at: 3000 }); // named
  // Empty + absent + named = three distinct rows (the two keyless events do NOT dedup).
  assert.equal(IV.children.length, 3, 'empty, absent, and named keys each get their own row');
  assert.equal(rows().length, 3);
  assert.equal(M.state.interventionRowData.size, 3);
  assert.equal(M.state.interventionRowBySession.size, 1, 'only the named session is tracked for dedup');
  // The named session coexists as its own row alongside the two keyless rows.
  const named = rowForSession('sess-A');
  assert.equal(named.children[1].textContent, 'r3', 'named session row is distinct');
  // The two keyless rows are distinct from each other and from the named row.
  const keyless = IV.children.filter((c: FakeEl) => c.dataset.session === '');
  assert.equal(keyless.length, 2, 'both empty + absent sessionKey events keep their own row');
  assert.deepEqual(keyless.map((c: FakeEl) => c.children[1].textContent).sort(), ['r1', 'r2'], 'the two keyless rows are not collapsed into one');
});
