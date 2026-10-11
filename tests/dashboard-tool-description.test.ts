/**
 * Coverage for the "Description" column in the live tool-call stream
 * (dashboard/js/live-view.mjs: createCallRow / createOrphanResultRow /
 * appendDescriptionCell). The cell shows the tool.call event's request-provided
 * `description` when present and a "—" placeholder otherwise; it sits immediately
 * after the Tool column, and orphan result rows (no tool.call event) always render
 * the placeholder.
 *
 * DOM-stubbed, mirroring tests/dashboard-policy-tool-detail.test.ts:
 *   - createDomStub() + materialized stream-list / stream-empty / stream-count /
 *     intervention-list / filter controls (so createCallRow / applyFilters resolve);
 *   - an injected globalThis.fetch (rows never fetch, but the modules expect one);
 *   - async completion drained purely via microtask flushing (no timers/sleeps).
 * Each test file runs in its own process, so one installed stub never leaks.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDomStub, DomStub } from './dom-stub';

/* Non-literal specifier keeps this compiling cleanly; resolves relative to
   dist/tests/ -> ../../dashboard at runtime (identical trick to the reference specs). */
const base = '../..' + '/dashboard';

const S: DomStub = createDomStub();
// Node has no window/location; the dashboard modules reference them defensively, so
// provide minimal shims BEFORE the live-view module is imported in `before` below.
(globalThis as any).location = { hash: '' };
(globalThis as any).window = { confirm: () => true, scrollTo: () => {} };

// Materialize the stream + filter elements the live-view modules touch so
// createCallRow / createOrphanResultRow / applyFilters resolve via
// document.getElementById.
S.el('stream-list', 'ul');
S.el('stream-empty', 'div');
S.el('stream-count', 'span');
S.el('intervention-list', 'ul');
S.el('filter-tool', 'input');
S.el('filter-status', 'select');
S.el('filter-session', 'input');

let LV: any;

// The .row-main container of a row (the grid that holds the column cells).
function rowMain(li: any): any {
  const main = li.children.find((c: any) => String(c.className || '').includes('row-main'));
  assert.ok(main, 'the row carries a .row-main container');
  return main;
}
// The .s-description cell of a row (the Description column).
function descriptionCell(li: any): any {
  const cell = rowMain(li).children.find((c: any) => String(c.className || '').includes('s-description'));
  assert.ok(cell, 'the row carries a .s-description cell');
  return cell;
}
// True when the Description cell sits immediately after the Tool cell.
function descriptionFollowsTool(li: any): boolean {
  const children: any[] = rowMain(li).children;
  const toolIdx = children.findIndex((c) => String(c.className || '').includes('s-tool'));
  const descIdx = children.findIndex((c) => String(c.className || '').includes('s-description'));
  return toolIdx !== -1 && descIdx === toolIdx + 1;
}

before(async () => {
  (globalThis as any).fetch = (url: string): Promise<unknown> =>
    Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
  LV = await import(base + '/js/live-view.mjs');
});

/* ---- (a) a tool.call WITH a description renders it in the cell ---------- */
test('a tool.call event with a description renders it in the Description cell (after the Tool column)', () => {
  const ev = {
    type: 'tool.call',
    sessionKey: 'sess-a',
    toolName: 'search_web',
    id: 'call-desc-a',
    at: 1000,
    description: 'Search the web for information.',
  };
  const rs = LV.createCallRow(ev);
  const cell = descriptionCell(rs.li);
  assert.equal(cell.textContent, 'Search the web for information.', 'the cell shows the request-provided description');
  assert.equal(cell.title, 'Search the web for information.', 'the full text is exposed via the title attribute');
  assert.ok(descriptionFollowsTool(rs.li), 'the Description column sits immediately after the Tool column');
});

/* ---- (b) a tool.call WITHOUT a description shows the "—" placeholder ----- */
test('a tool.call event without a description shows the "—" placeholder', () => {
  const ev = { type: 'tool.call', sessionKey: 'sess-b', toolName: 'mystery_tool', id: 'call-nodesc-b', at: 2000 };
  const rs = LV.createCallRow(ev);
  const cell = descriptionCell(rs.li);
  assert.equal(cell.textContent, '\u2014', 'the cell shows the "—" placeholder when the event has no description');
  assert.ok(descriptionFollowsTool(rs.li), 'the Description column still sits immediately after the Tool column');
});

/* ---- (c) an orphan result row (no tool.call event) shows the "—" -------- */
test('an orphan result row (no tool.call event) shows the "—" placeholder', () => {
  const ev = {
    type: 'tool.result',
    sessionKey: 'sess-c',
    toolName: 'search_web',
    toolCallId: 'call-orphan-c',
    id: 'call-orphan-c',
    at: 3000,
    ok: true,
  };
  // createOrphanResultRow does not return the row state (unlike createCallRow), so read
  // the freshly-added orphan row from the stream list by its class.
  LV.createOrphanResultRow(ev);
  const orphanLi = S.byId('stream-list')!.children.find((c: any) => String(c.className || '').includes('orphan-row'));
  assert.ok(orphanLi, 'the orphan row was added to the stream list');
  const cell = descriptionCell(orphanLi);
  assert.equal(cell.textContent, '\u2014', 'the orphan row shows the "—" placeholder (no callEv to read a description from)');
});
