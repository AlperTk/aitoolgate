/**
 * CONCRETE default composition for the model proxy (the single source of the
 * concrete policy/telemetry builders the proxy's defaults depend on).
 *
 * This module lives OUTSIDE `src/proxy/` on purpose: `createProxyHandler`
 * (src/proxy/index.ts) only ever imports the {@link ProxyDefaults} PORT
 * interface plus this `defaultProxyDefaults` VALUE. The concrete `createXxx`
 * factory imports live HERE so the proxy files themselves never name a concrete
 * policy/telemetry factory (dependency inversion: the proxy depends on the port,
 * the composition root + this module depend on the concrete impls).
 */
import { createRuleEngine } from './policy/ruleEngine';
import { createPolicyStage } from './policy/policyStage';
import type { SessionFeedbackStore } from './policy/feedbackStore';
import { createEventBus } from './telemetry/event-bus';
import { createCollector } from './telemetry/collector';
import { createToolMetricsTracker, monotonicEpochMs } from './telemetry/toolMetrics';
import { createSseToolCallExtractor } from './telemetry/stream-extract';
import { estimateInputTokens, estimateTurnUsage } from './telemetry/tokenEstimate';
import type { ProxyDefaults } from './ports/telemetry';

/**
 * The concrete {@link ProxyDefaults} the proxy uses by default (and that the
 * composition root, `src/server/index.ts`, reuses to build + inject the policy
 * stage). Every builder returns a concrete instance that structurally satisfies
 * the matching port.
 */
export const defaultProxyDefaults: ProxyDefaults = {
  makeBus: createEventBus,
  makeCollector: (bus) => createCollector({ bus }),
  makeTracker: createToolMetricsTracker,
  makePolicyStage: (rules, feedback, bus) =>
    createPolicyStage({
      engine: createRuleEngine(rules),
      // The concrete stage's `feedback` param is over-specified (the concrete
      // `SessionFeedbackStore`, whose private members make it nominal); only the
      // `FeedbackStore` surface (`queue` / `drain`) is used, so the port instance
      // is safe to pass (and `undefined` lets the concrete build a fresh store).
      feedback: feedback as unknown as SessionFeedbackStore | undefined,
      bus,
    }),
  makeSseExtractor: createSseToolCallExtractor,
  usage: { now: monotonicEpochMs, estimateInputTokens, estimateTurnUsage },
};
