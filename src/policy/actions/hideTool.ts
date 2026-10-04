import type { Action, PolicyContext } from '../types';
import type { ActionEffect } from './block';

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
