/* ==========================================================================
 * aitoolgate dashboard — dynamic rule-form field schemas.
 *
 * Each dynamic form control is described here by `kind`. Feature modules
 * (`readField` and `makeField`) interpret `kind`, and `clientValidate`
 * enforces the required fields the server's validateSpec also requires. This
 * keeps the emitted RuleSpec in sync with src/api/ruleSpec.ts without any
 * framework. Only import: the i18n `t()` for labels and hints.
 *
 * Field labels and hints are written human-first: the plain phrase leads and
 * internal jargon is dropped or deferred to the value itself. The type-select
 * labels (matcher / action type) live in js/rules/rule-summary.mjs, re-exported via js/rules/rules.mjs.
 *
 * Label and hint are getters so each read re-translates on locale change.
 * ========================================================================== */
import { t } from '../i18n/index.mjs';

export const MATCHER_FIELDS = {
  loop: [
    { key: 'window', get label() { return t('schema.loop.window.label'); }, kind: 'number', get hint() { return t('schema.loop.window.hint'); } },
    { key: 'requireConsecutive', get label() { return t('schema.loop.requireConsecutive.label'); }, kind: 'bool', def: true, get hint() { return t('schema.loop.requireConsecutive.hint'); } },
    { key: 'paramIdentity', get label() { return t('schema.loop.paramIdentity.label'); }, kind: 'select', options: ['', 'exact', 'normalized'], get hint() { return t('schema.loop.paramIdentity.hint'); } },
    { key: 'resultIdentity', get label() { return t('schema.loop.resultIdentity.label'); }, kind: 'select', options: ['', 'exact', 'normalized'], get hint() { return t('schema.loop.resultIdentity.hint'); } }
  ],
  toolName: [
    { key: 'toolName', get label() { return t('schema.toolName.toolName.label'); }, kind: 'text', get hint() { return t('schema.toolName.toolName.hint'); } },
    { key: 'toolNames', get label() { return t('schema.toolName.toolNames.label'); }, kind: 'list', get hint() { return t('schema.toolName.toolNames.hint'); } }
  ],
  argPattern: [
    { key: 'toolName', get label() { return t('schema.argPattern.toolName.label'); }, kind: 'text', get hint() { return t('schema.argPattern.toolName.hint'); } },
    { key: 'toolNames', get label() { return t('schema.argPattern.toolNames.label'); }, kind: 'list', get hint() { return t('schema.argPattern.toolNames.hint'); } },
    { key: 'pattern', get label() { return t('schema.argPattern.pattern.label'); }, kind: 'text', required: true, get hint() { return t('schema.argPattern.pattern.hint'); } }
  ]
};

export const ACTION_FIELDS = {
  hideTool: [
    {
      key: 'toolNames',
      get label() { return t('schema.hideTool.toolNames.label'); },
      kind: 'list',
      required: true,
      get hint() { return t('schema.hideTool.toolNames.hint'); }
    }
  ],
  rewriteArgs: [
    { key: 'toolName', get label() { return t('schema.rewriteArgs.toolName.label'); }, kind: 'text', get hint() { return t('schema.rewriteArgs.toolName.hint'); } },
    { key: 'toolCallId', get label() { return t('schema.rewriteArgs.toolCallId.label'); }, kind: 'text', get hint() { return t('schema.rewriteArgs.toolCallId.hint'); } },
    { key: 'arguments', get label() { return t('schema.rewriteArgs.arguments.label'); }, kind: 'json', required: true, get hint() { return t('schema.rewriteArgs.arguments.hint'); } },
    { key: 'mode', get label() { return t('schema.rewriteArgs.mode.label'); }, kind: 'select', options: ['', 'replace', 'merge'], get hint() { return t('schema.rewriteArgs.mode.hint'); } }
  ],
  injectMessage: [
    { key: 'role', get label() { return t('schema.injectMessage.role.label'); }, kind: 'select', options: ['', 'user', 'system'], get hint() { return t('schema.injectMessage.role.hint'); } },
    { key: 'content', get label() { return t('schema.injectMessage.content.label'); }, kind: 'area', required: true, get hint() { return t('schema.injectMessage.content.hint'); } }
  ]
};
