import type {
  AnthropicContentBlock,
  AnthropicMessage,
  AnthropicRequest,
  AnthropicResponse,
  AnthropicTool,
  AnthropicToolResultContentBlock,
  OpenAIChatMessage,
  OpenAIChatRequest,
  OpenAIChatResponse,
  OpenAIFunctionTool,
  OpenAIContent,
  OpenAIToolCall,
} from './types';

const DEFAULT_MAX_TOKENS = 4096;

/** Extract plain text from an OpenAI message content (string or parts). */
function extractOpenAIText(content: OpenAIContent | undefined): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  return content
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map((part) => part.text)
    .join('');
}

/** Parse a JSON tool-call argument string into an object (defaults to `{}`). */
function parseArgs(args: string | undefined): Record<string, unknown> {
  if (args == null || args.trim() === '') return {};
  try {
    const parsed: unknown = JSON.parse(args);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function toAnthropicTool(tool: OpenAIFunctionTool): AnthropicTool {
  return {
    name: tool.function.name,
    ...(tool.function.description ? { description: tool.function.description } : {}),
    input_schema: tool.function.parameters ?? { type: 'object' },
  };
}

function toOpenAITool(tool: AnthropicTool): OpenAIFunctionTool {
  return {
    type: 'function',
    function: {
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      parameters: tool.input_schema ?? { type: 'object' },
    },
  };
}

/** Translate an OpenAI client request into an Anthropic request. */
export function openaiToAnthropicRequest(request: OpenAIChatRequest): AnthropicRequest {
  const systemParts: string[] = [];
  const messages: AnthropicMessage[] = [];

  for (const message of request.messages) {
    if (message.role === 'system') {
      const text = extractOpenAIText(message.content);
      if (text) systemParts.push(text);
      continue;
    }

    if (message.role === 'tool') {
      const toolResult: AnthropicToolResultContentBlock = {
        type: 'tool_result',
        tool_use_id: message.tool_call_id ?? '',
      };
      const resultText = extractOpenAIText(message.content);
      if (resultText) toolResult.content = resultText;
      messages.push({ role: 'user', content: [toolResult] });
      continue;
    }

    // `user` or `assistant`
    const blocks: AnthropicContentBlock[] = [];
    const text = extractOpenAIText(message.content);
    if (text) blocks.push({ type: 'text', text });
    for (const toolCall of message.tool_calls ?? []) {
      blocks.push({
        type: 'tool_use',
        id: toolCall.id,
        name: toolCall.function.name,
        input: parseArgs(toolCall.function.arguments),
      });
    }
    if (blocks.length === 0) blocks.push({ type: 'text', text: '' });
    const content =
      blocks.length === 1 && blocks[0].type === 'text'
        ? (blocks[0] as { text: string }).text
        : blocks;
    messages.push({ role: message.role, content });
  }

  const result: AnthropicRequest = {
    model: request.model,
    messages,
    max_tokens: request.max_tokens ?? DEFAULT_MAX_TOKENS,
  };
  if (systemParts.length) result.system = systemParts.join('\n');
  if (request.temperature !== undefined) result.temperature = request.temperature;
  if (request.top_p !== undefined) result.top_p = request.top_p;
  if (request.tools?.length) result.tools = request.tools.map(toAnthropicTool);
  if (request.tool_choice !== undefined) result.tool_choice = request.tool_choice;
  return result;
}

/** Translate an Anthropic client request into an OpenAI request. */
export function anthropicToOpenAIRequest(request: AnthropicRequest): OpenAIChatRequest {
  const messages: OpenAIChatMessage[] = [];
  if (request.system) messages.push({ role: 'system', content: request.system });

  for (const message of request.messages) {
    if (typeof message.content === 'string') {
      messages.push({ role: message.role, content: message.content });
      continue;
    }

    const textParts: string[] = [];
    const toolCalls: OpenAIToolCall[] = [];
    const toolResults: { toolCallId: string; content: string }[] = [];
    for (const block of message.content) {
      if (block.type === 'text') {
        textParts.push(block.text);
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          type: 'function',
          function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
        });
      } else if (block.type === 'tool_result') {
        toolResults.push({
          toolCallId: block.tool_use_id,
          content: extractToolResultText(block.content),
        });
      }
    }

    if (message.role === 'assistant') {
      const out: OpenAIChatMessage = {
        role: 'assistant',
        content: textParts.length ? textParts.join('') : null,
      };
      if (toolCalls.length) out.tool_calls = toolCalls;
      messages.push(out);
    } else {
      // OpenAI represents tool results as separate `tool` messages.
      for (const toolResult of toolResults) {
        messages.push({ role: 'tool', tool_call_id: toolResult.toolCallId, content: toolResult.content });
      }
      if (textParts.length) messages.push({ role: 'user', content: textParts.join('') });
    }
  }

  const result: OpenAIChatRequest = { model: request.model, messages };
  if (request.temperature !== undefined) result.temperature = request.temperature;
  if (request.top_p !== undefined) result.top_p = request.top_p;
  if (request.max_tokens !== undefined) result.max_tokens = request.max_tokens;
  if (request.tools?.length) result.tools = request.tools.map(toOpenAITool);
  if (request.tool_choice !== undefined) result.tool_choice = request.tool_choice;
  return result;
}

/** Translate an OpenAI chat completion response into an Anthropic response. */
export function openaiResponseToAnthropic(response: OpenAIChatResponse): AnthropicResponse {
  const choice = response.choices?.[0];
  const message = choice?.message;
  const blocks: AnthropicContentBlock[] = [];
  const text = extractOpenAIText(message?.content);
  if (text) blocks.push({ type: 'text', text });
  for (const toolCall of message?.tool_calls ?? []) {
    blocks.push({
      type: 'tool_use',
      id: toolCall.id,
      name: toolCall.function.name,
      input: parseArgs(toolCall.function.arguments),
    });
  }
  if (blocks.length === 0) blocks.push({ type: 'text', text: '' });

  // Anthropic `input_tokens` EXCLUDES cache tokens, so the base input is prompt minus the
  // cached subset, and the cache hit rides on `cache_read_input_tokens`. Cache fields are
  // omitted when zero so the shape stays clean. NOTE: OpenAI `cache_write_tokens` is a
  // SEPARATE cache-WRITE metric (not part of prompt_tokens and not the cache-hit field); it is
  // intentionally NOT folded into `cache_creation_input_tokens`, which would inflate base input
  // (and thus the translated total) when present. Carrying only the cache hit keeps the
  // translated total (input_tokens + cache_read_input_tokens + output_tokens) reconciling with
  // the source's true total (prompt_tokens + completion_tokens).
  const usageRecord = (response.usage ?? {}) as Record<string, unknown>;
  const prompt = typeof usageRecord.prompt_tokens === 'number' ? usageRecord.prompt_tokens : 0;
  const completion = typeof usageRecord.completion_tokens === 'number' ? usageRecord.completion_tokens : 0;
  const details =
    typeof usageRecord.prompt_tokens_details === 'object' && usageRecord.prompt_tokens_details !== null
      ? (usageRecord.prompt_tokens_details as Record<string, unknown>)
      : undefined;
  const cached = typeof details?.cached_tokens === 'number' ? details.cached_tokens : 0;
  const usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
  } = {
    input_tokens: Math.max(0, prompt - cached),
    output_tokens: completion,
    ...(cached > 0 ? { cache_read_input_tokens: cached } : {}),
  };
  return {
    id: response.id,
    type: 'message',
    role: 'assistant',
    model: response.model,
    content: blocks,
    stop_reason: mapFinishReasonToStopReason(choice?.finish_reason ?? null),
    usage,
  };
}

/** Translate an Anthropic response into an OpenAI chat completion response. */
export function anthropicResponseToOpenAI(response: AnthropicResponse): OpenAIChatResponse {
  const textParts: string[] = [];
  const toolCalls: OpenAIToolCall[] = [];
  for (const block of response.content ?? []) {
    if (block.type === 'text') {
      textParts.push(block.text);
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
      });
    }
  }

  const message: OpenAIChatMessage = {
    role: 'assistant',
    content: textParts.length ? textParts.join('') : null,
  };
  if (toolCalls.length) message.tool_calls = toolCalls;

  // OpenAI `prompt_tokens` is the TOTAL input (includes cached), with the cache hit on
  // `prompt_tokens_details.cached_tokens`. Anthropic's base `input_tokens` excludes cache tokens,
  // so total input = input_tokens + cache_creation + cache_read; the cache read is the hit.
  const usageRecord = (response.usage ?? {}) as Record<string, unknown>;
  const input = typeof usageRecord.input_tokens === 'number' ? usageRecord.input_tokens : 0;
  const output = typeof usageRecord.output_tokens === 'number' ? usageRecord.output_tokens : 0;
  const cacheRead = typeof usageRecord.cache_read_input_tokens === 'number' ? usageRecord.cache_read_input_tokens : 0;
  const cacheCreation = typeof usageRecord.cache_creation_input_tokens === 'number' ? usageRecord.cache_creation_input_tokens : 0;
  const promptTokens = input + cacheCreation + cacheRead;
  const usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    prompt_tokens_details?: { cached_tokens?: number };
  } = {
    prompt_tokens: promptTokens,
    completion_tokens: output,
    total_tokens: promptTokens + output,
    ...(cacheRead > 0 ? { prompt_tokens_details: { cached_tokens: cacheRead } } : {}),
  };
  return {
    id: response.id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: response.model,
    choices: [{ index: 0, message, finish_reason: mapStopReasonToFinishReason(response.stop_reason) }],
    usage,
  };
}

function extractToolResultText(content: unknown): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) =>
        c !== null && typeof c === 'object' && 'text' in (c as object)
          ? String((c as { text?: unknown }).text ?? '')
          : '',
      )
      .join('');
  }
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

function mapFinishReasonToStopReason(reason: string | null): string {
  switch (reason) {
    case 'tool_calls':
      return 'tool_use';
    case 'length':
      return 'max_tokens';
    case 'content_filter':
      return 'refusal';
    case 'stop':
    default:
      return 'end_turn';
  }
}

function mapStopReasonToFinishReason(reason: string): string {
  switch (reason) {
    case 'tool_use':
      return 'tool_calls';
    case 'max_tokens':
      return 'length';
    case 'refusal':
      return 'content_filter';
    case 'end_turn':
    case 'stop_sequence':
    default:
      return 'stop';
  }
}
