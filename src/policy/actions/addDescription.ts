import type { Action, Match, PolicyContext, ActionStrategy, SessionKey } from '../types';
import type { ActionEffect } from './index';
import type { RequestContext, ResponseContext } from '../../ports';
import type { PolicyAction } from '../ruleEngine';
import type { FeedbackMessage } from '../feedbackStore';

/** Configuration for {@link createAddDescriptionAction}. */
export interface AddDescriptionActionConfig {
  /** Description text set on the matched tool(s)' definition in the outgoing request. */
  description: string;
}

/**
 * Create an {@link Action} that sets the description of the matched tool(s)'
 * definition in the outgoing request when a rule fires.
 *
 * The returned action implements the port {@link Action}: its `apply` extracts
 * the tool name(s) the match targeted (from `match.details.matchedToolNames`)
 * and returns an {@link ActionEffect} of type `'addDescription'` carrying those
 * names plus the configured `description`. Returns `null` when the match targeted
 * no tool name(s) (there is nothing to set).
 */
export function createAddDescriptionAction(config: AddDescriptionActionConfig): Action {
  return {
    name: 'addDescription',
    apply(_ctx: PolicyContext, match?: Match): ActionEffect | null {
      const toolNames = matchedToolNamesOf(match);
      if (toolNames === undefined) return null;
      return { type: 'addDescription', description: config.description, toolNames };
    },
  };
}

/**
 * The `addDescription` action strategy: applies an `addDescription` effect (sets
 * the matched tool(s)' description in the request's `tools` array, in either the
 * OpenAI `tools[i].function.description` or the Anthropic top-level
 * `tools[i].description` shape), describes it, and validates/builds its wire
 * spec. A bare response carries no tool list, so the response phase is a
 * graceful no-op.
 */
export const addDescriptionStrategy: ActionStrategy = {
  type: 'addDescription',

  applyRequest(ctx: RequestContext, effect: ActionEffect): void {
    const add = effect as Extract<ActionEffect, { type: 'addDescription' }>;
    setDescriptionOnTools(ctx.raw, add.toolNames, add.description);
  },

  applyResponse(
    _ctx: ResponseContext,
    _effect: ActionEffect,
    _sessionKey: SessionKey,
    _queue: (key: string | SessionKey, message: FeedbackMessage) => void,
  ): void {
    // A bare response carries no tool list; nothing to describe. Skip gracefully.
  },

  describe(effect: ActionEffect): string {
    const add = effect as Extract<ActionEffect, { type: 'addDescription' }>;
    return `set description for tool(s) ${add.toolNames.join(', ')}: ${add.description}`;
  },

  validateSpec(spec: unknown): string | null {
    const record = spec as Record<string, unknown>;
    if (typeof record.description !== 'string') return 'missing required "description" string';
    return null;
  },

  buildSpec(spec: unknown): PolicyAction {
    const record = spec as Record<string, unknown>;
    if (typeof record.description !== 'string') {
      throw new Error('action "addDescription" requires a "description" string');
    }
    return createAddDescriptionAction({ description: record.description }) as PolicyAction;
  },
};

/**
 * Set the given description on each tool in the request's `tools` array whose
 * name is in `toolNames`. Understands both provider shapes (OpenAI
 * `tools[i].function.description` and Anthropic top-level `tools[i].description`).
 * Mutates `raw` in place. A no-op (no throw, no new entries) when `raw` has no
 * `tools` array, when no tool name matches, or when a matching entry carries no
 * recognizable shape.
 */
function setDescriptionOnTools(raw: unknown, toolNames: readonly string[], description: string): void {
  if (toolNames.length === 0) return;
  if (!isRecord(raw)) return;
  const tools = raw.tools;
  if (!Array.isArray(tools)) return;
  const names = new Set(toolNames);
  for (const tool of tools) {
    const name = toolNameOf(tool);
    if (name !== undefined && names.has(name)) setDescriptionOnTool(tool, description);
  }
}

/** Set the description on a single tool definition, in whichever shape it carries. */
function setDescriptionOnTool(tool: unknown, description: string): void {
  if (!isRecord(tool)) return;
  const fn = tool.function;
  if (isRecord(fn)) {
    // OpenAI shape: tools[i].function.description
    fn.description = description;
  } else {
    // Anthropic shape: tools[i].description (top-level)
    tool.description = description;
  }
}

/** Extract a tool definition's name from either the OpenAI or Anthropic shape. */
function toolNameOf(tool: unknown): string | undefined {
  if (!isRecord(tool)) return undefined;
  const fn = isRecord(tool.function) ? tool.function : undefined;
  if (typeof fn?.name === 'string') return fn.name;
  return typeof tool.name === 'string' ? tool.name : undefined;
}

/** The tool name(s) a match actually targeted (undefined when it carries none). */
function matchedToolNamesOf(match: Match | undefined): string[] | undefined {
  const raw = match?.details?.matchedToolNames;
  if (!Array.isArray(raw)) return undefined;
  const names = raw.filter((name): name is string => typeof name === 'string' && name.length > 0);
  return names.length > 0 ? names : undefined;
}

/** Type guard: is the value a non-null, non-array object? */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
