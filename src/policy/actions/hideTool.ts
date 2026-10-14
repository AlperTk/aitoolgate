import type { Action, PolicyContext, ActionStrategy, SessionKey } from '../types';
import type { ActionEffect } from './index';
import type { RequestContext, ResponseContext } from '../../ports';
import type { PolicyAction } from '../ruleEngine';
import type { FeedbackMessage } from '../feedbackStore';

/** Configuration for {@link createHideToolAction}. */
export interface HideToolActionConfig {
  /**
   * The tools to hide from the model's available tool set. The entries form EITHER a
   * **block-list** (the default: no entry starts with `!`) — hide every tool whose
   * name matches any entry's base pattern — OR an **allow-list** (at least one entry
   * starts with `!`) — keep only the tools matching any entry's base pattern and hide
   * everything else (the listed base patterns form the keep-set). A base pattern is an
   * exact tool name OR a glob (`*` = any sequence of characters, anchored to the full
   * name), with a single leading `!` stripped: `serena_*` hides every `serena_*` tool;
   * `!serena_*` keeps only `serena_*`; `!graphify_*, !serena_*` keeps only
   * `graphify_*` + `serena_*` and hides the rest. Only names actually present in the
   * request's tool definitions can be hidden.
   */
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
 * Glob match: `*` → any (possibly empty) run of characters, anchored to the full name;
 * all other characters are escaped and matched literally. Never throws (a malformed
 * generated pattern falls back to `false`).
 */
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

/**
 * Resolve a set of `hideTool` `toolNames` against the tool-definition names a request
 * actually offers, producing the CONCRETE names to hide.
 *
 * The entries form EITHER a **block-list** or an **allow-list**:
 * - **Block-list** (no entry starts with `!`): hide every tool whose name matches any
 *   entry's base pattern (the base patterns are OR-combined). `serena_*` hides every
 *   `serena_*` tool; `serena_*, webfetch` hides both `serena_*` and `webfetch`.
 * - **Allow-list** (at least one entry starts with `!`): keep every tool whose name
 *   matches any entry's base pattern and hide EVERYTHING else. The leading `!` is the
 *   allow-list marker; all listed base patterns form the keep-set (their union).
 *   `!serena_*` keeps only `serena_*` and hides the rest; `!graphify_*, !serena_*`
 *   keeps only `graphify_*` + `serena_*` and hides the rest.
 *
 * An entry's "base pattern" is the entry with a single leading `!` stripped; it is an
 * exact name (case-sensitive) OR a glob (`*` = any run of characters, anchored). A
 * plain exact name is backward compatible. Only names actually present in
 * `availableNames` are ever hidden — a pattern matching no present tool is a no-op.
 */
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

/**
 * The `hideTool` action strategy: applies a `hideTool` effect (strips the named
 * tools from a request's tool list AND their message references; a bare response
 * carries no tool list, so it is a graceful no-op), describes it, and
 * validates/builds its wire spec.
 */
export const hideToolStrategy: ActionStrategy = {
  type: 'hideTool',

  applyRequest(ctx: RequestContext, effect: ActionEffect): void {
    const toolNames = (effect as Extract<ActionEffect, { type: 'hideTool' }>).toolNames;
    // Resolve the configured names (a block-list or allow-list of exact names / glob
    // patterns) against the tools the request actually offers, then strip the CONCRETE
    // resolved names from both the tool definitions and the message references.
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

/**
 * Validate a `hideTool` action spec's `toolNames` field: it must be a non-empty array
 * of non-empty strings, where each entry's base pattern (the entry with a single
 * leading `!` stripped) is itself non-empty (a lone `!` is not a pattern). Returns an
 * error message, or `null` when valid.
 */
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

/**
 * Remove the CONCRETE named tools from a provider request so the model can no longer
 * see or invoke them. This strips BOTH surfaces consistently:
 * - the top-level `tools` definitions (`raw.tools`, either OpenAI/Anthropic shape), and
 * - any in-message references to those tools (assistant `tool_calls` entries / Anthropic
 *   `tool_use` content blocks, plus the tool-result messages/blocks that point at them),
 *   so history does not still expose the hidden tool and the forwarded request stays
 *   consistent. It mutates `ctx.raw`'s `tools` in place and reassigns `ctx.messages`
 *   when references are removed; when nothing matches it is a no-op that preserves the
 *   messages array identity (so an unedited passthrough stays byte-identical).
 *
 * `toolNames` are CONCRETE tool names — already resolved from the action's exact-name /
 * glob-pattern config via {@link resolveHiddenToolNames} — so both the tool-definition
 * removal and the message-reference removal are exact (no pattern re-matching here).
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

/**
 * Read the tool-definition names a request offers from `raw.tools`, understanding BOTH
 * provider wire shapes by value (OpenAI `tools[i].function.name` and Anthropic
 * `tools[i].name`). Best-effort: a non-record `raw` or a non-array `tools` yields `[]`
 * (never throws).
 */
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

/** Type guard: is the value a non-null, non-array object? */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
