import type { ModelConfig, ToolCall } from './domain';
import type { RequestContext, ResponseContext, ResultContext } from './pipeline';

/** The contexts any matcher/action can observe (request / response / result). */
export type PolicyContext = RequestContext | ResponseContext | ResultContext;

/**
 * Decides whether a rule fires for a given context (Strategy).
 * Pure and side-effect-free: it only inspects the context.
 */
export interface Matcher {
  /** Returns true when the rule should fire. */
  matches(ctx: PolicyContext): boolean;
}

/**
 * The behavior applied when a rule fires (Strategy).
 * May mutate the context in place to rewrite the stream.
 */
export interface Action {
  /** Unique action name. */
  readonly name: string;
  /** Apply the behavior to the context. */
  apply(ctx: PolicyContext): void;
}

/**
 * Supplies injectable tools (e.g. MCP servers, skills) as plugins (Strategy).
 */
export interface ToolProvider {
  /** Stable id for this provider. */
  readonly id: string;
  /** Tool definitions contributed by this provider. */
  listTools(): Promise<ToolCall[]> | ToolCall[];
}

/**
 * Chooses the upstream model for a request (Strategy).
 * v1: single configured model; extensible to per-client routing / fallback.
 */
export interface ModelRouter {
  /** Route the request to the model it should be forwarded to. */
  route(ctx: RequestContext): Promise<ModelConfig> | ModelConfig;
}
