/**
 * DOM-stubbed behaviour tests for the dashboard stream filters
 * (dashboard/js/live-view.mjs + controls.mjs). Loads the real ES modules under a
 * minimal in-memory DOM (tests/dom-stub.ts) and drives them through the same
 * event wiring used by the app: control value changes dispatch real input/change
 * events, and live-appended rows are filtered via the single applyFilters()
 * re-render path. Covers: each of the four filters, AND-combining, clean reset,
 * the shared time window (presets + custom), and live-append consistency.
 */
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createDomStub, FakeEl, DomStub } from './dom-stub';

/* Import the REAL dashboard modules at runtime (non-literal specifier keeps this
   file compiling cleanly; resolves relative to dist/tests/ -> ../../dashboard). */
const base = '../..' + '/dashboard';

/* Shared DOM fixture for this file (each test file is its own process). */
const S: DomStub = createDomStub();
const SL = S.el('stream-list', 'ul');
const IV = S.el('intervention-list', 'ul');
S.el('stream-count', 'span');
const FT = S.el('filter-tool', 'input');
const FS = S.el('filter-status', 'select');
const FSE = S.el('filter-session', 'input');
const FTIME = S.el('filter-time', 'select');
S.el('filter-time-from', 'input');
S.el('filter-time-to', 'input');

let M: { lv: any; ctl: any; state: any };
before(async () => {
  const lv = await import(base + '/js/live-view.mjs');
  const ctl = await import(base + '/js/controls.mjs');
  const st = await import(base + '/js/state.mjs');
  M = { lv, ctl, state: st.state };
  M.lv.bindFilterEvents(); // tool / status / session
  M.ctl.bindControlEvents(); // time-range select (4th filter) + clear + exports
});

interface RowSpec { tool?: string; status?: string; session?: string; at: number; cls?: string; id?: string; }
function addRow(p: RowSpec): FakeEl {
  const li = new FakeEl('li');
  ('stream-row ' + (p.cls || 'call-row')).split(' ').forEach((c) => li.classList.add(c));
  li.dataset.tool = p.tool || '';
  li.dataset.status = p.status || 'pending';
  li.dataset.session = p.session || '';
  li.dataset.at = String(p.at);
  if (p.id) {
    li.dataset.callId = p.id;
    M.state.callRows.set(p.id, { li, callEv: { id: p.id, at: p.at, toolName: p.tool, sessionKey: p.session }, resultEv: null, status: p.status || 'pending' });
  }
  SL.children.push(li);
  return li;
}
function addIvRow(p: { session?: string; at: number }): FakeEl {
  const li = new FakeEl('li');
  li.className = 'stream-row intervention-row';
  li.dataset.session = p.session || '';
  li.dataset.at = String(p.at);
  IV.children.push(li);
  M.state.interventionRowData.set(li, { ruleId: 'r1', action: 'hideTool', at: p.at, detail: '', sessionKey: p.session || '' });
  return li;
}
function visibleRows(): FakeEl[] {
  return SL.children.filter((c) => c.classList.contains('stream-row') && c.style.display !== 'none');
}
function visibleIvRows(): FakeEl[] {
  return IV.children.filter((c) => c.classList.contains('stream-row') && c.style.display !== 'none');
}
const setF = (id: string, v: string): void => { S.byId(id)!.value = v; };
const fire = (id: string, t: string): void => { S.byId(id)!.emit(t); };

beforeEach(() => {
  SL.children.length = 0;
  IV.children.length = 0;
  FT.value = ''; FS.value = ''; FSE.value = ''; FTIME.value = 'all';
  S.byId('filter-time-from')!.hidden = true;
  S.byId('filter-time-to')!.hidden = true;
  M.state.timeRange = { mode: 'all' };
  M.state.callRows.clear();
  M.state.orphanResultEntries.length = 0;
  M.state.interventionsBySession.clear();
  M.state.interventionRowData.clear();
  S.byId('stream-count')!.textContent = '';
});

test('D2 baseline: no active filter shows every row and clears the count', () => {
  addRow({ tool: 'ReadFile', status: 'ok', session: 's1', at: 1000 });
  addRow({ tool: 'WriteFile', status: 'error', session: 's2', at: 2000 });
  M.lv.applyFilters();
  assert.equal(visibleRows().length, 2);
  assert.equal(S.byId('stream-count')!.textContent, '');
});

test('D2 tool-name filter (case-insensitive substring) + clean reset', () => {
  const a = addRow({ tool: 'ReadFile', status: 'ok', session: 's1', at: 1000 });
  addRow({ tool: 'WriteFile', status: 'error', session: 's2', at: 2000 });
  const c = addRow({ tool: 'READFILE', status: 'pending', session: 's3', at: 3000 });
  setF('filter-tool', 'read'); fire('filter-tool', 'input');
  assert.equal(visibleRows().length, 2, 'only Read* rows show');
  assert.ok(visibleRows().includes(a));
  assert.ok(visibleRows().includes(c), 'case-insensitive match for READFILE');
  assert.equal(S.byId('stream-count')!.textContent, 'showing 2 of 3');
  // reset: clearing the input back to "" restores the full set
  setF('filter-tool', ''); fire('filter-tool', 'input');
  assert.equal(visibleRows().length, 3);
  assert.equal(S.byId('stream-count')!.textContent, '');
});

test('D2 status filter over pending/ok/error + unmatched/orphan + intervention', () => {
  addRow({ tool: 'A', status: 'ok', session: 's1', at: 1000 });
  const err = addRow({ tool: 'B', status: 'error', session: 's2', at: 2000 });
  const orphan = addRow({ tool: 'C', status: 'ok', session: 's3', at: 3000, cls: 'orphan-row' });
  M.state.interventionsBySession.set('s4', [{ ruleId: 'r9', action: 'hideTool' }]);
  const interv = addRow({ tool: 'D', status: 'ok', session: 's4', at: 4000 });
  // ok
  FS.value = 'ok'; fire('filter-status', 'change');
  assert.equal(visibleRows().length, 2, 'two ok rows');
  // error -> only the errored row
  FS.value = 'error'; fire('filter-status', 'change');
  assert.deepEqual(visibleRows(), [err]);
  // unmatched -> only orphan rows
  FS.value = 'unmatched'; fire('filter-status', 'change');
  assert.deepEqual(visibleRows(), [orphan]);
  // intervention -> only rows whose session has a recorded intervention
  FS.value = 'intervention'; fire('filter-status', 'change');
  assert.deepEqual(visibleRows(), [interv]);
  // reset to "All statuses" (empty value) restores the full set
  FS.value = ''; fire('filter-status', 'change');
  assert.equal(visibleRows().length, 4);
});

test('D2 session-key filter (substring, case-insensitive) + clean reset', () => {
  addRow({ tool: 'A', status: 'ok', session: 'sess-AAA', at: 1000 });
  const b = addRow({ tool: 'B', status: 'ok', session: 'SESS-BBB', at: 2000 });
  addRow({ tool: 'C', status: 'ok', session: 'sess-CCC', at: 3000 });
  setF('filter-session', 'bbb'); fire('filter-session', 'input');
  assert.deepEqual(visibleRows(), [b], 'only the SESS-BBB row shows');
  setF('filter-session', ''); fire('filter-session', 'input');
  assert.equal(visibleRows().length, 3, 'reset restores all');
});

test('D2 filters COMBINE as AND across tool + status + session', () => {
  addRow({ tool: 'ReadFile', status: 'ok', session: 's1', at: 1000 });
  const hit = addRow({ tool: 'ReadFile', status: 'error', session: 'session-target', at: 2000 });
  addRow({ tool: 'WriteFile', status: 'error', session: 's3', at: 3000 });
  addRow({ tool: 'ReadFile', status: 'error', session: 's4', at: 4000 }); // matches tool+status but not session -> hidden
  const alt = addRow({ tool: 'ReadFile', status: 'ok', session: 'session-target', at: 5000 }); // matches tool+session but not status
  setF('filter-tool', 'read'); fire('filter-tool', 'input');
  FS.value = 'error'; fire('filter-status', 'change');
  setF('filter-session', 'target'); fire('filter-session', 'input');
  assert.deepEqual(visibleRows(), [hit], 'only the row passing all three shows; s4 is hidden by the session filter even though it matches tool+status');
  assert.match(S.byId('stream-count')!.textContent, /^showing 1 of 5$/);
  // releasing ONE constraint widens the result (still AND among the rest)
  FS.value = ''; fire('filter-status', 'change');
  assert.deepEqual(visibleRows(), [hit, alt], 'tool=read + session=target without status shows exactly the two read+target rows');
});

test('D2 time-window preset filters rows by timestamp and resets to all', () => {
  const now = Date.now();
  const recent = now - 60_000; // inside last hour
  const oldT = now - 3 * 3600_000; // outside last hour
  const a = addRow({ tool: 'A', status: 'ok', session: 's1', at: recent });
  addRow({ tool: 'B', status: 'ok', session: 's2', at: oldT });
  const c = addRow({ tool: 'C', status: 'ok', session: 's3', at: recent });
  addRow({ tool: 'D', status: 'ok', session: 's4', at: oldT });
  // Last hour -> only the recent rows survive (wired via the select's change event)
  FTIME.value = '1h'; fire('filter-time', 'change');
  assert.equal(M.state.timeRange.mode, 'preset');
  assert.deepEqual(visibleRows(), [a, c], 'old rows hidden by the 1h window');
  // Reset to "All retained" restores everything and clears the count.
  FTIME.value = 'all'; fire('filter-time', 'change');
  assert.equal(M.state.timeRange.mode, 'all');
  assert.equal(visibleRows().length, 4);
  assert.equal(S.byId('stream-count')!.textContent, '');
});

test('D2 time-window custom range excludes rows outside the chosen window', () => {
  const now = Date.now();
  addRow({ tool: 'A', status: 'ok', session: 's1', at: now });
  // Selecting "Custom…" reveals the from/to inputs; a far-future startMs hides everything.
  FTIME.value = 'custom'; fire('filter-time', 'change');
  setF('filter-time-from', '9999-01-01T00:00'); fire('filter-time-from', 'change');
  assert.equal(M.state.timeRange.mode, 'custom');
  assert.equal(visibleRows().length, 0, 'no row falls before a 9999 start');
  FTIME.value = 'all'; fire('filter-time', 'change');
  assert.equal(visibleRows().length, 1);
});

test('D2 intervention log is constrained by the shared session + time filters only', () => {
  const now = Date.now();
  const inA = addIvRow({ session: 'sess-AAA', at: now });
  addIvRow({ session: 'sess-BBB', at: now });
  setF('filter-session', 'aaa'); fire('filter-session', 'input');
  assert.deepEqual(visibleIvRows(), [inA], 'session filter constrains the intervention log');
  setF('filter-session', ''); fire('filter-session', 'input');
  // A narrow time window hides both (their `at` is ~now but we pick a tiny past window)
  M.state.timeRange = { mode: 'custom', startMs: now + 5000, endMs: now + 10_000 };
  M.lv.applyFilters();
  assert.equal(visibleIvRows().length, 0, 'time window also applies to the intervention log');
  M.state.timeRange = { mode: 'all' };
  M.lv.applyFilters();
  assert.equal(visibleIvRows().length, 2);
});

test('D2 live-append consistency: newly-streamed rows honor active filters immediately', () => {
  const now = Date.now();
  addRow({ tool: 'Search', status: 'ok', session: 's1', at: now }); // matches
  setF('filter-tool', 'Search'); fire('filter-tool', 'input');
  assert.equal(visibleRows().length, 1);
  // A new non-matching row streams in; it must stay hidden until the filter changes.
  const nonMatch = addRow({ tool: 'ReadFile', status: 'pending', session: 's2', at: now + 1 });
  const match = addRow({ tool: 'Search', status: 'pending', session: 's3', at: now + 2 });
  M.lv.applyFilters(); // exactly what createCallRow() does right after appending
  assert.equal(nonMatch.style.display, 'none', 'non-matching live row hidden while filtering');
  assert.notEqual(match.style.display, 'none', 'matching live row shown');
  assert.equal(visibleRows().length, 2, 'existing + matching new row visible');
  // Resetting the filter reveals the previously-hidden live row.
  setF('filter-tool', ''); fire('filter-tool', 'input');
  assert.equal(visibleRows().length, 3);
});

test('D2 readStreamFilters normalizes controls; rowPassesFilters ANDs all constraints', () => {
  const hit = addRow({ tool: 'ReadFile', status: 'ok', session: 'sess-x', at: Date.now() });
  addRow({ tool: 'WriteFile', status: 'ok', session: 'sess-y', at: Date.now() });
  setF('filter-tool', ' READ '); // whitespace-padded -> trimmed/lowercased by reader
  FS.value = 'ok';
  assert.deepEqual(M.lv.readStreamFilters(), { tool: 'read', status: 'ok', session: '' });
  assert.equal(M.lv.rowPassesFilters(hit, M.lv.readStreamFilters()), true);
  FS.value = 'error';
  assert.equal(M.lv.rowPassesFilters(hit, M.lv.readStreamFilters()), false, 'status=error fails an ok row');
  FS.value = '';
  assert.equal(M.lv.rowPassesFilters(hit, M.lv.readStreamFilters()), true, 'empty status imposes no constraint');
});

test('D2 tool filter AND time-range combine; clearing one does not reset the other', () => {
  const now = Date.now();
  const recent = addRow({ tool: 'Search', status: 'ok', session: 's1', at: now - 60_000 });
  const oldMatch = addRow({ tool: 'Search', status: 'ok', session: 's2', at: now - 3 * 3600_000 });
  const recentOther = addRow({ tool: 'ReadFile', status: 'ok', session: 's3', at: now - 60_000 });
  // Activate both tool and time filters simultaneously (all four controls combine as AND).
  setF('filter-tool', 'search'); fire('filter-tool', 'input');
  FTIME.value = '1h'; fire('filter-time', 'change');
  assert.deepEqual(visibleRows(), [recent], 'only the recent Search row passes both constraints');
  assert.match(S.byId('stream-count')!.textContent, /^showing 1 of 3$/);
  // Clearing the TIME filter (back to "all") must NOT reset the tool filter.
  FTIME.value = 'all'; fire('filter-time', 'change');
  assert.equal(M.state.timeRange.mode, 'all');
  assert.deepEqual(visibleRows(), [recent, oldMatch], 'tool filter still active after time reset');
  // Clearing the TOOL filter must NOT reset the time filter (set it again first).
  FTIME.value = '1h'; fire('filter-time', 'change');
  setF('filter-tool', ''); fire('filter-tool', 'input');
  assert.equal(M.state.timeRange.mode, 'preset', 'time filter survives a tool reset');
  assert.deepEqual(visibleRows(), [recent, recentOther], 'only recent rows remain');
});
