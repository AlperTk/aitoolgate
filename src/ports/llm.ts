/** Provider-neutral LLM message, request and streaming event model. Framework-free; no runtime code. */

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

export type FinishReason = 'stop' | 'length' | 'tool-calls' | 'content-filter' | 'other';

/** Token usage. `input` excludes cache hits; `total` = input + cacheHitInput + output (see domain.md). */
export interface Usage {
  input: number;
  output: number;
  cacheHitInput: number;
  total: number;
}

export interface TextPart {
  type: 'text';
  text: string;
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
}

export interface ToolResultPart {
  type: 'tool-result';
  id: string;
  name: string;
  content: string;
  isError: boolean;
}

export type MessagePart = TextPart | ReasoningPart | ToolCallPart | ToolResultPart;

/** A message with role and ordered parts. */
export interface Message {
  role: MessageRole;
  parts: MessagePart[];
}

export interface ToolDefinition {
  name: string;
  description?: string;
  /** JSON Schema for the tool input. */
  parameters?: Record<string, unknown>;
}

/** Provider-neutral request, encoded to a wire format by a Protocol. */
export interface CommonRequest {
  model: string;
  messages: Message[];
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  tools?: ToolDefinition[];
  /** Provider-specific tool-choice value, carried through verbatim (e.g. OpenAI `tool_choice`). */
  toolChoice?: unknown;
  stream?: boolean;
}

/** Decoded non-streaming response. */
export interface CommonResponse {
  message: Message;
  usage?: Usage;
  finishReason?: FinishReason;
  id?: string;
  model?: string;
}

/** Streaming event model. Text/reasoning are fragments; a tool-call is emitted once its arguments are complete. */
export type LLMEvent =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string; signature?: string; redactedData?: string }
  | { type: 'tool-call'; id: string; name: string; args: Record<string, unknown> }
  | { type: 'tool-result'; id: string; name: string; content: string; isError: boolean }
  | { type: 'usage'; usage: Usage }
  | { type: 'step-start'; id?: string; model?: string }
  | { type: 'step-finish'; finishReason: FinishReason }
  | { type: 'finish'; finishReason: FinishReason };
