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
import type { ResponseContext } from '../ports/pipeline';
import type { ToolCall } from '../ports/domain';
import { normalizeUsage, parseArgs, isRecord } from '../telemetry/protocol-common';

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
        input: parseArgs(toolCall.function.arguments) ?? {},
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
      input: parseArgs(toolCall.function.arguments) ?? {},
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
  const neutral = normalizeUsage(response.usage);
  const usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
  } = {
    input_tokens: neutral?.input ?? 0,
    output_tokens: neutral?.output ?? 0,
    ...(neutral?.cacheHitInput ? { cache_read_input_tokens: neutral.cacheHitInput } : {}),
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
  const neutral = normalizeUsage(response.usage);
  const baseInput = neutral?.input ?? 0;
  const cacheHit = neutral?.cacheHitInput ?? 0;
  const output = neutral?.output ?? 0;
  const promptTokens = baseInput + cacheHit;
  const usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    prompt_tokens_details?: { cached_tokens?: number };
  } = {
    prompt_tokens: promptTokens,
    completion_tokens: output,
    total_tokens: promptTokens + output,
    ...(cacheHit > 0 ? { prompt_tokens_details: { cached_tokens: cacheHit } } : {}),
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

/**
 * Rehydrate the raw wire response body from the (possibly-edited) provider-agnostic
 * tool-call list (+ content), respecting the provider shape the raw body carries
 * (OpenAI `choices[].message.tool_calls`; Anthropic assistant `content[]` with
 * `tool_use` blocks). Mutates the raw body in place and is idempotent: when the view
 * is unchanged from the pre-pipeline `original` summary, the raw body is left
 * byte-for-byte identical to the upstream response.
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
  const protocol = detectResponseProtocol(raw);
  if (protocol === 'openai') rehydrateOpenAIResponse(raw, ctx.toolCalls);
  else if (protocol === 'anthropic') rehydrateAnthropicResponse(raw, ctx.toolCalls);
}

/** Classify a raw response body by provider shape (`unknown` → no rehydration). */
function detectResponseProtocol(raw: Record<string, unknown>): 'openai' | 'anthropic' | 'unknown' {
  const choices = raw.choices;
  if (Array.isArray(choices)) {
    for (const choice of choices) {
      if (isRecord(choice) && isRecord(choice.message)) return 'openai';
    }
  }
  if (Array.isArray(raw.content)) return 'anthropic';
  return 'unknown';
}

/** Overwrite/clear each OpenAI assistant `choices[].message.tool_calls` from the view. */
function rehydrateOpenAIResponse(raw: Record<string, unknown>, toolCalls: ToolCall[]): void {
  const choices = raw.choices;
  if (!Array.isArray(choices)) return;
  for (const choice of choices) {
    if (!isRecord(choice)) continue;
    const message = choice.message;
    if (!isRecord(message)) continue;
    if (toolCalls.length > 0) {
      message.tool_calls = toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: JSON.stringify(tc.arguments ?? {}) },
      }));
    } else {
      delete message.tool_calls;
    }
  }
}

/** Rebuild an Anthropic assistant `content[]` from non-tool blocks + fresh `tool_use` blocks. */
function rehydrateAnthropicResponse(raw: Record<string, unknown>, toolCalls: ToolCall[]): void {
  const content = raw.content;
  if (!Array.isArray(content)) return;
  // Keep non-`tool_use` blocks (e.g. text) in their original order, then emit one
  // `tool_use` block per remaining tool call (drops clear them, rewrites update them).
  const blocks: Record<string, unknown>[] = content.filter(
    (block): block is Record<string, unknown> => isRecord(block) && block.type !== 'tool_use',
  );
  for (const tc of toolCalls) {
    blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.arguments ?? {} });
  }
  raw.content = blocks;
}

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
