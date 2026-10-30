import type { UpstreamProtocol } from '../../config/config';
import type { Protocol } from '../ports/protocol';
import { createAnthropicMessagesProtocol, encodeAnthropicErrorBody } from './anthropic-messages/protocol';
import { createOpenAIChatProtocol, encodeOpenAIErrorBody } from './openai-chat/protocol';

/** One registered wire protocol: its codec factory, upstream HTTP path, and client error-body encoder. */
export interface ProtocolRegistration {
  create: () => Protocol;
  streamPath: string;
  errorBody: (message: string) => Record<string, unknown>;
}

/** Protocol id → registration. Adding a protocol = one entry here (Open/Closed). */
const REGISTRY = {
  'openai-chat': {
    create: createOpenAIChatProtocol,
    streamPath: '/chat/completions',
    errorBody: encodeOpenAIErrorBody,
  },
  'anthropic-messages': {
    create: createAnthropicMessagesProtocol,
    streamPath: '/messages',
    errorBody: encodeAnthropicErrorBody,
  },
} as const satisfies Record<string, ProtocolRegistration>;

export type ProtocolId = keyof typeof REGISTRY;

/** Config-level upstream protocol name → registry id. Typed exhaustively over `UpstreamProtocol`. */
export const WIRE_PROTOCOL_IDS: Readonly<Record<UpstreamProtocol, ProtocolId>> = {
  openai: 'openai-chat',
  anthropic: 'anthropic-messages',
};

/** Registration for a protocol id (total: the id type is derived from the table). */
export function protocolRegistration(id: ProtocolId): ProtocolRegistration {
  return REGISTRY[id];
}

/** Client error body for a protocol id; unknown ids fall back to the OpenAI shape. */
export function clientErrorBody(id: string, message: string): Record<string, unknown> {
  const known = Object.hasOwn(REGISTRY, id) ? REGISTRY[id as ProtocolId] : REGISTRY['openai-chat'];
  return known.errorBody(message);
}

/** Message carried by an upstream error body (`{error:{message}}`, `{error:"text"}` or `{message}`, shared by both wire protocols); undefined when absent. */
export function upstreamErrorMessage(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const record = body as { error?: unknown; message?: unknown };
  if (typeof record.error === 'string') return record.error;
  if (typeof record.error === 'object' && record.error !== null) {
    const message = (record.error as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return typeof record.message === 'string' ? record.message : undefined;
}
