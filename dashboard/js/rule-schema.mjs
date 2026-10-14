/* ==========================================================================
 * aitoolgate dashboard — dynamic rule-form field schemas.
 *
 * Each dynamic form control is described here by `kind`. Feature modules
 * (`readField` and `makeField`) interpret `kind`, and `clientValidate`
 * enforces the required fields the server's validateSpec also requires. This
 * keeps the emitted RuleSpec in sync with src/api/ruleSpec.ts without any
 * framework. Zero dependencies; no imports.
 *
 * Field labels and hints are written human-first: the plain phrase leads and
 * internal jargon is dropped or deferred to the value itself. The type-select
 * labels (matcher / action type) live in js/rules.mjs.
 * ========================================================================== */

export const MATCHER_FIELDS = {
  loop: [
    { key: 'window', label: 'Window', kind: 'number', hint: 'How many repeated calls in a row to flag (server default 4)' },
    { key: 'requireConsecutive', label: 'Require consecutive', kind: 'bool', def: true, hint: 'Only flag when the repeated calls are the most recent in the run' },
    { key: 'paramIdentity', label: 'Param identity', kind: 'select', options: ['', 'exact', 'normalized'], hint: 'How the repeated arguments are compared. Blank = default (normalized).' },
    { key: 'resultIdentity', label: 'Result identity', kind: 'select', options: ['', 'exact', 'normalized'], hint: 'How the repeated results are compared. Blank = default (normalized).' }
  ],
  toolName: [
    { key: 'toolName', label: 'Tool name', kind: 'text', hint: 'A single tool to match' },
    { key: 'toolNames', label: 'Tool names', kind: 'list', hint: 'Comma-separated list of tools; matches any listed name' }
  ],
  argPattern: [
    { key: 'toolName', label: 'Tool name', kind: 'text', hint: 'Restrict to this tool (leave blank to match any tool)' },
    { key: 'toolNames', label: 'Tool names', kind: 'list', hint: 'Comma-separated list of tools (leave blank to match any tool)' },
    { key: 'pattern', label: 'Argument pattern', kind: 'text', required: true, hint: 'A case-sensitive pattern (regex) matched against the tool’s arguments' }
  ]
};

export const ACTION_FIELDS = {
  hideTool: [
    {
      key: 'toolNames',
      label: 'Tools to hide',
      kind: 'list',
      required: true,
      hint: 'Tool name(s) or patterns — a block-list by default (hide the matching tools). Add a leading ! to any entry to make it an allow-list (keep only the matching tools, hide the rest). E.g. serena_* hides serena tools; !serena_* keeps only serena tools; !graphify_*, !serena_* keeps only graphify + serena tools. * = wildcard; entries are OR-combined.'
    }
  ],
  rewriteArgs: [
    { key: 'toolName', label: 'Tool name', kind: 'text', hint: 'Target this tool by name' },
    { key: 'toolCallId', label: 'Tool call id', kind: 'text', hint: 'Target a specific call by id (takes precedence over the name)' },
    { key: 'arguments', label: 'Arguments (JSON object)', kind: 'json', required: true, hint: 'A JSON object of new arguments — a full replacement or a partial merge' },
    { key: 'mode', label: 'Mode', kind: 'select', options: ['', 'replace', 'merge'], hint: 'replace = swap all arguments; merge = update only the listed keys. Blank = default (replace).' }
  ],
  injectMessage: [
    { key: 'role', label: 'Role', kind: 'select', options: ['', 'user', 'system'], hint: 'Which role the message appears as. Blank = default (user).' },
    { key: 'content', label: 'Content', kind: 'area', required: true, hint: 'The message text shown to the model' }
  ]
};
