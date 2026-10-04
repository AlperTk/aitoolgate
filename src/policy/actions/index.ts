/**
 * Policy actions — concrete, rule-level behaviors applied when a matcher fires.
 *
 * Each factory returns a port {@link Action} (from `src/ports`). All four
 * built-in actions are implemented; each re-exports its config type alongside
 * its factory. The shared {@link ActionEffect} union lives in `./block`.
 */
export { createBlockAction } from './block';
export type { BlockActionConfig } from './block';
export type { ActionEffect } from './block';
export { createHideToolAction } from './hideTool';
export type { HideToolActionConfig } from './hideTool';
export { createRewriteArgsAction } from './rewriteArgs';
export type { RewriteArgsActionConfig } from './rewriteArgs';
export { createInjectMessageAction } from './injectMessage';
export type { InjectMessageActionConfig } from './injectMessage';
