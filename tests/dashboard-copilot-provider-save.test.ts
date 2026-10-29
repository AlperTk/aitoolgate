/**
 * Coverage for the Save action in the API Providers form (dashboard/js/settings-providers.mjs):
 * a saved GitHub Copilot row persists via PATCH without apiKey, the add flow never saves a
 * copilot provider on Save, and generic providers keep their existing create/update behavior.
 *
 * DOM-stubbed like tests/dashboard-device-flow.test.ts: injected fetchImpl, microtask flushing,
 * no timers. Rows are opened by invoking the list's delegated click listener with a row target.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createDomStub, DomStub, FakeEl } from './dom-stub';

const base = '../..' + '/dashboard';

type Resp = { ok: boolean; status: number; json: () => any };
interface Call { url: string; method: string; body?: any }

const S: DomStub = createDomStub();

S.el('open-settings', 'button');
S.el('settings-dialog', 'div');
S.el('settings-close', 'button');
S.el('settings-rail', 'ul');
S.el('settings-panel', 'main');
['prov-add-btn', 'pf-cancel', 'pf-reset', 'pf-key-toggle', 'pf-save', 'pf-test', 'pf-copilot-login', 'pf-copilot-confirm-btn'].forEach((id) => S.el(id, 'button'));
S.el('prov-list', 'ul');
['prov-editor-title', 'pf-error', 'pf-test-result', 'prov-status', 'prov-empty', 'prov-error', 'prov-editor',
  'pf-adapter-field', 'pf-base-url-field', 'pf-api-key-field', 'pf-copilot', 'pf-copilot-device', 'pf-copilot-status',
  'pf-copilot-confirm'].forEach((id) => S.el(id, 'div'));
S.el('prov-form', 'form');
['pf-name', 'pf-base-url', 'pf-model', 'pf-api-key', 'pf-copilot-code'].forEach((id) => S.el(id, 'input'));
S.el('pf-type', 'select');
S.el('pf-copilot-link', 'a');
['pf-copilot-success', 'pf-model-row'].forEach((id) => S.el(id, 'div'));
['prov-list-view', 'prov-form-view'].forEach((id) => S.el(id, 'section'));

let M: any;
let calls: Call[] = [];
let db: any[] = [];

function ok(body: unknown): Resp { return { ok: true, status: 200, json: () => body }; }
function httpErr(status: number, body: unknown): Resp { return { ok: false, status, json: () => body }; }

function copilotRow(): any {
  return {
    id: 'p-copilot', name: 'GitHub Copilot', baseUrl: 'https://api.githubcopilot.com', model: null,
    protocol: 'openai', adapterId: 'copilot', authType: 'deviceOAuth', isActive: true, apiKeySet: false,
  };
}

function responder(url: string, init?: any): Resp {
  const method = init?.method ?? 'GET';
  if (url === 'api/api-providers' && method === 'GET') {
    return ok({ providers: db.slice(), activeId: db.find((p) => p.isActive)?.id ?? null });
  }
  if (url === 'api/api-providers' && method === 'POST') {
    const created = { id: 'p-new', isActive: false, apiKeySet: !!init.body && JSON.parse(init.body).apiKey, ...JSON.parse(init.body) };
    db.push(created);
    return ok(created);
  }
  if (url === 'api/api-providers/probe') return ok({ ok: true, models: ['m1'], latencyMs: 3 });
  if (url.startsWith('api/api-providers/') && method === 'GET') {
    const id = decodeURIComponent(url.slice('api/api-providers/'.length));
    const row = db.find((p) => p.id === id);
    return row ? ok({ ...row, apiKey: null }) : httpErr(404, { error: 'not_found' });
  }
  if (url.startsWith('api/api-providers/') && method === 'PATCH') {
    const id = decodeURIComponent(url.slice('api/api-providers/'.length));
    const row = db.find((p) => p.id === id);
    if (!row) return httpErr(404, { error: 'not_found' });
    Object.assign(row, JSON.parse(init.body));
    return ok(row);
  }
  return httpErr(404, { error: 'not_found' });
}

function fetchImpl(url: string, init?: any): Promise<Resp> {
  const rec: Call = { url: String(url), method: init?.method ?? 'GET' };
  if (typeof init?.body === 'string') { try { rec.body = JSON.parse(init.body); } catch { rec.body = init.body; } }
  calls.push(rec);
  return Promise.resolve(responder(String(url), init));
}

async function flush(): Promise<void> { let p: Promise<unknown> = Promise.resolve(); for (let i = 0; i < 64; i += 1) p = p.then(() => undefined); await p; }

function byId(id: string): any {
  const n = S.byId(id);
  if (!n) throw new Error('missing stub element #' + id);
  return n;
}

// Submits the provider form the way the browser does (the module's submit listener).
function submitForm(): void {
  const form: any = byId('prov-form');
  (form._listeners.submit || []).forEach((fn: any) => fn({ preventDefault() { /* no-op */ } }));
}

// Opens a saved provider by invoking the list's delegated row-click listener (row body, not radio/delete).
function openRow(id: string): void {
  const list: any = byId('prov-list');
  const row: any = list.children.find((li: any) => li.getAttribute('data-provider-id') === id);
  if (!row) throw new Error('row not rendered: ' + id);
  const target = { tagName: 'LI', closest: (sel: string) => (sel === '.provider-row' ? row : null) };
  (list._listeners.click || []).forEach((fn: any) => fn({ target }));
}

function writesTo(url: string): Call[] {
  return calls.filter((c) => c.url === url && c.method !== 'GET');
}

before(async () => {
  (FakeEl.prototype as any).focus = function focus() { /* no-op */ };
  (FakeEl.prototype as any).scrollIntoView = function scrollIntoView() { /* no-op */ };
  (FakeEl.prototype as any).closest = function closest(): null { return null; };
  (FakeEl.prototype as any).querySelector = function querySelector(): null { return null; };
  let tplSeq = 0;
  S.document.createElement = (tag: string): any => {
    if (tag === 'template') {
      const root = S.el('__tpl_' + tplSeq++, 'div');
      return { _html: '', innerHTML: '', content: { firstElementChild: root } };
    }
    return S.createElement(tag);
  };
  (S.document as any).addEventListener = () => { /* keydown wiring is not exercised here */ };

  M = await import(base + '/js/settings.mjs');
  M.initSettings({ fetchImpl: fetchImpl });
});

after(() => { /* stubs are per-process; nothing to restore */ });

// Fresh state per test; opens the API Providers section and returns to the list view.
async function setup(rows: any[]): Promise<void> {
  calls = [];
  db = rows;
  const rail = byId('settings-rail');
  const btn = rail.children.map((li: any) => li.children[0]).find((b: any) => b.getAttribute('data-section-id') === 'apiProviders');
  btn.click();
  await flush();
  byId('pf-cancel').click();
  await flush();
  calls = [];
}

test('copilot edit: Save is visible and PATCH omits apiKey', async () => {
  await setup([copilotRow()]);
  openRow('p-copilot');
  await flush();
  assert.equal(byId('pf-save').hidden, false, 'Save is shown for a saved copilot row');
  assert.equal(byId('pf-api-key-field').hidden, true);

  byId('pf-name').value = 'Copilot work';
  byId('pf-model').value = 'gpt-4.1';
  calls = [];
  submitForm();
  await flush();

  const patches = writesTo('api/api-providers/p-copilot');
  assert.equal(patches.length, 1);
  assert.equal(patches[0].method, 'PATCH');
  assert.equal(Object.prototype.hasOwnProperty.call(patches[0].body, 'apiKey'), false, 'apiKey must not be sent for copilot');
  assert.equal(patches[0].body.name, 'Copilot work');
  assert.equal(patches[0].body.model, 'gpt-4.1');
  assert.equal(patches[0].body.adapterId, 'copilot');
  assert.equal(byId('pf-error').hidden, true, 'successful save shows no error');
  assert.equal(byId('prov-list-view').classList.contains('is-hidden'), false, 'returns to the list after saving');
});

test('copilot add: Save never persists a provider before login is confirmed', async () => {
  await setup([]);
  byId('prov-add-btn').click();
  await flush();
  byId('pf-type').value = 'copilot';
  byId('pf-type').emit('change');
  byId('pf-name').value = 'Copilot';
  calls = [];

  assert.equal(byId('pf-save').hidden, true, 'add-flow Save is hidden for copilot');
  submitForm();
  await flush();

  assert.equal(calls.filter((c) => c.method !== 'GET').length, 0, 'no write request without a pendingId');
});

test('copilot add: no model probe and the model select stays hidden before login', async () => {
  await setup([]);
  byId('prov-add-btn').click();
  await flush();
  byId('pf-type').value = 'copilot';
  byId('pf-type').emit('change');
  await flush();

  assert.equal(calls.filter((c) => c.url === 'api/api-providers/probe').length, 0, 'no probe before login succeeds');
  assert.equal(byId('pf-model-row').hidden, true, 'model select hidden until signed in');
});

test('generic create still POSTs with apiKey and the chosen model', async () => {
  await setup([]);
  byId('prov-add-btn').click();
  await flush();
  byId('pf-name').value = 'Local';
  byId('pf-base-url').value = 'https://llm.example/v1';
  byId('pf-api-key').value = 'sk-test';
  calls = [];
  submitForm();
  await flush();

  const posts = writesTo('api/api-providers');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].method, 'POST');
  assert.equal(posts[0].body.apiKey, 'sk-test');
  assert.equal(posts[0].body.model, null, 'From Request');
  assert.equal(posts[0].body.adapterId, 'generic-openai');
});

test('generic edit still PATCHes with apiKey', async () => {
  await setup([{
    id: 'p-gen', name: 'Local', baseUrl: 'https://llm.example/v1', model: null, protocol: 'openai',
    adapterId: 'generic-openai', isActive: true, apiKeySet: true,
  }]);
  openRow('p-gen');
  await flush();
  assert.equal(byId('pf-save').hidden, false);
  byId('pf-name').value = 'Local 2';
  calls = [];
  submitForm();
  await flush();

  const patches = writesTo('api/api-providers/p-gen');
  assert.equal(patches.length, 1);
  assert.equal(patches[0].method, 'PATCH');
  assert.equal(patches[0].body.name, 'Local 2');
  assert.ok('apiKey' in patches[0].body, 'generic PATCH carries apiKey as before');
});
