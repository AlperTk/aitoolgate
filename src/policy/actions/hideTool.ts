import type { Action, PolicyContext, ActionStrategy, SessionKey } from '../types';
import type { ActionEffect } from './block';
import type { RequestContext, ResponseContext } from '../../ports';
import type { PolicyAction } from '../ruleEngine';
import type { FeedbackMessage } from '../feedbackStore';

/** Configuration for {@link createHideToolAction}. */
export interface HideToolActionConfig {
  /** Names of the tools to hide from the model's available tool set. */
  toolNames: string[];
}

/**
 * Create an {@link Action} that hides the named tools from the model's
 * available tool set when a rule fires.
 *
 * The returned action implements the port {@link Action}: its `apply` returns
 * an {@link ActionEffect} of type `'hideTool'` carrying the configured
 * `toolNames`.
 */
export function createHideToolAction(config: HideToolActionConfig): Action {
  return {
    name: 'hideTool',
    apply(_ctx: PolicyContext): ActionEffect {
      return { type: 'hideTool', toolNames: config.toolNames };
    },
  };
}

/**
 * The `hideTool` action strategy: applies a `hideTool` effect (strips the named
 * tools from a request's tool list AND their message references; a bare response
 * carries no tool list, so it is a graceful no-op), describes it, and
 * validates/builds its wire spec.
 */
export const hideToolStrategy: ActionStrategy = {
  type: 'hideTool',

  applyRequest(ctx: RequestContext, effect: ActionEffect): void {
    hideToolsFromRequest(ctx, (effect as Extract<ActionEffect, { type: 'hideTool' }>).toolNames);
  },

  applyResponse(
    _ctx: ResponseContext,
    _effect: ActionEffect,
    _sessionKey: SessionKey,
    _queue: (key: string | SessionKey, message: FeedbackMessage) => void,
  ): void {
    // A bare response carries no tool list; nothing to hide. Skip gracefully.
  },

  describe(effect: ActionEffect): string {
    return `hid tool(s): ${(effect as Extract<ActionEffect, { type: 'hideTool' }>).toolNames.join(', ')}`;
  },

  validateSpec(spec: unknown): string | null {
    const record = spec as Record<string, unknown>;
    if (!Array.isArray(record.toolNames)) return 'missing required "toolNames" array';
    return null;
  },

  buildSpec(spec: unknown): PolicyAction {
    const record = spec as Record<string, unknown>;
    if (!Array.isArray(record.toolNames)) {
      throw new Error('action "hideTool" requires a "toolNames" array');
    }
    return createHideToolAction({ toolNames: record.toolNames }) as PolicyAction;
  },
};

/**
 * Remove the named tools from a provider request so the model can no longer see or
 * invoke them. This strips BOTH surfaces consistently:
 * - the top-level `tools` definitions (`raw.tools`, either OpenAI/Anthropic shape), and
 * - any in-message references to those tools (assistant `tool_calls` entries / Anthropic
 *   `tool_use` content blocks, plus the tool-result messages/blocks that point at them),
 *   so history does not still expose the hidden tool and the forwarded request stays
 *   consistent. It mutates `ctx.raw`'s `tools` in place and reassigns `ctx.messages`
 *   when references are removed; when nothing matches it is a no-op that preserves the
 *   messages array identity (so an unedited passthrough stays byte-identical).
 */
function hideToolsFromRequest(ctx: RequestContext, toolNames: readonly string[]): void {
  const names = new Set(toolNames);
  const raw = ctx.raw;
  if (isRecord(raw)) {
    const tools = raw.tools;
    if (Array.isArray(tools)) {
      raw.tools = tools.filter((tool) => {
        const name = toolNameOf(tool);
        return name === undefined || !names.has(name);
      });
    }
  }
  ctx.messages = stripHiddenToolReferences(ctx.messages, names);
}

/**
 * Strip hidden-tool references from a provider-agnostic message list. Removes assistant
 * `tool_calls` entries / Anthropic `tool_use` content blocks whose name is hidden, then
 * drops the tool-result references that pointed at a removed call (OpenAI `role:'tool'`
 * messages by `tool_call_id`/name, Anthropic `tool_result` blocks by `tool_use_id`).
 * Returns the input unchanged (same reference) when nothing matches; otherwise a new list.
 */
function stripHiddenToolReferences(messages: unknown[], names: Set<string>): unknown[] {
  const removedIds = new Set<string>();
  let changed = false;
  // Pass 1: drop hidden references by name, remembering each removed call's id.
  const withoutRefs = messages.map((message): unknown => {
    if (!isRecord(message)) return message;
    let next: Record<string, unknown> = message;
    let localChanged = false;
    if (Array.isArray(next.tool_calls)) {
      const list = next.tool_calls as unknown[];
      const kept = list.filter((call) => {
        const name = toolNameOf(call);
        if (name !== undefined && names.has(name)) {
          if (isRecord(call) && typeof call.id === 'string') removedIds.add(call.id);
          return false;
        }
        return true;
      });
      if (kept.length !== list.length) {
        next = { ...next, tool_calls: kept };
        localChanged = true;
      }
    }
    if (Array.isArray(next.content)) {
      const list = next.content as unknown[];
      const kept = list.filter((block) => {
        if (isRecord(block) && block.type === 'tool_use') {
          if (typeof block.name === 'string' && names.has(block.name)) {
            if (typeof block.id === 'string') removedIds.add(block.id);
            return false;
          }
        }
        return true;
      });
      if (kept.length !== list.length) {
        next = { ...next, content: kept };
        localChanged = true;
      }
    }
    if (localChanged) changed = true;
    return next;
  });
  if (!changed) return messages;
  // Pass 2: drop tool-result references tied to a removed call id.
  return withoutRefs.reduce<unknown[]>((out, message) => {
    if (isRecord(message) && message.role === 'tool') {
      const id = typeof message.tool_call_id === 'string' ? message.tool_call_id : undefined;
      const name = typeof message.name === 'string' ? message.name : undefined;
      if ((id !== undefined && removedIds.has(id)) || (name !== undefined && names.has(name))) return out;
    }
    if (isRecord(message) && Array.isArray(message.content)) {
      const content = message.content as unknown[];
      const kept = content.filter(
        (block) =>
          !(
            isRecord(block) &&
            block.type === 'tool_result' &&
            typeof block.tool_use_id === 'string' &&
            removedIds.has(block.tool_use_id)
          ),
      );
      if (kept.length !== content.length) {
        out.push({ ...message, content: kept });
        return out;
      }
    }
    out.push(message);
    return out;
  }, []);
}

/** Extract a tool definition's name from either the OpenAI or Anthropic shape. */
function toolNameOf(tool: unknown): string | undefined {
  if (!isRecord(tool)) return undefined;
  const fn = isRecord(tool.function) ? tool.function : undefined;
  if (typeof fn?.name === 'string') return fn.name;
  return typeof tool.name === 'string' ? tool.name : undefined;
}

/** Type guard: is the value a non-null, non-array object? */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
