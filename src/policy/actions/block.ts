import type { Action, Match, PolicyContext, ActionStrategy, SessionKey } from '../types';
import type { RequestContext, ResponseContext } from '../../ports';
import type { PolicyAction } from '../ruleEngine';
import type { FeedbackMessage } from '../feedbackStore';

/**
 * The effect a policy {@link Action} applies to the stream when a rule fires.
 *
 * A discriminated union — each member describes one kind of behavior the rule
 * engine carries out. Only `block` is implemented today; `hideTool`,
 * `rewriteArgs`, and `injectMessage` are reserved for future actions.
 */
export type ActionEffect =
  | {
      /** Block the matched tool call(s); see {@link createBlockAction}. */
      type: 'block';
      /** Specific tool-call ids to block. Omit to block all matched calls. */
      toolCallIds?: string[];
      /** Human-readable explanation. A `block` is never silent. */
      message: string;
    }
  | {
      /** Hide the named tools from the model's available tool set. */
      type: 'hideTool';
      toolNames: string[];
    }
  | {
      /** Rewrite a tool call's arguments before it reaches the executor. */
      type: 'rewriteArgs';
      toolCallId: string;
      newArguments: string | Record<string, unknown>;
    }
  | {
      /** Inject an additional message into the stream. */
      type: 'injectMessage';
      role: 'user' | 'system';
      content: string;
    };

/** Configuration for {@link createBlockAction}. */
export interface BlockActionConfig {
  /** Why the rule fired; substituted for `{reason}` in the message. */
  reason?: string;
  /** Message emitted verbatim when blocking (takes precedence over `template`). */
  message?: string;
  /** Message template with `{tool}` / `{reason}` placeholders, used when `message` is absent. */
  template?: string;
}

const DEFAULT_BLOCK_MESSAGE = "Tool call '{tool}' was blocked: {reason}";
const NO_REASON = 'no reason given';
const UNKNOWN_TOOL = 'unknown';

/**
 * Create an {@link Action} that blocks the tool call(s) matched by a rule.
 *
 * The returned action implements the port {@link Action}: its `apply` inspects
 * the context and returns an {@link ActionEffect} of type `'block'`. It is
 * never silent — the effect always carries a `message`: the configured
 * `message` (verbatim), else the configured `template`, else a default, in
 * each case substituting `{tool}` and `{reason}`. When the match targets
 * specific tool calls (ids observable on the context), those ids are carried on
 * `toolCallIds`; otherwise `toolCallIds` is omitted (blocking all matched
 * calls).
 */
export function createBlockAction(config: BlockActionConfig): Action {
  return {
    name: 'block',
    apply(ctx: PolicyContext, match?: Match): ActionEffect {
      const { ids, names } = extractFromContext(ctx, matchedNamesOf(match));
      const effect: Extract<ActionEffect, { type: 'block' }> = {
        type: 'block',
        message: buildMessage(config, dedupe(names)),
      };
      if (ids.length > 0) effect.toolCallIds = dedupe(ids);
      return effect;
    },
  };
}

/**
 * The `block` action strategy: applies a `block` effect (drop the offending tool
 * call(s) from a request; drop them from a response AND queue never-silent
 * feedback), describes it, and validates/builds its wire spec.
 */
export const blockStrategy: ActionStrategy = {
  type: 'block',

  applyRequest(ctx: RequestContext, effect: ActionEffect): void {
    const block = effect as Extract<ActionEffect, { type: 'block' }>;
    withAssistantToolCalls(ctx.messages, (message, toolCalls) => {
      if (block.toolCallIds === undefined) {
        message.tool_calls = [];
      } else {
        const blocked = new Set(block.toolCallIds);
        message.tool_calls = toolCalls.filter(
          (toolCall) => !(isRecord(toolCall) && typeof toolCall.id === 'string' && blocked.has(toolCall.id)),
        );
      }
    });
  },

  applyResponse(
    ctx: ResponseContext,
    effect: ActionEffect,
    sessionKey: SessionKey,
    queue: (key: string | SessionKey, message: FeedbackMessage) => void,
  ): void {
    const block = effect as Extract<ActionEffect, { type: 'block' }>;
    // Drop the offending tool call(s) from the response. When `toolCallIds` is
    // omitted, block every call carried on the context.
    if (ctx.toolCalls.length > 0) {
      if (block.toolCallIds === undefined) {
        ctx.toolCalls = [];
      } else {
        const blocked = new Set(block.toolCallIds);
        ctx.toolCalls = ctx.toolCalls.filter((call) => !blocked.has(call.id));
      }
    }
    // A block is never silent: queue its feedback for the next request.
    queue(sessionKey, { role: 'user', content: block.message });
  },

  describe(effect: ActionEffect): string {
    const block = effect as Extract<ActionEffect, { type: 'block' }>;
    return block.toolCallIds !== undefined
      ? `blocked ${block.toolCallIds.length} tool call(s) (${block.message})`
      : `blocked all tool calls (${block.message})`;
  },

  validateSpec(_spec: unknown): string | null {
    // `block` has no required fields (reason / message / template are all optional).
    return null;
  },

  buildSpec(spec: unknown): PolicyAction {
    const record = spec as Record<string, unknown>;
    const config: BlockActionConfig = {};
    if (typeof record.reason === 'string') config.reason = record.reason;
    if (typeof record.message === 'string') config.message = record.message;
    if (typeof record.template === 'string') config.template = record.template;
    return createBlockAction(config) as PolicyAction;
  },
};

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

/**
 * Compute the block message: configured `message` verbatim, else the
 * configured `template` (falling back to {@link DEFAULT_BLOCK_MESSAGE}), with
 * `{tool}` and `{reason}` substituted. Never returns an empty string.
 */
function buildMessage(config: BlockActionConfig, toolNames: string[]): string {
  if (nonEmptyString(config.message)) {
    return config.message;
  }
  const template = nonEmptyString(config.template) ? config.template : DEFAULT_BLOCK_MESSAGE;
  const reason = nonEmptyString(config.reason) ? config.reason : NO_REASON;
  const tool = toolNames.join(', ') || UNKNOWN_TOOL;
  return render(template, { tool, reason });
}

/** Replace every `{key}` occurrence in `template` with its value. */
function render(template: string, vars: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.split(`{${key}}`).join(value);
  }
  return result;
}

/** Distinct values, preserving first-seen order. */
function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

/** Type guard: a non-empty string. */
function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Extract tool-call ids and names observable in the policy context.
 *
 * Prefers the parsed `ToolCall[]` (`ResponseContext.toolCalls`); when that is
 * absent, falls back to parsing OpenAI-shape `tool_calls` out of assistant
 * messages (`RequestContext.messages`) — mirroring the matcher extraction. When
 * {@link matchedNamesOf} yields a non-empty target set (i.e. the rule's match
 * identified specific tool names), ONLY calls whose name is in that set are
 * returned, so a block scopes to the MATCHED calls rather than every call on the
 * context. With no target info (e.g. an "always" rule) every observable call
 * applies, preserving the prior behavior.
 */
function extractFromContext(ctx: PolicyContext, matchedNames?: string[]): { ids: string[]; names: string[] } {
  const allowed = matchedNames !== undefined ? new Set(matchedNames) : undefined;
  const matchesTarget = (name: unknown): boolean =>
    allowed === undefined || (typeof name === 'string' && allowed.has(name));
  const ids: string[] = [];
  const names: string[] = [];
  if ('toolCalls' in ctx) {
    for (const call of ctx.toolCalls ?? []) {
      if (!matchesTarget(call.name)) continue;
      pushIf(ids, call.id);
      pushIf(names, call.name);
    }
  } else if ('messages' in ctx) {
    for (const message of ctx.messages ?? []) {
      if (!isRecord(message) || message.role !== 'assistant') continue;
      const toolCalls = message.tool_calls;
      if (!Array.isArray(toolCalls)) continue;
      for (const raw of toolCalls) {
        if (!isRecord(raw)) continue;
        const fn = isRecord(raw.function) ? raw.function : undefined;
        const name = fn && typeof fn.name === 'string' ? fn.name : undefined;
        if (!matchesTarget(name)) continue;
        pushIf(ids, raw.id);
        if (fn) pushIf(names, name);
      }
    }
  }
  return { ids, names };
}

/** The tool-call names a match actually targeted (undefined when it carries none). */
function matchedNamesOf(match: Match | undefined): string[] | undefined {
  const raw = match?.details?.matchedToolNames;
  if (!Array.isArray(raw)) return undefined;
  const names = raw.filter((name): name is string => typeof name === 'string' && name.length > 0);
  return names.length > 0 ? names : undefined;
}
/** Append `value` to `target` when it is a non-empty string. */
function pushIf(target: string[], value: unknown): void {
  if (typeof value === 'string' && value.length > 0) target.push(value);
}

/** Type guard: a non-null, non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
