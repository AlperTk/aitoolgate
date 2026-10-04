// ---------------------------------------------------------------------------
// OpenAI — non-streaming client request/response types
// ---------------------------------------------------------------------------

export interface OpenAITextContentPart {
  type: 'text';
  text: string;
}

export interface OpenAIImageContentPart {
  type: 'image_url';
  image_url: { url: string; detail?: 'auto' | 'low' | 'high' };
}

export type OpenAIContentPart = OpenAITextContentPart | OpenAIImageContentPart;

/** Message content: a plain string, an array of content parts, or null. */
export type OpenAIContent = string | OpenAIContentPart[] | null;

export interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    /** JSON-encoded argument object. */
    arguments: string;
  };
}

export interface OpenAIChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: OpenAIContent;
  name?: string;
  /** Present on assistant messages that invoke tools. */
  tool_calls?: OpenAIToolCall[];
  /** Present on `tool` messages; references the originating tool call. */
  tool_call_id?: string;
  [key: string]: unknown;
}

export interface OpenAIFunctionTool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export interface OpenAIChatRequest {
  model: string;
  messages: OpenAIChatMessage[];
  temperature?: number;
  top_p?: number;
  /** OpenAI uses `max_tokens`. */
  max_tokens?: number;
  tools?: OpenAIFunctionTool[];
  tool_choice?: unknown;
  [key: string]: unknown;
}

export interface OpenAIChatCompletionChoice {
  index: number;
  message: OpenAIChatMessage;
  finish_reason: string | null;
}

export interface OpenAIChatResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: OpenAIChatCompletionChoice[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  [key: string]: unknown;
}

export interface OpenAIModelListResponse {
  object: 'list';
  data: {
    id: string;
    object: 'model';
    created: number;
    owned_by: string;
  }[];
}

// ---------------------------------------------------------------------------
// Anthropic — non-streaming client request/response types
// ---------------------------------------------------------------------------

export interface AnthropicTextContentBlock {
  type: 'text';
  text: string;
}

export interface AnthropicToolUseContentBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface AnthropicToolResultContentBlock {
  type: 'tool_result';
  tool_use_id: string;
  /** String or content blocks returned by the tool. */
  content?: string | AnthropicTextContentBlock[] | Record<string, unknown>;
  is_error?: boolean;
}

export type AnthropicContentBlock =
  | AnthropicTextContentBlock
  | AnthropicToolUseContentBlock
  | AnthropicToolResultContentBlock;

/** Message content: a plain string or an array of content blocks. */
export type AnthropicContent = string | AnthropicContentBlock[];

export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: AnthropicContent;
}

export interface AnthropicTool {
  name: string;
  description?: string;
  /** JSON schema describing the tool's `input`. */
  input_schema: Record<string, unknown>;
}

export interface AnthropicRequest {
  model: string;
  /** System prompt (separate from messages in the Anthropic API). */
  system?: string;
  messages: AnthropicMessage[];
  /** Required by the Anthropic API. */
  max_tokens: number;
  temperature?: number;
  top_p?: number;
  tools?: AnthropicTool[];
  tool_choice?: unknown;
  [key: string]: unknown;
}

export interface AnthropicResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  model: string;
  content: AnthropicContentBlock[];
  stop_reason: string;
  stop_sequence?: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
  [key: string]: unknown;
}
