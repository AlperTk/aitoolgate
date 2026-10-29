/**
 * Coverage for the GitHub Copilot device-login UI in dashboard/js/settings-providers.mjs
 * (adapter selector, login action, poll loop, provider list refresh).
 *
 * DOM-stubbed like tests/dashboard-settings-modal.test.ts: an injected fetchImpl serves
 * the /api/api-providers contract, async completion is awaited via microtask flushing,
 * and the poll loop's setTimeout is captured (never real) so each tick is driven by the test.
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
  'pf-adapter-field', 'pf-base-url-field', 'pf-api-key-field', 'pf-copilot', 'pf-copilot-device', 'pf-copilot-status'].forEach((id) => S.el(id, 'div'));
S.el('prov-form', 'form');
['pf-name', 'pf-base-url', 'pf-model', 'pf-api-key', 'pf-copilot-code'].forEach((id) => S.el(id, 'input'));
S.el('pf-type', 'select');
S.el('pf-copilot-link', 'a');
['prov-list-view', 'prov-form-view'].forEach((id) => S.el(id, 'section'));

let M: any;
let calls: Call[] = [];
let db: any[] = [];
let timers: Timer[] = [];
let nextHandle = 1;
let pollQueue: Array<() => Resp> = [];
const START_BODY = { flowId: 'flow-1', userCode: 'ABCD-EFGH', verificationUri: 'https://github.com/login/device', interval: 5, expiresIn: 900 };

function ok(body: unknown): Resp { return { ok: true, status: 200, json: () => body }; }
function httpErr(status: number, body: unknown): Resp { return { ok: false, status, json: () => body }; }

function responder(url: string, init?: any): Resp {
  if (url === 'api/api-providers/device-flow/start') return ok(START_BODY);
  if (url === 'api/api-providers/device-flow/poll') {
    const next = pollQueue.shift();
    return next ? next() : httpErr(404, { error: 'not_found' });
  }
  if (url === 'api/api-providers' && (!init || !init.method || init.method === 'GET')) {
    return ok({ providers: db.slice(), activeId: db.find((p) => p.isActive)?.id ?? null });
  }
  return httpErr(404, { error: 'not_found' });
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

// Run the single pending poll timer (the only timer the device flow schedules).
function runTimer(): void {
  const t = timers.shift();
  if (!t) throw new Error('no poll timer pending');
  t.fn();
}

// Concatenate the text/value/href of every provider-pane node a user could read.
const PANE_IDS = [
  'prov-list', 'prov-status', 'prov-error', 'prov-empty', 'prov-editor-title', 'pf-error', 'pf-test-result',
  'pf-name', 'pf-base-url', 'pf-api-key', 'pf-copilot-code', 'pf-copilot-link', 'pf-copilot-status', 'pf-copilot-device',
];
function visibleText(): string {
  let out = '';
  PANE_IDS.forEach((id) => {
    const node: any = S.byId(id);
    if (!node) return;
    out += ' ' + String(node.textContent ?? '') + ' ' + String(node.value ?? '') + ' ' + String(node.href ?? '');
    (node.children || []).forEach((c: any) => { out += ' ' + String(c.textContent ?? '') + ' ' + String(c.value ?? ''); });
  });
  return out;
}

const realSetTimeout = (globalThis as any).setTimeout;
const realClearTimeout = (globalThis as any).clearTimeout;

before(async () => {
  (FakeEl.prototype as any).focus = function focus() { /* no-op */ };
  (FakeEl.prototype as any).scrollIntoView = function scrollIntoView() { /* no-op */ };
  (FakeEl.prototype as any).closest = function closest(): null { return null; };
  (FakeEl.prototype as any).querySelector = function querySelector(sel: string) {
    if (typeof sel === 'string' && sel === '#pf-protocol') return S.byId?.('pf-protocol') ?? null;
    return null;
  };
  let tplSeq = 0;
  S.document.createElement = (tag: string): any => {
    if (tag === 'template') {
      const root = S.el('__tpl_' + tplSeq++, 'div');
      return { _html: '', innerHTML: '', content: { firstElementChild: root } };
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
async function setup(): Promise<void> {
  calls = [];
  db = [];
  timers = [];
  pollQueue = [];
  const rail = byId('settings-rail');
  const btn = rail.children.map((li: any) => li.children[0]).find((b: any) => b.getAttribute('data-section-id') === 'apiProviders');
  btn.click();
  await flush();
  byId('pf-cancel').click();
  await flush();
  calls = [];
}

// Opens a new draft and selects the copilot adapter.
async function startCopilotDraft(): Promise<void> {
  byId('prov-add-btn').click();
  await flush();
  const sel = byId('pf-type');
  sel.value = 'copilot';
  sel.emit('change');
  await flush();
}

function doneEntry(): () => Resp {
  return () => {
    const row = {
      id: 'p-copilot', name: 'GitHub Copilot', baseUrl: 'https://github.com', model: null,
      protocol: 'openai', adapterId: 'copilot', isActive: true, apiKeySet: false,
    };
    db.push(row);
    // Defensive: even if a provider payload carried an access token, the UI must not render it.
    return ok({ status: 'done', provider: { ...row, authState: { accessToken: 'gho_SECRET_TOKEN' } } });
  };
}

test('adapter selector switches the add-provider form between generic and copilot fields', async () => {
  await setup();
  byId('prov-add-btn').click();
  await flush();
  assert.equal(byId('pf-type').value, 'generic-openai');
  assert.equal(byId('pf-base-url-field').hidden, false);
  assert.equal(byId('pf-api-key-field').hidden, false);
  assert.equal(byId('pf-copilot').hidden, true);
  assert.equal(byId('pf-save').hidden, false);

  byId('pf-type').value = 'copilot';
  byId('pf-type').emit('change');
  assert.equal(byId('pf-base-url-field').hidden, true);
  assert.equal(byId('pf-api-key-field').hidden, true);
  assert.equal(byId('pf-copilot').hidden, false);
  assert.equal(byId('pf-save').hidden, true);

  byId('pf-type').value = 'generic-openai';
  byId('pf-type').emit('change');
  assert.equal(byId('pf-base-url-field').hidden, false);
  assert.equal(byId('pf-copilot').hidden, true);
  assert.equal(byId('pf-save').hidden, false);
});

test('start renders the user code and verification link, and the login button is busy', async () => {
  await setup();
  await startCopilotDraft();
  byId('pf-copilot-login').click();
  await flush();

  assert.equal(calls.find((c) => c.url === 'api/api-providers/device-flow/start')?.method, 'POST');
  assert.equal(byId('pf-copilot-code').textContent, 'ABCD-EFGH');
  assert.equal(byId('pf-copilot-link').href, 'https://github.com/login/device');
  assert.equal(byId('pf-copilot-device').hidden, false);
  assert.equal(byId('pf-copilot-login').disabled, true);
  assert.equal(byId('pf-copilot-status').hidden, false);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 5000);
});

test('poll pending then done activates the provider and refreshes the list', async () => {
  await setup();
  await startCopilotDraft();
  byId('pf-copilot-login').click();
  await flush();

  pollQueue.push(() => ok({ status: 'pending', interval: 5 }));
  pollQueue.push(doneEntry());
  runTimer();
  await flush();
  assert.equal(timers.length, 1, 'pending keeps polling at the server interval');
  assert.equal(timers[0].ms, 5000);

  const listGetsBefore = calls.filter((c) => c.url === 'api/api-providers' && c.method === 'GET').length;
  runTimer();
  await flush();

  const polls = calls.filter((c) => c.url === 'api/api-providers/device-flow/poll');
  assert.equal(polls.length, 2);
  assert.deepEqual(polls[0].body, { flowId: 'flow-1' });
  assert.equal(timers.length, 0, 'done stops polling');
  const listGetsAfter = calls.filter((c) => c.url === 'api/api-providers' && c.method === 'GET').length;
  assert.equal(listGetsAfter, listGetsBefore + 1, 'provider list is refetched on done');
  assert.equal(byId('prov-list').children.length, 1);
  assert.equal(byId('prov-list').children[0].getAttribute('data-provider-id'), 'p-copilot');
  assert.equal(byId('prov-list-view').classList.contains('is-hidden'), false);
});

test('slow_down updates the poll interval', async () => {
  await setup();
  await startCopilotDraft();
  byId('pf-copilot-login').click();
  await flush();

  pollQueue.push(() => ok({ status: 'slow_down', interval: 10 }));
  runTimer();
  await flush();
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 10000);
});

test('denied stops polling and shows the denial message', async () => {
  await setup();
  await startCopilotDraft();
  byId('pf-copilot-login').click();
  await flush();

  pollQueue.push(() => ok({ status: 'denied' }));
  runTimer();
  await flush();

  assert.equal(timers.length, 0, 'denied is terminal');
  assert.equal(byId('pf-copilot-status').textContent, 'Access was denied on GitHub. Login cancelled.');
  assert.equal(byId('pf-copilot-status').hidden, false);
  assert.equal(byId('pf-copilot-login').disabled, false, 'login can be retried');
  assert.equal(calls.filter((c) => c.url === 'api/api-providers/device-flow/poll').length, 1);
});

test('expired stops polling and shows the expiry message', async () => {
  await setup();
  await startCopilotDraft();
  byId('pf-copilot-login').click();
  await flush();

  pollQueue.push(() => ok({ status: 'expired' }));
  runTimer();
  await flush();

  assert.equal(timers.length, 0);
  assert.match(byId('pf-copilot-status').textContent, /expired/);
});

test('no access token text appears anywhere in the DOM', async () => {
  await setup();
  await startCopilotDraft();
  byId('pf-copilot-login').click();
  await flush();

  pollQueue.push(doneEntry());
  runTimer();
  await flush();

  const text = visibleText();
  assert.equal(text.includes('gho_SECRET_TOKEN'), false);
  assert.equal(text.includes('authState'), false);
});
