import type { Action, Match, PolicyContext, ActionStrategy, SessionKey } from '../types';
import type { ActionEffect } from './index';
import type { RequestContext, ResponseContext } from '../../ports';
import type { PolicyAction } from '../ruleEngine';
import type { FeedbackMessage } from '../feedbackStore';

export interface AddDescriptionActionConfig {
  /** Description text set on the matched tool(s)' definition in the outgoing request. */
  description: string;
}

/** Create an addDescription action: apply returns an addDescription effect for the tool name(s) the match targeted (match.details.matchedToolNames); null when none. */
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

/** addDescription action strategy: sets the matched tool(s)' description in a request's tools (OpenAI or Anthropic shape); a bare response is a no-op. */
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

/** Set the description on each tool in raw.tools whose name matches; understands both provider shapes, mutates in place, no-op when there's no match. */
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
