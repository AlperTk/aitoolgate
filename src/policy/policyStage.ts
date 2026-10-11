import type { PipelineStage, RequestContext, ResponseContext } from '../ports/pipeline';
import type { SessionKey } from '../ports/domain';
import type { PolicyContext, ActionStrategy } from './types';
import type { RuleEvaluationResult } from './ruleEngine';
import { ACTION_STRATEGIES, spliceMessages } from './actions';
import type { ActionEffect } from './actions';
import type { FeedbackMessage } from './feedbackStore';
import { deriveSessionKey } from '../session/session';
import type { Message } from '../session/session';
import { SessionFeedbackStore } from './feedbackStore';
import type { TelemetryEventBus } from '../telemetry/event-bus';
import type { InterventionEvent, TelemetryEvent } from '../telemetry/events';

/** Options for {@link createPolicyStage}. */
export interface PolicyStageOptions {
  /** The rule engine whose effects the stage applies to the message stream. */
  engine: { evaluate(ctx: PolicyContext): RuleEvaluationResult };
  /**
   * Per-session queue bridging response-side actions into the NEXT request.
   * Defaults to a fresh in-memory store when omitted.
   */
  feedback?: SessionFeedbackStore;
  /**
   * Optional telemetry event bus. When provided, each applied rule effect
   * (request or response) is emitted as an {@link InterventionEvent}. Tool-call
   * observation/emission is NOT done here — it is centralized in proxy/context.ts
   * (runThroughPipeline) on every path — so this stage never double-emits and always
   * feeds the same shared tracker. Omitting the bus (the default) leaves the stage
   * completely emission-free (no events are published, nothing is subscribed), so
   * behavior is unchanged.
   */
  bus?: TelemetryEventBus;
}

/** A minimal queue callback used by response-phase effect application. */
type FeedbackQueue = (key: string | SessionKey, message: FeedbackMessage) => void;

/**
 * Create the POLICY pipeline stage: it runs the rule engine against the
 * model-proxy request/response stream and applies the resulting
 * {@link ActionEffect}s by editing the message stream in place.
 *
 * This is a self-contained, testable stage: it depends only on an injected rule
 * engine ({@link PolicyStageOptions.engine}) and an optional
 * {@link SessionFeedbackStore}. It is not yet wired into the proxy (a later
 * task); register it on a `Pipeline` via `use()`.
 *
 * - **Request phase:** derives the session key from the request's message prefix
 *   (+ any client token surfaced on the context), drains queued feedback into
 *   the message list, then evaluates the request (a `RequestContext` IS a
 *   `PolicyContext`) and applies each effect (`hideTool`, `injectMessage`, and
 *   generically `block` / `rewriteArgs`).
 * - **Response phase:** resolves the session key (prefer the response context's
 *   own key, else the most recent request's derived key), evaluates the
 *   response (a `ResponseContext` IS a `PolicyContext`), and applies each
 *   effect (`block` → drop the offending call(s) + queue feedback;
 *   `rewriteArgs`; `injectMessage` → queue for the next request).
 *
 * Phases whose context lacks the required data skip gracefully without throwing.
 */
export function createPolicyStage(options: PolicyStageOptions): PipelineStage {
  const feedback = options.feedback ?? new SessionFeedbackStore();
  const queue: FeedbackQueue = feedback.queue.bind(feedback);
  const bus = options.bus;
  // Emit a telemetry event through the OPTIONAL bus without ever letting a
  // failing subscriber break the pipeline flow. We RELY ON THE BUS'S HANDLER
  // ISOLATION (each handler runs inside its own try/catch; a throwing or
  // rejecting handler never stops the remaining ones) AND additionally wrap each
  // dispatch here in try/catch + swallow any rejection, so even a throwing
  // `emit` cannot surface out of a pipeline hook. With no bus wired this is a
  // pure no-op (behavior identical to the bus-less stage).
  const emitTelemetry = (event: TelemetryEvent): void => {
    if (bus === undefined) return;
    try {
      void bus.emit(event).catch(() => {});
    } catch {
      // A throwing bus can never break the pipeline flow.
    }
  };
  // Most recent request's derived session key. The pipeline threads no shared
  // object between its request and response halves (the proxy builds a fresh
  // response context), so the response phase falls back to this instance-level
  // reference. Documented limitation: adequate for sequential single-client
  // usage, where each request precedes its own response before the next begins.
  let lastRequestSessionKey: SessionKey | undefined;

  return {
    name: 'policy',

    onRequest(ctx: RequestContext): RequestContext {
      // Derive the session key from the stable message prefix, honoring any
      // client token surfaced on the context (e.g. an X-Session-Id header).
      const sessionKey = deriveSessionKey({
        messages: (ctx.messages ?? []) as Message[],
        token: ctx.sessionKey?.token,
      });
      lastRequestSessionKey = sessionKey;

      // Drain queued feedback for this session and inject it BEFORE evaluating,
      // so corrective/feedback messages are part of the evaluated history.
      const drained = feedback.drain(sessionKey);
      if (drained.length > 0) {
        ctx.messages = spliceMessages(
          ctx.messages,
          drained.map((message) => ({ role: message.role, content: message.content })),
        );
      }

      // A RequestContext IS a PolicyContext: evaluate it, then apply each effect
      // and (when a bus is wired) record each applied effect as an intervention.
      const result = options.engine.evaluate(ctx);
      for (const entry of result.applied) {
        applyRequestEffect(ctx, entry.effect);
        emitTelemetry(makeInterventionEvent(sessionKey, entry));
      }
      return ctx;
    },

    onResponse(ctx: ResponseContext): ResponseContext {
      const sessionKey = resolveResponseSessionKey(ctx, lastRequestSessionKey);
      // NOTE: tool-CALL observation/emission is NOT done here. It is centralized in
      // proxy/context.ts (runThroughPipeline -> emitResponseTelemetry), which emits one
      // tool.call per issued call (carrying its stable id + turn tokens) and records it
      // into the shared tracker on EVERY path (default and policy alike). Emitting a
      // second, id/token-less tool.call here would double-count and skip the tracker.
      // This stage owns ONLY its INTERVENTION events; the session key resolved above is
      // therefore used exclusively for those intervention events below.
      // A ResponseContext IS a PolicyContext: evaluate it, then apply each effect
      // and (when a bus is wired) record each applied effect as an intervention.
      const result = options.engine.evaluate(ctx);
      for (const entry of result.applied) {
        applyResponseEffect(ctx, entry.effect, sessionKey, queue);
        emitTelemetry(makeInterventionEvent(sessionKey, entry));
      }
      return ctx;
    },
  };
}

/**
 * Resolve a response-phase session key. Prefer the response context's own key
 * when it carries a non-empty fingerprint; otherwise reuse the most recent
 * request's derived key (the pipeline exposes no shared object across the two
 * halves); as a last resort an empty key.
 */
function resolveResponseSessionKey(ctx: ResponseContext, last: SessionKey | undefined): SessionKey {
  const fromContext = ctx.sessionKey;
  if (fromContext && typeof fromContext.fingerprint === 'string' && fromContext.fingerprint.length > 0) {
    return fromContext;
  }
  return last ?? { fingerprint: '' };
}


/** Coerce a session key (object or plain fingerprint string) to its canonical string form. */
function sessionKeyToString(key: string | SessionKey): string {
  return typeof key === 'string' ? key : key.fingerprint;
}

/** Build the {@link InterventionEvent} describing one applied rule effect. */
function makeInterventionEvent(
  sessionKey: string | SessionKey,
  entry: { ruleId: string; effect: ActionEffect },
): InterventionEvent {
  return {
    type: 'policy.intervention',
    sessionKey: sessionKeyToString(sessionKey),
    ruleId: entry.ruleId,
    action: entry.effect.type,
    detail: describeEffect(entry.effect),
    at: Date.now(),
  };
}

/**
 * Look up the strategy for an effect's kind via the action registry. Unknown kinds
 * (not in the registry) resolve to `undefined`, so callers skip gracefully — the
 * stage never throws on a non-matching effect (house convention: non-throwing ops).
 */
function strategyFor(effect: ActionEffect): ActionStrategy | undefined {
  return (ACTION_STRATEGIES as Record<string, ActionStrategy | undefined>)[effect.type];
}

/** A short, human-readable summary of an applied effect (the event's `detail`). */
function describeEffect(effect: ActionEffect): string | undefined {
  const strategy = strategyFor(effect);
  return strategy === undefined ? undefined : strategy.describe(effect);
}

/** Apply a single effect to a REQUEST context by dispatching to its action strategy. */
function applyRequestEffect(ctx: RequestContext, effect: ActionEffect): void {
  strategyFor(effect)?.applyRequest(ctx, effect);
}

/** Apply a single effect to a RESPONSE context by dispatching to its action strategy. */
function applyResponseEffect(
  ctx: ResponseContext,
  effect: ActionEffect,
  sessionKey: SessionKey,
  queue: FeedbackQueue,
): void {
  strategyFor(effect)?.applyResponse(ctx, effect, sessionKey, queue);
}