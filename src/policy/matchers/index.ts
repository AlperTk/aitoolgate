import type { Matcher } from '../../ports';
import type { PolicyMatcher } from '../types';

/**
 * Policy matchers — the concrete, rule-level matchers of the policy engine.
 *
 * Each factory returns a {@link PolicyMatcher} (a rich `Match | null`), the
 * policy-level specialization of the port {@link Matcher} (a bare boolean).
 * Use {@link toPortMatcher} to adapt a policy matcher to the port `Matcher`
 * expected by `Rule` / the pipeline.
 */
export { createToolNameMatcher } from './toolName';
export type { ToolNameMatcherConfig } from './toolName';
export { createArgPatternMatcher } from './argPattern';
export type { ArgPatternMatcherConfig } from './argPattern';

/**
 * Adapt a policy-level {@link PolicyMatcher} (returns a rich `Match | null`)
 * to the port {@link Matcher} (returns a bare `boolean`).
 *
 * We adapt rather than change the port: `Rule.matcher` and the pipeline
 * consume the port `Matcher` (the Strategy contract in `src/ports`), while
 * policy matchers carry the extra `reason` / `details` the rule engine needs
 * for block messages and telemetry. This lets a `PolicyMatcher` be used
 * anywhere a port `Matcher` is expected, without modifying the port.
 */
export function toPortMatcher(policyMatcher: PolicyMatcher): Matcher {
  return {
    matches(ctx) {
      return policyMatcher.matches(ctx)?.matched === true;
    },
  };
}

export { createLoopDetector } from './loopDetector';
export type { LoopDetectorOptions } from './loopDetector';
