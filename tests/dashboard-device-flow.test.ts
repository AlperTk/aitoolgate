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
  'pf-adapter-field', 'pf-base-url-field', 'pf-api-key-field', 'pf-copilot', 'pf-copilot-device', 'pf-copilot-status',
  'pf-copilot-confirm'].forEach((id) => S.el(id, 'div'));
S.el('pf-copilot-confirm-btn', 'button');
S.el('pf-copilot-popup', 'div');
S.el('pf-copilot-popup-close', 'button');
S.el('pf-copilot-copy', 'button');
S.el('pf-copilot-copy-msg', 'span');
S.el('prov-form', 'form');
['pf-name', 'pf-base-url', 'pf-model', 'pf-api-key', 'pf-copilot-code'].forEach((id) => S.el(id, 'input'));
S.el('pf-type', 'select');
S.el('pf-copilot-link', 'a');
['pf-copilot-success', 'pf-model-row'].forEach((id) => S.el(id, 'div'));
['prov-list-view', 'prov-form-view'].forEach((id) => S.el(id, 'section'));

let M: any;
// Injected clipboard: the module reads globalThis.navigator.clipboard at click time.
let clipWrites: string[] = [];
let clipFail = false;
const realNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
let calls: Call[] = [];
let db: any[] = [];
let timers: Timer[] = [];
let probeNext: () => Resp = () => ok({ ok: true, models: ['gpt-4o', 'claude-3.5'], latencyMs: 2 });
let nextHandle = 1;
let pollQueue: Array<() => Resp> = [];
let confirmQueue: Array<(init?: any) => Resp> = [];
const START_BODY = { flowId: 'flow-1', userCode: 'ABCD-EFGH', verificationUri: 'https://github.com/login/device', interval: 5, expiresIn: 900 };

function ok(body: unknown): Resp { return { ok: true, status: 200, json: () => body }; }
function httpErr(status: number, body: unknown): Resp { return { ok: false, status, json: () => body }; }

function responder(url: string, init?: any): Resp {
  if (url === 'api/api-providers/device-flow/start') return ok(START_BODY);
  if (url === 'api/api-providers/device-flow/poll') {
    const next = pollQueue.shift();
    return next ? next() : httpErr(404, { error: 'not_found' });
  }
  if (url === 'api/api-providers/device-flow/confirm') {
    const next = confirmQueue.shift();
    return next ? next(init) : httpErr(404, { error: 'not_found' });
  }
  if (url === 'api/api-providers/probe') return probeNext();
  if (url === 'api/api-providers' && (!init || !init.method || init.method === 'GET')) {
    return ok({ providers: db.slice(), activeId: db.find((p) => p.isActive)?.id ?? null });
  }
  if (url.startsWith('api/api-providers/') && (!init || !init.method || init.method === 'GET')) {
    const row = db.find((p) => p.id === decodeURIComponent(url.slice('api/api-providers/'.length)));
    return row ? ok({ ...row, apiKey: null }) : httpErr(404, { error: 'not_found' });
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

  Object.defineProperty(globalThis, 'navigator', {
    value: {
      clipboard: {
        writeText: (text: string) => {
          clipWrites.push(text);
          return clipFail ? Promise.reject(new Error('clipboard denied')) : Promise.resolve();
        },
      },
    },
    configurable: true,
    writable: true,
  });
  M = await import(base + '/js/settings.mjs');
  M.initSettings({ fetchImpl: fetchImpl });
});

after(() => {
  (globalThis as any).setTimeout = realSetTimeout;
  (globalThis as any).clearTimeout = realClearTimeout;
  if (realNavigator) Object.defineProperty(globalThis, 'navigator', realNavigator);
});

// Fresh state per test; opens the API Providers section (list GET) and returns to the list view.
async function setup(rows: any[] = []): Promise<void> {
  calls = [];
  db = rows.slice();
  timers = [];
  pollQueue = [];
  confirmQueue = [];
  clipWrites = [];
  clipFail = false;
  probeNext = () => ok({ ok: true, models: ['gpt-4o', 'claude-3.5'], latencyMs: 2 });
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
  // Poll 'done' is unsaved: only a pendingId + TTL come back; no provider row exists yet.
  return () => ok({ status: 'done', pendingId: 'pend-1', expiresIn: 600 });
}

// Drives a copilot draft through start + poll 'done' so the model/save step is visible.
async function reachModelStep(): Promise<void> {
  await startCopilotDraft();
  byId('pf-copilot-login').click();
  await flush();
  pollQueue.push(doneEntry());
  runTimer();
  await flush();
}

function confirmCalls(): Call[] {
  return calls.filter((c) => c.url === 'api/api-providers/device-flow/confirm');
}

function savedRow(): any {
  return {
    id: 'p-copilot', name: 'GitHub Copilot', baseUrl: 'https://github.com', model: null,
    protocol: 'openai', adapterId: 'copilot', isActive: true, apiKeySet: false,
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
  assert.equal(byId('pf-copilot-popup').hidden, false, 'code is shown in the popup');
  assert.equal(byId('pf-copilot-login').disabled, true);
  assert.equal(byId('pf-copilot-status').hidden, false);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 5000);
});

test('poll pending then done shows the model step and does not save', async () => {
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
  assert.equal(calls.filter((c) => c.method === 'POST' && c.url === 'api/api-providers').length, 0, 'done persists nothing');
  assert.equal(calls.filter((c) => c.url === 'api/api-providers' && c.method === 'GET').length, listGetsBefore, 'list is not refetched on done');
  assert.equal(byId('pf-copilot-confirm').hidden, false, 'model step with save action is shown');
  assert.equal(byId('pf-save').hidden, true, 'add-flow form Save stays hidden for copilot');
  assert.equal(byId('prov-form-view').classList.contains('is-hidden'), false, 'editor stays open for the confirm step');
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
  assert.equal(byId('pf-copilot-popup').hidden, true, 'expiry closes the popup');
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

test('confirm sends {pendingId, model: null} exactly once and then shows the saved provider', async () => {
  await setup();
  await reachModelStep();
  calls = [];
  confirmQueue.push(() => {
    db.push(savedRow());
    return ok({ status: 'done', provider: savedRow() });
  });

  byId('pf-copilot-confirm-btn').click();
  byId('pf-copilot-confirm-btn').click(); // double click while in flight must not re-send
  await flush();

  assert.equal(confirmCalls().length, 1);
  assert.equal(confirmCalls()[0].method, 'POST');
  assert.deepEqual(confirmCalls()[0].body, { pendingId: 'pend-1', model: null });
  assert.equal(calls.filter((c) => c.method === 'POST' && c.url === 'api/api-providers').length, 0);
  assert.equal(byId('prov-list').children.length, 1);
  assert.equal(byId('prov-list').children[0].getAttribute('data-provider-id'), 'p-copilot');
  assert.equal(byId('prov-list-view').classList.contains('is-hidden'), false);
});

test('a chosen model is sent with the confirm call', async () => {
  await setup();
  await reachModelStep();
  calls = [];
  confirmQueue.push(() => { db.push(savedRow()); return ok({ status: 'done', provider: savedRow() }); });
  byId('pf-model').value = 'gpt-4.1';

  byId('pf-copilot-confirm-btn').click();
  await flush();

  assert.equal(confirmCalls().length, 1);
  assert.deepEqual(confirmCalls()[0].body, { pendingId: 'pend-1', model: 'gpt-4.1' });
});

test('the typed name is sent with the confirm call', async () => {
  await setup();
  await reachModelStep();
  calls = [];
  confirmQueue.push(() => { db.push(savedRow()); return ok({ status: 'done', provider: savedRow() }); });
  byId('pf-name').value = '  My Copilot  ';

  byId('pf-copilot-confirm-btn').click();
  await flush();

  assert.equal(confirmCalls().length, 1);
  assert.deepEqual(confirmCalls()[0].body, { pendingId: 'pend-1', model: null, name: 'My Copilot' });
});

test('an empty name is omitted from the confirm call', async () => {
  await setup();
  await reachModelStep();
  calls = [];
  confirmQueue.push(() => { db.push(savedRow()); return ok({ status: 'done', provider: savedRow() }); });
  byId('pf-name').value = '   ';

  byId('pf-copilot-confirm-btn').click();
  await flush();

  assert.equal(confirmCalls().length, 1);
  assert.equal('name' in confirmCalls()[0].body, false, 'blank name must not be sent');
  assert.deepEqual(confirmCalls()[0].body, { pendingId: 'pend-1', model: null });
});

test('two adds each confirm without providerId so each login creates a new provider', async () => {
  await setup();
  for (const name of ['First', 'Second']) {
    await reachModelStep();
    confirmQueue.push(() => ok({ status: 'done', provider: savedRow() }));
    byId('pf-name').value = name;
    byId('pf-copilot-confirm-btn').click();
    await flush();
  }

  const bodies = confirmCalls().map((c) => c.body);
  assert.equal(bodies.length, 2);
  bodies.forEach((b) => assert.equal('providerId' in b, false, 'add-mode confirm must not send providerId'));
  assert.deepEqual(bodies[1], { pendingId: 'pend-1', model: null, name: 'Second' });
});

test('a re-login on a saved copilot row sends its providerId so only that row is updated', async () => {
  await setup([savedRow()]);
  const list: any = byId('prov-list');
  const row: any = list.children.find((li: any) => li.getAttribute('data-provider-id') === 'p-copilot');
  const target = { tagName: 'LI', closest: (sel: string) => (sel === '.provider-row' ? row : null) };
  (list._listeners.click || []).forEach((fn: any) => fn({ target }));
  await flush();
  assert.equal(byId('pf-copilot-login').textContent, 'Re-login with GitHub Copilot');

  pollQueue.push(doneEntry());
  byId('pf-copilot-login').click();
  await flush();
  runTimer();
  await flush();
  calls = [];
  confirmQueue.push(() => ok({ status: 'done', provider: savedRow() }));
  byId('pf-copilot-confirm-btn').click();
  await flush();

  assert.deepEqual(confirmCalls().map((c) => c.body), [{ pendingId: 'pend-1', model: null, name: 'GitHub Copilot', providerId: 'p-copilot' }]);
});

test('confirm 404/410 shows a restart message and allows login again', async () => {
  for (const status of [404, 410]) {
    await setup();
    await reachModelStep();
    calls = [];
    confirmQueue.push(() => httpErr(status, { error: status === 410 ? 'pending_expired' : 'not_found' }));

    byId('pf-copilot-confirm-btn').click();
    await flush();

    assert.equal(confirmCalls().length, 1, 'no retry of a dead pendingId');
    assert.match(byId('pf-copilot-status').textContent, /expired/);
    assert.equal(byId('pf-copilot-status').hidden, false);
    assert.equal(byId('pf-copilot-confirm').hidden, true, 'model step is dropped');
    assert.equal(byId('pf-copilot-login').disabled, false, 'login can be restarted');
    assert.equal(byId('prov-form-view').classList.contains('is-hidden'), false, 'draft stays open');
  }
});

test('login success hides the login button, shows the tick label, and reveals the model select under the login block', async () => {
  await setup();
  await startCopilotDraft();
  assert.equal(byId('pf-model-row').hidden, true, 'model select is hidden before login');

  byId('pf-copilot-login').click();
  await flush();
  assert.equal(byId('pf-copilot-login').hidden, false, 'button stays while polling');
  assert.equal(byId('pf-copilot-success').hidden, true);
  assert.equal(byId('pf-model-row').hidden, true);

  pollQueue.push(doneEntry());
  runTimer();
  await flush();
  assert.equal(byId('pf-copilot-login').hidden, true, 'login button hidden once signed in');
  assert.equal(byId('pf-copilot-success').hidden, false, 'tick + label shown once signed in');
  assert.equal(byId('pf-model-row').hidden, false, 'model select visible after login');
  assert.equal(byId('pf-model-row').parentNode, byId('pf-copilot'), 'model select sits in the login block');
});

test('model list is fetched once after login succeeds, via the probe route with pendingId only', async () => {
  await setup();
  await startCopilotDraft();
  byId('pf-copilot-login').click();
  await flush();

  pollQueue.push(() => ok({ status: 'pending', interval: 5 }));
  runTimer();
  await flush();
  assert.equal(calls.filter((c) => c.url === 'api/api-providers/probe').length, 0, 'no probe before login succeeds');

  pollQueue.push(doneEntry());
  runTimer();
  await flush();

  const probes = calls.filter((c) => c.url === 'api/api-providers/probe');
  assert.equal(probes.length, 1, 'fetched exactly once');
  assert.equal(probes[0].method, 'POST');
  assert.deepEqual(probes[0].body, { pendingId: 'pend-1' });
  assert.deepEqual(byId('pf-model').children.map((o: any) => o.value), ['', 'gpt-4o', 'claude-3.5'], 'From Request plus fetched ids');
});

test('save after login sends the chosen fetched model once', async () => {
  await setup();
  await reachModelStep();
  calls = [];
  confirmQueue.push(() => { db.push(savedRow()); return ok({ status: 'done', provider: savedRow() }); });
  byId('pf-model').value = 'claude-3.5';

  byId('pf-copilot-confirm-btn').click();
  await flush();

  assert.deepEqual(confirmCalls().map((c) => c.body), [{ pendingId: 'pend-1', model: 'claude-3.5' }]);
});

test('a failed model fetch keeps From Request as the only option and Save enabled', async () => {
  await setup();
  probeNext = () => httpErr(502, { error: 'upstream unavailable' });
  await reachModelStep();

  assert.deepEqual(byId('pf-model').children.map((o: any) => o.value), [''], 'From Request only');
  assert.match(byId('pf-copilot-status').textContent, /Could not load models/);
  assert.equal(byId('pf-copilot-status').hidden, false, 'non-blocking message is visible');
  assert.equal(byId('pf-copilot-confirm').hidden, false, 'Save remains available');

  calls = [];
  confirmQueue.push(() => { db.push(savedRow()); return ok({ status: 'done', provider: savedRow() }); });
  byId('pf-copilot-confirm-btn').click();
  await flush();
  assert.deepEqual(confirmCalls().map((c) => c.body), [{ pendingId: 'pend-1', model: null }]);
});

test('cancel after login restores the login button and hides the tick and the model step', async () => {
  await setup();
  await reachModelStep();
  assert.equal(byId('pf-copilot-login').hidden, true);

  byId('pf-cancel').click();
  await flush();
  assert.equal(byId('pf-copilot-login').hidden, false, 'login button restored');
  assert.equal(byId('pf-copilot-success').hidden, true, 'tick hidden');
  assert.equal(byId('pf-copilot-confirm').hidden, true, 'model step dropped');
  assert.equal(byId('prov-list-view').classList.contains('is-hidden'), false, 'back to the list view');
});

test('copy button writes the user code to the injected clipboard and shows Copied', async () => {
  await setup();
  await startCopilotDraft();
  byId('pf-copilot-login').click();
  await flush();

  byId('pf-copilot-copy').click();
  await flush();

  assert.deepEqual(clipWrites, ['ABCD-EFGH']);
  assert.equal(byId('pf-copilot-copy-msg').textContent, 'Copied');
  assert.equal(byId('pf-copilot-copy-msg').hidden, false);
  assert.equal(byId('pf-copilot-popup').hidden, false, 'copying keeps the popup open');
});

test('a rejected clipboard write shows an inline copy error and keeps the code visible', async () => {
  await setup();
  await startCopilotDraft();
  byId('pf-copilot-login').click();
  await flush();

  clipFail = true;
  byId('pf-copilot-copy').click();
  await flush();

  assert.deepEqual(clipWrites, ['ABCD-EFGH']);
  assert.match(byId('pf-copilot-copy-msg').textContent, /^Copy failed/);
  assert.equal(byId('pf-copilot-copy-msg').hidden, false);
  assert.equal(byId('pf-copilot-code').textContent, 'ABCD-EFGH');
});

test('poll done closes the popup and shows the signed-in success state on the add screen', async () => {
  await setup();
  await startCopilotDraft();
  byId('pf-copilot-login').click();
  await flush();
  assert.equal(byId('pf-copilot-popup').hidden, false);

  pollQueue.push(doneEntry());
  runTimer();
  await flush();

  assert.equal(byId('pf-copilot-popup').hidden, true, 'popup closes automatically on success');
  assert.equal(byId('pf-copilot-login').hidden, true, 'login button replaced by the success state');
  assert.equal(byId('pf-copilot-success').hidden, false, 'tick + label shown');
  assert.equal(byId('pf-model-row').hidden, false, 'model select shown');
  assert.equal(byId('pf-copilot-confirm').hidden, false, 'save step shown');
});

test('closing the popup cancels the device flow and restores the login button', async () => {
  await setup();
  await startCopilotDraft();
  byId('pf-copilot-login').click();
  await flush();
  assert.equal(timers.length, 1);

  byId('pf-copilot-popup-close').click();
  await flush();

  assert.equal(byId('pf-copilot-popup').hidden, true, 'popup closed');
  assert.equal(timers.length, 0, 'poll timer cleared, no further polls');
  assert.equal(byId('pf-copilot-login').disabled, false, 'login button restored');
  assert.equal(byId('pf-copilot-login').hidden, false);
  assert.equal(byId('pf-copilot-status').hidden, true, 'no stale status left behind');
  assert.equal(calls.filter((c) => c.url === 'api/api-providers/device-flow/poll').length, 0);
});

test('a typed name survives copilot type selection, login success, and model load', async () => {
  await setup();
  byId('prov-add-btn').click();
  await flush();
  byId('pf-name').value = 'My Copilot';
  byId('pf-type').value = 'copilot';
  byId('pf-type').emit('change');
  await flush();
  byId('pf-copilot-login').click();
  await flush();
  pollQueue.push(doneEntry());
  runTimer();
  await flush();

  assert.equal(calls.filter((c) => c.url === 'api/api-providers/probe').length, 1, 'models loaded after login');
  assert.equal(byId('pf-name').value, 'My Copilot', 'typed name is not replaced by the default');
});

