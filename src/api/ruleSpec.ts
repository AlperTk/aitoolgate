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
 * - actions: `createHideToolAction` /
 *   `createRewriteArgsAction` / `createInjectMessageAction` /
 *   `createAddDescriptionAction` — all return a port
 *   `Action`, cast to the concrete effect-returning `PolicyAction`.
 *
 * The inverse, {@link describeRule}, is best-effort display-only: matchers and
 * actions are closures that cannot be introspected, so lossless reconstruction
 * requires carrying the original spec (the HTTP layer stores submitted specs in
 * `options.specs` and prefers them over this fallback).
 */
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
    }
  | {
      /** Unconditionally match every request (fires on all phases, including turn-1). */
      type: 'always';
  };

/** JSON-serializable action descriptor, discriminated by `type`. */
export type ActionSpec =
  | {
      /** Hide the named tools from the model's available tool set. */
      type: 'hideTool';
      /**
       * Tool names (exact or glob patterns) to hide. The entries form EITHER a
       * **block-list** (no entry starts with `!`) — hide every tool whose name matches
       * any entry's base pattern — OR an **allow-list** (at least one entry starts
       * with `!`) — keep only the tools matching any entry's base pattern and hide
       * everything else (the listed base patterns form the keep-set). A base pattern is
       * an exact name OR a glob (`*` = any characters, anchored to the full name), with
       * a single leading `!` stripped (e.g. `serena_*` hides every `serena_*` tool;
       * `!serena_*` keeps only `serena_*`; `!graphify_*, !serena_*` keeps only
       * `graphify_*` + `serena_*` and hides the rest). Only names present in the
       * request's tool definitions can be hidden. Must be a non-empty array of
       * non-empty strings (a lone `!` is not a pattern).
       */
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
  }
  | {
      /** Set the matched tool(s)' description on their definition in the outgoing request. */
      type: 'addDescription';
      /** Description text set on the matched tool(s). */
      description: string;
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

/** True when the given matcher is the unconditional "always" matcher. */
function isAlwaysMatcher(matcher: PolicyMatcher): boolean {
  return (matcher as AlwaysMatcher)[ALWAYS_MATCHER_BRAND] === true;
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
    case 'always':
      // Unconditional: fire on every request (including a fresh turn-1).
      return createAlwaysMatcher();
  }
}

/**
 * Build a concrete {@link PolicyAction} from an {@link ActionSpec} by looking up
 * the action's strategy in the {@link ACTION_STRATEGIES} registry (via `spec.type`)
 * and delegating to its `buildSpec`. Adding a new action needs only a new strategy
 * + a registry entry — no edit to this function. Throws a descriptive error when a
 * required field for the chosen `type` is missing. Unknown extra fields are ignored.
 */
export function buildAction(spec: ActionSpec): PolicyAction {
  // Dispatch to the action's strategy via the registry: adding a new action needs
  // only a new strategy + a single registry entry, no edit to this function.
  return ACTION_STRATEGIES[spec.type].buildSpec(spec);
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
    // Derive the action TYPE from the readable closure name (the port Action sets
    // `name` to its discriminator); params are not recoverable from the closure, so
    // emit empty/placeholder fields that stay valid for each type.
    action: describeAction(rule),
  };
}

const KNOWN_MATCHER_TYPES = new Set<['toolName' | 'argPattern' | 'loop' | 'always'][number]>([
  'toolName',
  'argPattern',
  'loop',
  'always',
]);

/**
 * The set of known action types, derived from the action registry so a newly
 * registered action is picked up automatically (a core part of the Open/Closed
 * design; no hand-listed array to edit).
 */
const KNOWN_ACTION_TYPES = new Set<ActionEffectKind>(Object.keys(ACTION_STRATEGIES) as ActionEffectKind[]);

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
    case 'always':
      // Unconditional: no fields are required.
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
  if (typeof t !== 'string' || !KNOWN_ACTION_TYPES.has(t as ActionEffectKind)) {
    return `unknown action type ${JSON.stringify(t)}`;
  }
  // Dispatch required-field validation to the action's strategy via the registry.
  return ACTION_STRATEGIES[t as ActionEffectKind].validateSpec(value);
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
