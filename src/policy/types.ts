import type {
  Action,
  ClientConfig,
  Matcher,
  PolicyContext,
  RequestContext,
  ResponseContext,
  Rule,
  SessionKey,
  ToolCall,
  ToolResult,
} from '../ports';
import type { Message } from '../session/session';
import type { ActionEffect } from './actions';
import type { PolicyAction } from './ruleEngine';
import type { FeedbackMessage } from './feedbackStore';

/**
 * Re-exported from `src/ports` (the single source of truth lives there).
 * Policy consumers can import these alongside the policy-only types defined
 * below from this single module.
 */
export type {
  Action,
  ClientConfig,
  Matcher,
  PolicyContext,
  Rule,
  SessionKey,
  ToolCall,
  ToolResult,
};

/**
 * Provider-agnostic view of a tool definition as it appears in an LLM request.
 *
 * - OpenAI: a `tools[]` entry carries `function.name` + `function.parameters`
 *   (a JSON schema describing the arguments).
 * - Anthropic: a `tools[]` entry carries `name` + `input_schema` (a JSON schema
 *   describing the tool's `input`).
 *
 * Normalized to `name` + optional `description` + a JSON-schema-like
 * `parameters` so matchers can reason about available tools without coupling to
 * a specific protocol.
 */
export interface ToolSchema {
  /** Name of the tool, as invoked by the model. */
  name: string;
  /** Human-readable description of what the tool does. */
  description?: string;
  /** JSON schema describing the tool's parameters (`function.parameters` / `input_schema`). */
  parameters?: Record<string, unknown>;
}

/**
 * The combined observable context a rule/matcher evaluates against — request,
 * response, and result state unified into a single policy-level view.
 */
export interface RuleContext {
  /** Session the rule evaluation belongs to. */
  sessionKey: SessionKey;
  /** Client that made the request. */
  client: ClientConfig;
  /** Provider-agnostic message history. */
  messages: Message[];
  /** Tool definitions available to the model. */
  toolSchemas: ToolSchema[];
  /** Tool calls the model emitted in the latest response. */
  toolCalls: ToolCall[];
  /** Tool-call results fed back into the stream. */
  toolResults: ToolResult[];
}

/**
 * The value a policy matcher returns to signal a hit, or `null` when it does
 * not fire.
 *
 * The port {@link Matcher} only returns a bare `boolean`, which is insufficient
 * for the rule engine: block messages need a human-readable `reason`
 * ("blocked by rule X, reason: …") and telemetry needs structured `details`.
 * This policy-level type widens that boolean signal into a rich result. The
 * port is intentionally NOT modified (single source of truth preserved in
 * `src/ports/strategy.ts`); where a port `Matcher` is required, adapt via the
 * `matched` field.
 */
export interface Match {
  /** Whether the rule fired. */
  matched: boolean;
  /** Human-readable explanation (used by block messages + telemetry). */
  reason: string;
  /** Structured, matcher-specific details (e.g. the matched tool call, counts). */
  details?: Record<string, unknown>;
}

/**
 * A policy-level matcher. Unlike the port {@link Matcher} (which returns a bare
 * `boolean`), this returns a rich {@link Match} — or `null` when it does not
 * fire — so the rule engine can explain *why* a rule fired.
 *
 * NOTE: this is a policy-level specialization of the port `Matcher`; the port
 * itself is left unchanged.
 */
export interface PolicyMatcher {
  matches(ctx: PolicyContext): Match | null;
}

/**
 * The discriminator values of the policy {@link ActionEffect} union
 * (`'hideTool' | 'rewriteArgs' | 'injectMessage' | 'addDescription'`). Derived from the
 * union (not hand-listed), so a newly-added action kind is picked up
 * automatically — a core part of the Open/Closed design.
 */
export type ActionEffectKind = ActionEffect['type'];

/**
 * A Strategy that owns ONE policy action kind end to end: how to apply it to the
 * stream (request and response phases), how to describe it, and how to validate
 * and build its wire spec. Each action module contributes one strategy; the
 * registry in `actions/index.ts` maps each {@link ActionEffectKind} to its
 * strategy, so both the policy stage (dispatching by `effect.type`) and ruleSpec
 * (dispatching by `spec.type`) look up a strategy instead of switching on the
 * kind. Adding a new action therefore needs only a new strategy file + a single
 * registry entry (Open/Closed).
 */
export interface ActionStrategy {
  /** The effect kind this strategy handles (mirrors `ActionEffect.type`). */
  readonly type: ActionEffectKind;

  /** Apply the effect to a REQUEST context, editing its message stream in place. */
  applyRequest(ctx: RequestContext, effect: ActionEffect): void;

  /**
   * Apply the effect to a RESPONSE context, editing it in place. `queue` bridges
   * response-side effects (e.g. `block`, `injectMessage`) into the session's next
   * request via the per-session feedback store.
   */
  applyResponse(
    ctx: ResponseContext,
    effect: ActionEffect,
    sessionKey: SessionKey,
    queue: (key: string | SessionKey, message: FeedbackMessage) => void,
  ): void;

  /** A short, human-readable summary of the applied effect (the intervention event's `detail`). */
  describe(effect: ActionEffect): string;

  /**
   * Validate a raw JSON action spec (the wire form). Returns an error message for
   * a malformed spec, or `null` when this kind's required fields are present and
   * correctly typed.
   */
  validateSpec(spec: unknown): string | null;

  /** Build a concrete {@link PolicyAction} from a raw JSON action spec (throws when a required field is missing). */
  buildSpec(spec: unknown): PolicyAction;
}
