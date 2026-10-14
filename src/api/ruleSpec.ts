/** JSON-serializable rule descriptor + builders over the policy engine; `describeRule` is best-effort only (lossless round-trips require storing the original spec). */
import { randomUUID } from 'node:crypto';
import type { ActionEffectKind, PolicyMatcher } from '../policy/types';
import type { PolicyAction, PolicyRule } from '../policy/ruleEngine';
import {
  createLoopDetector,
  createToolNameMatcher,
  createArgPatternMatcher,
  createAlwaysMatcher,
  ALWAYS_MATCHER_BRAND,
} from '../policy/matchers';
import type { LoopDetectorOptions, AlwaysMatcher } from '../policy/matchers';
import { ACTION_STRATEGIES } from '../policy/actions';

export type MatcherSpec =
  | {
      type: 'toolName';
      toolName?: string;
      toolNames?: string[];
    }
  | {
      type: 'argPattern';
      toolName?: string;
      toolNames?: string[];
      pattern: string | RegExp;
    }
  | {
      type: 'loop';
      window?: number;
      requireConsecutive?: boolean;
      paramIdentity?: 'exact' | 'normalized';
      resultIdentity?: 'exact' | 'normalized';
    }
  | {
      /** Unconditionally match every request (fires on all phases, including turn-1). */
      type: 'always';
  };

export type ActionSpec =
  | {
      type: 'hideTool';
      /** Tool names to hide: a block-list by default, or an allow-list when any entry starts with `!` (exact names or anchored globs); non-empty strings. */
      toolNames: string[];
    }
  | {
      type: 'rewriteArgs';
      toolName?: string;
      /** Target tool call by id (takes precedence over `toolName`). */
      toolCallId?: string;
      arguments: Record<string, unknown>;
      mode?: 'replace' | 'merge';
    }
  | {
      type: 'injectMessage';
      role?: 'user' | 'system';
      content: string;
  }
  | {
      type: 'addDescription';
      description: string;
  };

export interface RuleSpec {
  /** Unique rule id; assigned (`randomUUID`) when omitted. */
  id?: string;
  enabled: boolean;
  /** Ordering: lower runs earlier; a missing priority sorts after explicit ones. */
  priority?: number;
  description?: string;
  matcher: MatcherSpec;
  action: ActionSpec;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAlwaysMatcher(matcher: PolicyMatcher): boolean {
  return (matcher as AlwaysMatcher)[ALWAYS_MATCHER_BRAND] === true;
}

/** Build a concrete PolicyMatcher from a MatcherSpec; throws on a missing required field, ignores unknown extras. */
export function buildMatcher(spec: MatcherSpec): PolicyMatcher {
  switch (spec.type) {
    case 'toolName':
      return createToolNameMatcher({ toolName: spec.toolName, toolNames: spec.toolNames });
    case 'argPattern': {
      if (typeof spec.pattern !== 'string' && !(spec.pattern instanceof RegExp)) {
        throw new Error('matcher "argPattern" requires a "pattern" (a string or RegExp)');
      }
      return createArgPatternMatcher({
        toolName: spec.toolName,
        toolNames: spec.toolNames,
        pattern: spec.pattern,
      });
    }
    case 'loop': {
      const options: LoopDetectorOptions = {};
      if (typeof spec.window === 'number') options.window = spec.window;
      if (typeof spec.requireConsecutive === 'boolean') options.requireConsecutive = spec.requireConsecutive;
      if (spec.paramIdentity === 'exact' || spec.paramIdentity === 'normalized') options.paramIdentity = spec.paramIdentity;
      if (spec.resultIdentity === 'exact' || spec.resultIdentity === 'normalized') options.resultIdentity = spec.resultIdentity;
      return createLoopDetector(options);
    }
    case 'always':
      // Unconditional: fire on every request (including a fresh turn-1).
      return createAlwaysMatcher();
  }
}

/** Build a concrete PolicyAction from an ActionSpec via the action-strategy registry (adding an action needs no edit here). */
export function buildAction(spec: ActionSpec): PolicyAction {
  return ACTION_STRATEGIES[spec.type].buildSpec(spec);
}

/** Build a concrete PolicyRule from a RuleSpec (assigns an id when omitted). */
export function buildRuleFromSpec(spec: RuleSpec): PolicyRule {
  const id = spec.id ?? randomUUID();
  return {
    id,
    enabled: spec.enabled,
    priority: spec.priority,
    description: spec.description,
    matcher: buildMatcher(spec.matcher),
    action: buildAction(spec.action),
  };
}

/** Best-effort, non-lossless display inverse of `buildRuleFromSpec`; round-trips exactly only if the original spec is stored. */
/** Best-effort action descriptor derived from the closure's readable `name`. */
function describeAction(rule: PolicyRule): ActionSpec {
  switch (rule.action.name) {
    case 'hideTool':
      return { type: 'hideTool', toolNames: [] };
    case 'rewriteArgs':
      return { type: 'rewriteArgs', arguments: {} };
    case 'addDescription':
      return { type: 'addDescription', description: rule.description ?? '' };
    default:
      return { type: 'injectMessage', content: rule.description ?? '(unrecoverable action)' };
  }
}

export function describeRule(rule: PolicyRule): RuleSpec {
  let matcherDescriptor: MatcherSpec;
  if (rule.id === 'flagship-loop-rule') {
    matcherDescriptor = {
      type: 'loop',
      window: 4,
      requireConsecutive: true,
      paramIdentity: 'normalized',
      resultIdentity: 'normalized',
    };
  } else if (isAlwaysMatcher(rule.matcher)) {
    // The unconditional matcher is recognizable via its brand, so render it faithfully.
    matcherDescriptor = { type: 'always' };
  } else {
    // A neutral, valid placeholder: a generic matcher's config is not recoverable from the closure.
    matcherDescriptor = { type: 'toolName', toolNames: [] };
  }
  return {
    id: rule.id,
    enabled: rule.enabled,
    priority: rule.priority,
    description: rule.description,
    matcher: matcherDescriptor,
    // Derive the action type from the closure's readable `name`; params are unrecoverable, so emit valid placeholders.
    action: describeAction(rule),
  };
}

const KNOWN_MATCHER_TYPES = new Set<['toolName' | 'argPattern' | 'loop' | 'always'][number]>([
  'toolName',
  'argPattern',
  'loop',
  'always',
]);

/** Known action types, derived from the registry so newly registered actions are picked up automatically. */
const KNOWN_ACTION_TYPES = new Set<ActionEffectKind>(Object.keys(ACTION_STRATEGIES) as ActionEffectKind[]);

function validateMatcher(value: unknown): string | null {
  if (!isRecord(value)) return 'must be an object';
  const t = value.type;
  if (t === undefined) return 'missing "type"';
  if (typeof t !== 'string' || !KNOWN_MATCHER_TYPES.has(t as 'toolName')) {
    return `unknown matcher type ${JSON.stringify(t)}`;
  }
  switch (t) {
    case 'argPattern':
      if (value.pattern === undefined) return 'missing required "pattern"';
      if (typeof value.pattern !== 'string' && !(value.pattern instanceof RegExp)) {
        return '"pattern" must be a string or RegExp';
      }
      break;
    case 'loop':
      if (value.window !== undefined && typeof value.window !== 'number') {
        return '"window" must be a number when provided';
      }
      break;
    case 'always':
      // Unconditional: no fields are required.
      break;
    default:
      break;
  }
  return null;
}

function validateAction(value: unknown): string | null {
  if (!isRecord(value)) return 'must be an object';
  const t = value.type;
  if (t === undefined) return 'missing "type"';
  if (typeof t !== 'string' || !KNOWN_ACTION_TYPES.has(t as ActionEffectKind)) {
    return `unknown action type ${JSON.stringify(t)}`;
  }
  return ACTION_STRATEGIES[t as ActionEffectKind].validateSpec(value);
}

/** Validate a candidate RuleSpec; returns null when valid, else an error message. */
export function validateSpec(value: unknown): string | null {
  if (!isRecord(value)) return 'spec must be an object';
  if (typeof value.enabled !== 'boolean') return '"enabled" must be a boolean';
  if (value.matcher === undefined) return 'missing "matcher"';
  const matcherError = validateMatcher(value.matcher);
  if (matcherError !== null) return `matcher ${matcherError}`;
  if (value.action === undefined) return 'missing "action"';
  const actionError = validateAction(value.action);
  if (actionError !== null) return `action ${actionError}`;
  if (value.id !== undefined && typeof value.id !== 'string') return '"id" must be a string when provided';
  if (value.priority !== undefined && typeof value.priority !== 'number') {
    return '"priority" must be a number when provided';
  }
  if (value.description !== undefined && typeof value.description !== 'string') {
    return '"description" must be a string when provided';
  }
  return null;
}
