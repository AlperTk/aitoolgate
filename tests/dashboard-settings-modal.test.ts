/**
 * Coverage for dashboard/js/settings.mjs — the "API Providers" settings section.
 *
 * Two tiers, mirroring the proven DOM-stubbed pattern used by
 * tests/rules-empty-state.test.ts / tests/dashboard-stream-filters.test.ts:
 *   1. PURE-FUNCTION unit checks against the exported helpers (zero DOM), loaded
 *      once via a non-literal dynamic import specifier so the ES-module graph
 *      caches after first load without re-importing per case.
 *   2. MOUNT-level DOM behaviour driven through the dom-stub registry elements + an
 *      injected fetchImpl (initSettings accepts opts.fetchImpl). Events are fired
 *      exactly as the pre-existing specs do (element.emit / document keydown) and
 *      async completion is awaited purely via microtask flushing (resolved promises)
 *      — NO setTimeout/sleep anywhere. Each test file runs in its own process, so
 *      installing one stub here never leaks across files.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDomStub, DomStub, FakeEl } from './dom-stub';

/* Non-literal specifier keeps this compiling cleanly; resolves relative to
   dist/tests/ -> ../../dashboard at runtime (identical trick to the reference specs). */
const base = '../..' + '/dashboard';

type Resp = { ok: boolean; status: number; json: () => any };
interface Call { url: string; method: string; body?: unknown }

/* ---- shared DOM fixture (one process per test file) ------------------- */
const S: DomStub = createDomStub();

// Provider-pane + overlay nodes resolved by $(id)/getElementById inside initSettings.
S.el('open-settings', 'button');
S.el('settings-dialog', 'div');
S.el('settings-close', 'button');
S.el('settings-rail', 'ul');
S.el('settings-panel', 'main');
['prov-add-btn', 'pf-cancel', 'pf-reset', 'pf-key-toggle', 'pf-save'].forEach((id) => S.el(id, 'button'));
['prov-list'].forEach((id) => S.el(id, 'ul'));
['prov-editor-title', 'pf-error', 'prov-status', 'prov-empty', 'prov-error', 'prov-editor'].forEach((id) => S.el(id, 'div'));
S.el('prov-form', 'form');
['pf-name', 'pf-base-url', 'pf-model', 'pf-api-key'].forEach((id) => S.el(id, 'input'));
S.el('pf-protocol', 'select');
['prov-list-view', 'prov-form-view'].forEach((id) => S.el(id, 'section'));

let M: any;
const calls: Call[] = [];
let respond: (url: string, init?: any) => Resp = () => ({ ok: true, status: 200, json: () => ({}) });

function makeFetchImpl() {
  return function fetchImpl(this: unknown, url: string, init?: any): Promise<Resp> {
    const rec: Call = { url: String(url), method: init?.method ?? 'GET' };
    if (typeof init?.body === 'string') { try { rec.body = JSON.parse(init.body); } catch { rec.body = init.body; } }
    calls.push(rec);
    return Promise.resolve(respond(String(url), init));
  };
}

// Microtask drain for async handler chains — purely promise-based, no timers/sleeps.
async function flush(): Promise<void> { let p: Promise<unknown> = Promise.resolve(); for (let i = 0; i < 64; i += 1) p = p.then(() => undefined); await p; }
function fireOn(el: FakeEl, type: string, ev?: Record<string, unknown>): void { (el as any).emit(type, ev ?? { target: el }); }

before(async () => {
  // Enhance every element instance for the settings module's needs (shared prototype).
  (FakeEl.prototype as any).focus = function focus() { this._focusedCount = (this._focusedCount || 0) + 1; };
  (FakeEl.prototype as any).scrollIntoView = function scrollIntoView() { /* no-op */ };
  (FakeEl.prototype as any).closest = function closest(sel: string): FakeEl | null {
    let n: any = this;
    while (n) {
      if (sel.startsWith('.')) { const cls = sel.slice(1); if ((String(n.className ?? '').split(/\s+/).filter(Boolean)).includes(cls)) return n; }
      else if (sel.startsWith('#')) { if (n.id === sel.slice(1)) return n; }
      n = n.parentNode || null;
    }
    return null;
  };
  // emit with an optional event payload (default target = the firing element) so the
  // delegated list handlers in settings.mjs can read ev.target / call ev.preventDefault().
  (FakeEl.prototype as any).emit = function emit(type: string, ev?: Record<string, unknown>) {
    const e = (this as any)._listeners[type] || [];
    const payload: Record<string, unknown> = ev ? Object.assign({ preventDefault(): void {} }, ev) : { target: this, preventDefault(): void {} };
    e.slice().forEach((fn: (ev: Record<string, unknown>) => void) => fn.call(this, payload));
  };
  // Resolve '#id' lookups ONLY for the protocol-select needed by initProtocolSelect; everything else returns
  // null so settings.mjs falls back to $(id) (document.getElementById) — giving ONE canonical element instance
  // per id across both its els[] caching and its $()/findEl() paths (avoiding duplicated/split event wiring).
  (FakeEl.prototype as any).querySelector = function querySelector(sel: string) {
    if (typeof sel === 'string' && sel.startsWith('#')) {
      const id = sel.slice(1);
      if (id !== 'pf-protocol') return null;   // force all other ids down the shared registry ($) path
      return S.byId?.(id) ?? null;             // only the protocol select resolves here directly
    }
    return null;
  };
  // Template-aware createElement: settings builds its modal/panes from <template>.innerHTML.
  // The parsed subtree isn't modelled; instead each template root resolves '#id' lookups to
  // our pre-materialized registry nodes and exposes a real firstElementChild (the backdrop).
  let tplSeq = 0;
  S.document.createElement = (tag: string): any => {
    if (tag === 'template') {
      // Register ONE canonical element per template so that byId(id) === content.firstElementChild
      // (the backdrop) — settings.mjs adds 'is-open' to the backdrop, which IS the template root here.
      const id = '__tpl_' + tplSeq++;
      const root = S.el(id, 'div');
      return { _html: '', innerHTML: '', content: { firstElementChild: root } };
    }
    return S.createElement(tag);
  };
  // document-level listeners (settings binds a keydown handler on document).
  const docListeners: Record<string, Array<(e: any) => void>> = {};
  (S.document as any).addEventListener = (t: string, f: (e: any) => void) => { docListeners[t] = docListeners[t] || []; docListeners[t].push(f); };
  const emitDoc = (t: string, ev: any): void => { (docListeners[t] || []).slice().forEach((f) => f.call(S.body, ev)); };
  (globalThis as unknown as Record<string, unknown>).window = { confirm: () => true };

  M = await import(base + '/js/settings.mjs');
  calls.length = 0;
  respond = defaultResponder();
  M.initSettings({ fetchImpl: makeFetchImpl() });
  (S as any)._emitDoc = emitDoc;
});

/* ---- tiny in-test provider registry that shapes ONLY the fetch responses -- */
interface PRow { id: string; name: string; baseUrl: string; model: string; apiKey: string | null; protocol: string; isActive: boolean }
const db: PRow[] = [];
function resetDb(rows: PRow[]): void { db.length = 0; rows.forEach((r) => db.push({ ...r })); }
const seedRows = (): PRow[] => [
  { id: 'prov-3', name: 'Alpha Engine', baseUrl: 'http://alpha.local/v1', model: 'alpha-model', apiKey: 'ALPHA-SECRET-9xZQ', protocol: 'openai', isActive: true },
  { id: 'prov-1', name: 'Beta Engine', baseUrl: 'http://beta.local/v1', model: 'beta-model', apiKey: null, protocol: 'anthropic', isActive: false },
  { id: 'prov-2', name: 'Gamma Engine', baseUrl: 'http://gamma.local/v1', model: 'gamma-model', apiKey: null, protocol: 'openai', isActive: false },
];
const okJson = (data: any): Resp => ({ ok: true, status: data && data.__status ? data.__status : 200, json: () => data });
const listResponse = (): any => ({ providers: db.map(({ apiKey, ...rest }) => ({ ...rest, apiKeySet: apiKey !== null && apiKey !== '' })), activeId: db.find((r) => r.isActive)?.id ?? null });
function findRowRadio(id: string): FakeEl | undefined {
  const list = S.byId('prov-list')!;
  for (const row of list.children) {
    if (row.getAttribute?.('data-provider-id') !== id) continue;
    return row.children.find((c) => c.type === 'radio' && (c as any).name === 'settings-provider-active') as FakeEl | undefined;
  }
  return undefined;
}
// Close-then-open cycle that ends with a guaranteed-fresh authoritative list render of the
// providers pane; used as an idempotent precondition for every mount-level scenario so each
// case is deterministic regardless of what prior scenarios left behind (each file runs once per process).
async function ensureOpenProvidersPane(): Promise<void> {
  S.byId('settings-close')!.emit('click');   // always runs through closeSettings first
  await flush();
  S.byId('open-settings')!.emit('click');    // fresh open -> selectSection -> refreshList (authoritative GET)
  await flush();
}
// Default responder mirrors single-active semantics only to keep DOM state coherent between actions.
function defaultResponder() {
  let seq = 0;
  return (url: string, init?: any): Resp => {
    const method = init?.method ?? 'GET';
    const segMatch = /^api\/api-providers\/(.+)$/.exec(url);
    const seg = segMatch ? decodeURIComponent(segMatch[1]) : undefined;
    if (method === 'GET' && seg === undefined) return okJson(listResponse());
    if (method === 'GET') { const f = db.find((r) => r.id === seg); if (!f) return { ok: false, status: 404, json: () => ({ error: 'not_found' }) }; return okJson({ ...f }); }
    if (method === 'POST') {
      const b: any = typeof (init as any)?.body === 'string' ? (() => { try { return JSON.parse((init as any).body); } catch { return {}; } })() : ((init as any)?.body ?? {});
      const row: PRow = { id: `p-new-${++seq}`, name: String(b.name ?? ''), baseUrl: String(b.baseUrl ?? ''), model: String(b.model ?? ''), apiKey: typeof b.apiKey === 'string' && b.apiKey.trim() ? b.apiKey.trim() : null, protocol: b.protocol === 'anthropic' ? 'anthropic' : 'openai', isActive: db.length === 0 };
      if (row.isActive) db.forEach((r) => (r.isActive = false));
      db.push(row);
      return okJson({ ...row });
    }
    if (method === 'PATCH') {
      const target = db.find((r) => r.id === seg);
      if (!target) return { ok: false, status: 404, json: () => ({ error: 'not_found' }) };
      const b: any = typeof (init as any)?.body === 'string' ? (() => { try { return JSON.parse((init as any).body); } catch { return {}; } })() : ((init as any)?.body ?? {});
      if ('name' in b) target.name = String(b.name);
      if ('baseUrl' in b) target.baseUrl = String(b.baseUrl);
      if ('model' in b) target.model = String(b.model);
      if ('protocol' in b) target.protocol = String(b.protocol);
      if ('apiKey' in b) target.apiKey = typeof b.apiKey === 'string' && b.apiKey.trim() ? b.apiKey.trim() : null;
      if ('isActive' in b) { target.isActive = Boolean(b.isActive); if (target.isActive) db.forEach((r) => { if (r !== target) r.isActive = false; }); }
      return okJson({ ...target });
    }
    if (method === 'DELETE') {
      const idx = db.findIndex((r) => r.id === seg);
      if (idx < 0) return { ok: false, status: 404, json: () => ({ error: 'not_found' }) };
      const wasActive = db[idx].isActive;
      db.splice(idx, 1);
      if (wasActive && db.length > 0) { let lowest: string | undefined; for (const r of db) if (!lowest || r.id < lowest) lowest = r.id; if (lowest) { const p = db.find((r) => r.id === lowest)!; db.forEach((r) => (r.isActive = false)); p.isActive = true; } }
      return okJson({ deleted: true });
    }
    return { ok: false, status: 405, json: () => ({ error: 'method_not_allowed' }) };
  };
}

/* ==========================================================================
 * TIER 1 — pure-function checks against the exported helpers (zero DOM).
 * ======================================================================== */
test('SETTINGS_SECTIONS registers the "API Providers" section first', async () => {
  assert.ok(Array.isArray(M.SETTINGS_SECTIONS), 'SETTINGS_SECTIONS is an array');
  assert.ok(M.SETTINGS_SECTIONS.some((s: any) => s.label === 'API Providers'), 'has an API Providers entry');
  assert.equal(M.SETTINGS_SECTIONS[0].label, 'API Providers', 'the first section is API Providers');
});

test('validateClientSide: empty/whitespace-only required fields yield ok:false with populated errors', async () => {
  // Fully-empty input flags name + baseUrl (model is now optional, so it is not flagged).
  const none = M.validateClientSide({});
  assert.equal(none.ok, false);
  assert.match(String(none.errors.name), /required/i);
  assert.match(String(none.errors.baseUrl), /required/i);
  assert.equal(none.errors.model, undefined, 'a blank model is no longer required');
  // Whitespace-only still fails each required field it omits.
  const wsOnlyName = M.validateClientSide({ name: '   ', baseUrl: 'https://x/v1', model: 'm' });
  assert.equal(wsOnlyName.ok, false);
  assert.equal(wsOnlyName.errors.name !== undefined, true, 'blank name flagged');
  assert.equal(wsOnlyName.errors.baseUrl, undefined, 'valid base-url not flagged');
});

test('validateClientSide: fully-valid input yields ok:true with no errors', async () => {
  const good = M.validateClientSide({ name: 'Local OpenAI', baseUrl: 'http://127.0.0.1:1234/v1', model: 'gpt-4o-mini' });
  assert.equal(good.ok, true);
  assert.deepEqual(good.errors, {});
  const trimmed = M.validateClientSide({ name: '  Pad  ', baseUrl: ' https://h/v1 ', model: ' m ' });
  assert.equal(trimmed.ok, true, 'surrounding whitespace tolerated after trim');
});

test('formatProviderRow masks raw keys and reflects apiKeySet accurately', async () => {
  const withKey = M.formatProviderRow({ id: 'a', name: 'Alpha', baseUrl: 'http://a/v1', model: 'alpha', protocol: 'anthropic', apiKey: 'RAWSECRET-do-not-leak', apiKeySet: true, isActive: true });
  assert.equal(withKey.keySet, true, 'apiKeySet true -> keySet true');
  assert.equal(withKey.active, true, 'isActive mirrored to active flag');
  assert.doesNotMatch(JSON.stringify(withKey), /RAWSECRET/, 'raw key never appears in display projection');
  assert.ok(!('apiKey' in withKey), 'no raw apiKey field in the display data');

  const withoutKey = M.formatProviderRow({ id: 'b', name: 'Beta', baseUrl: 'http://b/v1', model: 'beta', protocol: 'openai', apiKey: 'OTHER-secret', apiKeySet: false, isActive: false });
  assert.equal(withoutKey.keySet, false, 'apiKeySet false -> keySet false');
  assert.equal(withoutKey.active, false, 'non-active row mirrored as inactive');
  assert.doesNotMatch(JSON.stringify(withoutKey), /OTHER-secret/, 'raw key still hidden when apiKeySet is false');
  assert.match(withoutKey.protocolLabel, /OpenAI/i, 'protocol label derives from openai default');
});

/* ==========================================================================
 * TIER 2 — mount-level DOM behaviour through the injected fetchImpl.
 * Driven as one DETERMINISTIC SEQUENTIAL SCENARIO (like the suite's e2e specs): initSettings runs
 * once per file-process, so module-local state persists; running the full user journey in a single
 * ordered test makes every step reproducible by construction. Each phase asserts the exact network
 * calls it produced by diffing recorded call counts, so phases stay mutually isolated.
 * ======================================================================== */
// Collect an element's entire subtree (the module nests chips/buttons inside per-row aux spans).
function descendants(row: FakeEl): FakeEl[] {
  const out: FakeEl[] = [];
  const walk = (n: FakeEl | null): void => { if (!n) return; for (const c of n.children) { out.push(c); walk(c); } };
  walk(row);
  return out;
}
// Clear only the observable form/error/list state between phases, preserving module-internal variables.
function resetMountFixture(): void {
  S.byId('prov-list')!.children.length = 0;
  ['pf-name', 'pf-base-url', 'pf-model', 'pf-api-key'].forEach((id) => { S.byId(id)!.value = ''; });
  S.byId('pf-error')!.hidden = true; S.byId('pf-error')!.textContent = '';
  S.byId('prov-error')!.hidden = true; S.byId('prov-error')!.textContent = '';
  S.byId('prov-status')!.hidden = true; S.byId('prov-status')!.textContent = '';
}
// True when the given providers sub-view carries the .is-hidden class (the list/form view toggle).
const isHidden = (id: string): boolean => S.byId(id)!.classList.contains('is-hidden');

test('M1-M7 settings providers pane end-to-end: render -> draft -> validation gate -> create -> activate -> delete -> escape', async () => {
  const hasCls = (n: FakeEl | undefined, cls: string): boolean => n !== undefined && String(n.className ?? '').split(/\s+/).includes(cls);
  const checkedRows = (): number => S.byId('prov-list')!.children.filter((row) => row.children.some((c) => c.type === 'radio' && c.checked)).length;

  /* Phase A: initial authoritative list render reflects the seeded fixture exactly. */
  resetDb(seedRows());
  respond = defaultResponder();
  resetMountFixture();
  await ensureOpenProvidersPane();
  const listEl = S.byId('prov-list')!;
  assert.equal(listEl.children.length, 3, 'one card per seeded provider');
  assert.deepEqual(
    listEl.children.map((c) => c.getAttribute?.('data-provider-id')),
    seedRows().map((r) => r.id),
    'rows rendered in insertion order',
  );
  assert.ok(listEl.children.every((row) => row.children.some((c) => c.type === 'radio')), 'every row carries a radio control');
  assert.equal(checkedRows(), 1, 'exactly ONE radio is checked client-side after the authoritative render');
  assert.equal(findRowRadio('prov-3')!.checked, true, 'only the activeId row renders its radio checked');
  assert.equal(findRowRadio('prov-1')!.checked, false, 'non-active rows keep their radios unchecked');
  assert.equal(findRowRadio('prov-2')!.checked, false);
  const keyDots = listEl.children.map((row) => hasCls(descendants(row).find((c) => hasCls(c, 'key-dot')), 'is-set'));
  assert.deepEqual(keyDots, [true, false, false], 'the key-status dot shows only where apiKeySet is true (raw keys never leak into display)');
  assert.ok(!calls.some((c) => c.method !== 'GET'), 'rendering issues no mutating request');
  assert.equal(isHidden('prov-list-view'), false, 'initial render shows the LIST sub-view by default');
  assert.equal(isHidden('prov-form-view'), true, 'the FORM sub-view is hidden on initial render');

  /* Phase B: "+ Add Provider" enters unsaved-draft mode without any outbound fetch. */
  S.byId('pf-cancel')!.emit('click'); await flush(); // discard dirty editor state; deterministic clean slate for the draft
  resetMountFixture();                               // clear form values + error banners only (module state preserved)
  const Lb = calls.length;
  fireOn(S.byId('prov-add-btn')!, 'click');
  await flush();
  assert.equal(S.byId('prov-editor-title')!.textContent, 'New provider', 'editor title reflects an unsaved draft');
  assert.equal(S.byId('pf-reset')!.hidden, true, 'reset-to-saved stays hidden while authoring a brand-new draft');
  assert.equal(S.byId('pf-name')!.value, '', 'draft form starts cleared');
  assert.equal(calls.length, Lb, 'opening the draft editor fires ZERO fetch calls');
  assert.equal(isHidden('prov-form-view'), false, '"+ Add" shows the FORM sub-view (new mode)');
  assert.equal(isHidden('prov-list-view'), true, '"+ Add" hides the LIST sub-view');

  /* Phase C: invalid field values + Save surfaces an inline error and reaches zero network activity. */
  S.byId('pf-name')!.value = ''; // empty name fails validation
  S.byId('pf-base-url')!.value = '   '; // whitespace-only base URL fails
  S.byId('pf-model')!.value = 'alpha-model';
  const beforeInvalidSubmit = calls.length;
  fireOn(S.byId('prov-form')!, 'submit');
  await flush();
  const formErr = S.byId('pf-error')!;
  assert.equal(formErr.hidden, false, 'inline form error becomes visible on failed validation');
  assert.match(String(formErr.textContent), /required/i, 'error message surfaces the client-side validation gate failure');
  assert.equal(calls.length, beforeInvalidSubmit, 'validation gates submission: exactly zero new requests after failing fields');
  assert.equal(isHidden('prov-form-view'), false, 'failed validation stays on the FORM sub-view');
  assert.equal(isHidden('prov-list-view'), true, 'failed validation does not switch to the LIST sub-view');

  /* Phase D: valid save issues EXACTLY one POST with the documented body, flips edit-state onto the returned id, then reloads via GET. */
  S.byId('pf-cancel')!.emit('click'); // discard any dirty editor state so we cleanly create fresh
  await flush();
  S.byId('prov-add-btn')!.click(); await flush();
  S.byId('pf-name')!.value = 'Local Engine';
  S.byId('pf-base-url')!.value = 'http://localhost:9000/v1';
  S.byId('pf-model')!.value = 'gpt-4o-mini';
  S.byId('pf-api-key')!.value = 'sk-fresh-KEY';
  (S.byId('pf-protocol') as any).value = 'openai';
  const L0 = calls.length;
  fireOn(S.byId('prov-form')!, 'submit');
  await flush();
  const postCalls = calls.slice(L0);
  assert.equal(postCalls.length, 2, 'a successful save yields exactly two requests (one write + one authoritative reload)');
  assert.equal(postCalls[0].method, 'POST', 'the create request uses POST');
  assert.equal(postCalls[0].url, 'api/api-providers', 'create targets the collection base path (not a detail url)');
  assert.deepEqual(
    postCalls[0].body,
    { name: 'Local Engine', baseUrl: 'http://localhost:9000/v1', model: 'gpt-4o-mini', apiKey: 'sk-fresh-KEY', protocol: 'openai' },
    'request body char-shape matches the REST contract precisely',
  );
  assert.equal(postCalls[1].method, 'GET', 'an authoritative full-list reload follows immediately');
  assert.equal(postCalls[1].url, 'api/api-providers');
  assert.equal(S.byId('pf-reset')!.hidden, false, 'edit state now tracks an existing saved record (reset-to-saved revealed)');
  assert.match(String(S.byId('prov-editor-title')!.textContent), /^Edit /, 'title reflects editing the just-created provider');
  assert.equal(isHidden('prov-form-view'), true, 'a successful save returns to the LIST sub-view');
  assert.equal(isHidden('prov-list-view'), false, 'the LIST sub-view is shown after a successful save');

  /* Phase D2: clicking an existing row BODY opens the FORM sub-view in EDIT mode, prefilled via GET :id.
     The list is intentionally left rendered here (no list reset) so an existing row can be clicked;
     loadEditorFor re-populates the form, overwriting any values left behind by the Phase D create. */
  const editRow = listEl.children.find((row) => row.getAttribute?.('data-provider-id') === 'prov-1')!;
  const infoCell = editRow.children.find((c) => c.className === 'provider-info') as FakeEl | undefined;
  assert.ok(infoCell !== undefined, 'each row renders an info cell; clicking it (not the radio/delete) opens the editor');
  const Ld2 = calls.length;
  fireOn(S.byId('prov-list')!, 'click', { target: infoCell });
  await flush();
  const editCalls = calls.slice(Ld2);
  assert.equal(editCalls.length, 1, 'opening the editor for an existing provider issues exactly one request (no create/update)');
  assert.equal(editCalls[0].method, 'GET', 'edit prefill uses the GET detail endpoint (full record incl raw key)');
  assert.equal(editCalls[0].url, 'api/api-providers/prov-1', 'GET targets the specific provider id');
  assert.equal(S.byId('pf-name')!.value, 'Beta Engine', 'name prefilled from the saved record');
  assert.equal(S.byId('pf-base-url')!.value, 'http://beta.local/v1', 'base URL prefilled from the saved record');
  assert.equal(S.byId('pf-model')!.value, 'beta-model', 'model prefilled from the saved record');
  assert.equal((S.byId('pf-protocol') as any).value, 'anthropic', 'protocol prefilled from the saved record');
  assert.equal(S.byId('pf-api-key')!.value, '', 'a provider with no stored key leaves the key field blank');
  assert.equal(S.byId('pf-reset')!.hidden, false, 'edit mode reveals reset-to-saved for the existing record');
  assert.match(String(S.byId('prov-editor-title')!.textContent), /^Edit /, 'title reflects editing the existing provider');
  assert.equal(isHidden('prov-form-view'), false, 'clicking an existing row body shows the FORM sub-view (edit mode)');
  assert.equal(isHidden('prov-list-view'), true, 'clicking an existing row body hides the LIST sub-view');

  /* Phase E: selecting a non-active radio emits EXACTLY one PATCH {isActive:true} before re-rendering from a fresh GET. */
  S.byId('pf-cancel')!.emit('click'); await flush(); // return to the LIST sub-view before selecting a radio
  const targetId = 'prov-2';
  const targetRadio = findRowRadio(targetId)!;
  targetRadio.checked = true; // simulate native radio selection on the user's click
  const L1 = calls.length;
  fireOn(S.byId('prov-list')!, 'change', { target: targetRadio });
  await flush();
  const patchCalls = calls.slice(L1);
  assert.equal(patchCalls.length, 2, 'radio activation issues one PATCH then one authoritative reload — nothing else');
  assert.equal(patchCalls[0].method, 'PATCH', 'activation uses PATCH');
  assert.equal(patchCalls[0].url, `api/api-providers/${targetId}`, 'PATCH targets that specific id');
  assert.deepEqual(patchCalls[0].body, { isActive: true }, 'payload is EXACTLY {isActive:true} for that id');
  assert.equal(patchCalls[1].method, 'GET', 'authoritative reload follows in-order, not debounced/delayed');
  assert.equal(patchCalls[1].url, 'api/api-providers');
  assert.equal(findRowRadio(targetId)!.checked, true, 'selected row stays active after re-render');
  assert.equal(findRowRadio('prov-3')!.checked, false, 'previously-active row flipped off by the server-cleared reload');
  assert.equal(checkedRows(), 1, 'still exactly ONE radio checked client-side after activate + reload');
  assert.equal(isHidden('prov-list-view'), false, 'radio activation keeps the LIST sub-view visible');
  assert.equal(isHidden('prov-form-view'), true, 'radio activation does not switch to the FORM sub-view');

  /* Phase F: */
  respond = (url: string, init?: any): Resp => {
    if ((init?.method ?? 'GET') === 'DELETE') {
      db.splice(db.findIndex((r) => r.id === 'prov-3'), 1);   // delete the seeded active row (prov-3)
      db.forEach((r) => (r.isActive = false));                 // backend clears all actives…
      const promo = db.find((r) => r.id === 'prov-2')!;       // …then promotes an intentionally NON-lowest survivor ('prov-2')
      promo.isActive = true;                                    // to prove the client trusts the authoritative response rather than guessing its own rule
      return okJson({ deleted: true });
    }
    return defaultResponder()(url, init);
  };
  S.byId('pf-cancel')!.emit('click'); await flush(); // discard dirty editor state so deletion proceeds unobstructed
  const delRow = listEl.children.find((row) => row.getAttribute?.('data-provider-id') === 'prov-3')!;
  const delBtn = descendants(delRow).find((n) => n.className === 'btn-ghost prov-del') as FakeEl | undefined;
  assert.ok(delBtn !== undefined, 'the active provider row renders a delete button');
  const L2 = calls.length;
  const rowsBeforeDelete = listEl.children.length; // baseline for the relative check below (robust to providers created in Phase D)
  fireOn(S.byId('prov-list')!, 'click', { target: delBtn }); // delegated delete handler
  await flush();
  const deleteCalls = calls.slice(L2);
  assert.equal(deleteCalls.filter((c) => c.method === 'DELETE').length, 1, 'exactly one DELETE issued for the removal');
  assert.ok(deleteCalls.some((c) => c.method === 'GET'), 'list is refreshed authoritatively after the delete');
  assert.doesNotThrow(() => { void findRowRadio('prov-3'); }, 'no crash accessing post-delete rows');
  assert.equal(findRowRadio('prov-2')!.checked, true, 'client faithfully mirrors the server-authoritative promoted id regardless of which one was chosen');
  assert.equal(checkedRows(), 1, 'exactly one active radio remains after promotion');
  assert.equal(listEl.children.length, rowsBeforeDelete - 1, 'the deleted row disappears in the fresh reload (row count drops by exactly one)');
  assert.equal(isHidden('prov-list-view'), false, 'deletion keeps the LIST sub-view visible');
  assert.equal(isHidden('prov-form-view'), true, 'deletion does not switch to the FORM sub-view');

  /* Phase G: Escape keydown closes the settings overlay when it is open. */
  respond = defaultResponder();
  resetMountFixture();
  S.byId('settings-close')!.emit('click'); await flush();
  S.byId('open-settings')!.emit('click'); await flush();
  const modalRoots: FakeEl[] = [S.byId('__tpl_0')!, S.byId('__tpl_1')!].filter((r) => r && r.classList.contains('is-open'));
  assert.equal(modalRoots.length, 1, 'exactly one template root carries is-open while the overlay is open');
  const backdrop = modalRoots[0];
  assert.equal(backdrop.hidden, false, 'overlay visible while settings is open');
  (S as any)._emitDoc?.('keydown', { key: 'Escape' });
  assert.equal(backdrop.hidden, true, 'Escape hides the overlay via closeSettings');
  assert.equal(backdrop.classList.contains('is-open'), false, 'is-open class removed by closeSettings');
  (S as any)._emitDoc?.('keydown', { key: 'Escape' }); // double-close stays safely closed (openFlag now false)
  assert.equal(backdrop.hidden, true, 'a second Escape leaves the overlay still hidden without error');
});

