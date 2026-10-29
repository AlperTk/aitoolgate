import type { ToolCall } from './domain';
import type { CommonRequest, CommonResponse, LLMEvent } from './llm';

/** Port: a wire protocol (e.g. OpenAI chat-completions, Anthropic messages). All decode methods are non-throwing. */
export interface Protocol {
  /** Stable protocol identifier, e.g. 'openai-chat' or 'anthropic-messages'. */
  readonly id: string;
  /** Encode a common request into the provider's wire JSON body. */
  encodeRequest(request: CommonRequest): Record<string, unknown>;
  /** Decode a wire JSON request body into a common request; returns undefined when it is not a recognisable request. */
  decodeRequest(wire: unknown): CommonRequest | undefined;
  /** Decode a non-streaming wire JSON body; returns undefined when it is not a recognisable response. */
  decodeResponse(wire: unknown): CommonResponse | undefined;
  /** Encode a common response into the provider's wire JSON response body. */
  encodeResponse(response: CommonResponse): Record<string, unknown>;
  /** Decode a stream of SSE text chunks into LLM events; unknown frames are skipped. */
  decodeStream(chunks: AsyncIterable<string> | Iterable<string>): AsyncIterable<LLMEvent>;
  /** Encode LLM events into this protocol's SSE text frames (complete frames, incl. terminators); non-throwing. */
  encodeStream(events: AsyncIterable<LLMEvent> | Iterable<LLMEvent>): AsyncIterable<string>;
  /** Rewrite the tool calls of a raw wire response body in place; returns the body, or undefined when it is not this protocol's response shape. */
  applyToolCalls(wire: Record<string, unknown>, toolCalls: readonly ToolCall[]): Record<string, unknown> | undefined;
}
