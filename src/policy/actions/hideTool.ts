import type { Action, PolicyContext, ActionStrategy, SessionKey } from '../types';
import type { ActionEffect } from './index';
import type { ChatMessage, RequestContext, ResponseContext } from '../../ports';
import type { PolicyAction } from '../ruleEngine';
import type { FeedbackMessage } from '../feedbackStore';

export interface HideToolActionConfig {
  /** Tools to hide; entries are exact names or globs, with a leading "!" marking an allow-list (keep only matches, hide the rest). */
  toolNames: string[];
}

/** Create a hideTool action: apply returns an ActionEffect of type 'hideTool' carrying the configured toolNames. */
export function createHideToolAction(config: HideToolActionConfig): Action {
  return {
    name: 'hideTool',
    apply(_ctx: PolicyContext): ActionEffect {
      return { type: 'hideTool', toolNames: config.toolNames };
    },
  };
}

/** Glob match anchored to the full name (`*` = any run); never throws (malformed patterns fall back to false). */
function nameMatchesGlob(name: string, pattern: string): boolean {
  const source = `^${pattern.split('*').map(escapeRegExp).join('.*')}$`;
  try {
    return new RegExp(source).test(name);
  } catch {
    return false;
  }
}

/** Escape regex-special characters so they match literally (only `*` stays a wildcard). */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Resolve toolNames (block-list or allow-list of exact names/globs) against available names to the concrete names to hide. */
export function resolveHiddenToolNames(patterns: readonly string[], availableNames: readonly string[]): string[] {
  const basePatterns = patterns.map((pattern) => (pattern.startsWith('!') ? pattern.slice(1) : pattern));
  const isAllowList = patterns.some((pattern) => pattern.startsWith('!'));
  const matchesAny = (name: string): boolean => basePatterns.some((base) => nameMatchesGlob(name, base));
  const hidden: string[] = [];
  for (const name of availableNames) {
    if (isAllowList ? !matchesAny(name) : matchesAny(name)) hidden.push(name);
  }
  return hidden;
}

/** hideTool action strategy: strips the named tools (and their message references) from a request; a bare response is a no-op. */
export const hideToolStrategy: ActionStrategy = {
  type: 'hideTool',

  applyRequest(ctx: RequestContext, effect: ActionEffect): void {
    const toolNames = (effect as Extract<ActionEffect, { type: 'hideTool' }>).toolNames;
    // Resolve configured names (block-/allow-list of exact names/globs) against the request's tools, then strip them.
    const hiddenNames = resolveHiddenToolNames(toolNames, toolDefinitionNames(ctx.raw));
    hideToolsFromRequest(ctx, hiddenNames);
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
    return validateHideToolToolNames(record.toolNames);
  },

  buildSpec(spec: unknown): PolicyAction {
    const record = spec as Record<string, unknown>;
    const error = validateHideToolToolNames(record.toolNames);
    if (error !== null) throw new Error(`action "hideTool" ${error}`);
    return createHideToolAction({ toolNames: record.toolNames as string[] }) as PolicyAction;
  },
};

/** Validate toolNames: a non-empty array of non-empty strings whose base pattern (leading "!" stripped) is non-empty; returns an error string or null. */
function validateHideToolToolNames(value: unknown): string | null {
  if (!Array.isArray(value)) return 'missing required "toolNames" array';
  if (value.length === 0) return '"toolNames" must be a non-empty array';
  for (const entry of value) {
    if (typeof entry !== 'string') return '"toolNames" must be an array of strings';
    const base = entry.charAt(0) === '!' ? entry.slice(1) : entry;
    if (base === '') return '"toolNames" entries must be non-empty (a lone "!" is not a pattern)';
  }
  return null;
}

/** Strip concrete tool names from a request (both tool definitions and message references); mutates raw.tools in place, preserving messages identity when nothing matches. */
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

/** Strip hidden-tool references from a message list; returns the input unchanged (same reference) when nothing matches. */
function stripHiddenToolReferences(messages: ChatMessage[], names: Set<string>): ChatMessage[] {
  const removedIds = new Set<string>();
  let changed = false;
  // Pass 1: drop hidden references by name, remembering each removed call's id.
  const withoutRefs = messages.map((message): ChatMessage => {
    if (!isRecord(message)) return message;
    let next: ChatMessage = message;
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
  return withoutRefs.reduce<ChatMessage[]>((out, message) => {
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

/** Read tool-definition names from raw.tools (both OpenAI/Anthropic shapes); best-effort, never throws (yields [] when unavailable). */
function toolDefinitionNames(raw: unknown): string[] {
  const tools = isRecord(raw) ? raw.tools : undefined;
  if (!Array.isArray(tools)) return [];
  const names: string[] = [];
  for (const tool of tools) {
    const name = toolNameOf(tool);
    if (name !== undefined) names.push(name);
  }
  return names;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
