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

/** Re-exported from `src/ports` (the single source of truth lives there). */
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

/** Provider-agnostic view of a tool definition as it appears in an LLM request (OpenAI `function.name`/`parameters`, Anthropic `name`/`input_schema`), normalized so matchers need not couple to a specific protocol. */
export interface ToolSchema {
  name: string;
  description?: string;
  /** JSON schema describing the tool's parameters (`function.parameters` / `input_schema`). */
  parameters?: Record<string, unknown>;
}

/** The combined observable context a rule/matcher evaluates against — request, response, and result state unified into one policy-level view. */
export interface RuleContext {
  sessionKey: SessionKey;
  client: ClientConfig;
  messages: Message[];
  toolSchemas: ToolSchema[];
  toolCalls: ToolCall[];
  toolResults: ToolResult[];
}

/** The value a policy matcher returns to signal a hit (a rich widening of the port {@link Matcher}'s bare boolean); the port is intentionally NOT modified — where a port `Matcher` is required, adapt via the `matched` field. */
export interface Match {
  matched: boolean;
  /** Human-readable explanation (used by block messages + telemetry). */
  reason: string;
  /** Structured, matcher-specific details (e.g. the matched tool call, counts). */
  details?: Record<string, unknown>;
}

/** A policy-level matcher returning a rich {@link Match} (or `null`); a specialization of the port {@link Matcher}, which is left unchanged. */
export interface PolicyMatcher {
  matches(ctx: PolicyContext): Match | null;
}

/** The discriminator values of the policy {@link ActionEffect} union; derived from the union (not hand-listed) so a new action kind is picked up automatically (Open/Closed). */
export type ActionEffectKind = ActionEffect['type'];

/** A Strategy that owns ONE policy action kind end to end; the registry in `actions/index.ts` maps each {@link ActionEffectKind} to its strategy, so adding a new action needs only a new strategy file + a single registry entry (Open/Closed). */
export interface ActionStrategy {
  readonly type: ActionEffectKind;

  applyRequest(ctx: RequestContext, effect: ActionEffect): void;

  /** Apply the effect to a RESPONSE context in place; `queue` bridges response-side effects into the session's next request via the per-session feedback store. */
  applyResponse(
    ctx: ResponseContext,
    effect: ActionEffect,
    sessionKey: SessionKey,
    queue: (key: string | SessionKey, message: FeedbackMessage) => void,
  ): void;

  describe(effect: ActionEffect): string;

  validateSpec(spec: unknown): string | null;

  /** Build a concrete {@link PolicyAction} from a raw JSON action spec (throws when a required field is missing). */
  buildSpec(spec: unknown): PolicyAction;
}
