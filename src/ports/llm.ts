/** Provider-neutral LLM message, request and streaming event model. Framework-free; no runtime code. */

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

export type FinishReason = 'stop' | 'length' | 'tool-calls' | 'content-filter' | 'other';

/** Token usage. `input` excludes cache hits; `total` = input + cacheHitInput + output (see domain.md). */
export interface Usage {
  input: number;
  output: number;
  /** Tokens read from the prompt cache; undefined when the provider does not report it (distinct from 0). */
  cacheHitInput?: number;
  /** Tokens written to the prompt cache; undefined when the provider does not report it. */
  cacheWriteInput?: number;
  total: number;
}

export interface TextPart {
  type: 'text';
  text: string;
  /** Opaque, same-protocol block fields (e.g. Anthropic `cache_control`); see RequestExtra. */
  extra?: RequestExtra;
}

/** Reasoning / thinking. `signature` (Anthropic thinking) and `redactedData` (Anthropic redacted_thinking) are optional. */
export interface ReasoningPart {
  type: 'reasoning';
  text: string;
  signature?: string;
  redactedData?: string;
}

export interface ToolCallPart {
  type: 'tool-call';
  id: string;
  name: string;
  args: Record<string, unknown>;
  /** Opaque, same-protocol block fields (e.g. Anthropic `cache_control`); see RequestExtra. */
  extra?: RequestExtra;
}

export interface ToolResultPart {
  type: 'tool-result';
  id: string;
  name: string;
  content: string;
  isError: boolean;
  /** Opaque, same-protocol block fields (e.g. Anthropic `cache_control`); see RequestExtra. */
  extra?: RequestExtra;
}

/** Protocol-specific block the shared model does not represent (e.g. Anthropic image). Re-emitted verbatim only for `protocol`; other encoders skip it. */
export interface OpaquePart {
  type: 'opaque';
  protocol: string;
  block: Record<string, unknown>;
}

export type MessagePart = TextPart | ReasoningPart | ToolCallPart | ToolResultPart | OpaquePart;

/** A message with role and ordered parts. */
export interface Message {
  role: MessageRole;
  parts: MessagePart[];
  /** Message content was originally a plain string (content-shape origin only). */
  plainStringContent?: boolean;
}

export interface ToolDefinition {
  name: string;
  description?: string;
  /** JSON Schema for the tool input. */
  parameters?: Record<string, unknown>;
  /** Opaque, same-protocol definition fields (e.g. OpenAI `function.strict`, Anthropic `cache_control`); see RequestExtra. */
  extra?: RequestExtra;
}

/** Provider-neutral request, encoded to a wire format by a Protocol. */
export interface InternalRequest {
  model: string;
  messages: Message[];
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  tools?: ToolDefinition[];
  /** Provider-specific tool-choice value, carried through verbatim (e.g. OpenAI `tool_choice`). */
  toolChoice?: unknown;
  stream?: boolean;
  /** Client-sent OpenAI `stream_options`, carried through; `include_usage` is forced on encode for streams. */
  streamOptions?: Record<string, unknown>;
  /** Unmodeled request fields, re-merged on encode only when the target protocol equals `extra.protocol` (same-protocol only). */
  extra?: RequestExtra;
}

/** Opaque, protocol-tagged fields the shared model does not represent (request level, tool, or block node). */
export interface RequestExtra {
  protocol: string;
  fields: Record<string, unknown>;
}

/** Decoded non-streaming response. */
export interface InternalResponse {
  message: Message;
  usage?: Usage;
  finishReason?: FinishReason;
  id?: string;
  model?: string;
}

/** Streaming event model. Text/reasoning are fragments; a tool-call is emitted once its arguments are complete. */
export type InternalLLMEvent =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string; signature?: string; redactedData?: string }
  | {
      type: 'tool-call';
      id: string;
      name: string;
      args: Record<string, unknown>;
      /** Exact concatenated argument string as received on the wire; undefined when not streamed. */
      rawArgs?: string;
      /** Provider tool-call index within the turn; undefined when the provider gives none. */
      index?: number;
    }
  | { type: 'tool-result'; id: string; name: string; content: string; isError: boolean }
  | { type: 'usage'; usage: Usage }
  | { type: 'step-start'; id?: string; model?: string }
  | { type: 'step-finish'; finishReason: FinishReason }
  | { type: 'finish'; finishReason: FinishReason };
