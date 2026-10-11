/**
 * Coverage for the rule form's `addDescription` action support
 * (dashboard/js/rules.mjs): the "Tool description" field renders only for the
 * addDescription action; its value round-trips through collectSpec /
 * createRule / loadSpecIntoForm / resetForm; and prefillNewRule(toolName,
 * description) pre-fills the matcher tool name + addDescription action + the
 * description field.
 *
 * DOM-stubbed, mirroring tests/dashboard-policy-tool-detail.test.ts:
 *   - createDomStub() + materialized rules-form / list / notice elements;
 *   - an injected globalThis.fetch that records calls and answers api/rules;
 *   - a per-file FakeEl.prototype.querySelector override (mirroring
 *     dashboard-settings-modal.test.ts) so readField's
 *     container.querySelector('[data-field="..."]') resolves the nested control.
 * Each test file runs in its own process, so one installed override never leaks.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDomStub, DomStub, FakeEl } from './dom-stub';

/* Non-literal specifier keeps this compiling cleanly; resolves relative to
   dist/tests/ -> ../../dashboard at runtime (identical trick to the reference specs). */
const base = '../..' + '/dashboard';

interface Call { url: string; method: string; body?: unknown }
const S: DomStub = createDomStub();

// readField (rules.mjs) reads each control via
//   container.querySelector('[data-field="<key>"]');
// the bare stub returns null for it, so resolve that selector to the nested
// control (per-file, mirroring dashboard-settings-modal.test.ts's #id override).
(FakeEl.prototype as any).querySelector = function querySelector(sel: string): any {
  const self = this as FakeEl;
  const walk = (node: FakeEl, match: (e: FakeEl) => boolean): FakeEl | null => {
    for (const c of node.children) {
      if (match(c)) return c;
      const r = walk(c, match);
      if (r) return r;
    }
    return null;
  };
  if (typeof sel === 'string') {
    const id = /^#([^#]+)$/.exec(sel);
    if (id) return walk(self, (e) => e.id === id[1]);
    const df = /^\[data-field="([^"]+)"\]$/.exec(sel);
    if (df) return walk(self, (e) => e.dataset && e.dataset.field === df[1]);
  }
  return null;
};

// Materialize the rules form / list / notice ids so the dashboard modules resolve
// them via document.getElementById (loadSpecIntoForm / renderRules / showNotice /
// refreshRules / updateFormMode / clientValidate all touch these).
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
const postBody = (url: string, method: string): any =>
  calls.find((c) => c.url === url && c.method === method)?.body as any;

let state: any;
let R: any;

before(async () => {
  (globalThis as any).location = { hash: '' };
  (globalThis as any).window = { confirm: () => true, scrollTo: () => {} };
  (globalThis as any).fetch = makeFetchImpl();
  state = (await import(base + '/js/state.mjs')).state;
  R = await import(base + '/js/rules.mjs');
});

// Read one dynamic field control's value from a container (makeField nests the
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
function hasField(containerId: string, fieldKey: string): boolean {
  const box = S.byId(containerId)!;
  for (const wrap of box.children) {
    for (const c of wrap.children) {
      if (c.dataset && c.dataset.field === fieldKey) return true;
    }
  }
  return false;
}
function setControlValue(containerId: string, fieldKey: string, value: string): void {
  const box = S.byId(containerId)!;
  for (const wrap of box.children) {
    for (const c of wrap.children) {
      if (c.dataset && c.dataset.field === fieldKey) { c.value = value; return; }
    }
  }
  throw new Error('field not found: ' + fieldKey);
}

/* ---- (1) the "Tool description" field renders only for addDescription ---- */
test('the "Tool description" field renders for addDescription and is absent for other actions', () => {
  R.renderActionFields('addDescription');
  assert.ok(hasField('action-fields', 'description'), 'addDescription renders a description field');
  assert.equal(S.byId('action-fields')!.children.length, 1, 'exactly one field (the description)');
  const wrap = S.byId('action-fields')!.children[0];
  const control = wrap.children.find((c: any) => c.dataset && c.dataset.field === 'description')!;
  assert.equal((control as any).tagName, 'TEXTAREA', 'the field is a textarea');
  // Other actions carry no description field.
  R.renderActionFields('hideTool');
  assert.ok(!hasField('action-fields', 'description'), 'hideTool renders no description field');
  R.renderActionFields('injectMessage');
  assert.ok(!hasField('action-fields', 'description'), 'injectMessage renders no description field');
});

/* ---- (2) the field value is collected into the spec and POSTed ----------- */
test('collectSpec + createRule save the "Tool description" field into spec.action.description', async () => {
  calls.length = 0;
  state.curMatcherType = 'toolName';
  state.curActionType = 'addDescription';
  (S.byId('matcher-type')! as any).value = 'toolName';
  (S.byId('action-type')! as any).value = 'addDescription';
  R.renderMatcherFields('toolName');
  R.renderActionFields('addDescription');
  (S.byId('rule-enabled')! as any).checked = true;
  setControlValue('matcher-fields', 'toolName', 'my_tool');
  setControlValue('action-fields', 'description', 'Does useful things.');
  const r: any = R.collectSpec();
  assert.equal(r.error, undefined, 'no client-side validation error');
  assert.equal(r.spec.action.type, 'addDescription', 'the action type is preserved');
  assert.equal(r.spec.action.description, 'Does useful things.', 'the field value is in spec.action.description');
  assert.equal(r.spec.matcher.toolName, 'my_tool', 'the matcher tool name is collected too');
  await R.createRule(r.spec);
  assert.equal(postBody('api/rules', 'POST')?.action?.description, 'Does useful things.', 'createRule POSTs the description');
});

/* ---- (3) editing an existing addDescription rule shows the saved value ---- */
test('loadSpecIntoForm shows the saved description for an existing addDescription rule', () => {
  R.loadSpecIntoForm({
    id: 'rule-1',
    enabled: true,
    matcher: { type: 'toolName', toolName: 'my_tool' },
    action: { type: 'addDescription', description: 'Saved description text.' },
  });
  assert.equal((S.byId('action-type')! as any).value, 'addDescription', 'action type selected');
  assert.ok(hasField('action-fields', 'description'), 'the description field is rendered in edit mode');
  assert.equal(controlValue('action-fields', 'description'), 'Saved description text.', 'the saved description is shown');
  assert.equal(state.editingId, 'rule-1', 'edit mode');
});

/* ---- (4) prefillNewRule(toolName, description) pre-fills the form -------- */
test('prefillNewRule(toolName, description) prefills the matcher name, addDescription action, and the description', () => {
  (globalThis as any).location.hash = '';
  R.prefillNewRule('my_tool', 'Prefilled description text.');
  assert.equal((globalThis as any).location.hash, '#/rules/new', 'navigates to the add-mode editor');
  // Simulate the router (hashchange -> applyRoute -> openNewRuleForm).
  R.openNewRuleForm();
  assert.equal((S.byId('matcher-type')! as any).value, 'toolName', 'matcher type pre-filled');
  assert.equal(controlValue('matcher-fields', 'toolName'), 'my_tool', 'tool name pre-filled');
  assert.equal((S.byId('action-type')! as any).value, 'addDescription', 'action type pre-filled to addDescription');
  assert.equal(controlValue('action-fields', 'description'), 'Prefilled description text.', 'the description field is pre-filled');
  assert.equal(state.editingId, '', 'add mode (not edit)');
});

/* ---- (a) resetForm clears the pre-filled description --------------------- */
test('resetForm clears the addDescription pre-fill', () => {
  (globalThis as any).location.hash = '';
  R.prefillNewRule('my_tool', 'Prefilled description text.');
  R.openNewRuleForm();
  assert.equal(controlValue('action-fields', 'description'), 'Prefilled description text.', 'pre-filled before reset');
  R.resetForm();
  assert.equal((S.byId('action-type')! as any).value, 'hideTool', 'action type reset to the default');
  assert.ok(!hasField('action-fields', 'description'), 'the description field is gone after reset');
});
