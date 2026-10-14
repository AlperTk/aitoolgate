/**
 * Coverage for the rule editor's 3-step wizard (dashboard/js/rules.mjs):
 * the step-state + navigation API (showStep / backStep /
 * jumpToStep / getCurrentStep), the step-indicator + footer visibility, the
 * per-step validation model (validateStep / collectStep), the whole-form Save
 * validation, and the add / edit / prefill landing behaviour.
 *
 * DOM-stubbed, mirroring tests/dashboard-rule-description-prefill.test.ts:
 *   - createDomStub() + materialized rules-form / list / notice / wizard ids;
 *   - an injected globalThis.fetch that records calls and answers api/rules;
 *   - a per-file FakeEl.prototype.querySelector override so readField's
 *     container.querySelector('[data-field="..."]') resolves the nested control;
 *   - a per-file FakeEl.prototype.focus override so we can assert focus moved.
 * Each test file runs in its own process, so one installed override never leaks.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDomStub, DomStub, FakeEl } from './dom-stub';

/* Non-literal specifier keeps this compiling cleanly; resolves relative to
   dist/tests/ -> ../../dashboard at runtime. */
const base = '../..' + '/dashboard';

interface Call { url: string; method: string; body?: unknown }
const S: DomStub = createDomStub();

// readField (rules.mjs) reads each control via
//   container.querySelector('[data-field="<key>"]');
// the bare stub returns null for it, so resolve that selector to the nested
// control (per-file, mirroring dashboard-rule-description-prefill.test.ts).
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

// Materialize the rules form / list / notice ids AND the wizard ids (step
// containers, step-indicator items, footer navigation buttons) so the dashboard
// modules resolve them via document.getElementById.
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
// Wizard: three step panels, three step-indicator items, and the footer nav.
S.el('rule-step-when', 'div');
S.el('rule-step-then', 'div');
S.el('rule-step-details', 'div');
S.el('rule-step-ind-1', 'button');
S.el('rule-step-ind-2', 'button');
S.el('rule-step-ind-3', 'button');
S.el('rule-btn-back', 'button');
// Live per-step previews + target chip (step 2) materialized so the
// "clarity layer" tests (labels / previews / target chip / combined preview)
// can read the text js/rules.mjs (updatePreviews) writes into them.
S.el('rule-when-preview', 'div');
S.el('rule-then-preview', 'div');
S.el('rule-target-chip', 'div');
S.el('rule-combined-preview', 'div');

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
const resetCalls = (): void => { calls.length = 0; };

let state: any;
let R: any;
let schema: any;

before(async () => {
  (globalThis as any).location = { hash: '' };
  (globalThis as any).window = { confirm: () => true, scrollTo: () => {} };
  // focus() counts calls on the target element (tests assert focus moved).
  (FakeEl.prototype as any).focus = function focus() { (this as any).focusedCount = ((this as any).focusedCount || 0) + 1; };
  (globalThis as any).fetch = makeFetchImpl();
  state = (await import(base + '/js/state.mjs')).state;
  R = await import(base + '/js/rules.mjs');
  schema = await import(base + '/js/rule-schema.mjs');
});

// Microtask drain for async handler chains — purely promise-based, no timers.
async function flush(): Promise<void> {
  let p: Promise<unknown> = Promise.resolve();
  for (let i = 0; i < 64; i += 1) p = p.then(() => undefined);
  await p;
}
// Set one dynamic field control's value from a container (makeField nests the
// control inside a per-field wrapper div whose dataset.field is the field key).
function setControlValue(containerId: string, fieldKey: string, value: string): void {
  const box = S.byId(containerId)!;
  for (const wrap of box.children) {
    for (const c of wrap.children) {
      if (c.dataset && c.dataset.field === fieldKey) { (c as any).value = value; return; }
    }
  }
  throw new Error('field not found: ' + fieldKey);
}
// Build a fully valid form state: an `always` matcher (no fields) + an
// injectMessage action with a non-empty content (its only required field).
function setupValidForm(): void {
  state.curMatcherType = 'always';
  state.curActionType = 'injectMessage';
  (S.byId('matcher-type')! as any).value = 'always';
  (S.byId('action-type')! as any).value = 'injectMessage';
  R.renderMatcherFields('always');
  R.renderActionFields('injectMessage');
  setControlValue('action-fields', 'content', 'injected message');
  (S.byId('rule-enabled')! as any).checked = true;
  (S.byId('rule-description')! as any).value = '';
  (S.byId('rule-priority')! as any).value = '';
  R.showStep(1);
}

/* ---- (1) the step indicator advances 1 → 2 → 3 across a valid form ----- */
test('the step indicator advances 1 → 2 → 3 across a fully valid form', () => {
  setupValidForm();
  assert.equal(R.getCurrentStep(), 1, 'starts on step 1');
  R.jumpToStep(2);
  assert.equal(R.getCurrentStep(), 2, 'jumping from step 1 lands on step 2');
  assert.equal(S.byId('rule-step-then')!.hidden, false, 'step 2 is visible');
  assert.equal(S.byId('rule-step-when')!.hidden, true, 'step 1 is now hidden');
  R.jumpToStep(3);
  assert.equal(R.getCurrentStep(), 3, 'jumping from step 2 lands on step 3');
  assert.equal(S.byId('rule-step-details')!.hidden, false, 'step 3 is visible');
});

/* ---- (2) Back goes back 3 → 2 → 1 ------------------------------------- */
test('Back goes back 3 → 2 → 1', () => {
  setupValidForm();
  R.showStep(3);
  assert.equal(R.getCurrentStep(), 3, 'starts on step 3');
  R.backStep();
  assert.equal(R.getCurrentStep(), 2, 'Back from step 3 lands on step 2');
  assert.equal(S.byId('rule-step-then')!.hidden, false, 'step 2 is visible');
  R.backStep();
  assert.equal(R.getCurrentStep(), 1, 'Back from step 2 lands on step 1');
  assert.equal(S.byId('rule-step-when')!.hidden, false, 'step 1 is visible');
});

/* ---- (3) the step indicator reflects the current step ------------------- */
test('the step indicator reflects the current step and marks completed steps', () => {
  setupValidForm();
  R.showStep(2);
  assert.ok(S.byId('rule-step-ind-2')!.classList.contains('is-current'), 'step 2 is current');
  assert.ok(S.byId('rule-step-ind-1')!.classList.contains('is-done'), 'step 1 is done (valid)');
  assert.ok(!S.byId('rule-step-ind-3')!.classList.contains('is-current'), 'step 3 is not current');
  R.showStep(3);
  assert.ok(S.byId('rule-step-ind-3')!.classList.contains('is-current'), 'step 3 is current');
  assert.ok(S.byId('rule-step-ind-1')!.classList.contains('is-done'), 'step 1 still done');
  assert.ok(S.byId('rule-step-ind-2')!.classList.contains('is-done'), 'step 2 now done');
  assert.ok(!S.byId('rule-step-ind-1')!.classList.contains('is-current'), 'step 1 no longer current');
});

/* ---- (4) the footer Back/Save visibility follows the active step -------- */
test('the footer Back / Save visibility and emphasis follow the active step', () => {
  setupValidForm();
  // Step 1: Back hidden; Save not primary.
  assert.equal(S.byId('rule-btn-back')!.hidden, true, 'Back hidden on step 1');
  assert.ok(!S.byId('btn-add')!.classList.contains('btn-primary'), 'Save not primary on step 1');
  // Step 2: Back visible; Save not primary.
  R.showStep(2);
  assert.equal(S.byId('rule-btn-back')!.hidden, false, 'Back visible on step 2');
  assert.ok(!S.byId('btn-add')!.classList.contains('btn-primary'), 'Save not primary on step 2');
  // Step 3: Back visible; Save primary.
  R.showStep(3);
  assert.equal(S.byId('rule-btn-back')!.hidden, false, 'Back visible on step 3');
  assert.ok(S.byId('btn-add')!.classList.contains('btn-primary'), 'Save is primary on step 3');
});

/* ---- (5) jumpToStep navigates to reachable steps, blocks the rest ------- */
test('jumpToStep navigates to a reachable step and blocks a non-reachable one', () => {
  setupValidForm();
  assert.equal(R.getCurrentStep(), 1, 'starts on step 1');
  R.jumpToStep(3); // all steps valid -> reachable
  assert.equal(R.getCurrentStep(), 3, 'jumps to step 3 when every intermediate step is valid');
  // Now make step 2 invalid (hideTool with no tool names).
  R.showStep(1);
  state.curActionType = 'hideTool';
  (S.byId('action-type')! as any).value = 'hideTool';
  R.renderActionFields('hideTool');
  // From step 1, step 3 is NOT reachable (step 2 is invalid in between).
  R.jumpToStep(3);
  assert.equal(R.getCurrentStep(), 1, 'jump to step 3 is blocked while step 2 is invalid');
  // Step 2 is still reachable from step 1 (the matcher is valid).
  R.jumpToStep(2);
  assert.equal(R.getCurrentStep(), 2, 'step 2 is reachable from step 1');
});

/*/* ---- (7) Save validates all and POSTs only when the whole spec is valid - */
test('Save validates all steps and POSTs only when the whole spec is valid', async () => {
  // Invalid action (hideTool with no tool names): Save must not POST and must
  // land on the first invalid step (step 2).
  state.curMatcherType = 'always';
  state.curActionType = 'hideTool';
  (S.byId('matcher-type')! as any).value = 'always';
  (S.byId('action-type')! as any).value = 'hideTool';
  R.renderMatcherFields('always');
  R.renderActionFields('hideTool'); // toolNames (empty)
  R.showStep(1);
  resetCalls();
  R.submitRule();
  await flush();
  assert.equal(postCalls().length, 0, 'no POST while the action is invalid');
  assert.match(String(S.byId('form-error')!.textContent), /toolNames/, 'the action error is shown');
  assert.equal(R.getCurrentStep(), 2, 'Save lands on the first invalid step (action)');

  // Whole spec valid: Save POSTs exactly once.
  setupValidForm();
  resetCalls();
  R.submitRule();
  await flush();
  assert.equal(postCalls().length, 1, 'exactly one POST when the whole spec is valid');
  assert.equal(postCalls()[0].url, 'api/rules');
  const postedBody = postCalls()[0].body as any;
  assert.equal(postedBody?.action?.type, 'injectMessage');
  assert.equal(postedBody?.action?.content, 'injected message');
  assert.equal(postedBody?.matcher?.type, 'always');
});

/* ---- (8) add mode lands on step 1 --------------------------------------- */
test('add mode (openNewRuleForm with no pending spec) lands on step 1', () => {
  (globalThis as any).location.hash = '';
  R.openNewRuleForm(); // no pending spec -> resetForm() -> step 1
  assert.equal(R.getCurrentStep(), 1, 'add mode lands on step 1');
  assert.equal(S.byId('rule-step-when')!.hidden, false, 'step 1 visible');
  assert.equal(S.byId('rule-step-then')!.hidden, true, 'step 2 hidden');
  assert.equal(S.byId('rule-step-details')!.hidden, true, 'step 3 hidden');
  assert.equal(S.byId('rule-editor-title')!.textContent, 'New rule', 'add-mode title');
  assert.equal(S.byId('btn-add')!.textContent, 'Add rule', 'Save button label in add mode');
  assert.equal(S.byId('btn-cancel')!.hidden, false, 'Cancel is always visible');
});

/* ---- (9) edit mode lands on step 1 -------------------------------------- */
test('edit mode (openEditRuleForm) lands on step 1', async () => {
  state.rules = [{ id: 'rule-1', enabled: true, matcher: { type: 'toolName', toolName: 'x' }, action: { type: 'hideTool', toolNames: ['x'] } }];
  await R.openEditRuleForm('rule-1');
  assert.equal(R.getCurrentStep(), 1, 'edit mode lands on step 1');
  assert.equal(state.editingId, 'rule-1', 'edit mode (not add)');
  assert.equal(S.byId('rule-editor-title')!.textContent, 'Edit rule', 'edit-mode title');
  assert.equal(S.byId('btn-add')!.textContent, 'Save changes', 'Save button label in edit mode');
  assert.equal(S.byId('rule-step-when')!.hidden, false, 'step 1 visible');
  assert.equal(S.byId('rule-step-details')!.hidden, true, 'step 3 hidden');
});

/* ---- (10) prefill lands on step 2 (Then) with step 1 done + step 3 reachable */
test('prefill lands on step 2 (Then) with step 1 done, step 3 reachable, and a step-2 element focused', () => {
  (globalThis as any).location.hash = '';
  (S.byId('action-type')! as any).focusedCount = 0;
  (S.byId('rule-description')! as any).focusedCount = 0;
  R.prefillNewRule('my_tool', 'Prefilled description.');
  assert.equal((globalThis as any).location.hash, '#/rules/new', 'navigates to the add editor');
  R.openNewRuleForm();
  assert.equal(R.getCurrentStep(), 2, 'prefill lands on step 2 (Then)');
  assert.equal(S.byId('rule-step-then')!.hidden, false, 'step 2 visible');
  assert.equal(S.byId('rule-step-when')!.hidden, true, 'step 1 hidden');
  assert.equal(S.byId('rule-step-details')!.hidden, true, 'step 3 hidden');
  assert.ok(S.byId('rule-step-ind-1')!.classList.contains('is-done'), 'step 1 marked done (matcher pre-filled)');
  assert.ok(S.byId('rule-step-ind-2')!.classList.contains('is-current'), 'step 2 is current');
  assert.ok(S.byId('rule-step-ind-3')!.classList.contains('is-reachable'), 'step 3 is reachable');
  assert.ok((S.byId('action-type')! as any).focusedCount >= 1, 'a step-2 element (the action-type select) is focused');
  assert.equal((S.byId('rule-description')! as any).focusedCount, 0, 'the step-3 description is NOT focused');
  assert.equal(state.editingId, '', 'add mode (not edit)');
});

/* =====================================================================
 * Clarity layer (step 2): human-first labels, live per-step + combined
 * previews, the read-only target-tool chip, the addDescription actionSummary
 * fix, and the humanized "Untitled" fallback.
 * ===================================================================== */

/* ---- (11) human-first type-select labels (static + dynamic) ---------- */
test('type-select labels are human-first for all matcher + action types', () => {
  // Static-option phrases (the <span class="muted">(identifier)</span> is the
  // secondary hint; the plain phrase leads).
  assert.equal(R.matcherTypeLabel('toolName'), 'Tool name');
  assert.equal(R.matcherTypeLabel('argPattern'), 'Argument pattern');
  assert.equal(R.matcherTypeLabel('loop'), 'Loop \u00B7 repeated calls');
  assert.equal(R.matcherTypeLabel('always'), 'Always');
  assert.equal(R.actionTypeLabel('hideTool'), 'Hide tool');
  assert.equal(R.actionTypeLabel('rewriteArgs'), 'Rewrite arguments');
  assert.equal(R.actionTypeLabel('injectMessage'), 'Inject a message');
  assert.equal(R.actionTypeLabel('addDescription'), 'Add a description');
});

test('the dynamically-added addDescription option carries the human-first label', () => {
  // ensureActionTypeOption('addDescription') is reached via loadSpecIntoForm.
  R.loadSpecIntoForm({
    id: 'r-add', enabled: true,
    matcher: { type: 'toolName', toolName: 'my_tool' },
    action: { type: 'addDescription', description: 'Does useful things.' },
  });
  const sel = S.byId('action-type')!;
  const opt = sel.children.find((o: any) => o.value === 'addDescription');
  assert.ok(opt, 'an addDescription option was appended to the select');
  assert.match(String(opt.textContent), /Add a description/, 'human phrase is present');
  assert.match(String(opt.textContent), /addDescription/, 'identifier shown as the muted hint');
});

/* ---- (12) per-step preview lines are present + correct ---------------- */
test('the step 1 "When" and step 2 "Then" preview lines reflect the live form', () => {
  state.curMatcherType = 'toolName';
  state.curActionType = 'addDescription';
  (S.byId('matcher-type')! as any).value = 'toolName';
  (S.byId('action-type')! as any).value = 'addDescription';
  R.renderMatcherFields('toolName');
  R.renderActionFields('addDescription');
  setControlValue('matcher-fields', 'toolName', 'my_tool');
  setControlValue('action-fields', 'description', 'Does useful things.');
  R.updatePreviews();
  assert.equal(String(S.byId('rule-when-preview')!.textContent), 'Fires when: by tool name: my_tool', 'step 1 "When" preview');
  assert.equal(String(S.byId('rule-then-preview')!.textContent), 'Then: add a description to my_tool', 'step 2 "Then" preview');
});

test('the step previews update live as a field value changes (without re-rendering)', () => {
  state.curMatcherType = 'toolName';
  state.curActionType = 'addDescription';
  (S.byId('matcher-type')! as any).value = 'toolName';
  (S.byId('action-type')! as any).value = 'addDescription';
  R.renderMatcherFields('toolName');
  R.renderActionFields('addDescription');
  R.updatePreviews();
  assert.equal(String(S.byId('rule-when-preview')!.textContent), 'Fires when: by any tool', 'no tool name yet');
  // Change a field value + re-run the preview (as the field-change handler does).
  setControlValue('matcher-fields', 'toolName', 'read_file');
  R.updatePreviews();
  assert.equal(String(S.byId('rule-when-preview')!.textContent), 'Fires when: by tool name: read_file', 'preview updated live');
});

/* ---- (13) combined preview on the Details step ------------------------- */
test('the Details step shows the combined "When … → then …" preview + enabled state', () => {
  state.curMatcherType = 'toolName';
  state.curActionType = 'addDescription';
  (S.byId('matcher-type')! as any).value = 'toolName';
  (S.byId('action-type')! as any).value = 'addDescription';
  R.renderMatcherFields('toolName');
  R.renderActionFields('addDescription');
  setControlValue('matcher-fields', 'toolName', 'my_tool');
  setControlValue('action-fields', 'description', 'Does useful things.');
  (S.byId('rule-enabled')! as any).checked = false;
  R.updatePreviews();
  const combined = String(S.byId('rule-combined-preview')!.textContent);
  assert.match(combined, /When by tool name: my_tool/, 'combined preview states the matcher');
  assert.match(combined, /\u2192 then add a description to my_tool\./, 'combined preview states the action');
  assert.match(combined, /Disabled/, 'the disabled state is shown');
  // Flipping the enabled state updates the suffix.
  (S.byId('rule-enabled')! as any).checked = true;
  R.updatePreviews();
  assert.match(String(S.byId('rule-combined-preview')!.textContent), /Enabled/, 'the enabled state is shown');
});

/* ---- (14) the target-tool chip mirrors the matcher -------------------- */
test('the target chip names a single tool for a toolName matcher (incl. addDescription)', () => {
  state.curMatcherType = 'toolName';
  state.curActionType = 'addDescription';
  (S.byId('matcher-type')! as any).value = 'toolName';
  (S.byId('action-type')! as any).value = 'addDescription';
  R.renderMatcherFields('toolName');
  R.renderActionFields('addDescription');
  setControlValue('matcher-fields', 'toolName', 'my_tool');
  R.updatePreviews();
  assert.equal(String(S.byId('rule-target-chip')!.textContent), 'Target: my_tool', 'chip names the matcher’s single tool');
});

test('the target chip says "matching tool(s)" for an always matcher', () => {
  state.curMatcherType = 'always';
  state.curActionType = 'addDescription';
  (S.byId('matcher-type')! as any).value = 'always';
  (S.byId('action-type')! as any).value = 'addDescription';
  R.renderMatcherFields('always');
  R.renderActionFields('addDescription');
  R.updatePreviews();
  assert.equal(String(S.byId('rule-target-chip')!.textContent), 'Applies to matching tool(s)', 'always → matching tool(s)');
});

test('the target chip says "matching tool(s)" for a multi-tool (toolNames) matcher', () => {
  state.curMatcherType = 'toolName';
  state.curActionType = 'hideTool';
  (S.byId('matcher-type')! as any).value = 'toolName';
  (S.byId('action-type')! as any).value = 'hideTool';
  R.renderMatcherFields('toolName');
  R.renderActionFields('hideTool');
  setControlValue('matcher-fields', 'toolNames', 'web_search, web_fetch');
  R.updatePreviews();
  assert.equal(String(S.byId('rule-target-chip')!.textContent), 'Applies to matching tool(s)', 'multiple tools → matching tool(s)');
});

/* ---- (15) actionSummary no longer shows "—" for addDescription --------- */
test('actionSummary is human-first and no longer "—" for addDescription', () => {
  assert.equal(
    R.actionSummary({ type: 'addDescription', description: 'x' }, { type: 'toolName', toolName: 'my_tool' }),
    'add a description to my_tool',
    'single-tool target');
  assert.equal(
    R.actionSummary({ type: 'addDescription', description: 'x' }, { type: 'always' }),
    'add a description to matching tool(s)',
    'no specific tool');
  assert.notEqual(R.actionSummary({ type: 'addDescription', description: 'x' }, { type: 'always' }), '\u2014', 'no longer a dash');
  // The other action types remain human-first.
  assert.equal(R.actionSummary({ type: 'hideTool', toolNames: ['read_file'] }), 'hide read_file');
  assert.equal(R.actionSummary({ type: 'injectMessage', content: 'hi' }), 'inject a message \u00B7 \u201C' + 'hi' + '\u201D');
});

test('the rule list no longer shows "Action: —" for an addDescription rule', () => {
  const card: any = R.renderRuleRow({
    enabled: true,
    matcher: { type: 'toolName', toolName: 'read_file' },
    action: { type: 'addDescription', description: 'Reads a file' },
  });
  const body = card.children.find((c: any) => c.className === 'rc-body')!;
  const actionCell = body.children.find((cell: any) =>
    cell.children.some((c: any) => c.className === 'rc-label' && c.textContent === 'Action'))!;
  const value = actionCell.children.find((c: any) => c.className === 'rc-value')!;
  assert.equal(String(value.textContent), 'add a description to read_file', 'the action cell names the target');
  assert.notEqual(String(value.textContent), '\u2014', 'no dash in the action cell');
});

/* ---- (16) humanized "Untitled" fallback (list name + delete confirm) --- */
test('ruleLabel humanizes an unnamed rule from its matcher + action', () => {
  assert.equal(
    R.ruleLabel({ description: 'My rule', matcher: { type: 'toolName' }, action: { type: 'hideTool', toolNames: ['x'] } }),
    'My rule',
    'the description wins when set');
  assert.equal(
    R.ruleLabel({ matcher: { type: 'toolName', toolName: 'x' }, action: { type: 'hideTool', toolNames: ['x'] } }),
    'New rule \u00B7 hide x',
    'an unnamed rule derives a friendly label');
  assert.notEqual(
    R.ruleLabel({ matcher: { type: 'always' }, action: { type: 'addDescription' } }),
    'Untitled rule',
    'no more "Untitled rule"');
  assert.doesNotMatch(
    String(R.ruleLabel({ id: 'c192a017-1234-5678', matcher: { type: 'always' }, action: { type: 'hideTool', toolNames: ['x'] } })),
    /c192a017/,
    'the raw id never leaks into the label');
});

test('the delete confirmation shows the humanized label, not the raw id', async () => {
  const savedConfirm = (globalThis as any).window.confirm;
  let captured = '';
  (globalThis as any).window.confirm = (msg: unknown) => { captured = String(msg); return true; };
  try {
    await R.deleteRule({
      id: 'c192a017-dead-beef',
      enabled: true,
      matcher: { type: 'toolName', toolName: 'x' },
      action: { type: 'hideTool', toolNames: ['x'] },
    });
    await flush();
  } finally {
    (globalThis as any).window.confirm = savedConfirm;
  }
  assert.match(captured, /New rule \u00B7 hide x/, 'the confirm names the rule humanly');
  assert.doesNotMatch(captured, /c192a017-dead-beef/, 'the raw id is not shown');
});

/* =====================================================================
 * hideTool block-list vs allow-list support (dashboard): the toolNames field
 * is a block-list by default (hide the matching tools) or an allow-list when
 * any entry starts with ! (keep only the matching tools, hide the rest), and
 * the actionSummary, the step-2 "Then" preview, and the action-aware target
 * chip all reflect block vs allow.
 * ===================================================================== */

/* ---- (17) the toolNames field accepts patterns without splitting on * / ! */
test('the hideTool toolNames field accepts patterns without splitting on * or !', () => {
  state.curMatcherType = 'always';
  state.curActionType = 'hideTool';
  (S.byId('matcher-type')! as any).value = 'always';
  (S.byId('action-type')! as any).value = 'hideTool';
  R.renderMatcherFields('always');
  R.renderActionFields('hideTool');
  // Comma-separated pattern + exact name: * and ! are never split points.
  setControlValue('action-fields', 'toolNames', 'codebase_*,webfetch');
  const r1 = R.collectSpec();
  assert.equal(r1.error, undefined, 'no parse error');
  assert.deepEqual(r1.spec.action.toolNames, ['codebase_*', 'webfetch'], 'pattern + exact name parse (not split on * or !)');
  // Line-separated + a negation preserved.
  setControlValue('action-fields', 'toolNames', '!codebase_*\nwebfetch');
  const r2 = R.collectSpec();
  assert.deepEqual(r2.spec.action.toolNames, ['!codebase_*', 'webfetch'], 'negation (!) preserved; entries are line- or comma-separated');
  // Whitespace around entries is trimmed.
  setControlValue('action-fields', 'toolNames', '  codebase_* ,  webfetch  ');
  const r3 = R.collectSpec();
  assert.deepEqual(r3.spec.action.toolNames, ['codebase_*', 'webfetch'], 'entries are trimmed');
});

/* ---- (18) the field's label + hint explain block-list vs allow-list ---- */
test('the hideTool field label + hint explain the block-list vs allow-list semantics', () => {
  const field = schema.ACTION_FIELDS.hideTool[0];
  assert.equal(field.key, 'toolNames', 'the toolNames field is the hideTool target');
  assert.match(field.label, /tool/i, 'the label still names the tools');
  assert.match(field.hint, /block-list/i, 'the hint states the field is a block-list by default');
  assert.match(field.hint, /allow-list/i, 'the hint explains the ! allow-list');
  assert.match(field.hint, /\*/, 'the hint mentions the * wildcard');
  assert.match(field.hint, /!codebase_\*/, 'the hint gives the !codebase_* example');
  assert.match(field.hint, /!knowledge_/, 'the hint gives the multi allow-list example (!knowledge_*)');
});

/* ---- (19) the block-list vs allow-list actionSummary ------------------- */
test('actionSummary reflects hideTool block-list vs allow-list semantics', () => {
  assert.equal(R.actionSummary({ type: 'hideTool', toolNames: ['webfetch'] }), 'hide webfetch', 'block single exact name');
  assert.equal(R.actionSummary({ type: 'hideTool', toolNames: ['codebase_*'] }), 'hide codebase_*', 'block single pattern');
  assert.equal(R.actionSummary({ type: 'hideTool', toolNames: ['codebase_*', 'webfetch'] }), 'hide 2 tools', 'block several (2) tools');
  assert.equal(R.actionSummary({ type: 'hideTool', toolNames: ['a', 'b', 'c'] }), 'hide 3 tools', 'block several (3) tools');
  assert.equal(R.actionSummary({ type: 'hideTool', toolNames: ['!codebase_*'] }), 'hide all except codebase_*', 'allow single');
  assert.equal(R.actionSummary({ type: 'hideTool', toolNames: ['!knowledge_*', '!codebase_*'] }), 'hide all except knowledge_* + codebase_*', 'allow multi (union)');
  assert.equal(R.actionSummary({ type: 'hideTool', toolNames: ['!knowledge_*', 'webfetch'] }), 'hide all except knowledge_* + webfetch', 'mixed entries = allow-list (union)');
  assert.equal(R.actionSummary({ type: 'hideTool', toolNames: [] }), 'hide tools', 'empty falls back');
});

/* ---- (20) the step-2 "Then" preview reflects block-list vs allow-list -- */
test('the step 2 "Then" preview reflects hideTool block-list vs allow-list semantics', () => {
  state.curMatcherType = 'always';
  state.curActionType = 'hideTool';
  (S.byId('matcher-type')! as any).value = 'always';
  (S.byId('action-type')! as any).value = 'hideTool';
  R.renderMatcherFields('always');
  R.renderActionFields('hideTool');
  setControlValue('action-fields', 'toolNames', 'codebase_*');
  R.updatePreviews();
  assert.equal(String(S.byId('rule-then-preview')!.textContent), 'Then: hide codebase_*', 'block single pattern');
  setControlValue('action-fields', 'toolNames', 'codebase_*,webfetch');
  R.updatePreviews();
  assert.equal(String(S.byId('rule-then-preview')!.textContent), 'Then: hide 2 tools', 'block several');
  setControlValue('action-fields', 'toolNames', '!codebase_*');
  R.updatePreviews();
  assert.equal(String(S.byId('rule-then-preview')!.textContent), 'Then: hide all except codebase_*', 'allow single');
  setControlValue('action-fields', 'toolNames', '!knowledge_*,!codebase_*');
  R.updatePreviews();
  assert.equal(String(S.byId('rule-then-preview')!.textContent), 'Then: hide all except knowledge_* + codebase_*', 'allow multi (union)');
});

/* ---- (21) the target chip is action-aware for hideTool (block vs allow) */
test('the target chip is action-aware for hideTool (block-list vs allow-list)', () => {
  state.curMatcherType = 'always';
  state.curActionType = 'hideTool';
  (S.byId('matcher-type')! as any).value = 'always';
  (S.byId('action-type')! as any).value = 'hideTool';
  R.renderMatcherFields('always');
  R.renderActionFields('hideTool');
  R.updatePreviews();
  assert.equal(String(S.byId('rule-target-chip')!.textContent), 'Applies to matching tool(s)', 'empty field → matcher fallback (always)');
  setControlValue('action-fields', 'toolNames', 'codebase_*');
  R.updatePreviews();
  assert.equal(String(S.byId('rule-target-chip')!.textContent), 'Target: codebase_*', 'block single pattern');
  setControlValue('action-fields', 'toolNames', 'webfetch');
  R.updatePreviews();
  assert.equal(String(S.byId('rule-target-chip')!.textContent), 'Target: webfetch', 'block single exact name');
  setControlValue('action-fields', 'toolNames', 'codebase_*,webfetch');
  R.updatePreviews();
  assert.equal(String(S.byId('rule-target-chip')!.textContent), 'Target: 2 tools', 'block several');
  setControlValue('action-fields', 'toolNames', '!codebase_*');
  R.updatePreviews();
  assert.equal(String(S.byId('rule-target-chip')!.textContent), 'Target: all except codebase_*', 'allow single');
  setControlValue('action-fields', 'toolNames', '!knowledge_*,!codebase_*');
  R.updatePreviews();
  assert.equal(String(S.byId('rule-target-chip')!.textContent), 'Target: all except knowledge_* + codebase_*', 'allow multi (union)');
});
