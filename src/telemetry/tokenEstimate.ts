/**
 * Character-based token estimation over FULL message content (dependency-free).
 *
 * The preferred source of per-turn token mass is the upstream-reported usage
 * (response body or stream usage frames, normalized to `{ input?, output?,
 * total? }`). This module supplies a best-effort fallback so per-request token
 * accounting covers ALL of the request/response message content — system/user/
 * assistant text as well as tool calls/results — even for turns whose upstream
 * reported no usage (instead of contributing zero).
 *
 * The assumption mirrors the collector's response-payload estimate: an average
 * of ~4 characters per token ({@link EST_CHARS_PER_TOKEN}). Estimates are
 * character-count based and intentionally rough; they exist so a usage-less
 * turn contributes honest, non-zero token mass rather than none.
 */

/** Assumed average characters per token when estimating payload size in tokens. */
export const EST_CHARS_PER_TOKEN = 4;

/** True for non-null, non-array objects (plain JSON-like records). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Extract the textual content of a message content value: a plain string, an array of
 * content parts/blocks (joining their `text` fields), or null/undefined (empty).
 * Tolerates provider-specific parts without coupling to either protocol.
 */
export function messageTextOf(content: unknown): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(
        (part): part is { type?: unknown; text?: unknown } => part !== null && typeof part === 'object',
      )
      .map((part) => (typeof part.text === 'string' ? part.text : ''))
      .join('');
  }
  return String(content);
}

/** Convert a raw character count into an estimated token count (rounded, clamped >= 0). */
export function estimateTokensFromChars(chars: number): number {
  return Number.isFinite(chars) && chars > 0 ? Math.max(0, Math.round(chars / EST_CHARS_PER_TOKEN)) : 0;
}

/**
 * Estimate the INPUT token mass of a request from its FULL provider-agnostic message list:
 * every message's textual content (any role — system, user, assistant, tool) plus any
 * OpenAI-style assistant `tool_calls[].function.arguments` carried on the messages, i.e.
 * everything the client resends as history — not only tool-related content. Returns 0 for a
 * non-array or empty message list (never throws).
 */
export function estimateInputTokens(messages: unknown): number {
  if (!Array.isArray(messages)) return 0;
  let chars = 0;
  for (const message of messages) {
    if (!isRecord(message)) continue;
    chars += messageTextOf(message.content).length;
    // OpenAI assistant messages carry their tool-call arguments on the message itself; they are
    // part of the resent history the upstream tokenizes, so count them too.
    const toolCalls = message.tool_calls;
    if (Array.isArray(toolCalls)) {
      for (const toolCall of toolCalls) {
        const fn = isRecord(toolCall) ? toolCall.function : undefined;
        if (isRecord(fn) && typeof fn.arguments === 'string') chars += fn.arguments.length;
      }
    }
  }
  return estimateTokensFromChars(chars);
}

/** Serialized length of a tool-call argument payload (best-effort; 0 when absent/unserializable). */
function serializedArgsLength(args: unknown): number {
  if (args == null) return 0;
  if (typeof args === 'string') return args.length;
  try {
    const stringified = JSON.stringify(args);
    return stringified === undefined ? 0 : stringified.length;
  } catch {
    return 0;
  }
}

/**
 * Estimate the OUTPUT token mass of a response: its textual content plus any tool calls it
 * emitted (serialized arguments) — the full model-side turn output, not only tool results.
 */
export function estimateOutputTokens(content: unknown, toolCalls?: readonly { arguments?: unknown }[]): number {
  let chars = messageTextOf(content).length;
  if (Array.isArray(toolCalls)) {
    for (const toolCall of toolCalls) {
      chars += serializedArgsLength(isRecord(toolCall) ? toolCall.arguments : toolCall);
    }
  }
  return estimateTokensFromChars(chars);
}

/**
 * Estimate a WHOLE turn's normalized usage: `input` over ALL request messages, `output` over
 * the response content + tool calls, and `total = input + output`. All fields are present
 * numbers (zero when there is nothing to measure), so callers never fabricate absent fields.
 */
export function estimateTurnUsage(
  messages: unknown,
  content?: unknown,
  toolCalls?: readonly { arguments?: unknown }[],
): { input: number; output: number; total: number } {
  const input = estimateInputTokens(messages);
  const output = estimateOutputTokens(content, toolCalls);
  return { input, output, total: input + output };
}
