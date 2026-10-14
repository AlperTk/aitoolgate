/** Policy actions: each action module contributes an ActionStrategy, and the ACTION_STRATEGIES registry maps every effect kind to its strategy — so a new action needs only a new strategy file + one entry here (Open/Closed). */
import type { ActionEffectKind, ActionStrategy } from '../types';
import { hideToolStrategy } from './hideTool';
import { rewriteArgsStrategy } from './rewriteArgs';
import { injectMessageStrategy } from './injectMessage';
import { addDescriptionStrategy } from './addDescription';

/** The effect a policy Action applies to the stream when a rule fires; a discriminated union of effect kinds. */
export type ActionEffect =
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
    }
  | {
      /** Set the matched tool(s)' description on their definition in the outgoing request. */
      type: 'addDescription';
      description: string;
      toolNames: string[];
    };

export { createHideToolAction } from './hideTool';
export type { HideToolActionConfig } from './hideTool';
export { createRewriteArgsAction } from './rewriteArgs';
export type { RewriteArgsActionConfig } from './rewriteArgs';
export { createInjectMessageAction } from './injectMessage';
export type { InjectMessageActionConfig } from './injectMessage';
export { createAddDescriptionAction } from './addDescription';
export type { AddDescriptionActionConfig } from './addDescription';
/** Shared message-splicing primitive (also used by the stage's cross-request feedback drain). */
export { spliceMessages } from './injectMessage';

/** Registry mapping each effect kind to its strategy; the policy stage and ruleSpec look up a strategy instead of switching on the kind. Adding a new action needs only a new strategy file + one entry here (Open/Closed). */
export const ACTION_STRATEGIES: Record<ActionEffectKind, ActionStrategy> = {
  hideTool: hideToolStrategy,
  rewriteArgs: rewriteArgsStrategy,
  injectMessage: injectMessageStrategy,
  addDescription: addDescriptionStrategy,
};
