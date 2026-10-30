/**
 * Pure SSE frame decoding for the streaming telemetry extractor (no bus, no state).
 *
 * {@link parseSseDataLine} extracts one JSON `data:` payload from a raw SSE line;
 * {@link decodeSseFrame} interprets it (OpenAI `choices[]` deltas or native Anthropic
 * events, plus turn usage) and reports each fragment to a {@link SseFrameSink}. The sink
 * owns all accumulation and emission state, so decoding stays free of side effects.
 */
import { normalizeUsage, isRecord, type NormalizedUsage } from './protocol-common';

/** One decoded tool-call fragment; `undefined` means the wire carried no usable value. */
export interface ToolFragment {
  /** Provider tool-call index; `undefined` lets the accumulator assign the next ordinal. */
  index: number | undefined;
  id: string | undefined;
  name: string | undefined;
  /** Raw argument text fragment, appended to the accumulated arguments. */
  args: string | undefined;
}

/** Receives decoded frame fragments in wire order. */
export interface SseFrameSink {
  /** Response-text characters streamed (both protocols). */
  text(chars: number): void;
  /** Turn usage reported by the frame (cache field cleared when the frame carries no cache signal). */
  usage(usage: NormalizedUsage): void;
  /** A tool-call fragment that opens or extends a call. */
  toolCall(fragment: ToolFragment): void;
  /** Anthropic `input_json_delta` argument text for an already-open block at `index`. */
  toolArgs(index: number, args: string): void;
}

/** Parse one SSE line into its JSON `data:` object, or `undefined` for any non-data/non-object line. */
export function parseSseDataLine(line: string): Record<string, unknown> | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith('data:')) return undefined;
  const payload = trimmed.slice('data:'.length).trim();
  if (payload === '' || payload === '[DONE]') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return undefined; // Non-JSON data line (comment / keep-alive).
  }
  return isRecord(parsed) ? parsed : undefined;
}

/** Interpret one decoded frame, reporting its usage, text and tool-call fragments to `sink` in wire order. */
export function decodeSseFrame(parsed: Record<string, unknown>, sink: SseFrameSink): void {
  const usage = frameUsage(parsed);
  if (usage !== undefined) sink.usage(usage);
  const choices = parsed.choices;
  if (Array.isArray(choices)) {
    decodeOpenAiChoices(choices, sink);
    return;
  }
  decodeAnthropicEvent(parsed, sink);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * Turn usage from either location: an OpenAI trailing `usage` chunk, or an Anthropic
 * `message_start` (`message.usage`) / `message_delta` (`usage`) frame.
 */
function frameUsage(parsed: Record<string, unknown>): NormalizedUsage | undefined {
  const nestedUsage = isRecord(parsed.message) ? parsed.message.usage : undefined;
  const rawUsage = parsed.usage ?? nestedUsage;
  const usage = normalizeUsage(rawUsage);
  if (usage === undefined) return undefined;
  // A frame without any cache signal (e.g. Anthropic message_delta) must not overwrite an earlier cache-hit value with 0.
  return carriesCacheSignal(rawUsage) ? usage : { ...usage, cacheHitInput: undefined };
}

/** True when a raw usage object reports cache fields (Anthropic cache_* or OpenAI prompt_tokens_details). */
function carriesCacheSignal(raw: unknown): boolean {
  return (
    isRecord(raw) &&
    ('cache_read_input_tokens' in raw || 'cache_creation_input_tokens' in raw || 'prompt_tokens_details' in raw)
  );
}

function decodeOpenAiChoices(choices: unknown[], sink: SseFrameSink): void {
  for (const choice of choices) {
    if (!isRecord(choice)) continue;
    const delta = choice.delta;
    if (!isRecord(delta)) continue;
    if (typeof delta.content === 'string') sink.text(delta.content.length);
    const toolCalls = delta.tool_calls;
    if (Array.isArray(toolCalls)) for (const tc of toolCalls) sink.toolCall(openAiToolFragment(tc));
  }
}

function openAiToolFragment(entry: unknown): ToolFragment {
  const record = entry as { index?: unknown; id?: unknown; function?: unknown };
  const fn = record.function;
  return {
    index: typeof record.index === 'number' ? record.index : undefined,
    id: nonEmptyString(record.id),
    name: isRecord(fn) ? nonEmptyString(fn.name) : undefined,
    args: isRecord(fn) && typeof fn.arguments === 'string' ? fn.arguments : undefined,
  };
}

/** Native Anthropic streaming events: only `tool_use` content blocks open a call; text deltas count toward output. */
function decodeAnthropicEvent(parsed: Record<string, unknown>, sink: SseFrameSink): void {
  switch (parsed.type) {
    case 'content_block_start': {
      const block = parsed.content_block;
      if (!isRecord(block) || block.type !== 'tool_use') return; // only tool_use blocks open a call
      sink.toolCall({
        index: typeof parsed.index === 'number' ? parsed.index : undefined,
        id: nonEmptyString(block.id),
        name: nonEmptyString(block.name),
        args: undefined,
      });
      break;
    }
    case 'content_block_delta': {
      const delta = parsed.delta;
      if (!isRecord(delta)) return;
      // Anthropic wire: the delta object itself carries its `type` plus `text` / `partial_json`.
      if (delta.type === 'text_delta' && typeof delta.text === 'string') sink.text(delta.text.length);
      if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
        sink.toolArgs(typeof parsed.index === 'number' ? parsed.index : -1, delta.partial_json);
      }
      break;
    }
    default:
      // message_start / message_delta / message_stop / content_block_stop: usage is handled in decodeSseFrame.
      break;
  }
}
