import type { Action, PolicyContext, ActionStrategy, SessionKey } from '../types';
import type { ActionEffect } from './index';
import type { ChatMessage, RequestContext, ResponseContext } from '../../ports';
import type { PolicyAction } from '../ruleEngine';
import type { FeedbackMessage } from '../feedbackStore';
import type { Message } from '../../session/session';

export interface InjectMessageActionConfig {
  /** Role of the injected message. Defaults to `'user'`. */
  role?: 'user' | 'system';
  content: string;
}

/** Create an injectMessage action: apply returns an injectMessage effect carrying the configured role (default 'user') and content. */
export function createInjectMessageAction(config: InjectMessageActionConfig): Action {
  return {
    name: 'injectMessage',
    apply(_ctx: PolicyContext): ActionEffect {
      return { type: 'injectMessage', role: config.role ?? 'user', content: config.content };
    },
  };
}

/** injectMessage action strategy: splices the message into a request's stream (or queues it for the next request on a bare response); describes and validates/builds its spec. */
export const injectMessageStrategy: ActionStrategy = {
  type: 'injectMessage',

  applyRequest(ctx: RequestContext, effect: ActionEffect): void {
    const inject = effect as Extract<ActionEffect, { type: 'injectMessage' }>;
    ctx.messages = spliceMessages(ctx.messages, [{ role: inject.role, content: inject.content }]);
  },

  applyResponse(
    _ctx: ResponseContext,
    effect: ActionEffect,
    sessionKey: SessionKey,
    queue: (key: string | SessionKey, message: FeedbackMessage) => void,
  ): void {
    const inject = effect as Extract<ActionEffect, { type: 'injectMessage' }>;
    // A bare response has no place to insert; queue it for the next request.
    queue(sessionKey, { role: inject.role, content: inject.content });
  },

  describe(effect: ActionEffect): string {
    const inject = effect as Extract<ActionEffect, { type: 'injectMessage' }>;
    return `injected ${inject.role} message: ${inject.content}`;
  },

  validateSpec(spec: unknown): string | null {
    const record = spec as Record<string, unknown>;
    if (typeof record.content !== 'string') return 'missing required "content" string';
    return null;
  },

  buildSpec(spec: unknown): PolicyAction {
    const record = spec as Record<string, unknown>;
    if (typeof record.content !== 'string') {
      throw new Error('action "injectMessage" requires a "content" string');
    }
    const config: InjectMessageActionConfig = { content: record.content };
    if (record.role === 'user' || record.role === 'system') config.role = record.role;
    return createInjectMessageAction(config) as PolicyAction;
  },
};

/** Insert messages after the system prefix / before the trailing user turn; shared by the injectMessage effect and the cross-request feedback drain. */
export function spliceMessages(messages: ChatMessage[], inserts: readonly Message[]): ChatMessage[] {
  if (inserts.length === 0) return messages;
  const result = [...messages];
  const at = injectionIndex(messages);
  result.splice(at, 0, ...inserts);
  return result;
}

function injectionIndex(messages: unknown[]): number {
  // Right after the leading system-message prefix...
  let start = 0;
  while (start < messages.length && roleOf(messages[start]) === 'system') start++;
  // ...but before the trailing user turn, when one occurs after that prefix.
  let lastUser = -1;
  for (let i = messages.length - 1; i > start; i--) {
    if (roleOf(messages[i]) === 'user') {
      lastUser = i;
      break;
    }
  }
  return lastUser >= 0 ? lastUser : messages.length;
}

function roleOf(message: unknown): string | undefined {
  if (!isRecord(message)) return undefined;
  return typeof message.role === 'string' ? message.role : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
