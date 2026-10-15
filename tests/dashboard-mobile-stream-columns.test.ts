/**
 * Mobile (<960px) stream column set: below the 960px breakpoint the live call
 * stream renders 7 columns — Status | Tool | Session | Time | In (est) | Out
 * (est) | expand — revealing the two per-tool token columns (In (est) =
 * ev.callTokens, Out (est) = the paired tool.result's estimated tokens, '—'
 * when absent) while keeping the other low-priority numeric columns
 * (Dur (ms) / Context Size / Size) hidden. At >=960px the desktop 10-track
 * grid is untouched (this file only guards the <960px block).
 *
 * Both HTML files + normalizeStreamHead() always build the full 10-cell row, so
 * the mobile column set is enforced purely in dashboard/css/responsive.css; this
 * test guards that CSS half (the <960px grid template + exactly which numeric
 * cells/labels stay hidden) plus the per-row token values in the DOM
 * (createDomStub + live-view.mjs, mirroring tests/dashboard-batch-turn-tokens.test.ts).
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createDomStub, DomStub } from './dom-stub';

const base = '../..' + '/dashboard';
const S: DomStub = createDomStub();
// Materialize the stream / filter / header elements the modules resolve
// (createCallRow / updateCallRowWithResult -> applyFilters reads them defensively).
S.el('stream-list', 'ul');
S.el('stream-empty', 'div');
S.el('stream-count', 'span');
S.el('stream-head', 'div');
S.el('intervention-list', 'ul');
S.el('filter-tool', 'input');
S.el('filter-status', 'select');
S.el('filter-session', 'input');

let LV: any;
let FMT: any;
before(async () => {
  LV = await import(base + '/js/live-view.mjs');
  FMT = await import(base + '/js/format.mjs');
});

// The <960px block of dashboard/css/responsive.css (the mobile media query),
// whitespace-normalised so the assertions are insensitive to formatting. Resolved
// against the project root, where `npm test` runs (dist/tests/**).
function mobileBlockNorm(): string {
  const css = fs.readFileSync('dashboard/css/responsive.css', 'utf8');
  const start = css.indexOf('@media (max-width: 960px)');
  assert.ok(start !== -1, 'responsive.css has a @media (max-width: 960px) block');
  const end = css.indexOf('@media (max-width: 560px)', start + 1);
  assert.ok(end !== -1, 'responsive.css has a following @media (max-width: 560px) block');
  return css.slice(start, end).replace(/\s+/g, ' ');
}

const GRID =
  'grid-template-columns: minmax(0, 4.6rem) minmax(0, 1fr) minmax(0, 1fr) minmax(0, 4.4rem) minmax(0, 3.5rem) minmax(0, 3.5rem) 1.2rem';

// The <960px stream is exactly the 7-column template: Status | Tool | Session |
// Time | In (est) | Out (est) | expand, with In/Out as fixed minmax(0, 3.5rem)
// tracks and Tool/Session the flexible minmax(0, 1fr) tracks.
test('mobile (<960px) stream grid is the 7-column template with In/Out tracks', () => {
  const b = mobileBlockNorm();
  assert.ok(b.includes(GRID), 'the <960px stream grid is exactly the 7-column template');
  assert.ok(b.includes('minmax(0, 3.5rem) minmax(0, 3.5rem) 1.2rem'), 'In (est) + Out (est) are minmax(0, 3.5rem) tracks ahead of the expand track');
});

// Exactly the three low-priority numeric columns (Dur (ms) / Context Size / Size)
// — cells AND their header labels — are hidden; the two revealed token columns
// (In (est) / Out (est)) are NOT in the hidden set (they stay visible).
test('mobile (<960px) hides Dur/Context/Size but shows In/Out (cells + header labels)', () => {
  const b = mobileBlockNorm();
  assert.ok(
    b.includes('.row-main .s-duration, .row-main .s-tokens-total, .row-main .s-size, #stream-head .num-col:nth-child(5), #stream-head .num-col:nth-child(8), #stream-head .num-col:nth-child(9) { display: none; }'),
    'Dur (ms) / Context Size / Size cells + header labels are hidden on mobile'
  );
  assert.ok(!/s-tokens-in[^{}]*display:\s*none/.test(b), 'the In (est) cell is not hidden on mobile');
  assert.ok(!/s-tokens-out[^{}]*display:\s*none/.test(b), 'the Out (est) cell is not hidden on mobile');
  assert.ok(!/th:nth-child\(6\)[^{}]*\{[^}]*display:\s*none/.test(b), 'the In (est) header label is not hidden on mobile');
  assert.ok(!/th:nth-child\(7\)[^{}]*\{[^}]*display:\s*none/.test(b), 'the Out (est) header label is not hidden on mobile');
});

// The two revealed In (est) / Out (est) header labels are allowed to wrap to two
// lines so "In (est) tok" / "Out (est) tok" stay legible in the narrow tracks.
test('mobile (<960px) lets the In/Out header labels wrap to two lines', () => {
  const b = mobileBlockNorm();
  assert.ok(/th:nth-child\(6\)[^{}]*\{[^}]*white-space:\s*normal/.test(b), 'the In (est) header label wraps (white-space: normal)');
  assert.ok(/th:nth-child\(7\)[^{}]*\{[^}]*white-space:\s*normal/.test(b), 'the Out (est) header label wraps (white-space: normal)');
});

// The mobile columns carry real per-row values: In (est) = ev.callTokens, Out
// (est) = the paired tool.result's estimated tokens (filled in place), and '—'
// when either is absent.
test('mobile row carries real per-row In (est)/Out (est) values (In = callTokens, Out = paired result, — when absent)', () => {
  const cell = (li: any, cls: string): any => {
    const main = li.children.find((c: any) => String(c.className || '').includes('row-main'));
    assert.ok(main, 'the row carries a .row-main container');
    const c = main.children.find((x: any) => String(x.className || '').includes(cls));
    assert.ok(c, `the row carries a .${cls} token cell`);
    return c;
  };

  // A call with a per-call token estimate: In shows it; Out is a placeholder until the result pairs.
  const rs = LV.createCallRow({ type: 'tool.call', sessionKey: 'sess-m', toolName: 'fetch', at: 1000, id: 'mc1', callTokens: 122300 });
  assert.equal(cell(rs.li, 's-tokens-in').textContent, FMT.formatCount(122300), 'In (est) = the per-call token estimate (ev.callTokens)');
  assert.equal(cell(rs.li, 's-tokens-out').textContent, '—', 'Out (est) is a placeholder before the result pairs');

  // The paired tool.result fills Out (est) in place; In keeps its call estimate.
  LV.updateCallRowWithResult(rs, { type: 'tool.result', toolCallId: 'mc1', ok: true, tokens: 456700, at: 1000 });
  assert.equal(cell(rs.li, 's-tokens-out').textContent, FMT.formatCount(456700), 'Out (est) = the paired result token estimate');
  assert.equal(cell(rs.li, 's-tokens-in').textContent, FMT.formatCount(122300), 'In (est) keeps its call estimate after the result');

  // A call with no callTokens: In is a placeholder (—); Out stays a placeholder.
  const rs2 = LV.createCallRow({ type: 'tool.call', sessionKey: 'sess-m', toolName: 'read', at: 2000, id: 'mc2' });
  assert.equal(cell(rs2.li, 's-tokens-in').textContent, '—', 'In (est) is a placeholder when callTokens is absent');
  assert.equal(cell(rs2.li, 's-tokens-out').textContent, '—', 'Out (est) is a placeholder with no result');
});
