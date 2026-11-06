/**
 * DOM-stubbed coverage for the live stream's token columns
 * (dashboard/js/live/view.mjs + dashboard/js/data/ingest.mjs): each row shows its OWN
 * per-tool estimates — In (est) = the call-side token estimate (ev.callTokens) and
 * Out (est) = the result-side token estimate (the paired tool.result's ev.tokens) —
 * on every row (batch or single). Turn-level totals are NOT rendered on rows: the
 * turn.usage total is shown in the session group header ("Latest turn" / "Session
 * total"), and rows carry no .s-tokens-total cell. The previously separate Call/Res
 * columns are gone.
 *
 * Mirrors tests/dashboard-tool-result-status.test.ts: createDomStub() + the
 * materialized stream/counter elements, an injected globalThis.fetch, and a
 * shared-state reset in beforeEach. Each test file runs in its own process, so
 * the installed stub never leaks.
 */
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createDomStub, DomStub } from '../dom-stub';

/* Non-literal specifier keeps this compiling cleanly; resolves relative to
   dist/tests/dashboard/ -> ../../../dashboard at runtime. */
const base = '../../..' + '/dashboard';

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
let I18N: any;
before(async () => {
  (globalThis as any).fetch = (url: string): Promise<unknown> =>
    Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
  LV = await import(base + '/js/live/view.mjs');
  ING = await import(base + '/js/data/ingest.mjs');
  ST = (await import(base + '/js/core/state.mjs')).state;
  I18N = await import(base + '/js/i18n/index.mjs');
  LV.bindFilterEvents();
});

// Each scenario starts from a clean stream (shared state persists across tests).
beforeEach(() => {
  S.byId('stream-list')!.children.length = 0;
  ST.callRows.clear();
  ST.orphanResultEntries.length = 0;
  ST.seenEventKeys.clear();
  ST.turnUsageBySession.clear();
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

// The row's In (est) / Out (est) token cells inside its .row-main container.
function tokenCells(li: any): { in: any; out: any } {
  const main = li.children.find((c: any) => String(c.className || '').includes('row-main'));
  assert.ok(main, 'the row carries a .row-main container');
  const pick = (cls: string): any => {
    const cell = main.children.find((c: any) => String(c.className || '').includes(cls));
    assert.ok(cell, `the row carries a .${cls} token cell`);
    return cell;
  };
  return { in: pick('s-tokens-in'), out: pick('s-tokens-out') };
}
// True when the row's .row-main contains a cell with the given class (used to assert the
// removed Call/Res columns and the per-row Total cell are gone).
function hasCellClass(li: any, cls: string): boolean {
  const main = li.children.find((c: any) => String(c.className || '').includes('row-main'));
  assert.ok(main, 'the row carries a .row-main container');
  return main.children.some((c: any) => String(c.className || '').includes(cls));
}
const rowHasTotal = (li: any): boolean => hasCellClass(li, 's-tokens-total');
// The session group header's usage meta text for a session key (null when the header carries none).
function groupMetaOf(key: string): string | null {
  const list = S.byId('stream-list')!;
  const head = list.children.find((c: any) => c.classList.contains('stream-group-head') && c.dataset.session === key);
  assert.ok(head, 'the session group header is rendered');
  const meta = head.children.find((c: any) => String(c.className || '').includes('stream-group-meta'));
  return meta ? meta.textContent : null;
}
const rowsOf = (): any[] => [...ST.callRows.values()];

// Batched turn (streamed path): the call events carry NO turn tokens (omitted for batched
// turns) but DO carry a distinct per-call callTokens estimate. Each row shows its own In
// (est) at creation; each row shows its own Out (est) once its result arrives; the
// whole-turn turn.usage total is shown in the session group header, never as a row cell.
test('batched turn: each row shows its own In (est) and Out (est); turn total in the group header; no Call/Res/Total row cells', () => {
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
  // The whole-turn turn.usage total is the session group header's "Latest turn" / "Session total"
  // (NOT the sum of In and Out); no row carries a Total cell.
  ING.ingestEvent(usageEv(1000, { input: 10, output: 20, total: 30 }));
  assert.equal(groupMetaOf('sess-batch'), 'Latest turn: 30 · Session total: 30', 'the session group header shows the turn total');
  for (const r of [r1, r2, r3]) assert.equal(rowHasTotal(r.li), false, 'no row carries a Total cell');
  // Every row still surfaces the turn tokens in its details panel (turnTokens set on all).
  assert.deepEqual(r1.turnTokens, { input: 10, output: 20, total: 30 });
  assert.deepEqual(r3.turnTokens, { input: 10, output: 20, total: 30 });
});

// A call event that carries its own turn tokens does not render a row Total cell, and the
// turn.usage total is still only shown in the session group header. In/Out stay per-tool.
test('a call carrying its own turn tokens renders no row Total; the turn.usage total is the group header', () => {
  ING.ingestEvent(callEv('c1', 1000, 'read_file', { input: 10, output: 20, total: 30 }));
  ING.ingestEvent(callEv('c2', 1000, 'write_file'));
  const [r1, r2] = rowsOf();
  assert.equal(rowHasTotal(r1.li), false, 'the row carrying its own turn tokens has no Total cell');
  ING.ingestEvent(usageEv(1000, { input: 10, output: 20, total: 30 }));
  assert.equal(groupMetaOf('sess-batch'), 'Latest turn: 30 · Session total: 30', 'the group header carries the turn total');
  assert.equal(rowHasTotal(r1.li), false, 'still no row Total cell after the turn.usage');
  assert.equal(rowHasTotal(r2.li), false, 'the sibling row has no Total cell either');
  assert.equal(tokenCells(r1.li).in.textContent, '—', 'In is not the turn usage.input');
  assert.equal(tokenCells(r2.li).in.textContent, '—');
  assert.equal(tokenCells(r2.li).out.textContent, '—', 'Out is not the turn usage.output');
});

// A turn.usage applies ONLY to rows of the same turn (matched by sessionKey + the shared
// turn-level `at`); rows of other turns keep no turnTokens. The group header total reflects the
// recorded turn usage. Per-tool In is unaffected by turn matching.
test('a turn.usage applies only to the rows of the same turn (matching at)', () => {
  ING.ingestEvent(callEv('c1', 1000, 'read_file', undefined, 120));
  ING.ingestEvent(callEv('c2', 2000, 'write_file', undefined, 60));
  const [r1, r2] = rowsOf();
  ING.ingestEvent(usageEv(2000, { input: 5, output: 6, total: 11 }));
  assert.equal(r1.turnTokens, undefined, 'the other-turn row gets no turn tokens');
  assert.deepEqual(r2.turnTokens, { input: 5, output: 6, total: 11 }, 'the matching-turn row gets turn tokens');
  assert.equal(groupMetaOf('sess-batch'), 'Latest turn: 11 · Session total: 11', 'the group header shows the recorded turn total');
  assert.equal(rowHasTotal(r1.li), false, 'no row Total cell on the other-turn row');
  assert.equal(rowHasTotal(r2.li), false, 'no row Total cell on the matching-turn row');
  assert.equal(tokenCells(r1.li).in.textContent, '120', 'per-tool In is unaffected by turn matching');
  assert.equal(tokenCells(r2.li).in.textContent, '60');
});

// Omit, don't fabricate: a turn.usage with no tokens is a no-op; no turn usage is shown in the
// group header and no turnTokens are bound.
test('a turn.usage without tokens is a no-op; no turn total is shown', () => {
  ING.ingestEvent(callEv('c1', 1000, 'read_file', undefined, 120));
  ING.ingestEvent(callEv('c2', 2000, 'write_file', undefined, 60));
  const [r1, r2] = rowsOf();
  ING.ingestEvent(usageEv(1000)); // no tokens field
  LV.regroupStream();
  assert.equal(groupMetaOf('sess-batch'), null, 'the group header shows no turn usage (no-op)');
  assert.equal(rowHasTotal(r1.li), false, 'no row Total cell on the no-op row');
  assert.equal(rowHasTotal(r2.li), false, 'no row Total cell on the other-turn row');
  assert.equal(r1.turnTokens, undefined, 'no turn tokens are bound on a no-op usage');
});

// The turn.usage total is shown in the group header; per-tool In/Out are independent estimates.
test('the turn.usage total goes to the group header; per-tool In/Out are independent', () => {
  ING.ingestEvent(callEv('c1', 1000, 'read_file', undefined, 120));
  const [r1] = rowsOf();
  ING.ingestEvent(usageEv(1000, { total: 30 }));
  assert.equal(groupMetaOf('sess-batch'), 'Latest turn: 30 · Session total: 30', 'the group header carries the turn total');
  assert.equal(rowHasTotal(r1.li), false, 'no row Total cell');
  assert.equal(tokenCells(r1.li).in.textContent, '120', 'In stays the per-call estimate (not the turn input)');
  assert.equal(tokenCells(r1.li).out.textContent, '—', 'Out stays the placeholder (no result)');
});

// Single-call turn: the row In/Out are the per-tool estimates (not the provider usage); the
// turn value is shown in the session group header.
test('single-call turn: In/Out are the per-tool estimates; turn value in the group header', () => {
  ING.ingestEvent(callEv('c1', 1000, 'read_file', undefined, 42));
  const [r1] = rowsOf();
  assert.equal(tokenCells(r1.li).in.textContent, '42', 'the row In is the per-tool call estimate (not the provider usage)');
  ING.ingestEvent(resultEv('c1', 1000, 'read_file', 300, 1200));
  assert.equal(tokenCells(r1.li).out.textContent, '300', 'the row Out is the per-tool result estimate');
  ING.ingestEvent(usageEv(1000, { input: 10, output: 20, total: 30 }));
  assert.equal(groupMetaOf('sess-batch'), 'Latest turn: 30 · Session total: 30', 'the group header shows the turn value');
  assert.equal(rowHasTotal(r1.li), false, 'no row Total cell');
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

// The header labels read Dur (ms) / In (est) / Out (est) / Size with the Call/Res/Description
// and Context Size columns removed (8 labelled columns + the empty expand cell).
test('the stream header reads In (est) / Out (est) and has no Call/Res/Context columns', () => {
  LV.normalizeStreamHead();
  const head = S.byId('stream-head')!;
  const labels = [...head.children].map((c: any) => String(c.textContent));
  assert.ok(labels.includes('Dur (ms)'), 'the header carries Dur (ms)');
  assert.ok(labels.includes('In (est)'), 'the header carries In (est)');
  assert.ok(labels.includes('Out (est)'), 'the header carries Out (est)');
  assert.ok(labels.includes('Size'), 'Size header retained');
  assert.ok(!labels.includes('Context Size'), 'no Context Size header (turn total lives in the session group header)');
  assert.ok(!labels.includes('Call'), 'no Call header');
  assert.ok(!labels.includes('Res'), 'no Res header');
  assert.ok(!labels.includes('Description'), 'no Description header');
  assert.equal(labels.length, 9, '8 labelled columns + 1 empty expand cell');
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
// estimate; without an estimate both stay placeholders. No Call/Res/Total cells.
test('an orphan result row shows In = — and Out = its own result estimate', () => {
  const orphansBefore = ST.orphanResultEntries.length;
  ING.ingestEvent({ type: 'tool.result', sessionKey: 'sess-orphan', toolName: 'read_file', toolCallId: 'zz1', ok: true, tokens: 300, chars: 1200, at: 1000 });
  assert.equal(ST.orphanResultEntries.length, orphansBefore + 1, 'the unmatched result became an orphan row');
  const orphan = ST.orphanResultEntries[ST.orphanResultEntries.length - 1].li;
  assert.equal(tokenCells(orphan).in.textContent, '—', 'the orphan In is a placeholder (no callTokens)');
  assert.equal(tokenCells(orphan).out.textContent, '300', 'the orphan Out shows the result token estimate');
  assert.equal(rowHasTotal(orphan), false, 'the orphan row has no Total cell');
  assert.equal(hasCellClass(orphan, 's-call-tokens'), false, 'no Call cell exists on the orphan row');
  assert.equal(hasCellClass(orphan, 's-res-tokens'), false, 'no Res cell exists on the orphan row');
  ING.ingestEvent({ type: 'tool.result', sessionKey: 'sess-orphan2', toolName: 'write_file', toolCallId: 'zz2', ok: true, chars: 10, at: 1000 });
  const orphan2 = ST.orphanResultEntries[ST.orphanResultEntries.length - 1].li;
  assert.equal(tokenCells(orphan2).in.textContent, '—', 'In placeholder with no callTokens');
  assert.equal(tokenCells(orphan2).out.textContent, '—', 'Out stays a placeholder when the result carries no estimate');
});

// Batch group: calls sharing (sessionKey, at) render under ONE header row (li.stream-batch-head)
// placed above the member rows (marked batch-child). The header appears at the second member and
// its count tracks every later sibling. Child rows carry no per-call batch badge.
const listEl = (): any => S.byId('stream-list')!;
function batchHeadsIn(): any[] {
  return listEl().children.filter((c: any) => c.classList.contains('stream-batch-head'));
}
function headAt(at: number): any {
  return batchHeadsIn().find((h: any) => h.dataset.batch === 'sess-batch\u0000' + at);
}
function batchBadgeOf(li: any): boolean {
  const main = li.children.find((c: any) => String(c.className || '').includes('row-main'));
  const tool = main.children.find((c: any) => String(c.className || '').includes('s-tool'));
  return tool.children.some((c: any) => String(c.className || '').includes('s-batch'));
}
function clickIn(target: any): void {
  ((listEl() as any)._listeners.click || []).slice().forEach((fn: any) => fn.call(listEl(), { target }));
}

test('same-turn calls render under exactly one batch header with the count; no per-call badges', () => {
  ING.ingestEvent(callEv('b1', 5000, 'read_file'));
  assert.equal(batchHeadsIn().length, 0, 'a lone call has no header');
  ING.ingestEvent(callEv('b2', 5000, 'write_file'));
  assert.equal(batchHeadsIn().length, 1, 'the second member creates exactly one header');
  assert.equal(headAt(5000).children[1].textContent, 'Batch call · 2 tools', 'header shows the count');
  ING.ingestEvent(callEv('b3', 5000, 'list_dir'));
  assert.equal(batchHeadsIn().length, 1, 'later siblings do not add headers');
  assert.equal(headAt(5000).children[1].textContent, 'Batch call · 3 tools', 'count updates on every sibling');
  assert.equal(headAt(5000).children[0].title, 'Batch call · 3 tools', 'toggle title is localized');
  assert.equal(headAt(5000).children[0].getAttribute('aria-label'), 'Batch call · 3 tools', 'toggle aria-label is localized');
  const idx = listEl().children.indexOf(headAt(5000));
  for (const id of ['b1', 'b2', 'b3']) {
    const li = ST.callRows.get(id).li;
    assert.equal(li.classList.contains('batch-child'), true, 'member is a batch child');
    assert.equal(batchBadgeOf(li), false, 'no per-call batch badge');
    assert.ok(listEl().children.indexOf(li) > idx, 'members follow their header');
  }
});

test('an unrelated turn gets its own header; a standalone call gets none', () => {
  ING.ingestEvent(callEv('u1', 6000, 'read_file'));
  ING.ingestEvent(callEv('u2', 6000, 'write_file'));
  ING.ingestEvent(callEv('u3', 7000, 'list_dir'));
  assert.equal(batchHeadsIn().length, 1, 'only the two-call turn has a header');
  assert.equal(headAt(6000).children[1].textContent, 'Batch call · 2 tools');
  assert.equal(ST.callRows.get('u1').li.classList.contains('batch-child'), true);
  assert.equal(ST.callRows.get('u2').li.classList.contains('batch-child'), true);
  assert.equal(ST.callRows.get('u3').li.classList.contains('batch-child'), false, 'standalone row is not a batch child');
  assert.equal(headAt(7000), undefined, 'standalone turn has no header');
});

test('batch header toggles collapse: members hidden (kept in DOM) and aria-expanded flips', () => {
  ING.ingestEvent(callEv('c1', 9000, 'read_file'));
  ING.ingestEvent(callEv('c2', 9000, 'write_file'));
  const kids = [ST.callRows.get('c1').li, ST.callRows.get('c2').li];
  assert.equal(headAt(9000).children[0].getAttribute('aria-expanded'), 'true', 'expanded by default');
  assert.ok(kids.every((k: any) => !k.classList.contains('is-batch-collapsed')));

  clickIn(headAt(9000).children[0]);
  assert.equal(headAt(9000).children[0].getAttribute('aria-expanded'), 'false', 'collapsed after toggle');
  assert.ok(kids.every((k: any) => k.classList.contains('is-batch-collapsed')), 'members hidden');
  assert.ok(kids.every((k: any) => listEl().children.indexOf(k) >= 0), 'members kept in the DOM');

  clickIn(headAt(9000).children[0]);
  assert.equal(headAt(9000).children[0].getAttribute('aria-expanded'), 'true', 'expanded again');
  assert.ok(kids.every((k: any) => !k.classList.contains('is-batch-collapsed')), 'members restored');
});

test('a reset list does not keep a stale collapsed batch for a new batch with the same key', () => {
  ING.ingestEvent(callEv('r1', 9500, 'read_file'));
  ING.ingestEvent(callEv('r2', 9500, 'write_file'));
  clickIn(headAt(9500).children[0]);
  assert.ok([ST.callRows.get('r1').li, ST.callRows.get('r2').li].every((k: any) => k.classList.contains('is-batch-collapsed')));

  LV.resetSessionGroupState();
  listEl().children.length = 0;
  ST.callRows.clear();
  ST.seenEventKeys.clear();

  ING.ingestEvent(callEv('r3', 9500, 'read_file'));
  ING.ingestEvent(callEv('r4', 9500, 'write_file'));
  assert.equal(headAt(9500).children[0].getAttribute('aria-expanded'), 'true', 'new batch with the same key starts expanded');
  assert.ok([ST.callRows.get('r3').li, ST.callRows.get('r4').li].every((k: any) => !k.classList.contains('is-batch-collapsed')));
});

test('batch header relabels on locale change (tr/en) across label, title and aria-label', () => {
  ING.ingestEvent(callEv('l1', 9800, 'read_file'));
  ING.ingestEvent(callEv('l2', 9800, 'write_file'));
  const doc = (globalThis as any).document;
  if (!doc.documentElement) doc.documentElement = { lang: '' };
  try {
    I18N.setLocale('tr');
    assert.equal(headAt(9800).children[1].textContent, 'Toplu çağrı · 2 araç', 'Turkish label');
    assert.equal(headAt(9800).children[0].title, 'Toplu çağrı · 2 araç', 'Turkish title');
    assert.equal(headAt(9800).children[0].getAttribute('aria-label'), 'Toplu çağrı · 2 araç', 'Turkish aria-label');
    assert.equal(I18N.t('stream.batch.one'), 'Toplu çağrı · 1 araç', 'Turkish singular catalog value');
    I18N.setLocale('en');
    assert.equal(headAt(9800).children[1].textContent, 'Batch call · 2 tools', 'English label');
    assert.equal(I18N.t('stream.batch.one'), 'Batch call · 1 tool', 'English singular catalog value');
  } finally {
    I18N.setLocale('en');
  }
});

test('calls missing sessionKey or at never group accidentally', () => {
  ING.ingestEvent({ type: 'tool.call', sessionKey: 'sess-batch', toolName: 'a', id: 'n1' });
  ING.ingestEvent({ type: 'tool.call', sessionKey: 'sess-batch', toolName: 'b', id: 'n2' });
  ING.ingestEvent({ type: 'tool.call', toolName: 'c', at: 8000, id: 'n3' });
  ING.ingestEvent({ type: 'tool.call', toolName: 'd', at: 8000, id: 'n4' });
  assert.equal(batchHeadsIn().length, 0, 'no batch header without a complete (sessionKey, at) key');
  for (const r of rowsOf()) assert.equal(r.li.classList.contains('batch-child'), false, 'no batch child without a complete key');
});
