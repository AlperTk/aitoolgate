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

  return {
    id: response.id,
    type: 'message',
    role: 'assistant',
    model: response.model,
    content: blocks,
    stop_reason: mapFinishReasonToStopReason(choice?.finish_reason ?? null),
    usage: {
      input_tokens: response.usage?.prompt_tokens ?? 0,
      output_tokens: response.usage?.completion_tokens ?? 0,
    },
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

  const usage = {
    prompt_tokens: response.usage?.input_tokens ?? 0,
    completion_tokens: response.usage?.output_tokens ?? 0,
  };

  return {
    id: response.id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: response.model,
    choices: [{ index: 0, message, finish_reason: mapStopReasonToFinishReason(response.stop_reason) }],
    usage: { ...usage, total_tokens: usage.prompt_tokens + usage.completion_tokens },
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
