/**
 * DOM-stubbed tests for the dashboard export controls
 * (dashboard/js/controls.mjs: getVisible* -> build*Csv/exportJson/exportCsv ->
 * downloadFile). Verifies each of the four export buttons produces a REAL,
 * non-empty Blob of the correct MIME type via an <a download> click, exports the
 * CURRENT (filtered) visible rows, and degrades gracefully (no throw, still a
 * valid minimal file) when nothing is visible.
 */
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createDomStub, FakeEl, DomStub } from './dom-stub';

const base = '../..' + '/dashboard';

const S: DomStub = createDomStub();
const SL = S.el('stream-list', 'ul');
const IV = S.el('intervention-list', 'ul');
S.el('stream-count', 'span');
// Controls the global toolbar references (guards mean absence is fine, but we
// materialize them so every handler is exercised).
S.el('filter-time', 'select');
S.el('filter-time-from', 'input');
S.el('filter-time-to', 'input');
S.el('btn-clear-history', 'button');
const CJSON = S.el('btn-export-calls-json', 'button');
const CCSV = S.el('btn-export-calls-csv', 'button');
const IJSON = S.el('btn-export-interventions-json', 'button');
const ICCSV = S.el('btn-export-interventions-csv', 'button');
const FT = S.el('filter-tool', 'input');
// readStreamFilters()/applyFilters() also read these; materialize them with empty
// defaults so a partial fixture never makes applyFilters() crash on a missing element.
S.el('filter-status', 'select');
S.el('filter-session', 'input');

let M: { lv: any; ctl: any; state: any };
before(async () => {
  const lv = await import(base + '/js/live-view.mjs');
  const ctl = await import(base + '/js/controls.mjs');
  const st = await import(base + '/js/state.mjs');
  M = { lv, ctl, state: st.state };
  M.lv.bindFilterEvents();
  M.ctl.bindControlEvents();
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
function addOrphan(tool: string, at: number, ok: boolean): FakeEl {
  const li = new FakeEl('li');
  li.className = 'stream-row orphan-row';
  li.dataset.tool = tool;
  li.dataset.status = ok ? 'ok' : 'error';
  li.dataset.session = 'sess-orphan';
  li.dataset.at = String(at);
  const ev = { at, toolName: tool, ok };
  M.state.orphanResultEntries.push({ li, ev, rs: { li, callEv: null, resultEv: ev, status: ok ? 'ok' : 'error' } });
  SL.children.push(li);
  return li;
}
function addIvRow(session: string, at: number): void {
  const li = new FakeEl('li');
  li.className = 'stream-row intervention-row';
  li.dataset.session = session;
  li.dataset.at = String(at);
  IV.children.push(li);
  M.state.interventionRowData.set(li, { ruleId: 'rule-1', action: 'block', at, detail: 'stopped', sessionKey: session });
}
const lastBlob = (): any => S.blobs[S.blobs.length - 1];
const lastAnchor = (): FakeEl => S.anchors[S.anchors.length - 1];

beforeEach(() => {
  SL.children.length = 0;
  IV.children.length = 0;
  FT.value = '';
  M.state.callRows.clear();
  M.state.orphanResultEntries.length = 0;
  M.state.interventionsBySession.clear();
  M.state.interventionRowData.clear();
  M.state.timeRange = { mode: 'all' };
  S.byId('stream-count')!.textContent = '';
  S.blobs.length = 0;
  S.anchors.length = 0;
});

test('D3 calls JSON export builds a non-empty Blob of type application/json and clicks a download anchor', async () => {
  addCallRow('c1', 'ReadFile', 1000, 'ok');
  addCallRow('c2', 'WriteFile', 2000, 'error');
  CJSON.click();
  assert.equal(S.blobs.length, 1, 'exactly one download was created');
  const blob = lastBlob();
  assert.ok(blob instanceof Blob, 'a real Blob was constructed');
  assert.equal(blob.type, 'application/json');
  assert.ok(blob.size > 0, 'blob is non-empty');
  const rows = JSON.parse(await blob.text());
  assert.equal(rows.length, 2, 'both visible call rows are exported');
  assert.deepEqual(new Set(rows.map((r: any) => r.toolName)), new Set(['ReadFile', 'WriteFile']));
  const a = lastAnchor();
  assert.match(a.download, /^mcp-manager-calls-.*\.json$/);
  assert.equal(a.clicked, true, 'the anchor click() was triggered programmatically');
});

test('D3 calls CSV export is RFC-4180 text/csv with a header even for the empty case', async () => {
  // Empty case first: header-only, still a valid, non-empty file, no throw.
  CCSV.click();
  assert.equal(S.blobs.length, 1);
  const eText = await lastBlob().text();
  assert.match(eText, /^type,at,time,toolName,sessionKey,status,durationMs,tokensInput,tokensOutput,tokensTotal,sizeChars/, 'header present when no rows');
  assert.ok(eText.length > 0 && lastBlob().size > 0);
  assert.match(lastBlob().type, /^text\/csv/);
  // Populated case: data rows follow the header.
  S.blobs.length = 0;
  addCallRow('c1', 'ReadFile', 1000, 'ok');
  addOrphan('Search', 1500, false);
  CCSV.click();
  const text = await lastBlob().text();
  assert.match(text, /ReadFile/, 'includes the call row');
  assert.match(text, /Search/, 'includes the orphan result row');
  assert.equal(text.split('\r\n').length, 3, 'header + 2 data rows');
  assert.match(lastAnchor().download, /^mcp-manager-calls-.*\.csv$/);
});

test('D3 interventions JSON/CSV export builds correct-type non-empty Blobs from visible intervention rows', async () => {
  addIvRow('sess-a', 1000);
  addIvRow('sess-b', 2000);
  IJSON.click();
  assert.equal(lastBlob().type, 'application/json');
  const iv = JSON.parse(await lastBlob().text());
  assert.equal(iv.length, 2);
  assert.deepEqual(new Set(iv.map((r: any) => r.ruleId)), new Set(['rule-1']));
  assert.match(lastAnchor().download, /^mcp-manager-interventions-.*\.json$/);

  S.blobs.length = 0;
  ICCSV.click();
  assert.match(lastBlob().type, /^text\/csv/);
  const csv = await lastBlob().text();
  assert.match(csv, /rule-1/);
  assert.match(csv, /^type,at,time,ruleId,action,detail,sessionKey/);
  assert.match(lastAnchor().download, /^mcp-manager-interventions-.*\.csv$/);
});

test('D3 export reflects ONLY the currently-visible (filtered) rows', async () => {
  addCallRow('c1', 'ReadFile', 1000, 'ok');
  addCallRow('c2', 'WriteFile', 2000, 'error');
  FT.value = 'read'; // filter to Read* rows only
  M.lv.applyFilters();
  assert.equal(SL.children.filter((c: FakeEl) => c.style.display !== 'none').length, 1, 'filter hides the WriteFile row');
  CJSON.click();
  const rows = JSON.parse(await lastBlob().text());
  assert.equal(rows.length, 1, 'only the visible (filtered) row is exported');
  assert.equal(rows[0].toolName, 'ReadFile');
});

test('D3 all four exports handle the empty case gracefully without throwing', () => {
  for (const btn of [CJSON, CCSV, IJSON, ICCSV]) {
    S.blobs.length = 0;
    assert.doesNotThrow(() => btn.click(), 'no console error on an empty export');
    assert.equal(S.blobs.length, 1, 'still yields a download');
    assert.ok(lastBlob().size > 0, 'minimal valid file, not an empty blob');
    assert.ok(typeof lastAnchor().download === 'string' && lastAnchor().download.length > 0);
  }
});

test('D3 empty JSON export produces exactly [] and empty CSV is header-only (single line)', async () => {
  // Calls JSON empty → exactly "[]" (not null, not missing)
  S.blobs.length = 0;
  CJSON.click();
  const cjText = await lastBlob().text();
  assert.deepEqual(JSON.parse(cjText), [], 'empty calls JSON is an empty array');
  assert.match(cjText.trim(), /^\[\]$/, 'pretty-printed empty array');
  // Interventions JSON empty → exactly "[]"
  S.blobs.length = 0;
  IJSON.click();
  const ijText = await lastBlob().text();
  assert.deepEqual(JSON.parse(ijText), [], 'empty interventions JSON is an empty array');
  // Calls CSV empty → exactly one line (the header row)
  S.blobs.length = 0;
  CCSV.click();
  const ccsvText = await lastBlob().text();
  assert.equal(ccsvText.split('\r\n').length, 1, 'header-only: no data rows');
  assert.match(ccsvText, /^type,at,time,toolName,sessionKey,status,durationMs,tokensInput,tokensOutput,tokensTotal,sizeChars$/);
  // Interventions CSV empty → exactly one line (the header row)
  S.blobs.length = 0;
  ICCSV.click();
  const iccsvText = await lastBlob().text();
  assert.equal(iccsvText.split('\r\n').length, 1, 'header-only: no data rows');
  assert.match(iccsvText, /^type,at,time,ruleId,action,detail,sessionKey$/);
});
