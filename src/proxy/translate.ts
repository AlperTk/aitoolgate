import type { AnthropicRequest, AnthropicResponse, OpenAIChatRequest, OpenAIChatResponse } from './types';
import type { ResponseContext } from '../ports/pipeline';
import type { ToolCall } from '../ports/domain';
import { isRecord } from '../telemetry/protocol-common';
import type { CommonRequest, CommonResponse } from '../ports/llm';
import { createOpenAIChatProtocol } from '../protocols/openai-chat';
import { createAnthropicMessagesProtocol } from '../protocols/anthropic-messages';

const openai = createOpenAIChatProtocol();
const anthropic = createAnthropicMessagesProtocol();
/** Response with no decodable content: protocols still carry id/model/usage when present. */
const EMPTY_RESPONSE: CommonResponse = { message: { role: 'assistant', parts: [] } };

/** Translate an OpenAI client request into an Anthropic request. */
export function openaiToAnthropicRequest(request: OpenAIChatRequest): AnthropicRequest {
  const common: CommonRequest = openai.decodeRequest(request) ?? { model: request.model, messages: [] };
  const wire = anthropic.encodeRequest(common) as AnthropicRequest;
  // Preserve legacy shape: a single text block is emitted as a plain string.
  for (const message of wire.messages) {
    const blocks = message.content;
    const only = Array.isArray(blocks) && blocks.length === 1 ? blocks[0] : undefined;
    if (only?.type === 'text') message.content = only.text;
  }
  return wire;
}

/** Translate an Anthropic client request into an OpenAI request. */
export function anthropicToOpenAIRequest(request: AnthropicRequest): OpenAIChatRequest {
  const common: CommonRequest = anthropic.decodeRequest(request) ?? { model: request.model, messages: [] };
  return openai.encodeRequest(common) as OpenAIChatRequest;
}

/** Translate an OpenAI chat completion response into an Anthropic response. */
export function openaiResponseToAnthropic(response: OpenAIChatResponse): AnthropicResponse {
  const common = openai.decodeResponse(response) ?? EMPTY_RESPONSE;
  return anthropic.encodeResponse(common) as AnthropicResponse;
}

/** Translate an Anthropic response into an OpenAI chat completion response. */
export function anthropicResponseToOpenAI(response: AnthropicResponse): OpenAIChatResponse {
  const common = anthropic.decodeResponse(response) ?? EMPTY_RESPONSE;
  return openai.encodeResponse(common) as OpenAIChatResponse;
}

/**
 * Rehydrate the raw wire response body from the (possibly-edited) provider-agnostic
 * tool-call list (+ content), respecting the provider shape the raw body carries
 * (OpenAI `choices[].message.tool_calls`; Anthropic assistant `content[]` with
 * `tool_use` blocks). The protocol returns a rewritten copy; it is stored back on
 * `ctx.raw` so the upstream body is never mutated. When the view is unchanged from the
 * pre-pipeline `original` summary, `ctx.raw` is left as the upstream response.
 */
export function syncResponseBody(
  ctx: ResponseContext,
  original: { toolCalls: ToolCall[]; content: string },
): void {
  const raw = ctx.raw;
  if (!isRecord(raw)) return;
  // Only touch the wire when the provider-agnostic view actually differs from what
  // the upstream returned, so an unedited passthrough is returned unchanged.
  if (ctx.content === original.content && toolCallsEqual(ctx.toolCalls, original.toolCalls)) return;
  const next = openai.applyToolCalls(raw, ctx.toolCalls) ?? anthropic.applyToolCalls(raw, ctx.toolCalls);
  if (next !== undefined) ctx.raw = next;
}

/** Classify a raw response body by provider shape (`unknown` → no rehydration). */
/** Overwrite/clear each OpenAI assistant `choices[].message.tool_calls` from the view. */
/** Rebuild an Anthropic assistant `content[]` from non-tool blocks + fresh `tool_use` blocks. */
/** True when two tool-call lists carry identical provider-agnostic data. */
function toolCallsEqual(a: readonly ToolCall[], b: readonly ToolCall[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (!deepEqual(a[i].id, b[i].id) || !deepEqual(a[i].name, b[i].name) || !deepEqual(a[i].arguments, b[i].arguments)) {
      return false;
    }
  }
  return true;
}

/** Structural equality for plain (JSON-like) values. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  if (typeof a === 'object') {
    const aObj = a as Record<string, unknown>;
    const bObj = b as Record<string, unknown>;
    if (Object.keys(aObj).length !== Object.keys(bObj).length) return false;
    for (const key of Object.keys(aObj)) {
      if (!Object.prototype.hasOwnProperty.call(bObj, key) || !deepEqual(aObj[key], bObj[key])) return false;
    }
    return true;
  }
  return Number.isNaN(a as number) && Number.isNaN(b as number);
}
