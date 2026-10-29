/**
 * Coverage for the provider TYPE select in dashboard/js/settings-providers.mjs:
 * the protocol select is gone, copilot rows hide the generic inputs, device rows never
 * expose a key in the form, the model select is filled from the id-based probe on open,
 * and generic drafts probe with the protocol mapped from the selected type.
 *
 * DOM-stubbed like tests/dashboard-device-flow.test.ts: an injected fetchImpl serves the
 * /api/api-providers contract, async work is awaited via microtask flushing, and the
 * setTimeout used by the debounced auto-probe is captured (never real).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createDomStub, DomStub, FakeEl } from './dom-stub';

const base = '../..' + '/dashboard';

type Resp = { ok: boolean; status: number; json: () => any };
interface Call { url: string; method: string; body?: any }
interface Timer { fn: () => void; ms: number; handle: number }

const S: DomStub = createDomStub();

// Overlay + provider-pane nodes resolved by $(id) inside initSettings / the pane.
S.el('open-settings', 'button');
S.el('settings-dialog', 'div');
S.el('settings-close', 'button');
S.el('settings-rail', 'ul');
S.el('settings-panel', 'main');
['prov-add-btn', 'pf-cancel', 'pf-reset', 'pf-key-toggle', 'pf-save', 'pf-test', 'pf-copilot-login'].forEach((id) => S.el(id, 'button'));
S.el('prov-list', 'ul');
['prov-editor-title', 'pf-error', 'pf-test-result', 'prov-status', 'prov-empty', 'prov-error', 'prov-editor',
  'pf-base-url-field', 'pf-api-key-field', 'pf-copilot', 'pf-copilot-device', 'pf-copilot-status', 'pf-copilot-auth'].forEach((id) => S.el(id, 'div'));
S.el('prov-form', 'form');
['pf-name', 'pf-base-url', 'pf-api-key', 'pf-copilot-code'].forEach((id) => S.el(id, 'input'));
S.el('pf-model', 'select');
S.el('pf-type', 'select');
S.el('pf-copilot-link', 'a');
['prov-list-view', 'prov-form-view'].forEach((id) => S.el(id, 'section'));

let M: any;
let calls: Call[] = [];
let db: any[] = [];
let timers: Timer[] = [];
let nextHandle = 1;
let templates: string[] = [];

const COPILOT_ROW = {
  id: 'p-cop', name: 'Copilot Work', baseUrl: 'https://github.com', model: null,
  protocol: 'openai', adapterId: 'copilot', authType: 'deviceOAuth', isActive: false, apiKeySet: false,
};
const GENERIC_ROW = {
  id: 'p-gen', name: 'Local OpenAI', baseUrl: 'http://local.example/v1', model: 'saved-model',
  protocol: 'openai', adapterId: 'generic-openai', authType: 'apiKey', isActive: false, apiKeySet: true,
};

function ok(body: unknown): Resp { return { ok: true, status: 200, json: () => body }; }

function responder(url: string, init?: any): Resp {
  const method = init?.method ?? 'GET';
  if (url === 'api/api-providers/probe') {
    const body = JSON.parse(String(init.body));
    if (body.id === 'p-gen' || body.id === 'p-cop') return ok({ ok: true, latencyMs: 3, models: ['gpt-a', 'gpt-b'] });
    return ok({ ok: true, latencyMs: 3, models: ['claude-x'] });
  }
  if (url === 'api/api-providers' && method === 'GET') {
    return ok({ providers: db.map(({ apiKey, ...rest }) => rest), activeId: null });
  }
  const m = /^api\/api-providers\/([^/]+)$/.exec(url);
  if (m && method === 'GET') {
    const row = db.find((r) => r.id === m[1]);
    // The server may return a value for a device row; the form must still ignore it.
    if (row) return ok(row.id === 'p-cop' ? { ...row, apiKey: 'gho_LEAK_TOKEN' } : row);
  }
  return { ok: false, status: 404, json: () => ({ error: 'not_found' }) };
}

function fetchImpl(this: unknown, url: string, init?: any): Promise<Resp> {
  const rec: Call = { url: String(url), method: init?.method ?? 'GET' };
  if (typeof init?.body === 'string') { try { rec.body = JSON.parse(init.body); } catch { rec.body = init.body; } }
  calls.push(rec);
  return Promise.resolve(responder(String(url), init));
}

// Microtask drain for async handler chains — purely promise-based, no timers/sleeps.
async function flush(): Promise<void> { let p: Promise<unknown> = Promise.resolve(); for (let i = 0; i < 64; i += 1) p = p.then(() => undefined); await p; }

function byId(id: string): any {
  const n = S.byId(id);
  if (!n) throw new Error('missing stub element #' + id);
  return n;
}

// Dispatch the listeners registered on a node with an explicit event payload (ev.target).
function fireOn(node: any, type: string, ev: Record<string, unknown>): void {
  (node._listeners[type] || []).slice().forEach((fn: (e: unknown) => void) => fn.call(node, ev));
}

const realSetTimeout = (globalThis as any).setTimeout;
const realClearTimeout = (globalThis as any).clearTimeout;

before(async () => {
  (FakeEl.prototype as any).focus = function focus() { /* no-op */ };
  (FakeEl.prototype as any).scrollIntoView = function scrollIntoView() { /* no-op */ };
  (FakeEl.prototype as any).closest = function closest(sel: string): FakeEl | null {
    let n: any = this;
    while (n) {
      if (sel.startsWith('.')) { const cls = sel.slice(1); if (String(n.className ?? '').split(/\s+/).includes(cls)) return n; }
      n = n.parentNode || null;
    }
    return null;
  };
  let tplSeq = 0;
  S.document.createElement = (tag: string): any => {
    if (tag === 'template') {
      const root = S.el('__tpl_' + tplSeq++, 'div');
      const tpl: any = { content: { firstElementChild: root } };
      // Capture the markup each pane/modal template is built from, so the static
      // option list of the type select can be asserted.
      Object.defineProperty(tpl, 'innerHTML', {
        get: () => '',
        set: (v: unknown) => { templates.push(String(v)); },
      });
      return tpl;
    }
    return S.createElement(tag);
  };
  (S.document as any).addEventListener = () => { /* keydown wiring is not exercised here */ };
  (globalThis as any).setTimeout = (fn: () => void, ms: number) => {
    const handle = nextHandle++;
    timers.push({ fn, ms, handle });
    return handle;
  };
  (globalThis as any).clearTimeout = (handle: number) => {
    timers = timers.filter((t) => t.handle !== handle);
  };

  M = await import(base + '/js/settings.mjs');
  M.initSettings({ fetchImpl: fetchImpl });
});

after(() => {
  (globalThis as any).setTimeout = realSetTimeout;
  (globalThis as any).clearTimeout = realClearTimeout;
});

// Fresh state per test; opens the API Providers section (list GET) and returns to the list view.
async function setup(rows: any[]): Promise<void> {
  calls = [];
  db = rows.map((r) => ({ ...r }));
  timers = [];
  const rail = byId('settings-rail');
  const btn = rail.children.map((li: any) => li.children[0]).find((b: any) => b.getAttribute('data-section-id') === 'apiProviders');
  btn.click();
  await flush();
  byId('pf-cancel').click();
  await flush();
  calls = [];
}

// Clicks the info cell of a list row (the row body loads the editor).
async function openRow(id: string): Promise<void> {
  const li = byId('prov-list').children.find((row: any) => row.getAttribute('data-provider-id') === id);
  if (!li) throw new Error('missing list row ' + id);
  fireOn(byId('prov-list'), 'click', { target: li.children[1] });
  await flush();
}

function optionValues(sel: any): string[] {
  return sel.children.map((o: any) => String(o.value));
}

test('type select offers the three provider types and no protocol select', async () => {
  await setup([]);
  byId('prov-add-btn').click();
  await flush();

  const html = templates.find((h) => h.includes('id="pf-type"')) ?? '';
  assert.ok(html.length > 0, 'pane markup includes the type select');
  const select = html.match(/<select id="pf-type">([\s\S]*?)<\/select>/);
  assert.ok(select, 'type select is present');
  const options = [...select![1].matchAll(/<option value="([^"]+)">([^<]+)<\/option>/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(options, [
    ['generic-openai', 'OpenAI-compatible'],
    ['generic-anthropic', 'Anthropic'],
    ['copilot', 'GitHub Copilot'],
  ]);
  assert.equal(/pf-protocol/.test(html), false, 'no protocol select markup remains');
  assert.equal(byId('pf-type').value, 'generic-openai', 'a fresh draft defaults to OpenAI-compatible');
});

test('copilot draft hides base URL, API key and save/test, and shows the login action', async () => {
  await setup([]);
  byId('prov-add-btn').click();
  await flush();
  byId('pf-type').value = 'copilot';
  byId('pf-type').emit('change');
  await flush();

  assert.equal(byId('pf-base-url-field').hidden, true, 'no Base URL for copilot');
  assert.equal(byId('pf-api-key-field').hidden, true, 'no API key for copilot');
  assert.equal(byId('pf-save').hidden, true);
  assert.equal(byId('pf-test').hidden, true);
  assert.equal(byId('pf-copilot').hidden, false, 'login section is shown');
  assert.equal(byId('pf-copilot-login').textContent, 'Login with GitHub Copilot', 'a draft is not labelled re-login');
});

test('populating a copilot row never fills the API key, even when the server returns one', async () => {
  await setup([COPILOT_ROW]);
  await openRow('p-cop');

  assert.equal(byId('pf-type').value, 'copilot', 'type select follows adapterId');
  assert.equal(byId('pf-api-key').value, '', 'device row leaves the key input empty');
  assert.equal(byId('pf-base-url-field').hidden, true);
  assert.equal(byId('pf-api-key-field').hidden, true);
  assert.equal(byId('pf-copilot-auth').hidden, false, 'login status is shown');
  assert.equal(byId('pf-copilot-login').textContent, 'Re-login with GitHub Copilot');
  const text = [byId('pf-api-key').value, byId('pf-copilot-auth').textContent, byId('pf-model').value].join(' ');
  assert.equal(text.includes('gho_LEAK_TOKEN'), false);
});

test('opening a saved row probes by id and fills the model select', async () => {
  await setup([GENERIC_ROW]);
  await openRow('p-gen');

  const probes = calls.filter((c) => c.url === 'api/api-providers/probe');
  assert.equal(probes.length, 1, 'one probe on open');
  assert.deepEqual(probes[0].body, { id: 'p-gen' }, 'saved rows probe by id only');
  assert.deepEqual(optionValues(byId('pf-model')), ['', 'gpt-a', 'gpt-b', 'saved-model'], 'From Request, probed models, and the saved model');
  assert.equal(byId('pf-model').value, 'saved-model', 'saved model stays selected');
  assert.equal(byId('pf-type').value, 'generic-openai');
});

test('generic draft test probes inline with the protocol mapped from the type, keeping the name', async () => {
  await setup([]);
  byId('prov-add-btn').click();
  await flush();
  byId('pf-name').value = 'Draft Engine';
  byId('pf-base-url').value = 'http://anth.example/v1';
  byId('pf-type').value = 'generic-anthropic';
  byId('pf-type').emit('change');
  await flush();
  assert.equal(byId('pf-name').value, 'Draft Engine', 'changing the type keeps the name');

  calls = [];
  byId('pf-test').click();
  await flush();
  const anthropicProbe = calls.find((c) => c.url === 'api/api-providers/probe');
  assert.deepEqual(anthropicProbe?.body, { protocol: 'anthropic', baseUrl: 'http://anth.example/v1', apiKey: null });

  byId('pf-type').value = 'generic-openai';
  byId('pf-type').emit('change');
  await flush();
  calls = [];
  byId('pf-test').click();
  await flush();
  const openaiProbe = calls.find((c) => c.url === 'api/api-providers/probe');
  assert.deepEqual(openaiProbe?.body, { protocol: 'openai', baseUrl: 'http://anth.example/v1', apiKey: null });
});
