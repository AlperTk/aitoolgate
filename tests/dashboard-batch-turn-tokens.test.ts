/**
 * DOM-stubbed coverage for the live stream's token columns
 * (dashboard/js/live-view.mjs + dashboard/js/ingest.mjs): each row shows its OWN
 * per-tool estimates — In (est) = the call-side token estimate (ev.callTokens) and
 * Out (est) = the result-side token estimate (the paired tool.result's ev.tokens) —
 * on every row (batch or single). The Total column keeps its turn-level "context
 * size" behavior: rendered exactly once per turn on the last tool-call row, '—'
 * elsewhere, and never the sum of In and Out. The previously separate Call/Res
 * columns are gone.
 *
 * Mirrors tests/dashboard-tool-result-status.test.ts: createDomStub() + the
 * materialized stream/counter elements, an injected globalThis.fetch, and a
 * shared-state reset in beforeEach. Each test file runs in its own process, so
 * the installed stub never leaks.
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
// Materialize the stream / counter / filter / header elements the modules resolve.
S.el('stream-list', 'ul');
S.el('stream-empty', 'div');
S.el('stream-count', 'span');
S.el('stream-head', 'div');
S.el('intervention-list', 'ul');
S.el('filter-tool', 'input');
S.el('filter-status', 'select');
S.el('filter-session', 'input');
S.el('live-calls', 'span');
S.el('live-results', 'span');
S.el('live-interventions', 'span');

let LV: any;
let ING: any;
let ST: any;
before(async () => {
  (globalThis as any).fetch = (url: string): Promise<unknown> =>
    Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
  LV = await import(base + '/js/live-view.mjs');
  ING = await import(base + '/js/ingest.mjs');
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

const callEv = (id: string, at: number, tool: string, tokens?: Record<string, number>, callTokens?: number): Record<string, unknown> =>
  ({ type: 'tool.call', sessionKey: 'sess-batch', toolName: tool, at, id, ...(tokens ? { tokens } : {}), ...(callTokens !== undefined ? { callTokens } : {}) });
const resultEv = (toolCallId: string, at: number, tool: string, tokens: number, chars: number): Record<string, unknown> =>
  ({ type: 'tool.result', sessionKey: 'sess-batch', toolName: tool, toolCallId, at, ok: true, tokens, chars });
const usageEv = (at: number, tokens?: Record<string, number>): Record<string, unknown> =>
  ({ type: 'turn.usage', sessionKey: 'sess-batch', at, ...(tokens ? { tokens } : {}) });

// The row's three token cells (In (est) | Out (est) | Total) inside its .row-main container.
function tokenCells(li: any): { in: any; out: any; total: any } {
  const main = li.children.find((c: any) => String(c.className || '').includes('row-main'));
  assert.ok(main, 'the row carries a .row-main container');
  const pick = (cls: string): any => {
    const cell = main.children.find((c: any) => String(c.className || '').includes(cls));
    assert.ok(cell, `the row carries a .${cls} token cell`);
    return cell;
  };
  return { in: pick('s-tokens-in'), out: pick('s-tokens-out'), total: pick('s-tokens-total') };
}
// True when the row's .row-main contains a cell with the given class (used to assert the
// removed Call/Res columns are gone).
function hasCellClass(li: any, cls: string): boolean {
  const main = li.children.find((c: any) => String(c.className || '').includes('row-main'));
  assert.ok(main, 'the row carries a .row-main container');
  return main.children.some((c: any) => String(c.className || '').includes(cls));
}
const rowsOf = (): any[] => [...ST.callRows.values()];

// Batched turn (streamed path): the call events carry NO turn tokens (omitted for batched
// turns) but DO carry a distinct per-call callTokens estimate. Each row shows its own In
// (est) at creation; each row shows its own Out (est) once its result arrives; the
// whole-turn turn.usage fills the Total on ONLY the last tool-call row.
test('batched turn: each row shows its own In (est) and Out (est); Total once on the last row; no Call/Res cells', () => {
  ING.ingestEvent(callEv('c1', 1000, 'fetchBig', undefined, 120));
  ING.ingestEvent(callEv('c2', 1000, 'fetchMid', undefined, 60));
  ING.ingestEvent(callEv('c3', 1000, 'fetchSmall', undefined, 12));
  const [r1, r2, r3] = rowsOf();
  // Per-row In (est) = its own call estimate (distinct per tool).
  assert.equal(tokenCells(r1.li).in.textContent, '120', 'row 1 In = its own call estimate');
  assert.equal(tokenCells(r2.li).in.textContent, '60', 'row 2 In = its own call estimate');
  assert.equal(tokenCells(r3.li).in.textContent, '12', 'row 3 In = its own call estimate');
  // No result yet → Out (est) is a placeholder on every row.
  assert.equal(tokenCells(r1.li).out.textContent, '—');
  assert.equal(tokenCells(r2.li).out.textContent, '—');
  assert.equal(tokenCells(r3.li).out.textContent, '—');
  // The separate Call/Res columns no longer exist anywhere on a row.
  assert.equal(hasCellClass(r1.li, 's-call-tokens'), false, 'no Call cell exists');
  assert.equal(hasCellClass(r1.li, 's-res-tokens'), false, 'no Res cell exists');
  // Results arrive (distinct per-tool estimates) → each row's Out = its own result estimate.
  ING.ingestEvent(resultEv('c1', 1000, 'fetchBig', 400, 1600));
  ING.ingestEvent(resultEv('c2', 1000, 'fetchMid', 100, 400));
  ING.ingestEvent(resultEv('c3', 1000, 'fetchSmall', 12, 48));
  assert.equal(tokenCells(r1.li).out.textContent, '400', 'row 1 Out = its own result estimate');
  assert.equal(tokenCells(r2.li).out.textContent, '100', 'row 2 Out = its own result estimate');
  assert.equal(tokenCells(r3.li).out.textContent, '12', 'row 3 Out = its own result estimate');
  // In (est) is NOT overwritten by the result (per-tool call estimate).
  assert.equal(tokenCells(r1.li).in.textContent, '120', 'row 1 In keeps its call estimate after the result');
  // The whole-turn turn.usage fills the Total on ONLY the last tool-call row (the turn context
  // size — NOT the sum of In and Out).
  ING.ingestEvent(usageEv(1000, { input: 10, output: 20, total: 30 }));
  assert.equal(tokenCells(r3.li).total.textContent, '30', 'only the last row gets its Total filled by the turn.usage');
  assert.equal(tokenCells(r1.li).total.textContent, '—', 'the earlier rows keep the Total placeholder');
  assert.equal(tokenCells(r2.li).total.textContent, '—');
  // Every row still surfaces the turn tokens in its details panel (turnTokens set on all).
  assert.deepEqual(r1.turnTokens, { input: 10, output: 20, total: 30 });
  assert.deepEqual(r3.turnTokens, { input: 10, output: 20, total: 30 });
});

// A Total cell already rendered from a buffered call event's own turn tokens is not changed by
// the turn.usage; the earlier rows keep the placeholder. In/Out are per-tool estimates, not the
// turn usage.
test('a Total cell already rendered from the call event is not changed by the turn.usage', () => {
  ING.ingestEvent(callEv('c1', 1000, 'read_file', { input: 10, output: 20, total: 30 }));
  ING.ingestEvent(callEv('c2', 1000, 'write_file'));
  const [r1, r2] = rowsOf();
  assert.equal(tokenCells(r1.li).total.textContent, '30', 'the row carrying its own turn tokens shows them at creation');
  ING.ingestEvent(usageEv(1000, { input: 10, output: 20, total: 30 }));
  assert.equal(tokenCells(r1.li).total.textContent, '30', 'the row carrying its own tokens is unchanged');
  assert.equal(tokenCells(r2.li).total.textContent, '30', 'the placeholder sibling row (last) is filled with the turn total');
  assert.equal(tokenCells(r1.li).in.textContent, '—', 'In is not the turn usage.input');
  assert.equal(tokenCells(r2.li).in.textContent, '—');
  assert.equal(tokenCells(r2.li).out.textContent, '—', 'Out is not the turn usage.output');
});

// A turn.usage applies ONLY to rows of the same turn (matched by sessionKey + the shared
// turn-level `at`); rows of other turns keep the placeholder and no turnTokens. Per-tool In
// is unaffected by turn matching.
test('a turn.usage applies only to the rows of the same turn (matching at)', () => {
  ING.ingestEvent(callEv('c1', 1000, 'read_file', undefined, 120));
  ING.ingestEvent(callEv('c2', 2000, 'write_file', undefined, 60));
  const [r1, r2] = rowsOf();
  ING.ingestEvent(usageEv(2000, { input: 5, output: 6, total: 11 }));
  assert.equal(r1.turnTokens, undefined, 'the other-turn row gets no turn tokens');
  assert.deepEqual(r2.turnTokens, { input: 5, output: 6, total: 11 }, 'the matching-turn row gets turn tokens');
  assert.equal(tokenCells(r1.li).total.textContent, '—', 'the other-turn row keeps the Total placeholder');
  assert.equal(tokenCells(r2.li).total.textContent, '11', 'the matching-turn row is filled');
  assert.equal(tokenCells(r1.li).in.textContent, '120', 'per-tool In is unaffected by turn matching');
  assert.equal(tokenCells(r2.li).in.textContent, '60');
});

// Omit, don't fabricate: a turn.usage with no tokens is a no-op; the Total stays the
// placeholder and no turnTokens are bound.
test('a turn.usage without tokens is a no-op; rows keep the Total placeholder', () => {
  ING.ingestEvent(callEv('c1', 1000, 'read_file', undefined, 120));
  ING.ingestEvent(callEv('c2', 2000, 'write_file', undefined, 60));
  const [r1, r2] = rowsOf();
  ING.ingestEvent(usageEv(1000)); // no tokens field
  assert.equal(tokenCells(r1.li).total.textContent, '—', 'the Total stays the placeholder (no-op)');
  assert.equal(tokenCells(r2.li).total.textContent, '—', 'the other-turn row is untouched too');
  assert.equal(r1.turnTokens, undefined, 'no turn tokens are bound on a no-op usage');
});

// The turn.usage fills only the Total cell (per-tool In/Out are independent estimates).
test('the turn.usage fills only the Total cell (per-tool In/Out are independent)', () => {
  ING.ingestEvent(callEv('c1', 1000, 'read_file', undefined, 120));
  const [r1] = rowsOf();
  ING.ingestEvent(usageEv(1000, { total: 30 }));
  assert.equal(tokenCells(r1.li).total.textContent, '30', 'the carried total is filled');
  assert.equal(tokenCells(r1.li).in.textContent, '120', 'In stays the per-call estimate (not the turn input)');
  assert.equal(tokenCells(r1.li).out.textContent, '—', 'Out stays the placeholder (no result)');
});

// Single-call turn: the row In/Out are the per-tool estimates (not the provider usage); the
// Total still shows the turn value.
test('single-call turn: In/Out are the per-tool estimates; Total shows the turn value', () => {
  ING.ingestEvent(callEv('c1', 1000, 'read_file', undefined, 42));
  const [r1] = rowsOf();
  assert.equal(tokenCells(r1.li).in.textContent, '42', 'the row In is the per-tool call estimate (not the provider usage)');
  ING.ingestEvent(resultEv('c1', 1000, 'read_file', 300, 1200));
  assert.equal(tokenCells(r1.li).out.textContent, '300', 'the row Out is the per-tool result estimate');
  ING.ingestEvent(usageEv(1000, { input: 10, output: 20, total: 30 }));
  assert.equal(tokenCells(r1.li).total.textContent, '30', 'Total still shows the turn value');
  assert.equal(tokenCells(r1.li).in.textContent, '42', 'In stays the per-tool estimate (not usage.input)');
  assert.equal(tokenCells(r1.li).out.textContent, '300', 'Out stays the per-tool result estimate (not usage.output)');
});

// The details panel surfaces the row's reported turn usage breakdown (input / cacheHitInput /
// output / total), whether from an applied turn.usage or the call event's own tokens.
test('the details panel surfaces the reported turn usage breakdown (in/cache/out/total)', () => {
  const rs1 = LV.createCallRow(callEv('d1', 1000, 'read_file'));
  LV.applyTurnUsageToRows(usageEv(1000, { input: 10, cacheHitInput: 5, output: 20, total: 35 }));
  const p1 = LV.buildDetailsPanel(rs1);
  assert.ok(p1.includes('tokens (turn):'), 'the panel carries a tokens (turn) line');
  assert.ok(p1.includes('in 10'), 'shows the reported input');
  assert.ok(p1.includes('cache 5'), 'shows the reported cache-hit input');
  assert.ok(p1.includes('out 20'), 'shows the reported output');
  assert.ok(p1.includes('total 35'), 'shows the reported total');

  const rs2 = LV.createCallRow(callEv('d2', 2000, 'write_file', { input: 4, output: 5, total: 9 }));
  const p2 = LV.buildDetailsPanel(rs2);
  assert.ok(p2.includes('tokens (turn):'), 'the panel carries a tokens (turn) line for own-token rows');
  assert.ok(p2.includes('total 9'), 'the line shows the call event own tokens');
});

// The header labels read In (est) / Out (est) with the Call/Res columns removed (9 labelled
// columns + the empty expand cell), regardless of the served HTML (self-healing).
test('the stream header reads In (est) / Out (est) and has no Call/Res columns', () => {
  LV.normalizeStreamHead();
  const head = S.byId('stream-head')!;
  const labels = [...head.children].map((c: any) => String(c.textContent));
  assert.ok(labels.includes('In (est)'), 'the header carries In (est)');
  assert.ok(labels.includes('Out (est)'), 'the header carries Out (est)');
  assert.ok(labels.includes('Context Size'), 'Context Size header retained');
  assert.ok(labels.includes('Size'), 'Size header retained');
  assert.ok(!labels.includes('Call'), 'no Call header');
  assert.ok(!labels.includes('Res'), 'no Res header');
  assert.ok(!labels.includes('Description'), 'no Description header');
  assert.equal(labels.length, 10, '9 labelled columns + 1 empty expand cell');
});

// The session cell renders the COMPLETE session id (no client-side 12-char slice); the
// full id is also carried in the cell's title attribute. Locks the rendered row in with
// the header / track lock-step above.
test('the session cell renders the full 30-char id (no client-side slice) with the title retained', () => {
  const full = 'ses_0123456789abcdef0123456789'; // 'ses_' + 26 = 30 chars (longer than the old 12-char slice)
  assert.equal(full.length, 30, 'the session id is 30 chars');
  const rs = LV.createCallRow({ type: 'tool.call', sessionKey: full, toolName: 'read_file', at: 1000, id: 'sess-cell-full' });
  const li = rs.li;
  const main = li.children.find((c: any) => String(c.className || '').includes('row-main'));
  assert.ok(main, 'the row carries a .row-main container');
  const sess = main.children.find((c: any) => String(c.className || '').includes('s-session'));
  assert.ok(sess, 'the row carries a .s-session cell');
  assert.equal(sess.textContent, full, 'the session cell shows the complete id (no 12-char slice)');
  assert.ok(!String(sess.textContent).includes('\u2026'), 'no ellipsis/truncation marker');
  assert.equal(sess.title, full, 'the full id is retained in the title attribute');
});
// An orphan result row shows In (est) = — (no callTokens) and Out (est) = its own result
// estimate; without an estimate both stay placeholders. No Call/Res cells.
test('an orphan result row shows In = — and Out = its own result estimate', () => {
  const orphansBefore = ST.orphanResultEntries.length;
  ING.ingestEvent({ type: 'tool.result', sessionKey: 'sess-orphan', toolName: 'read_file', toolCallId: 'zz1', ok: true, tokens: 300, chars: 1200, at: 1000 });
  assert.equal(ST.orphanResultEntries.length, orphansBefore + 1, 'the unmatched result became an orphan row');
  const orphan = ST.orphanResultEntries[ST.orphanResultEntries.length - 1].li;
  assert.equal(tokenCells(orphan).in.textContent, '—', 'the orphan In is a placeholder (no callTokens)');
  assert.equal(tokenCells(orphan).out.textContent, '300', 'the orphan Out shows the result token estimate');
  assert.equal(tokenCells(orphan).total.textContent, '—', 'the orphan Total is a placeholder');
  assert.equal(hasCellClass(orphan, 's-call-tokens'), false, 'no Call cell exists on the orphan row');
  assert.equal(hasCellClass(orphan, 's-res-tokens'), false, 'no Res cell exists on the orphan row');
  ING.ingestEvent({ type: 'tool.result', sessionKey: 'sess-orphan2', toolName: 'write_file', toolCallId: 'zz2', ok: true, chars: 10, at: 1000 });
  const orphan2 = ST.orphanResultEntries[ST.orphanResultEntries.length - 1].li;
  assert.equal(tokenCells(orphan2).in.textContent, '—', 'In placeholder with no callTokens');
  assert.equal(tokenCells(orphan2).out.textContent, '—', 'Out stays a placeholder when the result carries no estimate');
});
