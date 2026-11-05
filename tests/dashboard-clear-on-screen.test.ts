/**
 * DOM-stubbed regression test for the dashboard "Clear" button — the on-screen
 * (client-side) history-clear control, now relocated into the "Live tool calls"
 * section's filter row (dashboard/index.html #stream-panel .stream-filters).
 *
 * Loads the real ES modules under a minimal in-memory DOM (tests/dom-stub.ts),
 * wires bindControlEvents() (which binds the guarded click handler onto the
 * #btn-clear-history node by id), simulates a click, and asserts the click
 * clears the on-screen live tool calls CLIENT-SIDE ONLY: it empties
 * #stream-list + #intervention-list, resets the shared state (callRows /
 * orphanResultEntries / interventionsBySession / interventionRowData /
 * localCounts), re-shows the empty-state placeholders, and re-renders via
 * applyFilters() — without touching the server-side stats. Each test file runs
 * in its own process, so installing one stub + wiring here never leaks across
 * files (identical harness to dashboard-stream-filters.test.ts / dashboard-stats-clear.test.ts).
 */
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createDomStub, FakeEl, DomStub } from './dom-stub';

/* Non-literal specifier keeps this compiling cleanly; resolves relative to
   dist/tests/ -> ../../dashboard at runtime (identical trick to the reference specs). */
const base = '../..' + '/dashboard';

/* In-memory localStorage stub: the Clear cutoff is persisted here (state.mjs). */
const LS = new Map<string, string>();
const CUTOFF_KEY = 'aitoolgate.dashboard.clearedBefore';
(globalThis as any).localStorage = {
  getItem: (k: string) => (LS.has(k) ? LS.get(k)! : null),
  setItem: (k: string, v: string) => { LS.set(k, String(v)); },
  removeItem: (k: string) => { LS.delete(k); }
};

/* ---- shared DOM fixture (one process per test file) ------------------- */
const S: DomStub = createDomStub();
const SL = S.el('stream-list', 'ul');
const IV = S.el('intervention-list', 'ul');
const SE = S.el('stream-empty', 'div');
const IE = S.el('intervention-empty', 'div');
S.el('stream-count', 'span');
// live counters read/written by updateLiveCounters() (called by clearOnScreenHistory).
S.el('live-calls', 'span');
S.el('live-results', 'span');
S.el('live-interventions', 'span');
// filter controls read by applyFilters()/readStreamFilters() (guarded, but
// materialized so the clear's final applyFilters() re-render path runs in full).
S.el('filter-tool', 'input');
S.el('filter-status', 'select');
S.el('filter-session', 'input');
// The relocated clear button; bindControlEvents() wires its click handler by id.
const BTN = S.el('btn-clear-history', 'button');

let M: { ctl: any; state: any };
before(async () => {
  const ctl = await import(base + '/js/controls.mjs');
  const st = await import(base + '/js/state.mjs');
  M = { ctl, state: st.state };
  M.ctl.bindControlEvents(); // binds the guarded click handler on #btn-clear-history
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
  return li;
}

// Restore a "populated" on-screen state so a click has something to clear.
beforeEach(() => {
  SL.children.length = 0;
  IV.children.length = 0;
  M.state.callRows.clear();
  M.state.orphanResultEntries.length = 0;
  M.state.interventionsBySession.clear();
  M.state.interventionRowData.clear();
  M.state.localCounts = { calls: 2, results: 1, interventions: 1 };
  M.state.timeRange = { mode: 'all' };
  addCallRow('c1', 'ReadFile', 1000, 'ok');
  addCallRow('c2', 'WriteFile', 2000, 'error');
  addOrphan('Search', 3000);
  addIvRow('sess-a', 4000);
  M.state.interventionsBySession.set('sess-a', [{ ruleId: 'r1', action: 'hideTool', at: 4000 }]);
});

test('Clear button click empties the on-screen stream + intervention lists', () => {
  assert.equal(SL.children.length, 3, 'seeded: 2 call rows + 1 orphan row');
  assert.equal(IV.children.length, 1, 'seeded: 1 intervention row');
  BTN.click();
  assert.equal(SL.children.length, 0, 'stream list is emptied on click');
  assert.equal(IV.children.length, 0, 'intervention list is emptied on click');
});

test('Clear button click resets the shared client-side state (callRows/orphans/counts)', () => {
  assert.equal(M.state.callRows.size, 2, 'seeded: 2 callRows');
  assert.equal(M.state.orphanResultEntries.length, 1, 'seeded: 1 orphan result');
  assert.equal(M.state.interventionRowData.size, 1, 'seeded: 1 intervention row record');
  assert.equal(M.state.interventionsBySession.size, 1, 'seeded: 1 session with interventions');
  assert.deepEqual(M.state.localCounts, { calls: 2, results: 1, interventions: 1 }, 'seeded: local counters non-zero');
  BTN.click();
  assert.equal(M.state.callRows.size, 0, 'callRows reset');
  assert.equal(M.state.orphanResultEntries.length, 0, 'orphan results reset');
  assert.equal(M.state.interventionsBySession.size, 0, 'interventions by session reset');
  assert.equal(M.state.interventionRowData.size, 0, 'intervention row data reset');
  assert.deepEqual(M.state.localCounts, { calls: 0, results: 0, interventions: 0 }, 'local counters zeroed');
});

test('Clear button click re-shows the empty-state placeholders and zeroes the live counters', () => {
  SE.hidden = true;
  IE.hidden = true;
  S.byId('live-calls')!.textContent = '2';
  S.byId('live-results')!.textContent = '1';
  S.byId('live-interventions')!.textContent = '1';
  BTN.click();
  assert.equal(SE.hidden, false, 'stream empty-state placeholder re-shown');
  assert.equal(IE.hidden, false, 'intervention empty-state placeholder re-shown');
  assert.equal(S.byId('live-calls')!.textContent, '0', 'live call counter zeroed');
  assert.equal(S.byId('live-results')!.textContent, '0', 'live result counter zeroed');
  assert.equal(S.byId('live-interventions')!.textContent, '0', 'live intervention counter zeroed');
});

test('Clear persists a durable cutoff: at/before ignored, later and at-less events render', async () => {
  const ing: any = await import(base + '/js/ingest.mjs');
  const t0 = Date.now();
  BTN.click();
  const cutoff = Number(LS.get(CUTOFF_KEY));
  assert.ok(cutoff >= t0, 'cutoff persisted to localStorage at Clear time');
  assert.equal(M.state.clearedBefore, cutoff, 'in-memory cutoff matches storage');
  const n0 = M.state.localCounts.calls;
  ing.ingestEvent({ type: 'tool.call', id: 'old', at: cutoff, sessionKey: 's', toolName: 'X' });
  assert.equal(M.state.localCounts.calls, n0, 'event at cutoff is ignored (replay)');
  ing.ingestEvent({ type: 'tool.call', id: 'new', at: cutoff + 1, sessionKey: 's', toolName: 'X' });
  assert.equal(M.state.localCounts.calls, n0 + 1, 'event after cutoff renders');
  ing.ingestEvent({ type: 'tool.call', id: 'noat', sessionKey: 's', toolName: 'X' });
  assert.equal(M.state.localCounts.calls, n0 + 2, 'event without a valid at is not filtered');
});

test('cutoff survives state re-initialization (reload) and invalid storage falls back to 0', async () => {
  const reloaded: any = await import(base + '/js/state.mjs?reload=1');
  assert.equal(reloaded.state.clearedBefore, Number(LS.get(CUTOFF_KEY)), 'reloaded state restores cutoff');
  LS.set(CUTOFF_KEY, 'garbage');
  const bad: any = await import(base + '/js/state.mjs?reload=2');
  assert.equal(bad.state.clearedBefore, 0, 'invalid stored value is ignored');
});

test('Clear resets session groups (context/usage/collapse), keeps group preference, and replayed pre-clear events stay hidden', async () => {
  const ing: any = await import(base + '/js/ingest.mjs');
  const LV: any = await import(base + '/js/live-view.mjs');
  const headOf = (sk: string): FakeEl | undefined =>
    SL.children.find((c) => c.classList.contains('stream-group-head') && c.dataset.session === sk);
  const ctxAt = Math.max(Date.now(), M.state.clearedBefore + 1);
  M.state.groupBySession = true;
  ing.ingestEvent({ type: 'session.context', sessionKey: 'ctx-clear', systemPrompt: 'P1', tools: [], promptVersion: 1, at: ctxAt });
  ing.ingestEvent({ type: 'turn.usage', sessionKey: 'ctx-clear', at: ctxAt, tokens: { total: 42, cacheHitInput: 7 } });
  M.state.collapsedSessions.add('ctx-clear');
  LV.regroupStream();
  assert.ok(headOf('ctx-clear'), 'context-only group is shown before Clear');
  assert.equal(M.state.turnUsageBySession.size, 1, 'turn usage recorded before Clear');

  BTN.click();
  assert.equal(headOf('ctx-clear'), undefined, 'context-only group is removed by Clear');
  assert.equal(M.state.turnUsageBySession.size, 0, 'turn usage reset');
  assert.equal(M.state.collapsedSessions.size, 0, 'collapse state reset');
  assert.equal(M.state.groupBySession, true, 'group-by-session preference preserved');

  // Reload simulation: the server ring replays the pre-clear context at/before the cutoff.
  ing.ingestEvent({ type: 'session.context', sessionKey: 'ctx-clear', systemPrompt: 'P1', tools: [], promptVersion: 1, at: ctxAt });
  LV.regroupStream();
  assert.equal(headOf('ctx-clear'), undefined, 'replayed pre-clear context does not resurrect the group');

  // A post-clear event is accepted.
  ing.ingestEvent({ type: 'session.context', sessionKey: 'ctx-clear', systemPrompt: 'P2', tools: [], promptVersion: 2, at: M.state.clearedBefore + 1 });
  assert.ok(headOf('ctx-clear'), 'post-clear context renders a group again');
});

test('Clear button click does not throw on an already-empty (client-side) state', () => {
  SL.children.length = 0;
  IV.children.length = 0;
  M.state.callRows.clear();
  M.state.orphanResultEntries.length = 0;
  M.state.interventionRowData.clear();
  M.state.interventionsBySession.clear();
  assert.doesNotThrow(() => BTN.click(), 'clearing an already-empty state is a no-op without throwing');
  assert.equal(SL.children.length, 0);
  assert.equal(M.state.callRows.size, 0);
});
