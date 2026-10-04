import { createHash } from 'node:crypto';
import type { SessionKey } from '../ports/domain';

/**
 * Minimal, provider-agnostic view of a single conversation message.
 *
 * Only the fields needed to fingerprint the stable message prefix are modeled;
 * the index signature tolerates provider-specific extras so both OpenAI- and
 * Anthropic-shaped messages are accepted without coupling to either protocol.
 */
export interface Message {
  /** Who produced the message, e.g. `'system'`, `'user'`, `'assistant'`, `'tool'`. */
  role: string;
  /** Message content: a plain string, an array of content parts/blocks, or null. */
  content?: unknown;
  /** Any additional provider-specific fields. */
  [key: string]: unknown;
}

/** Domain tag distinguishing a token-derived fingerprint from a content fingerprint. */
const TOKEN_DOMAIN = 'session-key/token/v1';
/** Domain tag for the content-fingerprint of the stable message prefix. */
const FINGERPRINT_DOMAIN = 'session-key/fingerprint/v1';

/**
 * Derive a stable, per-session key from a client request.
 *
 * A client resends the full message history every turn and there is no
 * conversation-id on the wire, so the key is built from the STABLE message
 * prefix — the system message(s) plus the first user message, i.e. the portion
 * of history that does not grow turn-to-turn — rather than the whole (ever-
 * growing) message list.
 *
 * A client-supplied `token` (non-empty string, e.g. an `X-Session-Id` header)
 * takes PRECEDENCE: the returned fingerprint is derived from the token alone,
 * so it is stable for the same token regardless of the messages, and the
 * returned key's `token` field records the origin. An empty or absent token
 * falls back to the content fingerprint.
 */
export function deriveSessionKey(input: { messages: Message[]; token?: string }): SessionKey {
  const token = normalizeToken(input.token);
  if (token !== undefined) {
    return { fingerprint: hash(`${TOKEN_DOMAIN}\u0000${token}`), token };
  }
  const canonical = stablePrefix(input.messages).map(canonicalMessage).join('\u0001');
  return { fingerprint: hash(`${FINGERPRINT_DOMAIN}\u0000${canonical}`) };
}

/** Treat an empty (`''`) or absent token as "no token"; any non-empty string is used as-is. */
function normalizeToken(token: string | undefined): string | undefined {
  if (token === undefined) return undefined;
  return token.length === 0 ? undefined : token;
}

/**
 * The STABLE message prefix: all system message(s) plus the first user message
 * (in their natural order). Turns appended after the first user message —
 * assistant, tool, and follow-up user messages — are excluded.
 */
function stablePrefix(messages: Message[]): Message[] {
  const systemMessages: Message[] = [];
  let firstUser: Message | undefined;
  for (const message of messages) {
    if (message.role === 'system') {
      systemMessages.push(message);
    } else if (message.role === 'user' && firstUser === undefined) {
      firstUser = message;
    }
  }
  return firstUser === undefined ? systemMessages : [...systemMessages, firstUser];
}

/** Deterministic canonical form of a single message (role + textual content). */
function canonicalMessage(message: Message): string {
  return `${message.role}\u0000${messageText(message.content)}`;
}

/**
 * Extract the textual content of a message. Accepts a plain string, an array of
 * content parts/blocks (joining their `text` fields), or null/undefined.
 */
function messageText(content: unknown): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(
        (part): part is { type?: unknown; text?: unknown } =>
          part !== null && typeof part === 'object',
      )
      .map((part) => (typeof part.text === 'string' ? part.text : ''))
      .join('');
  }
  return String(content);
}

/** SHA-256 hex digest of a UTF-8 string. */
function hash(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}
