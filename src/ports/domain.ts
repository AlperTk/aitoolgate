import type { Matcher } from './strategy';
import type { Action } from './strategy';

/** A tool call emitted by the model (provider-agnostic view). */
export interface ToolCall {
  /** Stable id for this call within the message. */
  id: string;
  /** Name of the tool being invoked. */
  name: string;
  /** Parsed (JSON) arguments for the call. */
  arguments: Record<string, unknown>;
}

/** Result of executing a tool call, as returned by the agent/executor. */
export interface ToolResult {
  /** Id of the tool call this result corresponds to. */
  toolCallId: string;
  /** Name of the tool. */
  name: string;
  /** Whether the call failed. */
  isError: boolean;
  /** Result payload (content). */
  content: unknown;
}

/** Configuration of an upstream model endpoint. */
export interface ModelConfig {
  /** Stable id for this model. */
  id: string;
  /** Base URL of the upstream provider, e.g. http://localhost:4000/v1 */
  baseUrl: string;
  /** Model name passed to the upstream provider. */
  model: string;
  /** Optional provider API key. */
  apiKey?: string;
}

/** Per-client identity (LiteLLM-style API key). */
export interface ClientConfig {
  /** Per-client API key. */
  apiKey: string;
  /** Human-readable name. */
  name: string;
  /** Default model this client is routed to. */
  model: string;
}

/** Identifies a logical session (for stateful / loop detection). */
export interface SessionKey {
  /** Content-fingerprint of the stable message prefix. */
  fingerprint: string;
  /** Optional client-supplied token (X-Session-Id). */
  token?: string;
}

/** A domain event emitted through the {@link TelemetryEventBus}. */
export interface PolicyEvent {
  /** Unique event id. */
  id: string;
  /** When the event occurred (ISO timestamp). */
  at: string;
  /** Discriminator for the event type. */
  type: string;
  /** Session the event belongs to, if any. */
  sessionKey?: string;
  /** Rule that fired, if any. */
  ruleId?: string;
  /** Structured, event-type-specific payload. */
  payload: Record<string, unknown>;
}

/** A declarative rule in the policy pipeline. */
export interface Rule {
  /** Unique rule id. */
  id: string;
  /** Whether the rule is active. */
  enabled: boolean;
  /** Ordering: lower value runs earlier (implementation-defined). */
  priority: number;
  /** Condition under which the rule fires. */
  matcher: Matcher;
  /** Behavior applied when the matcher fires. */
  action: Action;
  /** Human description. */
  description: string;
}
