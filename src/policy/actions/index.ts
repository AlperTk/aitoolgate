/**
 * Policy actions — concrete, rule-level behaviors applied when a matcher fires.
 *
 * Each factory returns a port {@link Action} (from `src/ports`). All four
 * built-in actions are implemented; each re-exports its config type alongside
 * its factory. The shared {@link ActionEffect} union lives in `./block`.
 *
 * Each action module ALSO contributes an {@link ActionStrategy} (how to apply,
 * describe, validate, and build its effect). The {@link ACTION_STRATEGIES}
 * registry maps every {@link ActionEffectKind} to its strategy, so the policy
 * stage (dispatching by `effect.type`) and ruleSpec (dispatching by `spec.type`)
 * look up a strategy instead of switching on the kind. Adding a new action is
 * therefore a new strategy file + a single entry below (Open/Closed).
 */
import type { ActionEffectKind, ActionStrategy } from '../types';
import { blockStrategy } from './block';
import { hideToolStrategy } from './hideTool';
import { rewriteArgsStrategy } from './rewriteArgs';
import { injectMessageStrategy } from './injectMessage';

export { createBlockAction } from './block';
export type { BlockActionConfig } from './block';
export type { ActionEffect } from './block';
export { createHideToolAction } from './hideTool';
export type { HideToolActionConfig } from './hideTool';
export { createRewriteArgsAction } from './rewriteArgs';
export type { RewriteArgsActionConfig } from './rewriteArgs';
export { createInjectMessageAction } from './injectMessage';
export type { InjectMessageActionConfig } from './injectMessage';
/** Shared message-splicing primitive (also used by the stage's cross-request feedback drain). */
export { spliceMessages } from './injectMessage';

/**
 * The registry mapping each policy effect kind to its strategy. The policy stage
 * looks up a strategy by `effect.type` to apply/describe it, and ruleSpec looks
 * one up by `spec.type` to validate/build it. Adding a new action requires only a
 * new strategy file + a single entry here — no per-kind switch to edit.
 */
export const ACTION_STRATEGIES: Record<ActionEffectKind, ActionStrategy> = {
  block: blockStrategy,
  hideTool: hideToolStrategy,
  rewriteArgs: rewriteArgsStrategy,
  injectMessage: injectMessageStrategy,
};
