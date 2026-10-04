/**
 * Domain events emitted through the telemetry {@link EventBus} (slice 6a of
 * telemetry/storage). These power the live dashboard: the real-time tool-call
 * stream plus the intervention log.
 *
 * Relationship to the port's {@link PolicyEvent} (`src/ports/domain.ts`):
 *
 * - These are **fresh, typed, discriminated** shapes and are *not* structurally
 *   interchangeable with the generic {@link PolicyEvent}: that event carries an
 *   untyped `payload: Record<string, unknown>` bag, a required `id`, and an
 *   ISO-string `at`; these carry concrete per-type fields and a numeric
 *   epoch-millisecond `at`.
 * - A producer that already emits a {@link PolicyEvent} should map it onto one of
 *   these at the pipeline boundary (e.g. `tool.call` → {@link ToolCallEvent});
 *   consumers of the concrete {@link TelemetryEvent} union get exhaustive,
 *   field-typed access instead of a payload bag.
 *
 * The intervention {@link InterventionAction} discriminator is derived from the
 * policy `ActionEffect` union so the telemetry view never drifts from the action
 * engine's set of effects.
 */
import type { ActionEffect } from '../policy/actions';

/**
 * Minimal emitter surface shared by the port-level `EventBus`
 * (`src/ports/event-bus.ts`) and the telemetry {@link TelemetryEventBus}
 * (`./event-bus`): both expose an `emit(event)` method, so either bus instance can
 * be handed directly to emission code. Declared as a method (not a function-typed
 * property) with a deliberately permissive parameter type so BOTH bus levels remain
 * structurally assignable under `strictFunctionTypes`.
 */
export interface TelemetryEmitter {
  /** Emit an event to all current subscribers (the parameter is intentionally permissive). */
  emit(event: { type: string; [key: string]: unknown }): unknown;
}

/** A tool call observed on the stream (telemetry view). */
export type ToolCallEvent = {
  /** Discriminator. */
  type: 'tool.call';
  /** Session the call belongs to. */
  sessionKey: string;
  /** Client identity, if known. */
  clientId?: string;
  /** Name of the tool invoked. */
  toolName: string;
  /** Parsed arguments of the call, if any. */
  args?: unknown;
  /** Stable tool-call id (`ToolCall.id`; OpenAI `tool_calls[].id` / Anthropic `tool_use.id`), present when available. */
  id?: string;
  /** Upstream token usage of the turn that produced this call (OpenAI prompt/completion/total or Anthropic input/output, normalized); omitted when the upstream didn't report usage. */
  tokens?: { input?: number; output?: number; total?: number };
  /** When it occurred (epoch milliseconds). */
  at: number;
};

/** The result of executing a tool call (telemetry view). */
export type ToolResultEvent = {
  /** Discriminator. */
  type: 'tool.result';
  /** Session the result belongs to. */
  sessionKey: string;
  /** Client identity, if known. */
  clientId?: string;
  /** Name of the tool that ran. */
  toolName: string;
  /** Whether the call succeeded. */
  ok?: boolean;
  /** Id of the specific tool call whose result this is (links to {@link ToolCallEvent.id}); used for cross-request pairing. */
  toolCallId?: string;
  /** Elapsed milliseconds from issue to result; omitted until measurable. */
  durationMs?: number;
  /** Raw character length of the tool-result payload (best-effort size metric); omitted when unknown. */
  chars?: number;
  /** When it occurred (epoch milliseconds). */
  at: number;
};

/**
 * The discriminator values shared by every policy {@link ActionEffect}
 * (`'block' | 'hideTool' | 'rewriteArgs' | 'injectMessage'`), so a telemetry
 * {@link InterventionEvent} always names a real, implemented action effect.
 */
export type InterventionAction = ActionEffect['type'];

/** A policy intervention applied to the stream (telemetry view). */
export type InterventionEvent = {
  /** Discriminator. */
  type: 'policy.intervention';
  /** Session the intervention fired in. */
  sessionKey: string;
  /** The rule that fired. */
  ruleId: string;
  /** Which effect the firing rule applied. */
  action: InterventionAction;
  /** Human-readable detail, if any. */
  detail?: string;
  /** When it occurred (epoch milliseconds). */
  at: number;
};

/** Any event published through the telemetry {@link EventBus}. */
export type TelemetryEvent = ToolCallEvent | ToolResultEvent | InterventionEvent;
