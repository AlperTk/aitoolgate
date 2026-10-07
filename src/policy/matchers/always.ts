import type { PolicyContext, PolicyMatcher } from '../types';

/**
 * Unique brand marking a matcher produced by {@link createAlwaysMatcher}. Lets
 * display code (e.g. {@link describeRule}) recognize the unconditional matcher
 * without having to introspect its closure.
 */
export const ALWAYS_MATCHER_BRAND: unique symbol = Symbol('policy.alwaysMatcher');

/**
 * A {@link PolicyMatcher} produced by {@link createAlwaysMatcher}: it fires on
 * every request. The optional {@link ALWAYS_MATCHER_BRAND} property carries the
 * brand so consumers can tell an "always" matcher apart from any other (it is
 * never observable in the returned {@link Match}).
 */
export interface AlwaysMatcher extends PolicyMatcher {
  /** Brand marker distinguishing this matcher from other policy matchers. */
  readonly [ALWAYS_MATCHER_BRAND]?: true;
}

/**
 * Create a STATELESS {@link PolicyMatcher} that fires on EVERY evaluation —
 * unconditionally, regardless of context. Its `matches` NEVER returns `null`:
 * it always yields a rich {@link Match}, so the rule engine applies the rule's
 * action on every request phase, including a fresh turn-1 request that carries
 * no prior tool calls.
 *
 * Attach it to an action that should run on every request, e.g.
 * `{ matcher: { type: 'always' }, action: { type: 'hideTool', toolNames: ['task'] } }`.
 */
export function createAlwaysMatcher(): PolicyMatcher {
  const matcher: AlwaysMatcher = {
    [ALWAYS_MATCHER_BRAND]: true,
    matches(_ctx: PolicyContext) {
      return {
        matched: true,
        reason: 'always (unconditional)',
      };
    },
  };
  return matcher;
}
