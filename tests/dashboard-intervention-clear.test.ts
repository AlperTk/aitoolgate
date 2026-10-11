/**
 * DOM-stubbed regression test for the section-scoped "Clear" button on the
 * dashboard "Intervention log" panel (dashboard/index.html
 * #interventions-panel .card-head #btn-clear-interventions).
 *
 * Loads the real ES modules under a minimal in-memory DOM (tests/dom-stub.ts),
 * wires bindControlEvents() (which binds the guarded click handler onto the
 * #btn-clear-interventions node by id), simulates a click, and asserts the
 * click clears ONLY the intervention log — it empties #intervention-list,
 * resets the intervention state (interventionsBySession / interventionRowData /
 * interventionRowBySession / localCounts.interventions), re-shows
 * #intervention-empty, and zeroes ONLY the live intervention counter — while
 * leaving the tool-call stream untouched (#stream-list rows, callRows,
 * orphanResultEntries, call/result counters, and #stream-empty all unchanged).
 *
 * Each test file runs in its own process, so installing one stub + wiring here
 * never leaks across files (identical harness to
 * dashboard-clear-on-screen.test.ts).
 */
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createDomStub, FakeEl, DomStub } from './dom-stub';

/* Non-literal specifier keeps this compiling cleanly; resolves relative to
   dist/tests/ -> ../../dashboard at runtime (identical trick to the reference specs). */
const base = '../..' + '/dashboard';

/* ---- shared DOM fixture (one process per test file) ------------------- */
const S: DomStub = createDomStub();
const SL = S.el('stream-list', 'ul');
const IV = S.el('intervention-list', 'ul');
const SE = S.el('stream-empty', 'div');
const IE = S.el('intervention-empty', 'div');
S.el('stream-count', 'span');
// live counters read/written by updateLiveCounters() (called by clearInterventionLog).
S.el('live-calls', 'span');
S.el('live-results', 'span');
S.el('live-interventions', 'span');
// filter controls read by applyFilters()/readStreamFilters() (guarded, but
// materialized so the clear's final applyFilters() re-render path runs in full).
S.el('filter-tool', 'input');
S.el('filter-status', 'select');
S.el('filter-session', 'input');
// The section-scoped clear button; bindControlEvents() wires its click handler by id.
const BTN = S.el('btn-clear-interventions', 'button');

let M: { ctl: any; state: any };
before(async () => {
  const ctl = await import(base + '/js/controls.mjs');
  const st = await import(base + '/js/state.mjs');
  M = { ctl, state: st.state };
  M.ctl.bindControlEvents(); // binds the guarded click handler on #btn-clear-interventions
});

function addCallRow(id: string, tool: string, at: number, status: string): FakeEl {
  const li = new FakeEl('li');
  li.className = 'stream-row call-row';
  li.dataset.tool = tool;
  li.dataset.status = status;
  li.dataset.session = 'sess-' + id;
  li.dataset.at = String(at);
  li.dataset.callId = id;
  M.state.callRows.set(id, { li, callEv: { id, at, toolName: tool, sessionKey: 'sess-' + id }, resultEv: null, status });
  SL.children.push(li);
  return li;
}
function addOrphan(tool: string, at: number): FakeEl {
  const li = new FakeEl('li');
  li.className = 'stream-row orphan-row';
  li.dataset.tool = tool;
  li.dataset.status = 'error';
  li.dataset.session = 'sess-orphan';
  li.dataset.at = String(at);
  const ev = { at, toolName: tool };
  M.state.orphanResultEntries.push({ li, ev, rs: { li, callEv: null, resultEv: ev, status: 'error' } });
  SL.children.push(li);
  return li;
}
function addIvRow(session: string, at: number): FakeEl {
  const li = new FakeEl('li');
  li.className = 'stream-row intervention-row';
  li.dataset.session = session;
  li.dataset.at = String(at);
  IV.children.push(li);
  M.state.interventionRowData.set(li, { ruleId: 'r1', action: 'hideTool', at, detail: 'stopped', sessionKey: session });
  M.state.interventionRowBySession.set(session, li);
  return li;
}

// Seed a "populated" state so a click has something to clear (and to prove
// untouched).
function seed(): void {
  SL.children.length = 0;
  IV.children.length = 0;
  M.state.callRows.clear();
  M.state.orphanResultEntries.length = 0;
  M.state.interventionsBySession.clear();
  M.state.interventionRowData.clear();
  M.state.interventionRowBySession.clear();
  M.state.localCounts = { calls: 2, results: 1, interventions: 1 };
  M.state.timeRange = { mode: 'all' };
  SE.hidden = true;
  IE.hidden = true;
  S.byId('live-calls')!.textContent = '2';
  S.byId('live-results')!.textContent = '1';
  S.byId('live-interventions')!.textContent = '1';
  addCallRow('c1', 'ReadFile', 1000, 'ok');
  addCallRow('c2', 'WriteFile', 2000, 'error');
  addOrphan('Search', 3000);
  addIvRow('sess-a', 4000);
  M.state.interventionsBySession.set('sess-a', [{ ruleId: 'r1', action: 'hideTool', at: 4000 }]);
}

beforeEach(() => {
  seed();
});

test('intervention Clear button click empties ONLY the intervention log (stream untouched)', () => {
  assert.equal(SL.children.length, 3, 'seeded: 2 call rows + 1 orphan row');
  assert.equal(IV.children.length, 1, 'seeded: 1 intervention row');
  BTN.click();
  assert.equal(IV.children.length, 0, 'intervention list is emptied on click');
  assert.equal(SL.children.length, 3, 'stream list is NOT emptied on click');
});

test('intervention Clear button click resets the intervention state only (not call state)', () => {
  assert.equal(M.state.interventionRowData.size, 1, 'seeded: 1 intervention row record');
  assert.equal(M.state.interventionRowBySession.size, 1, 'seeded: 1 render-dedup entry');
  assert.equal(M.state.interventionsBySession.size, 1, 'seeded: 1 session with interventions');
  assert.equal(M.state.callRows.size, 2, 'seeded: 2 callRows');
  assert.equal(M.state.orphanResultEntries.length, 1, 'seeded: 1 orphan result');
  assert.deepEqual(M.state.localCounts, { calls: 2, results: 1, interventions: 1 }, 'seeded: local counters non-zero');
  BTN.click();
  assert.equal(M.state.interventionRowData.size, 0, 'intervention row data reset');
  assert.equal(M.state.interventionRowBySession.size, 0, 'render-dedup map reset');
  assert.equal(M.state.interventionsBySession.size, 0, 'interventions by session reset');
  assert.equal(M.state.callRows.size, 2, 'callRows untouched');
  assert.equal(M.state.orphanResultEntries.length, 1, 'orphan results untouched');
  assert.deepEqual(M.state.localCounts, { calls: 2, results: 1, interventions: 0 }, 'only the intervention counter is zeroed');
});

test('intervention Clear button click re-shows #intervention-empty and zeroes only the live intervention counter', () => {
  BTN.click();
  assert.equal(IE.hidden, false, 'intervention empty-state placeholder re-shown');
  assert.equal(SE.hidden, true, 'stream empty-state placeholder NOT re-shown (stream untouched)');
  assert.equal(S.byId('live-interventions')!.textContent, '0', 'live intervention counter zeroed');
  assert.equal(S.byId('live-calls')!.textContent, '2', 'live call counter untouched');
  assert.equal(S.byId('live-results')!.textContent, '1', 'live result counter untouched');
});

test('intervention Clear button click does not throw on an already-empty (client-side) state', () => {
  IV.children.length = 0;
  M.state.interventionRowData.clear();
  M.state.interventionRowBySession.clear();
  M.state.interventionsBySession.clear();
  M.state.localCounts.interventions = 0;
  assert.doesNotThrow(() => BTN.click(), 'clearing an already-empty intervention state is a no-op without throwing');
  assert.equal(IV.children.length, 0);
  assert.equal(M.state.interventionRowData.size, 0);
  assert.equal(M.state.callRows.size, 2, 'call rows remain even when clearing an empty intervention state');
});
