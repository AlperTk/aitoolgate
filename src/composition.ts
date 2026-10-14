/** Concrete default composition: the concrete policy/telemetry builders behind the `ProxyDefaults` port. */
import { createRuleEngine } from './policy/ruleEngine';
import { createPolicyStage } from './policy/policyStage';
import type { SessionFeedbackStore } from './policy/feedbackStore';
import { createEventBus } from './telemetry/event-bus';
import { createCollector } from './telemetry/collector';
import { createToolMetricsTracker, monotonicEpochMs } from './telemetry/toolMetrics';
import { createSseToolCallExtractor } from './telemetry/stream-extract';
import { estimateInputTokens, estimateTurnUsage } from './telemetry/tokenEstimate';
import type { ProxyDefaults } from './ports/telemetry';

/** The concrete `ProxyDefaults` used by the proxy and the composition root; each builder returns an instance satisfying the matching port. */
export const defaultProxyDefaults: ProxyDefaults = {
  makeBus: createEventBus,
  makeCollector: (bus) => createCollector({ bus }),
  makeTracker: createToolMetricsTracker,
  makePolicyStage: (rules, feedback, bus) =>
    createPolicyStage({
      engine: createRuleEngine(rules),
      // Only the FeedbackStore surface is used; `undefined` lets the concrete build a fresh store.
      feedback: feedback as unknown as SessionFeedbackStore | undefined,
      bus,
    }),
  makeSseExtractor: createSseToolCallExtractor,
  usage: { now: monotonicEpochMs, estimateInputTokens, estimateTurnUsage },
  // Default = no user patterns (heuristic only); the server overrides this with `config.toolErrorPatterns`.
  toolErrorPatterns: [],
};
