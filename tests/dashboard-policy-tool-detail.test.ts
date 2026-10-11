/**
 * Coverage for the "Policy" quick-actions section in the tool-call detail panel
 * (dashboard/js/live-view.mjs: buildPolicySection / handlePolicyAction /
 * createPolicyRule) and the rules.mjs quick-create + pre-fill helpers
 * (createRule / findDuplicatePolicyRule / prefillNewRule / openNewRuleForm).
 *
 * DOM-stubbed, mirroring tests/dashboard-settings-modal.test.ts:
 *   - createDomStub() + materialized registry elements for the rules form / list /
 *     notice (so loadSpecIntoForm / renderRules / showNotice / refreshRules resolve);
 *   - an injected globalThis.fetch that records calls and answers api/rules;
 *   - async completion drained purely via microtask flushing (no timers/sleeps).
 * Each test file runs in its own process, so one installed stub never leaks.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDomStub, DomStub, FakeEl } from './dom-stub';

/* Non-literal specifier keeps this compiling cleanly; resolves relative to
   dist/tests/ -> ../../dashboard at runtime (identical trick to the reference specs). */
const base = '../..' + '/dashboard';

interface Call { url: string; method: string; body?: unknown }
const S: DomStub = createDomStub();

// Materialize the rules form / list / notice ids so the dashboard modules resolve
// them via document.getElementById (loadSpecIntoForm / renderRules / showNotice /
// refreshRules / updateFormMode all touch these).
S.el('matcher-type', 'select');
S.el('action-type', 'select');
S.el('matcher-fields', 'div');
S.el('action-fields', 'div');
S.el('rule-enabled', 'input');
S.el('rule-description', 'input');
S.el('rule-priority', 'input');
S.el('rule-form', 'form');
S.el('btn-add', 'button');
S.el('btn-cancel', 'button');
S.el('rule-editor-title', 'div');
S.el('form-error', 'div');
S.el('notice', 'div');
S.el('rule-saved-note', 'div');
S.el('rule-list', 'ul');
S.el('rule-empty', 'div');
S.el('rule-list-view', 'div');
S.el('view-rule-editor', 'div');
S.el('view-rules', 'div');
S.el('view-dashboard', 'div');

const calls: Call[] = [];
function makeFetchImpl(): (url: string, init?: any) => Promise<unknown> {
  return function fetchImpl(url: string, init?: any): Promise<unknown> {
    const rec: Call = { url: String(url), method: (init?.method as string) ?? 'GET' };
    if (typeof init?.body === 'string') { try { rec.body = JSON.parse(init.body); } catch { rec.body = init.body; } }
    calls.push(rec);
    const method = rec.method;
    if (url === 'api/rules' && method === 'GET') return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([]) });
    if (url === 'api/rules' && method === 'POST') return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(Object.assign({ id: 'new-rule-id' }, rec.body)) });
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
  };
}
const postCalls = (): Call[] => calls.filter((c) => c.method === 'POST');
const getRuleCalls = (): Call[] => calls.filter((c) => c.method === 'GET' && c.url === 'api/rules');
const resetCalls = (): void => { calls.length = 0; };

let state: any;
let LV: any;
let R: any;

before(async () => {
  (globalThis as any).location = { hash: '' };
  (globalThis as any).window = { confirm: () => true, scrollTo: () => {} };
  // focus() counts calls on the target element (tests assert focus moved into the form).
  (FakeEl.prototype as any).focus = function focus() { (this as any).focusedCount = ((this as any).focusedCount || 0) + 1; };
  (globalThis as any).fetch = makeFetchImpl();
  state = (await import(base + '/js/state.mjs')).state;
  LV = await import(base + '/js/live-view.mjs');
  R = await import(base + '/js/rules.mjs');
});

// Microtask drain for async handler chains — purely promise-based, no timers/sleeps.
async function flush(): Promise<void> {
  let p: Promise<unknown> = Promise.resolve();
  for (let i = 0; i < 64; i += 1) p = p.then(() => undefined);
  await p;
}
// Read one dynamic field control's value from a container (the module nests the
// control inside a per-field wrapper div whose dataset.field is the field key).
function controlValue(containerId: string, fieldKey: string): string {
  const box = S.byId(containerId)!;
  for (const wrap of box.children) {
    for (const c of wrap.children) {
      if (c.dataset && c.dataset.field === fieldKey) return c.value as string;
    }
  }
  return '';
}
const rowNamed = (name: string): any => ({
  li: new FakeEl('li'),
  callEv: { toolName: name, id: 'c1', at: 1, sessionKey: 's1' },
  resultEv: null,
  activeTab: 'details' as any,
  expanded: true,
});
const rowNameless = (): any => ({
  li: new FakeEl('li'),
  callEv: null,
  resultEv: { toolName: '', at: 1 },
  activeTab: 'details' as any,
  expanded: true,
});

/* ---- (a) buildPolicySection renders the three controls for a named call --- */
test('policy section renders the three controls for a named tool call', () => {
  const h: string = LV.buildPolicySection(rowNamed('read_file'));
  assert.match(h, /data-policy="block"/, 'block control present');
  assert.match(h, /data-policy="hide"/, 'hide control present');
  assert.match(h, /data-policy="new"/, 'new control present');
  assert.match(h, />Block</, 'Block visible text');
  assert.match(h, />Hide</, 'Hide visible text');
  assert.match(h, /New policy \u2192/, 'New policy arrow visible text');
  assert.match(h, /class="rd-section policy-section"/, 'policy-section present');
  assert.match(h, /<div class="rd-label">Policy<\/div>/, 'Policy label present');
  assert.match(h, /role="group"/, 'section carries role=group');
  assert.match(h, /aria-label="Block tool read_file"/, 'block aria-label names the tool');
  assert.match(h, /aria-label="Hide tool read_file"/, 'hide aria-label names the tool');
  assert.match(h, /aria-label="Create new policy rule for tool read_file"/, 'new aria-label names the tool');
});

/* ---- (a) buildPolicySection is omitted for a name-less row --------------- */
test('policy section is omitted for a name-less orphan row', () => {
  assert.equal(LV.buildPolicySection(rowNameless()), '', 'no policy controls for a name-less row');
});

/* ---- (b) Block POSTs the exact spec, confirms, and refreshes ------------- */
test('Block button POSTs the exact block spec, confirms, and refreshes the list', async () => {
  resetCalls();
  state.rules = [];
  S.byId('notice')!.hidden = false;
  await LV.handlePolicyAction('block', 'read_file');
  await flush();
  assert.equal(postCalls().length, 1, 'exactly one POST to api/rules');
  assert.equal(postCalls()[0].url, 'api/rules');
  assert.deepEqual(postCalls()[0].body, {
    enabled: true,
    matcher: { type: 'toolName', toolName: 'read_file' },
    action: { type: 'block', message: 'Blocked: read_file' },
  }, 'block spec char-shape matches the documented RuleSpec precisely');
  assert.ok(getRuleCalls().length >= 1, 'a GET api/rules refresh follows the create');
  assert.match(String(S.byId('notice')!.textContent), /policy rule created/);
  assert.equal(S.byId('notice')!.hidden, false, 'success notice is visible');
});

/* ---- (c) Hide POSTs the exact hide spec ---------------------------------- */
test('Hide button POSTs the exact hide spec', async () => {
  resetCalls();
  state.rules = [];
  await LV.handlePolicyAction('hide', 'read_file');
  await flush();
  assert.equal(postCalls().length, 1, 'exactly one POST to api/rules');
  assert.deepEqual(postCalls()[0].body, {
    enabled: true,
    matcher: { type: 'toolName', toolName: 'read_file' },
    action: { type: 'hideTool', toolNames: ['read_file'] },
  }, 'hide spec char-shape matches the documented RuleSpec precisely');
});

/* ---- (d) New policy prefills the editor, navigates, moves focus ---------- */
test('New policy prefills the editor, navigates, moves focus, and consumes the pending spec', async () => {
  state.rules = [];
  (globalThis as any).location.hash = '';
  (S.byId('rule-description')! as any).focusedCount = 0;
  R.prefillNewRule({ enabled: true, matcher: { type: 'toolName', toolName: 'read_file' }, action: { type: 'block' } });
  assert.equal((globalThis as any).location.hash, '#/rules/new', 'navigates to the add-mode editor');
  // Simulate the router (hashchange -> applyRoute -> openNewRuleForm).
  R.openNewRuleForm();
  assert.equal(S.byId('matcher-type')!.value, 'toolName', 'matcher type pre-filled');
  assert.equal(controlValue('matcher-fields', 'toolName'), 'read_file', 'tool name pre-filled');
  assert.equal(S.byId('action-type')!.value, 'block', 'action type pre-filled');
  assert.equal(S.byId('rule-enabled')!.checked, true, 'enabled checked');
  assert.ok((S.byId('rule-description')! as any).focusedCount >= 1, 'focus moved into the editor form');
  assert.equal(S.byId('rule-editor-title')!.textContent, 'New rule', 'add mode, not edit');
  // A subsequent fresh (no-pending) open resets cleanly — proving no pre-fill leak.
  R.openNewRuleForm();
  assert.equal(S.byId('matcher-type')!.value, 'loop', 'clean reset default after consuming the pre-fill');
});

/* ---- (e) Duplicate enabled rules are not re-created ---------------------- */
test('duplicate enabled rule suppresses the POST and notifies', async () => {
  state.rules = [{ enabled: true, matcher: { type: 'toolName', toolName: 'x' }, action: { type: 'block' } }];
  resetCalls();
  await LV.handlePolicyAction('block', 'x');
  await flush();
  assert.equal(postCalls().length, 0, 'no duplicate POST for an already-enabled identical rule');
  assert.ok(calls.every((c) => c.method !== 'POST'), 'no POST at all');
  assert.match(String(S.byId('notice')!.textContent), /already blocked/);
});

/* ---- failed POST surfaces an error notice without throwing --------------- */
test('failed POST shows an error notice without throwing (no refresh)', async () => {
  state.rules = [];
  resetCalls();
  const savedFetch = (globalThis as any).fetch;
  (globalThis as any).fetch = (url: string, init?: any): Promise<unknown> => {
    const rec: Call = { url: String(url), method: (init?.method as string) ?? 'GET' };
    if (typeof init?.body === 'string') { try { rec.body = JSON.parse(init.body); } catch { rec.body = init.body; } }
    calls.push(rec);
    if (url === 'api/rules' && rec.method === 'POST') return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ error: 'boom' }) });
    if (url === 'api/rules' && rec.method === 'GET') return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([]) });
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
  };
  try {
    await assert.doesNotReject(() => LV.handlePolicyAction('block', 'x'));
    await flush();
    assert.match(String(S.byId('notice')!.textContent), /not created/i, 'error notice surfaces the failed create');
    assert.match(String(S.byId('notice')!.textContent), /boom/);
    assert.equal(postCalls().length, 1, 'the failed POST was attempted exactly once');
    assert.equal(getRuleCalls().length, 0, 'no list refresh follows a failed create');
  } finally {
    (globalThis as any).fetch = savedFetch;
  }
});
