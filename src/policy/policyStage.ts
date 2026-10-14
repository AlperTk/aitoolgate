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

export interface PolicyStageOptions {
  engine: { evaluate(ctx: PolicyContext): RuleEvaluationResult };
  /** Per-session queue bridging response-side actions into the next request; defaults to a fresh in-memory store. */
  feedback?: SessionFeedbackStore;
  /** Optional telemetry bus emitting each applied effect as an {@link InterventionEvent}; tool-call observation is NOT done here (centralized in proxy/context.ts), so omitting it leaves the stage emission-free. */
  bus?: TelemetryEventBus;
}

type FeedbackQueue = (key: string | SessionKey, message: FeedbackMessage) => void;

/** Create the policy pipeline stage: runs the rule engine against the request/response stream and applies the resulting {@link ActionEffect}s in place. */
export function createPolicyStage(options: PolicyStageOptions): PipelineStage {
  const feedback = options.feedback ?? new SessionFeedbackStore();
  const queue: FeedbackQueue = feedback.queue.bind(feedback);
  const bus = options.bus;
  // Emit through the optional bus without ever letting a failing subscriber/emit break the pipeline (relies on the bus's handler isolation); no-op with no bus.
  const emitTelemetry = (event: TelemetryEvent): void => {
    if (bus === undefined) return;
    try {
      void bus.emit(event).catch(() => {});
    } catch {
      // a throwing bus must not break the pipeline
    }
  };
  // Most recent request's derived session key (the pipeline exposes no shared object across the two halves); the response phase falls back to it. Limitation: adequate only for sequential single-client usage.
  let lastRequestSessionKey: SessionKey | undefined;

  return {
    name: 'policy',

    onRequest(ctx: RequestContext): RequestContext {
      // Derive the session key from the stable message prefix, honoring any client token on the context (e.g. an X-Session-Id header).
      const sessionKey = deriveSessionKey({
        messages: (ctx.messages ?? []) as Message[],
        token: ctx.sessionKey?.token,
      });
      lastRequestSessionKey = sessionKey;

      // Drain queued feedback and inject it BEFORE evaluating, so feedback messages are part of the evaluated history.
      const drained = feedback.drain(sessionKey);
      if (drained.length > 0) {
        ctx.messages = spliceMessages(
          ctx.messages,
          drained.map((message) => ({ role: message.role, content: message.content })),
        );
      }

      const result = options.engine.evaluate(ctx);
      for (const entry of result.applied) {
        applyRequestEffect(ctx, entry.effect);
        emitTelemetry(makeInterventionEvent(sessionKey, entry));
      }
      return ctx;
    },

    onResponse(ctx: ResponseContext): ResponseContext {
      const sessionKey = resolveResponseSessionKey(ctx, lastRequestSessionKey);
      // NOTE: tool-CALL observation/emission is NOT done here — it is centralized in proxy/context.ts; emitting it here would double-count. This stage owns ONLY its intervention events.
      const result = options.engine.evaluate(ctx);
      for (const entry of result.applied) {
        applyResponseEffect(ctx, entry.effect, sessionKey, queue);
        emitTelemetry(makeInterventionEvent(sessionKey, entry));
      }
      return ctx;
    },
  };
}

/** Resolve a response-phase session key: prefer the context's own non-empty key, else the last request's derived key, else an empty key. */
function resolveResponseSessionKey(ctx: ResponseContext, last: SessionKey | undefined): SessionKey {
  const fromContext = ctx.sessionKey;
  if (fromContext && typeof fromContext.fingerprint === 'string' && fromContext.fingerprint.length > 0) {
    return fromContext;
  }
  return last ?? { fingerprint: '' };
}


function sessionKeyToString(key: string | SessionKey): string {
  return typeof key === 'string' ? key : key.fingerprint;
}

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

/** Look up the strategy for an effect's kind via the action registry; unknown kinds resolve to `undefined` (the stage never throws on a non-matching effect). */
function strategyFor(effect: ActionEffect): ActionStrategy | undefined {
  return (ACTION_STRATEGIES as Record<string, ActionStrategy | undefined>)[effect.type];
}

function describeEffect(effect: ActionEffect): string | undefined {
  const strategy = strategyFor(effect);
  return strategy === undefined ? undefined : strategy.describe(effect);
}

function applyRequestEffect(ctx: RequestContext, effect: ActionEffect): void {
  strategyFor(effect)?.applyRequest(ctx, effect);
}

function applyResponseEffect(
  ctx: ResponseContext,
  effect: ActionEffect,
  sessionKey: SessionKey,
  queue: FeedbackQueue,
): void {
  strategyFor(effect)?.applyResponse(ctx, effect, sessionKey, queue);
}