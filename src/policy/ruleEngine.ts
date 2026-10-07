import type { Action, Match, PolicyContext, PolicyMatcher } from './types';
import type { ActionEffect } from './actions';
import { createInjectMessageAction } from './actions';
import { createLoopDetector } from './matchers';
import type { LoopDetectorOptions } from './matchers';

/**
 * The CONCRETE action shape consumed by the policy rule engine.
 *
 * This is a policy-level refinement of the port `Action` (see `src/ports`). Every
 * built-in action factory (`createBlockAction`, `createHideToolAction`,
 * `createRewriteArgsAction`, `createInjectMessageAction`) returns an object whose
 * `apply` yields an {@link ActionEffect} (or `null`), which is a SUBTYPE of the
 * port `Action` (`apply(ctx): void`) — so any `PolicyAction` is also a valid
 * port `Action`. We type the rule engine's actions as `PolicyAction` rather than
 * the bare port `Action` so the resulting {@link ActionEffect} is CAPTURABLE:
 * the port intentionally returns `void`, but the engine needs the concrete effect
 * to hand to the downstream pipeline stage.
 */
export interface PolicyAction {
  /** Unique action name. */
  name: string;
  /**
   * Apply the behavior; return the produced effect, or `null` for a no-op. The
   * optional {@link Match} describes WHY the rule fired (e.g. which tool-call
   * names matched) so an action can scope its effect to the MATCHED calls rather
   * than every call observable on the context. Actions that do not need it omit
   * the parameter (a fewer-parameter implementation remains valid).
   */
  apply(ctx: PolicyContext, match?: Match): ActionEffect | null;
}

/**
 * A CONCRETE policy rule for the rule engine.
 *
 * RELATIONSHIP TO THE PORT `Rule`: this is the rule-engine specialization of the
 * port `Rule` (`src/ports`). Where they differ:
 * - `matcher` is the concrete {@link PolicyMatcher} (rich `Match | null`) rather
 *   than the port `Matcher` (bare boolean), so the reason WHY a rule fired is
 *   capturable.
 * - `action` is the concrete {@link PolicyAction} (effect-returning) rather than
 *   the port `Action` (`void`), so the effect is capturable.
 * - `priority` and `description` are OPTIONAL here: a missing `priority` simply
 *   sorts AFTER any explicit one; a port `Rule` makes both required.
 *
 * Because the matcher/action types differ, a `PolicyRule` is NOT interchangeable
 * with a port `Rule`; use it at the engine boundary and adapt to the port where
 * the pipeline expects one (e.g. via the matchers' `toPortMatcher`).
 */
export interface PolicyRule {
  /** Unique rule id. */
  id: string;
  /** Whether the rule participates in evaluation. Only enabled rules run. */
  enabled: boolean;
  /** Ordering: lower runs earlier. A missing priority sorts after any explicit one. */
  priority?: number;
  /** Human description. */
  description?: string;
  /** Concrete matcher that produces a rich {@link Match} (or `null` when not fired). */
  matcher: PolicyMatcher;
  /** Concrete action applied when the matcher fires; its effect is captured. */
  action: PolicyAction;
}

/** The accumulated result of evaluating all enabled rules against a context. */
export interface RuleEvaluationResult {
  /** Effects produced by matched rules, in evaluation (priority) order. */
  effects: ActionEffect[];
  /** One entry per matched rule, in evaluation (priority) order. */
  matches: { ruleId: string; match: Match }[];
  /**
   * Each applied effect paired with the rule that produced it, in evaluation
   * (priority) order. Populated alongside `effects`: one entry whenever a
   * matched rule's action returns a non-null effect. Lets a later pipeline
   * stage record WHICH rule produced each effect (for telemetry) without
   * re-deriving it.
   */
  applied: { ruleId: string; effect: ActionEffect }[];
}

/** The engine produced by {@link createRuleEngine}. */
export interface RuleEngine {
  evaluate(ctx: PolicyContext): RuleEvaluationResult;
}

/**
 * Create a rule engine that evaluates ENABLED rules in PRIORITY ORDER and
 * collects each matched rule's effect.
 *
 * The rules source may be a static array of {@link PolicyRule}s OR a getter
 * `() => PolicyRule[]`. A getter is re-invoked on EVERY `evaluate` call so rules
 * added or removed at runtime (e.g. from an in-memory rule store) are reflected on
 * each evaluation; a static array is evaluated as-is. Either way, the result shape
 * and ordering below are unchanged.
 *
 * Ordering: enabled rules run in ascending `priority` (lower = higher
 * precedence); ties are broken by original array order; a missing `priority`
 * sorts after every explicit one. Disabled rules are skipped entirely. Evaluation
 * never throws on a non-match — an unmatched rule simply contributes nothing.
 *
 * The returned `effects`, `matches`, and `applied` let a later pipeline stage
 * apply the effects to the message stream and record WHICH rule produced each
 * effect (and why the rule fired) for telemetry.
 */
export function createRuleEngine(rules: PolicyRule[] | (() => PolicyRule[])): RuleEngine {
  // Resolve the rules once per evaluation: a getter is re-run so runtime
  // add/remove is reflected; a plain array is used as-is.
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

/**
 * The enabled rules in evaluation order: ascending explicit `priority`, then
 * original array index (stable), with a missing `priority` treated as `+Infinity`
 * so it sorts after every explicit one.
 */
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

/**
 * Cast a port-action factory result to the concrete engine-facing shape. Every
 * built-in factory returns a `PolicyAction` at runtime (its `apply` yields an
 * {@link ActionEffect}); this merely tells TypeScript that.
 */
function asPolicyAction(action: Action): PolicyAction {
  return action as PolicyAction;
}

/** Default corrective message injected by the flagship loop rule. */
const DEFAULT_MESSAGE =
  'You appear to be stuck repeating the same tool call. Stop repeating identical calls and change your approach to make progress.';

/** Options for {@link flagshipLoopRule}. */
export interface FlagshipLoopRuleOptions {
  /** Consecutive identical calls before flagging (default `4`). Falls back to `matcherOptions.window`. */
  window?: number;
  /** Content of the corrective message injected on detection (default `DEFAULT_MESSAGE`). */
  message?: string;
  /** Role of the injected corrective message (default `'user'`). */
  role?: 'user' | 'system';
  /** Extra options forwarded to `createLoopDetector`. */
  matcherOptions?: LoopDetectorOptions;
  /** Custom action applied on detection. Defaults to an `injectMessage` action. */
  action?: PolicyAction;
}

/**
 * The FLAGSHIP loop-detection rule: detect a run of consecutive identical tool
 * calls and inject a single corrective message prompting a different approach.
 *
 * NOTE (v1 simplification): the full "feedback ladder + per-session cooldown" is
 * composed in the PIPELINE STAGE, which owns the per-session state this rule is
 * deliberately kept without. Here the flagship rule is just a STATELESS
 * `createLoopDetector` matcher plus a single configurable default intervention
 * action (`injectMessage`); wire per-session feedback/cooldown in the stage.
 */
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
    description:
      'Detects consecutive identical tool calls and injects a corrective message to break the loop.',
    matcher,
    action,
  };
}
