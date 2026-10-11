/* ==========================================================================
 * aitoolgate dashboard — dynamic rule-form field schemas.
 *
 * Each dynamic form control is described here by `kind`. Feature modules
 * (`readField` and `makeField`) interpret `kind`, and `clientValidate`
 * enforces the required fields the server's validateSpec also requires. This
 * keeps the emitted RuleSpec in sync with src/api/ruleSpec.ts without any
 * framework. Zero dependencies; no imports.
 * ========================================================================== */

export const MATCHER_FIELDS = {
  loop: [
    { key: 'window', label: 'Window', kind: 'number', hint: 'Consecutive identical calls to flag (server default 4)' },
    { key: 'requireConsecutive', label: 'Require consecutive', kind: 'bool', def: true, hint: 'The run must sit at the tail of the sequence' },
    { key: 'paramIdentity', label: 'Param identity', kind: 'select', options: ['', 'exact', 'normalized'], hint: 'How repeated args are compared: exact vs normalized. Blank = default (normalized).' },
    { key: 'resultIdentity', label: 'Result identity', kind: 'select', options: ['', 'exact', 'normalized'], hint: 'How results are compared: exact vs normalized. Blank = default (normalized).' }
  ],
  toolName: [
    { key: 'toolName', label: 'Tool name', kind: 'text', hint: 'A single tool to match' },
    { key: 'toolNames', label: 'Tool names', kind: 'list', hint: 'Comma-separated; OR-ed with the single name' }
  ],
  argPattern: [
    { key: 'toolName', label: 'Tool name', kind: 'text', hint: 'Restrict to this tool (omit for all)' },
    { key: 'toolNames', label: 'Tool names', kind: 'list', hint: 'Comma-separated; omit for all' },
    { key: 'pattern', label: 'Argument pattern', kind: 'text', required: true, hint: 'Case-sensitive, matched against serialized args' }
  ]
};

export const ACTION_FIELDS = {
  hideTool: [
    { key: 'toolNames', label: 'Tools to hide', kind: 'list', required: true, hint: 'Comma-separated tool names' }
  ],
  rewriteArgs: [
    { key: 'toolName', label: 'Tool name', kind: 'text', hint: 'Target by name' },
    { key: 'toolCallId', label: 'Tool call id', kind: 'text', hint: 'Takes precedence over the name' },
    { key: 'arguments', label: 'Arguments (JSON object)', kind: 'json', required: true, hint: 'Full replacement or partial merge' },
    { key: 'mode', label: 'Mode', kind: 'select', options: ['', 'replace', 'merge'], hint: 'replace = swap all arguments; merge = update only listed keys. Blank = default (replace).' }
  ],
  injectMessage: [
    { key: 'role', label: 'Role', kind: 'select', options: ['', 'user', 'system'], hint: 'Which role the injected message appears as. Blank = default (user).' },
    { key: 'content', label: 'Content', kind: 'area', required: true, hint: 'Text injected into the stream' }
  ]
};
