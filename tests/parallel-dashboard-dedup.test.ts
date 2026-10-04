/**
 * The REAL dashboard dedup gate — dashboard/js/ingest.mjs `ingestEvent` + `eventKey` + `state`
 * (the single entry point BOTH the WS onmessage handler AND the /api/events poll funnel through):
 * N parallel same-name same-turn tool.call events followed by N tool.result events must render N
 * resolved rows with NO orphan and N DISTINCT result keys. Before the fix, eventKey ignored
 * `toolCallId`, so N same-name same-at empty-id results collapsed onto ONE key and only the first
 * row resolved (the rest stayed pending).
 *
 * There is NO DOM/browser test infra here (zero-dependency vanilla-JS dashboard), so the .mjs
 * modules are loaded under Node with a MINIMAL global DOM stub — just enough surface for el()/$()/
 * classList/appendChild/querySelector to build rows without a layout engine. The dashboard .mjs
 * files are served RAW (not part of the TS build), so they are imported dynamically via a
 * non-literal specifier (keeps this file compiling cleanly; resolves relative to dist/tests/).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

/* ---- minimal global DOM stub ---------------------------------------------- */
class FakeEl {
  tagName: string;
  className = '';
  childNodes: any[] = [];
  textContent = '';
  dataset: Record<string, unknown> = {};
  style: Record<string, string> = {};
  hidden = false;
  title = '';
  parentNode: FakeEl | null = null;
  onclick: unknown = null;
  private _attrs: Record<string, string> = {};
  private _listeners: Record<string, Array<(e?: unknown) => void>> = {};
  constructor(tag: string) { this.tagName = String(tag).toLowerCase(); }
  get children(): any[] { return this.childNodes.filter((n) => n instanceof FakeEl); }
  get firstChild(): any { return this.childNodes[0] ?? null; }
  get lastChild(): any { return this.childNodes[this.childNodes.length - 1] ?? null; }
  appendChild(n: any): any { if (n.parentNode) n.parentNode.removeChild(n); n.parentNode = this; this.childNodes.push(n); return n; }
  removeChild(n: any): any { const i = this.childNodes.indexOf(n); if (i >= 0) { this.childNodes.splice(i, 1); n.parentNode = null; } return n; }
  insertBefore(n: any, ref: any): any {
    if (n.parentNode) n.parentNode.removeChild(n);
    n.parentNode = this;
    if (ref == null) this.childNodes.push(n);
    else { const i = this.childNodes.indexOf(ref); if (i < 0) this.childNodes.push(n); else this.childNodes.splice(i, 0, n); }
    return n;
  }
  setAttribute(k: string, v: unknown): void { this._attrs[k] = String(v); }
  getAttribute(k: string): string | null { return k in this._attrs ? this._attrs[k] : null; }
  removeAttribute(k: string): void { delete this._attrs[k]; }
  addEventListener(type: string, fn: (e?: unknown) => void): void { (this._listeners[type] ??= []).push(fn); }
  querySelector(sel: string): FakeEl | null {
    let found: FakeEl | null = null;
    const clsSel = sel.slice(sel.lastIndexOf('.') + 1);
    const tagSel = sel.slice(0, sel.lastIndexOf('.'));
    const classSet = (el: FakeEl): Set<string> => new Set(String(el.className || '').split(/\s+/).filter(Boolean));
    const walk = (node: FakeEl): void => {
      for (const c of node.childNodes) {
        if (!(c instanceof FakeEl)) continue;
        if (!found) {
          const okClass = clsSel === '' || classSet(c).has(clsSel);
          const okTag = tagSel === '' || c.tagName === tagSel.toLowerCase();
          if (okClass && okTag) found = c;
        }
        walk(c);
      }
    };
    walk(this);
    return found;
  }
}
type ClassList = {
  contains(c: string): boolean;
  add(...cs: string[]): void;
  remove(...cs: string[]): void;
  toggle(c: string, force?: boolean): boolean;
};
function makeClassList(el: FakeEl): ClassList {
  const all = (): Set<string> => new Set(String(el.className || '').split(/\s+/).filter(Boolean));
  const list: ClassList = {
    contains(c): boolean { return all().has(c); },
    add(...cs: string[]): void { const s = all(); cs.forEach((x) => { if (x) s.add(x); }); el.className = [...s].join(' '); },
    remove(...cs: string[]): void { el.className = [...all()].filter((x) => !cs.includes(x)).join(' '); },
    toggle(c: string, force?: boolean): boolean {
      const has = list.contains(c); const want = force === undefined ? !has : !!force;
      if (want && !has) list.add(c); else if (!want && has) list.remove(c);
      return want;
    },
  };
  return list;
}
let domInstalled = false;
function installDomStub(): void {
  if (domInstalled) return;
  const registry = new Map<string, FakeEl>();
  const doc = {
    createElement(tag: string): FakeEl { return new FakeEl(tag); },
    getElementById(id: string): FakeEl {
      let n = registry.get(id);
      if (!n) { n = new FakeEl('div'); registry.set(id, n); }
      return n;
    },
  };
  // classList is lazily created per element (as a getter-backed factory result).
  for (const key of Object.getOwnPropertyNames(FakeEl.prototype)) void key; // (no-op: keeps linter quiet)
  Object.defineProperty(FakeEl.prototype, 'classList', {
    get(this: FakeEl) { return makeClassList(this); },
    configurable: true,
  });
  (globalThis as unknown as { document: unknown }).document = doc;
  domInstalled = true;
}
/** Import the real dashboard modules (shared singleton state) under the DOM stub. */
async function loadDashboard(): Promise<{ ingestEvent: any; eventKey: any; state: any }> {
  installDomStub();
  const base = '../..' + '/dashboard'; // non-literal specifier -> Promise<any>, no TS module resolution
  const ing = await import(base + '/js/ingest.mjs');
  const st = await import(base + '/js/state.mjs');
  return { ingestEvent: (ing as any).ingestEvent, eventKey: (ing as any).eventKey, state: (st as any).state };
}
/** Reset the shared runtime state so each scenario starts from a clean dedup gate. */
function resetState(state: any): void {
  state.seenEventKeys.clear();
  state.callRows.clear();
  state.orphanResultEntries.length = 0;
  state.interventionsBySession.clear();
  state.interventionRowData.clear();
  state.localCounts.calls = 0;
  state.localCounts.results = 0;
  state.localCounts.interventions = 0;
}
const callEv = (id: string, at: number, session: string, tool: string): Record<string, unknown> =>
  ({ type: 'tool.call', sessionKey: session, toolName: tool, at, id });
// A tool.result the way the backend emits it (durationMs + toolCallId; `ok` omitted). Post-fix
// shape sets id === toolCallId; pre-fix shape omits id entirely.
const resEv = (tcid: string, at: number, session: string, tool: string, withId: boolean): Record<string, unknown> => {
  const ev: Record<string, unknown> = { type: 'tool.result', sessionKey: session, toolName: tool, at, toolCallId: tcid, durationMs: 42 };
  if (withId) ev.id = tcid;
  return ev;
};

test('B1: N parallel results in post-fix shape (id == toolCallId) render N distinct ok rows', async () => {
  const { ingestEvent, eventKey, state } = await loadDashboard();
  resetState(state);
  const N = 3; const SESSION = 'sess-dash-b1'; const AT = 1700000000000; const TOOL = 'read_file';
  const ids = ['call_b1_1', 'call_b1_2', 'call_b1_3'];
  for (const id of ids) ingestEvent(callEv(id, AT, SESSION, TOOL));
  const keys = ids.map((tcid) => { const ev = resEv(tcid, AT, SESSION, TOOL, true); ingestEvent(ev); return eventKey(ev); });
  assert.equal(new Set(keys).size, N, 'the N result eventKeys are distinct');
  assert.equal(state.callRows.size, N, 'all N call rows exist');
  assert.ok([...state.callRows.values()].every((r: any) => r.status === 'ok'), 'all N call rows end status ok (done)');
  assert.equal(state.orphanResultEntries.length, 0, 'no orphan result entries');
});

test('B2: N parallel same-name results with an EMPTY id but distinct toolCallIds no longer collapse to one key', async () => {
  // The exact pre-fix backend output: same type/sessionKey/at/toolName and NO id, only a
  // per-result toolCallId. This is what collapsed onto ONE dashboard key before the fix.
  const { ingestEvent, eventKey, state } = await loadDashboard();
  resetState(state);
  const N = 3; const SESSION = 'sess-dash-b2'; const AT = 1700000000000; const TOOL = 'read_file';
  const ids = ['call_b2_1', 'call_b2_2', 'call_b2_3'];
  for (const id of ids) ingestEvent(callEv(id, AT, SESSION, TOOL));
  const keys = ids.map((tcid) => { const ev = resEv(tcid, AT, SESSION, TOOL, false); ingestEvent(ev); return eventKey(ev); });
  assert.equal(new Set(keys).size, N, 'N empty-id results with distinct toolCallIds yield N DISTINCT eventKeys (never collide on one key)');
  assert.equal(state.callRows.size, N, 'all N call rows exist');
  assert.ok(
    [...state.callRows.values()].every((r: any) => r.status === 'ok'),
    'all N call rows end status ok (pre-fix: identical-key results dropped N-1, leaving the rest pending)',
  );
  assert.equal(state.orphanResultEntries.length, 0, 'no orphan result entries');
});
