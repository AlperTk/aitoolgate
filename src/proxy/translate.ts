import type { AnthropicRequest, AnthropicResponse, OpenAIChatRequest, OpenAIChatResponse } from './types';
import type { ResponseContext } from '../ports/pipeline';
import { isRecord } from '../telemetry/protocol-common';
import type { InternalRequest, InternalResponse } from '../ports/llm';
import type { Protocol } from '../ports/protocol';
import type { ProtocolId } from '../protocols/registry';
import { createOpenAIChatProtocol } from '../protocols/openai-chat';
import { createAnthropicMessagesProtocol } from '../protocols/anthropic-messages';

const openai = createOpenAIChatProtocol();
const anthropic = createAnthropicMessagesProtocol();
const CODECS: Readonly<Record<ProtocolId, Protocol>> = { 'openai-chat': openai, 'anthropic-messages': anthropic };
/** Response with no decodable content: protocols still carry id/model/usage when present. */
const EMPTY_RESPONSE: InternalResponse = { message: { role: 'assistant', parts: [] } };

/**
 * Generic request conversion keyed by protocol ids: decode with the client protocol, apply the
 * optional model override, encode with the upstream protocol. Same-protocol calls keep opaque fields.
 */
export function reencodeRequest(clientId: ProtocolId, upstreamId: ProtocolId, request: unknown, model?: string): unknown {
  const source = CODECS[clientId];
  const target = CODECS[upstreamId];
  const common = source.decodeRequest(request) ?? { model: (request as { model: string }).model, messages: [] };
  return target.encodeRequest(model === undefined ? common : withModelOverride(common, model));
}

/** A blank provider model keeps the client-sent model. */
function withModelOverride(common: InternalRequest, model: string): InternalRequest {
  const override = model.trim();
  return override === '' ? common : { ...common, model: override };
}

/** Generic response conversion keyed by protocol ids; same-protocol responses pass through unchanged. */
export function convertResponse(upstreamId: ProtocolId, clientId: ProtocolId, response: unknown): unknown {
  if (upstreamId === clientId) return response;
  const common = CODECS[upstreamId].decodeResponse(response) ?? EMPTY_RESPONSE;
  return CODECS[clientId].encodeResponse(common);
}

/**
 * Rehydrate the raw wire response body from the (possibly-edited) provider-agnostic
 * tool-call list (+ content), respecting the provider shape the raw body carries
 * (OpenAI `choices[].message.tool_calls`; Anthropic assistant `content[]` with
 * `tool_use` blocks). The protocol returns a rewritten copy; it is stored back on
 * `ctx.raw` so the upstream body is never mutated. Every response is re-encoded (no change-gate).
 */
export function syncResponseBody(ctx: ResponseContext): void {
  const raw = ctx.raw;
  if (!isRecord(raw)) return;
  for (const id of Object.keys(CODECS) as ProtocolId[]) {
    const next = CODECS[id].applyToolCalls(raw, ctx.toolCalls);
    if (next !== undefined) {
      ctx.raw = next;
      return;
    }
  }
}

/** Classify a raw response body by provider shape (`unknown` → no rehydration). */
/** Overwrite/clear each OpenAI assistant `choices[].message.tool_calls` from the view. */
/** Rebuild an Anthropic assistant `content[]` from non-tool blocks + fresh `tool_use` blocks. */
