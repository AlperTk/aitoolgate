/**
 * JSON-serializable rule descriptor + builders over the existing policy engine.
 *
 * A {@link RuleSpec} is the wire form a REST client POSTs/PATCHes. It mirrors
 * the scalar fields of {@link PolicyRule} and carries a {@link MatcherSpec} /
 * {@link ActionSpec} discriminated by `type`, each of which maps onto the REAL
 * factory option types of the existing policy engine:
 *
 * - matchers: `createToolNameMatcher` (ToolNameMatcherConfig) /
 *   `createArgPatternMatcher` (ArgPatternMatcherConfig) /
 *   `createLoopDetector` (LoopDetectorOptions) — all return a `PolicyMatcher`
 *   directly (no `toPortMatcher` needed; `PolicyRule.matcher` is a `PolicyMatcher`).
 * - actions: `createBlockAction` / `createHideToolAction` /
 *   `createRewriteArgsAction` / `createInjectMessageAction` — all return a port
 *   `Action`, cast to the concrete effect-returning `PolicyAction`.
 *
 * The inverse, {@link describeRule}, is best-effort display-only: matchers and
 * actions are closures that cannot be introspected, so lossless reconstruction
 * requires carrying the original spec (the HTTP layer stores submitted specs in
 * `options.specs` and prefers them over this fallback).
 */
import { randomUUID } from 'node:crypto';
import type { Action, PolicyMatcher } from '../policy/types';
import type { PolicyAction, PolicyRule } from '../policy/ruleEngine';
import {
  createLoopDetector,
  createToolNameMatcher,
  createArgPatternMatcher,
} from '../policy/matchers';
import type { LoopDetectorOptions } from '../policy/matchers';
import {
  createBlockAction,
  createHideToolAction,
  createRewriteArgsAction,
  createInjectMessageAction,
} from '../policy/actions';
import type {
  BlockActionConfig,
  HideToolActionConfig,
  RewriteArgsActionConfig,
  InjectMessageActionConfig,
} from '../policy/actions';

/** JSON-serializable matcher descriptor, discriminated by `type`. */
export type MatcherSpec =
  | {
      /** Match tool calls by name (`toolName` and/or `toolNames`). */
      type: 'toolName';
      /** A single tool name to match. */
      toolName?: string;
      /** Additional tool names to match (OR-ed with `toolName`). */
      toolNames?: string[];
    }
  | {
      /** Match a tool call's serialized arguments against a pattern. */
      type: 'argPattern';
      /** Restrict to this tool name (omit to apply to all). */
      toolName?: string;
      /** Restrict to these tool names (OR-ed; omit for all). */
      toolNames?: string[];
      /** Case-sensitive pattern tested against serialized arguments. */
      pattern: string | RegExp;
    }
  | {
      /** Detect a run of consecutive identical tool calls. */
      type: 'loop';
      /** Consecutive identical calls to flag (default `4`). */
      window?: number;
      /** When `true` (default) the run must be at the tail of the sequence. */
      requireConsecutive?: boolean;
      /** How to compare call arguments (default `'normalized'`). */
      paramIdentity?: 'exact' | 'normalized';
      /** How to compare tool results (default `'normalized'`). */
      resultIdentity?: 'exact' | 'normalized';
  };

/** JSON-serializable action descriptor, discriminated by `type`. */
export type ActionSpec =
  | {
      /** Block the matched tool call(s), returning a (never-silent) message. */
      type: 'block';
      /** Reason substituted for `{reason}` in the message. */
      reason?: string;
      /** Message emitted verbatim (takes precedence over `template`). */
      message?: string;
      /** Message template with `{tool}` / `{reason}` placeholders. */
      template?: string;
    }
  | {
      /** Hide the named tools from the model's available tool set. */
      type: 'hideTool';
      /** Names of the tools to hide. */
      toolNames: string[];
    }
  | {
      /** Rewrite a tool call's arguments before it reaches the executor. */
      type: 'rewriteArgs';
      /** Target tool call by name (used when `toolCallId` is absent/unmatched). */
      toolName?: string;
      /** Target tool call by id (takes precedence over `toolName`). */
      toolCallId?: string;
      /** Argument changes to apply: a full replacement or a partial merge. */
      arguments: Record<string, unknown>;
      /** How to apply `arguments`: `replace` (default) or `merge`. */
      mode?: 'replace' | 'merge';
    }
  | {
      /** Inject an additional message into the stream. */
      type: 'injectMessage';
      /** Role of the injected message (defaults to `'user'`). */
      role?: 'user' | 'system';
      /** Message content to inject into the stream. */
      content: string;
  };

/** A JSON-serializable rule, mirroring the scalar fields of {@link PolicyRule}. */
export interface RuleSpec {
  /** Unique rule id; assigned (`randomUUID`) when omitted. */
  id?: string;
  /** Whether the rule participates in evaluation. */
  enabled: boolean;
  /** Ordering: lower runs earlier; a missing priority sorts after explicit ones. */
  priority?: number;
  /** Human description (used as the display label). */
  description?: string;
  matcher: MatcherSpec;
  action: ActionSpec;
}

/** Type guard: a non-null, non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Cast a port-action factory result to the concrete engine-facing shape. */
function asPolicyAction(action: Action): PolicyAction {
  return action as PolicyAction;
}

/**
 * Build a concrete {@link PolicyMatcher} from a {@link MatcherSpec}, dispatching
 * on `type` to the right existing factory. Throws a descriptive error when a
 * required field for the chosen `type` is missing. Unknown extra fields are
 * ignored.
 */
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
  }
}

/**
 * Build a concrete {@link PolicyAction} from an {@link ActionSpec}, dispatching
 * on `type` to the right existing factory (each returns a port `Action`, cast
 * to the effect-returning `PolicyAction`). Throws a descriptive error when a
 * required field for the chosen `type` is missing. Unknown extra fields are
 * ignored.
 */
export function buildAction(spec: ActionSpec): PolicyAction {
  switch (spec.type) {
    case 'block': {
      const config: BlockActionConfig = {};
      if (typeof spec.reason === 'string') config.reason = spec.reason;
      if (typeof spec.message === 'string') config.message = spec.message;
      if (typeof spec.template === 'string') config.template = spec.template;
      return asPolicyAction(createBlockAction(config));
    }
    case 'hideTool': {
      if (!Array.isArray(spec.toolNames)) {
        throw new Error('action "hideTool" requires a "toolNames" array');
      }
      const config: HideToolActionConfig = { toolNames: spec.toolNames };
      return asPolicyAction(createHideToolAction(config));
    }
    case 'rewriteArgs': {
      if (!isRecord(spec.arguments)) {
        throw new Error('action "rewriteArgs" requires an "arguments" object');
      }
      const config: RewriteArgsActionConfig = { arguments: spec.arguments };
      if (typeof spec.toolName === 'string') config.toolName = spec.toolName;
      if (typeof spec.toolCallId === 'string') config.toolCallId = spec.toolCallId;
      if (spec.mode === 'replace' || spec.mode === 'merge') config.mode = spec.mode;
      return asPolicyAction(createRewriteArgsAction(config));
    }
    case 'injectMessage': {
      if (typeof spec.content !== 'string') {
        throw new Error('action "injectMessage" requires a "content" string');
      }
      const config: InjectMessageActionConfig = { content: spec.content };
      if (spec.role === 'user' || spec.role === 'system') config.role = spec.role;
      return asPolicyAction(createInjectMessageAction(config));
    }
  }
}

/**
 * Build a concrete {@link PolicyRule} from a {@link RuleSpec}. Assigns
 * `id: spec.id ?? randomUUID()`. Throws a descriptive error if a required field
 * for the chosen matcher/action `type` is missing. Unknown extra fields are
 * ignored.
 */
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

/**
 * Best-effort display inverse of {@link buildRuleFromSpec}.
 *
 * Copy the scalar fields (`id` / `enabled` / `priority` / `description`) and
 * emit a *representative* descriptor for the non-introspectable matcher/action.
 * The flagship rule is a known loop detector, so it gets a `loop` descriptor;
 * everything else falls back to a neutral valid placeholder that never crashes.
 * NOTE: this is NOT lossless — matchers/actions are closures; carrying the
 * original {@link RuleSpec} (which the HTTP layer stores) is what makes
 * round-tripping exact.
 */
export function describeRule(rule: PolicyRule): RuleSpec {
  const loopDescriptor: MatcherSpec =
    rule.id === 'flagship-loop-rule'
      ? { type: 'loop', window: 4, requireConsecutive: true, paramIdentity: 'normalized', resultIdentity: 'normalized' }
      : { type: 'toolName', toolNames: [] };
  return {
    id: rule.id,
    enabled: rule.enabled,
    priority: rule.priority,
    description: rule.description,
    matcher: loopDescriptor,
    // A neutral, always-valid placeholder: effect config is not recoverable from the closure.
    action: { type: 'injectMessage', content: rule.description ?? '(unrecoverable action)' },
  };
}

const KNOWN_MATCHER_TYPES = new Set<['toolName' | 'argPattern' | 'loop'][number]>([
  'toolName',
  'argPattern',
  'loop',
]);

const KNOWN_ACTION_TYPES = new Set<['block' | 'hideTool' | 'rewriteArgs' | 'injectMessage'][number]>([
  'block',
  'hideTool',
  'rewriteArgs',
  'injectMessage',
]);

/** Validate the `matcher` member of a spec; returns an error message or `null`. */
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
    default:
      break;
  }
  return null;
}

/** Validate the `action` member of a spec; returns an error message or `null`. */
function validateAction(value: unknown): string | null {
  if (!isRecord(value)) return 'must be an object';
  const t = value.type;
  if (t === undefined) return 'missing "type"';
  if (typeof t !== 'string' || !KNOWN_ACTION_TYPES.has(t as 'block')) {
    return `unknown action type ${JSON.stringify(t)}`;
  }
  switch (t) {
    case 'hideTool':
      if (!Array.isArray(value.toolNames)) return 'missing required "toolNames" array';
      break;
    case 'rewriteArgs':
      if (!isRecord(value.arguments)) return 'missing required "arguments" object';
      break;
    case 'injectMessage':
      if (typeof value.content !== 'string') return 'missing required "content" string';
      break;
    default:
      break;
  }
  return null;
}

/**
 * Validate an unknown candidate {@link RuleSpec}. Returns `null` when valid,
 * else a human-readable error message. Checks: the value is an object;
 * `enabled` is a boolean; `matcher` and `action` are present objects with a
 * known `type` and the required fields for that `type`; optional scalar fields
 * (`id` / `priority` / `description`) have the right types when provided.
 */
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
