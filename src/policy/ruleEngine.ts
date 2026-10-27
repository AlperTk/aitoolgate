import type { Action, Match, PolicyContext, PolicyMatcher } from './types';
import type { ActionEffect } from './actions';
import { createInjectMessageAction } from './actions';
import { createLoopDetector } from './matchers';
import type { LoopDetectorOptions } from './matchers';

/** Concrete action shape for the rule engine; a refinement of the port `Action` whose `apply` yields a capturable {@link ActionEffect}. */
export interface PolicyAction {
  name: string;
  /** Apply the behavior; return the effect or `null`; the optional `match` scopes the effect to the matched calls. */
  apply(ctx: PolicyContext, match?: Match): ActionEffect | null;
}

/** Concrete policy rule for the rule engine; a non-interchangeable specialization of the port `Rule` (concrete matcher/action, optional priority/description). */
export interface PolicyRule {
  id: string;
  enabled: boolean;
  /** Ordering: lower runs earlier. A missing priority sorts after any explicit one. */
  priority?: number;
  description?: string;
  matcher: PolicyMatcher;
  action: PolicyAction;
}

/** Rule-store registry entry: the engine-facing rule plus its originally-submitted spec (opaque here; `api/ruleSpec.ts` owns the shape), kept for lossless serialization. */
export interface RuleRegistryEntry {
  spec?: unknown;
  rule: PolicyRule;
}

export interface RuleEvaluationResult {
  effects: ActionEffect[];
  matches: { ruleId: string; match: Match }[];
  /** Each applied effect paired with its producing rule, so a later stage can record which rule produced it without re-deriving. */
  applied: { ruleId: string; effect: ActionEffect }[];
}

export interface RuleEngine {
  evaluate(ctx: PolicyContext): RuleEvaluationResult;
}

/** Create a rule engine that evaluates enabled rules in priority order; `rules` may be a static array or a getter re-invoked on every evaluate call. */
export function createRuleEngine(rules: PolicyRule[] | (() => PolicyRule[])): RuleEngine {
  const resolve = typeof rules === 'function' ? rules : () => rules;
  return {
    evaluate(ctx) {
      const activeRules = resolve();
      const ordered = orderByPriority(activeRules);
      const effects: ActionEffect[] = [];
      const matches: RuleEvaluationResult['matches'] = [];
      const applied: RuleEvaluationResult['applied'] = [];
      for (const rule of ordered) {
        const match = rule.matcher.matches(ctx);
        if (match === null) continue;
        const effect = rule.action.apply(ctx, match);
        if (effect !== null) {
          effects.push(effect);
          applied.push({ ruleId: rule.id, effect });
        }
        matches.push({ ruleId: rule.id, match });
      }
      return { effects, matches, applied };
    },
  };
}

/** Enabled rules in evaluation order: ascending priority, then stable original index; a missing priority sorts after every explicit one. */
function orderByPriority(rules: PolicyRule[]): PolicyRule[] {
  return rules
    .map((rule, index) => ({ rule, index }))
    .filter(({ rule }) => rule.enabled)
    .sort((a, b) => {
      const pa = a.rule.priority ?? Number.POSITIVE_INFINITY;
      const pb = b.rule.priority ?? Number.POSITIVE_INFINITY;
      if (pa !== pb) return pa < pb ? -1 : 1;
      return a.index - b.index;
    })
    .map(({ rule }) => rule);
}

/** Cast a port-action factory result to the concrete engine-facing shape. */
function asPolicyAction(action: Action): PolicyAction {
  return action as PolicyAction;
}

const DEFAULT_MESSAGE =
  'You appear to be stuck repeating the same tool call. Stop repeating identical calls and change your approach to make progress.';

export interface FlagshipLoopRuleOptions {
  /** Consecutive identical calls before flagging (default `4`). Falls back to `matcherOptions.window`. */
  window?: number;
  /** Content of the corrective message injected on detection (default `DEFAULT_MESSAGE`). */
  message?: string;
  /** Role of the injected corrective message (default `'user'`). */
  role?: 'user' | 'system';
  matcherOptions?: LoopDetectorOptions;
  /** Custom action applied on detection. Defaults to an `injectMessage` action. */
  action?: PolicyAction;
}

/** Stable evaluation priority of the flagship rule; low value (high precedence) so it is evaluated before caller-supplied rules. */
export const FLAGSHIP_RULE_PRIORITY = 0;

/** The flagship loop-detection rule; deliberately stateless — per-session feedback/cooldown is composed in the pipeline stage. */
export function flagshipLoopRule(options: FlagshipLoopRuleOptions = {}): PolicyRule {
  const matcher = createLoopDetector({
    ...(options.matcherOptions ?? {}),
    window: options.matcherOptions?.window ?? options.window ?? 4,
  });
  const action =
    options.action ??
    asPolicyAction(
      createInjectMessageAction({
        role: options.role ?? 'user',
        content: options.message ?? DEFAULT_MESSAGE,
      }),
    );
  return {
    id: 'flagship-loop-rule',
    enabled: true,
    // Evaluated first (high precedence); see FLAGSHIP_RULE_PRIORITY.
    priority: FLAGSHIP_RULE_PRIORITY,
    description:
      'Detects consecutive identical tool calls and injects a corrective message to break the loop.',
    matcher,
    action,
  };
}
