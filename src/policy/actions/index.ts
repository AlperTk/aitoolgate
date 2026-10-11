/**
 * Policy actions — concrete, rule-level behaviors applied when a matcher fires.
 *
 * Each factory returns a port {@link Action} (from `src/ports`). All four
 * built-in actions are implemented; each re-exports its config type alongside
 * its factory. The shared {@link ActionEffect} union is defined in this module.
 *
 * Each action module ALSO contributes an {@link ActionStrategy} (how to apply,
 * describe, validate, and build its effect). The {@link ACTION_STRATEGIES}
 * registry maps every {@link ActionEffectKind} to its strategy, so the policy
 * stage (dispatching by `effect.type`) and ruleSpec (dispatching by `spec.type`)
 * look up a strategy instead of switching on the kind. Adding a new action is
 * therefore a new strategy file + a single entry below (Open/Closed).
 */
import type { ActionEffectKind, ActionStrategy } from '../types';
import { hideToolStrategy } from './hideTool';
import { rewriteArgsStrategy } from './rewriteArgs';
import { injectMessageStrategy } from './injectMessage';
import { addDescriptionStrategy } from './addDescription';

/**
 * The effect a policy {@link Action} applies to the stream when a rule fires.
 *
 * A discriminated union — each member describes one kind of behavior the rule
 * engine carries out.
 */
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
      /** Description text set on the matched tool(s). */
      description: string;
      /** Names of the tools to set the description on. */
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

/**
 * The registry mapping each policy effect kind to its strategy. The policy stage
 * looks up a strategy by `effect.type` to apply/describe it, and ruleSpec looks
 * one up by `spec.type` to validate/build it. Adding a new action requires only a
 * new strategy file + a single entry here — no per-kind switch to edit.
 */
export const ACTION_STRATEGIES: Record<ActionEffectKind, ActionStrategy> = {
  hideTool: hideToolStrategy,
  rewriteArgs: rewriteArgsStrategy,
  injectMessage: injectMessageStrategy,
  addDescription: addDescriptionStrategy,
};
