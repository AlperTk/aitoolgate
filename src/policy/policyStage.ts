import type { PipelineStage, RequestContext, ResponseContext } from '../ports/pipeline';
import type { SessionKey } from '../ports/domain';
import type { PolicyContext } from './types';
import type { RuleEvaluationResult } from './ruleEngine';
import type { ActionEffect } from './actions';
import type { FeedbackMessage } from './feedbackStore';
import { deriveSessionKey } from '../session/session';
import type { Message } from '../session/session';
import { SessionFeedbackStore } from './feedbackStore';
import type { TelemetryEventBus } from '../telemetry/event-bus';
import type { InterventionEvent, TelemetryEvent, ToolCallEvent } from '../telemetry/events';

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
   * Optional telemetry event bus. When provided, every tool call observed in the
   * response phase is emitted as a {@link ToolCallEvent} and each applied rule
   * effect (request or response) is emitted as an {@link InterventionEvent}.
   * Omitting it (the default) leaves the stage completely emission-free — no
   * events are published and nothing is subscribed, so behavior is unchanged.
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
      // Observe every tool call the model emitted in this response BEFORE any
      // effect mutates ctx.toolCalls, publishing each as a {@link ToolCallEvent}
      // when a bus is wired (a no-op otherwise — the guard keeps the emission-
      // free stage byte-for-byte identical to before).
      if (bus !== undefined) {
        const at = Date.now();
        for (const call of ctx.toolCalls) {
          const event: ToolCallEvent = {
            type: 'tool.call',
            sessionKey: sessionKeyToString(sessionKey),
            toolName: call.name,
            args: call.arguments,
            at,
          };
          emitTelemetry(event);
        }
      }
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

/** A short, human-readable summary of an applied effect (the event's `detail`). */
function describeEffect(effect: ActionEffect): string {
  switch (effect.type) {
    case 'block':
      return effect.toolCallIds !== undefined
        ? `blocked ${effect.toolCallIds.length} tool call(s) (${effect.message})`
        : `blocked all tool calls (${effect.message})`;
    case 'hideTool':
      return `hid tool(s): ${effect.toolNames.join(', ')}`;
    case 'rewriteArgs':
      return `rewrote arguments for tool call ${effect.toolCallId}`;
    case 'injectMessage':
      return `injected ${effect.role} message: ${effect.content}`;
  }
}

/** Apply a single effect to a REQUEST context by editing its stream in place. */
function applyRequestEffect(ctx: RequestContext, effect: ActionEffect): void {
  switch (effect.type) {
    case 'hideTool':
      hideToolsFromRequest(ctx.raw, effect.toolNames);
      break;
    case 'injectMessage':
      ctx.messages = spliceMessages(ctx.messages, [{ role: effect.role, content: effect.content }]);
      break;
    case 'block':
      withAssistantToolCalls(ctx.messages, (message, toolCalls) => {
        if (effect.toolCallIds === undefined) {
          message.tool_calls = [];
        } else {
          const blocked = new Set(effect.toolCallIds);
          message.tool_calls = toolCalls.filter(
            (toolCall) => !(isRecord(toolCall) && typeof toolCall.id === 'string' && blocked.has(toolCall.id)),
          );
        }
      });
      break;
    case 'rewriteArgs':
      withAssistantToolCalls(ctx.messages, (message, toolCalls) => {
        message.tool_calls = toolCalls.map((toolCall) => {
          if (!isRecord(toolCall) || toolCall.id !== effect.toolCallId) return toolCall;
          const functionRecord: Record<string, unknown> = isRecord(toolCall.function)
            ? { ...toolCall.function }
            : {};
          functionRecord.arguments = effect.newArguments;
          return { ...toolCall, function: functionRecord };
        });
      });
      break;
  }
}

/** Apply a single effect to a RESPONSE context by editing its stream in place. */
function applyResponseEffect(
  ctx: ResponseContext,
  effect: ActionEffect,
  sessionKey: SessionKey,
  queue: FeedbackQueue,
): void {
  switch (effect.type) {
    case 'block': {
      // Drop the offending tool call(s) from the response. When `toolCallIds` is
      // omitted, block every call carried on the context.
      if (ctx.toolCalls.length > 0) {
        if (effect.toolCallIds === undefined) {
          ctx.toolCalls = [];
        } else {
          const blocked = new Set(effect.toolCallIds);
          ctx.toolCalls = ctx.toolCalls.filter((call) => !blocked.has(call.id));
        }
      }
      // A block is never silent: queue its feedback for the next request.
      queue(sessionKey, { role: 'user', content: effect.message });
      break;
    }
    case 'rewriteArgs': {
      const target = ctx.toolCalls.find((call) => call.id === effect.toolCallId);
      if (target) target.arguments = parseArgsLoose(effect.newArguments);
      break;
    }
    case 'injectMessage':
      // A bare response has no place to insert; queue it for the next request.
      queue(sessionKey, { role: effect.role, content: effect.content });
      break;
    case 'hideTool':
      // A bare response carries no tool list; nothing to hide. Skip gracefully.
      break;
  }
}

/** Remove the named tools from a raw provider request's top-level `tools` array. */
function hideToolsFromRequest(raw: unknown, toolNames: readonly string[]): void {
  if (!isRecord(raw)) return;
  const tools = raw.tools;
  if (!Array.isArray(tools)) return;
  const names = new Set(toolNames);
  raw.tools = tools.filter((tool) => {
    const name = toolNameOf(tool);
    return name === undefined || !names.has(name);
  });
}

/** Extract a tool definition's name from either the OpenAI or Anthropic shape. */
function toolNameOf(tool: unknown): string | undefined {
  if (!isRecord(tool)) return undefined;
  const fn = isRecord(tool.function) ? tool.function : undefined;
  if (typeof fn?.name === 'string') return fn.name;
  return typeof tool.name === 'string' ? tool.name : undefined;
}

/** Insert messages after the system prefix / before the trailing user turn. */
function spliceMessages(messages: unknown[], inserts: readonly Message[]): unknown[] {
  if (inserts.length === 0) return messages;
  const result = [...messages];
  const at = injectionIndex(messages);
  result.splice(at, 0, ...inserts);
  return result;
}

/** The index at which injected/feedback messages should be inserted. */
function injectionIndex(messages: unknown[]): number {
  // Right after the leading system-message prefix...
  let start = 0;
  while (start < messages.length && roleOf(messages[start]) === 'system') start++;
  // ...but before the trailing user turn, when one occurs after that prefix.
  let lastUser = -1;
  for (let i = messages.length - 1; i > start; i--) {
    if (roleOf(messages[i]) === 'user') {
      lastUser = i;
      break;
    }
  }
  return lastUser >= 0 ? lastUser : messages.length;
}

/** Visit each assistant message that carries an OpenAI-style `tool_calls` list. */
function withAssistantToolCalls(
  messages: unknown[],
  mutate: (message: Record<string, unknown>, toolCalls: unknown[]) => void,
): void {
  for (const message of messages) {
    if (!isRecord(message) || message.role !== 'assistant') continue;
    const toolCalls = message.tool_calls;
    if (!Array.isArray(toolCalls)) continue;
    mutate(message, toolCalls);
  }
}

/** Parse a tool-call argument value into an object; tolerant of JSON strings. */
function parseArgsLoose(value: string | Record<string, unknown>): Record<string, unknown> {
  if (typeof value !== 'string') return value;
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Extract a message's `role` when present. */
function roleOf(message: unknown): string | undefined {
  if (!isRecord(message)) return undefined;
  return typeof message.role === 'string' ? message.role : undefined;
}

/** Type guard: is the value a non-null, non-array object? */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
