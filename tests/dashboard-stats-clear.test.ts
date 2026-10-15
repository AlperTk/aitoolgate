/**
 * Coverage for dashboard/js/stats.mjs — the stats panel's "Clear" button and
 * the top-tools table's "Avg call (tok/call)" column (totalCallTokens / count).
 *
 * Loads the real ES module under a minimal in-memory DOM (tests/dom-stub.ts)
 * with an injected global fetch, wires initClearStats(), and simulates a click
 * on #btn-clear-stats. Asserts the click issues POST api/stats/reset and that a
 * follow-up api/stats GET refresh fires AFTER the reset (so the cleared state
 * is reflected rather than re-populated by the 3s poll). Each test file runs in
 * its own process, so installing one stub + fetch here never leaks across files.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDomStub, DomStub, FakeEl } from './dom-stub';

/* Non-literal specifier keeps this compiling cleanly; resolves relative to
   dist/tests/ -> ../../dashboard at runtime (identical trick to the reference specs). */
const base = '../..' + '/dashboard';

type Resp = { ok: boolean; status: number; json: () => any };
interface Call { url: string; method: string }

/* ---- shared DOM fixture (one process per test file) ------------------- */
const S: DomStub = createDomStub();
// Elements the stats module resolves via $(id) during initClearStats/refreshStats.
S.el('btn-clear-stats', 'button');
['total-calls', 'total-results', 'total-tokens', 'input-tokens', 'output-tokens',
 'cache-hit-input-tokens', 'interventions-retained'].forEach((id) => S.el(id, 'span'));
S.el('top-tools', 'div');
S.el('notice', 'div');

let M: any;
const calls: Call[] = [];
let respond: (url: string, init?: any) => Resp = () => ({ ok: true, status: 200, json: () => ({}) });

function makeFetchImpl() {
  return function (url: string, init?: any): Promise<Resp> {
    calls.push({ url: String(url), method: (init && init.method) || 'GET' });
    return Promise.resolve(respond(String(url), init));
  };
}

// Microtask drain for the async handler chain — purely promise-based, no timers/sleeps.
async function flush(): Promise<void> {
  let p: Promise<unknown> = Promise.resolve();
  for (let i = 0; i < 64; i += 1) p = p.then(() => undefined);
  await p;
}

before(async () => {
  // setStatValue() calls removeAttribute('title') on present values; the base
  // FakeEl models title as a property, so expose removeAttribute to match it.
  (FakeEl.prototype as any).removeAttribute = function (k: string) { delete (this as any)[k]; };
  // stats.mjs calls the bare global fetch(); point it at our recording stub.
  (globalThis as unknown as Record<string, unknown>).fetch = makeFetchImpl();
  // Minimal valid summary: the reset POST acks, the GET refresh returns a cleared
  // (zero/empty) state so the panel visibly resets rather than re-populating.
  respond = (url, init) => {
    const method = (init && init.method) || 'GET';
    if (method === 'POST') return { ok: true, status: 200, json: () => ({ cleared: true }) };
    return { ok: true, status: 200, json: () => ({ totalCalls: 0, totalResults: 0, topTools: [] }) };
  };
  M = await import(base + '/js/stats.mjs');
  calls.length = 0;
  M.initClearStats();
});

test('Clear button issues POST api/stats/reset then a follow-up api/stats refresh', async () => {
  S.byId('btn-clear-stats')!.click();
  await flush();

  // The click issued the reset request, using POST against the documented path.
  const resetCall = calls.find((c) => c.url === 'api/stats/reset');
  assert.ok(resetCall !== undefined, 'a reset request was issued');
  assert.equal(resetCall!.method, 'POST', 'the reset uses POST');

  // A follow-up stats refresh fired so the cleared state is reflected on the panel.
  const refreshCall = calls.find((c) => c.url === 'api/stats');
  assert.ok(refreshCall !== undefined, 'a follow-up api/stats refresh was triggered');
  assert.equal(refreshCall!.method, 'GET', 'the refresh uses the default GET');
  assert.ok(calls.indexOf(resetCall!) < calls.indexOf(refreshCall!), 'the reset is issued before the panel refresh');

  // The refreshed (empty) summary is reflected in the stat tiles.
  assert.equal(S.byId('total-calls')!.textContent, '0', 'total calls reset to zero');
  assert.equal(S.byId('total-results')!.textContent, '0', 'total results reset to zero');
});

/* ---- top-tools table: "Avg call (tok/call)" column ------------------- */
// Locate the rendered <table> inside the #top-tools widget container.
function findTable(): any {
  const root = S.byId('top-tools')!.children[0];
  const table = root.children.find((c: any) => c.tagName === 'TABLE');
  assert.ok(table, 'the top-tools widget rendered a <table>');
  return table;
}
// The rendered header labels, in column order.
function headerLabels(table: any): string[] {
  const thead = table.children.find((c: any) => c.tagName === 'THEAD');
  return thead.children[0].children.map((th: any) => String(th.textContent));
}
// The rendered value of a cell for the given tool's row + column index
// (textContent for plain cells, innerHTML for render()-produced string cells).
function cellValue(table: any, colIndex: number, toolName: string): string {
  const tbody = table.children.find((c: any) => c.tagName === 'TBODY');
  const row = tbody.children.find((tr: any) => tr.children[0] && String(tr.children[0].textContent) === toolName);
  assert.ok(row, `a data row for ${toolName} is rendered`);
  const td = row.children[colIndex];
  return String(td.textContent || td.innerHTML || '');
}

test('the top-tools table shows "Avg call (tok/call)" as totalCallTokens / count', async () => {
  M.initTopTools();
  // Feed the table: a tool with a 96-token call-side sum over 4 calls (avg 24)
  // and a tool with no call-side estimate (renders the em-dash placeholder).
  respond = () => ({
    ok: true,
    status: 200,
    json: () => ({
      totalCalls: 7,
      totalResults: 0,
      topTools: [
        { toolName: 'bash', count: 4, totalCallTokens: 96, resolvedCount: 2, totalResponseTokens: 50 },
        { toolName: 'no_est', count: 3 }
      ]
    })
  });
  await M.refreshStats();

  const table = findTable();
  const headers = headerLabels(table);
  assert.ok(headers.includes('Avg call (tok/call)'), 'the header reads "Avg call (tok/call)"');
  assert.ok(!headers.includes('Call (tok)'), 'the old per-tool sum header is gone');
  const col = headers.indexOf('Avg call (tok/call)');
  assert.equal(cellValue(table, col, 'bash'), '24', '96 total call tokens / 4 calls renders 24 (average per call)');
  assert.equal(cellValue(table, col, 'no_est'), '\u2014', 'no call-side estimate renders the placeholder');
});
