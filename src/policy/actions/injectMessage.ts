import type { Action, PolicyContext } from '../types';
import type { ActionEffect } from './block';

/** Configuration for {@link createInjectMessageAction}. */
export interface InjectMessageActionConfig {
  /** Role of the injected message. Defaults to `'user'`. */
  role?: 'user' | 'system';
  /** Message content to inject into the stream. */
  content: string;
}

/**
 * Create an {@link Action} that injects an additional message into the stream
 * when a rule fires.
 *
 * The returned action implements the port {@link Action}: its `apply` returns
 * an {@link ActionEffect} of type `'injectMessage'` carrying the configured
 * `role` (defaulting to `'user'`) and `content`.
 */
export function createInjectMessageAction(config: InjectMessageActionConfig): Action {
  return {
    name: 'injectMessage',
    apply(_ctx: PolicyContext): ActionEffect {
      return { type: 'injectMessage', role: config.role ?? 'user', content: config.content };
    },
  };
}
