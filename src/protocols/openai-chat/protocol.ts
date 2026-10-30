import type {
  InternalRequest,
  InternalResponse,
  FinishReason,
  InternalLLMEvent,
  Message,
  MessagePart,
  ToolDefinition,
  Usage,
} from '../../ports/llm';
import type { ToolCall } from '../../ports/domain';
import type { Protocol } from '../../ports/protocol';
import { captureRequestExtra, mergeNodeExtra, mergeRequestExtra } from '../request-extra';

type Obj = Record<string, unknown>;

const OPENAI_MODELED_REQUEST_KEYS = ['model', 'messages', 'max_tokens', 'temperature', 'top_p', 'tools', 'tool_choice', 'stream', 'stream_options'];
const OPENAI_MODELED_FUNCTION_KEYS = ['name', 'description', 'parameters'];

interface PendingCall {
  id: string;
  name: string;
  args: string;
}

const isRecord = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value);

const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

function parseArgs(raw: string): Record<string, unknown> {
  if (raw.trim() === '') return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function mapFinishReason(raw: unknown): FinishReason | undefined {
  if (typeof raw !== 'string') return undefined;
  switch (raw) {
    case 'stop':
      return 'stop';
    case 'length':
      return 'length';
    case 'tool_calls':
    case 'function_call':
      return 'tool-calls';
    case 'content_filter':
      return 'content-filter';
    default:
      return 'other';
  }
}

/** OpenAI `prompt_tokens` includes cached tokens; split them so input excludes the cache hit. */
function decodeUsage(raw: unknown): Usage | undefined {
  if (!isRecord(raw)) return undefined;
  const prompt = isNumber(raw.prompt_tokens) ? raw.prompt_tokens : undefined;
  const completion = isNumber(raw.completion_tokens) ? raw.completion_tokens : undefined;
  const total = isNumber(raw.total_tokens) ? raw.total_tokens : undefined;
  if (prompt === undefined && completion === undefined && total === undefined) return undefined;
  const details = isRecord(raw.prompt_tokens_details) ? raw.prompt_tokens_details : undefined;
  const cached = details !== undefined && isNumber(details.cached_tokens) ? details.cached_tokens : undefined;
  const input = prompt !== undefined ? Math.max(0, prompt - (cached ?? 0)) : 0;
  const output = completion ?? 0;
  const cacheHitInput = cached !== undefined ? { cacheHitInput: cached } : {};
  return { input, output, ...cacheHitInput, total: total ?? input + (cached ?? 0) + output };
}

function textOf(parts: MessagePart[]): string {
  return parts
    .filter((part): part is Extract<MessagePart, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('');
}

/** Concatenated reasoning text (`reasoning_content` has no signature/redacted form). */
function reasoningOf(parts: MessagePart[]): string {
  return parts
    .filter((part): part is Extract<MessagePart, { type: 'reasoning' }> => part.type === 'reasoning')
    .map((part) => part.text)
    .join('');
}

function encodeMessages(messages: Message[]): Obj[] {
  const out: Obj[] = [];
  for (const message of messages) {
    const text = textOf(message.parts);
    const toolCalls = message.parts.filter((part) => part.type === 'tool-call');
    const reasoning = reasoningOf(message.parts);
    // An empty assistant turn is kept as `content: null`, matching translate.ts.
    if (message.role !== 'tool' && (text !== '' || toolCalls.length > 0 || message.role === 'assistant')) {
      const wire: Obj = { role: message.role, content: text !== '' ? text : null };
      if (message.role === 'assistant' && toolCalls.length > 0) {
        wire.tool_calls = toolCalls.map((part) => {
          const call = part as Extract<MessagePart, { type: 'tool-call' }>;
          return { id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } };
        });
      } else if (message.role !== 'assistant') {
        wire.content = text;
      }
      if (message.role === 'assistant' && reasoning !== '') wire.reasoning_content = reasoning;
      out.push(wire);
    }
    // Tool results become standalone `tool` messages; `isError` has no OpenAI field and is not encoded.
    for (const part of message.parts) {
      if (part.type === 'tool-result') {
        out.push({ role: 'tool', tool_call_id: part.id, ...(part.name !== '' ? { name: part.name } : {}), content: part.content });
      }
    }
  }
  return out;
}

function decodeMessageParts(message: Obj): MessagePart[] {
  const parts: MessagePart[] = [];
  if (typeof message.content === 'string' && message.content !== '') parts.push({ type: 'text', text: message.content });
  if (typeof message.reasoning_content === 'string' && message.reasoning_content !== '') {
    parts.push({ type: 'reasoning', text: message.reasoning_content });
  }
  if (Array.isArray(message.tool_calls)) {
    for (const raw of message.tool_calls) {
      if (!isRecord(raw) || !isRecord(raw.function)) continue;
      const name = typeof raw.function.name === 'string' ? raw.function.name : '';
      if (name === '') continue;
      const args = typeof raw.function.arguments === 'string' ? parseArgs(raw.function.arguments) : {};
      parts.push({ type: 'tool-call', id: typeof raw.id === 'string' ? raw.id : '', name, args });
    }
  }
  return parts;
}

/** Stream state for one SSE response; calls are emitted by index once a finish boundary or stream end is reached. */
interface StreamState {
  started: boolean;
  finishReason?: FinishReason;
  calls: Map<number, PendingCall>;
}

function flushCalls(state: StreamState): InternalLLMEvent[] {
  const events: InternalLLMEvent[] = [];
  const indices = [...state.calls.keys()].sort((a, b) => a - b);
  for (const index of indices) {
    const call = state.calls.get(index);
    if (call === undefined || call.name === '') continue;
    events.push({
      type: 'tool-call',
      id: call.id,
      name: call.name,
      args: parseArgs(call.args),
      rawArgs: call.args,
      index,
    });
  }
  state.calls.clear();
  return events;
}

/** Upstream id/model carried on a frame; only fields actually present are returned. */
function identityOf(source: Obj): { id?: string; model?: string } {
  return {
    ...(typeof source.id === 'string' ? { id: source.id } : {}),
    ...(typeof source.model === 'string' ? { model: source.model } : {}),
  };
}

function handleFrame(frame: Obj, state: StreamState): InternalLLMEvent[] {
  const events: InternalLLMEvent[] = [];
  if (!state.started) {
    state.started = true;
    events.push({ type: 'step-start', ...identityOf(frame) });
  }
  const usage = decodeUsage(frame.usage);
  if (usage !== undefined) events.push({ type: 'usage', usage });
  if (!Array.isArray(frame.choices)) return events;
  for (const choice of frame.choices) {
    if (!isRecord(choice)) continue;
    const delta: Obj = isRecord(choice.delta) ? choice.delta : {};
    if (typeof delta.content === 'string' && delta.content !== '') events.push({ type: 'text', text: delta.content });
    // Copilot streams reasoning as `reasoning_text`; `reasoning_opaque` is an encrypted blob kept as the signature.
    for (const key of ['reasoning_content', 'reasoning_text'] as const) {
      const reasoning = delta[key];
      if (typeof reasoning === 'string' && reasoning !== '') events.push({ type: 'reasoning', text: reasoning });
    }
    if (typeof delta.reasoning_opaque === 'string' && delta.reasoning_opaque !== '') {
      events.push({ type: 'reasoning', text: '', signature: delta.reasoning_opaque });
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const fragment of delta.tool_calls) {
        if (!isRecord(fragment)) continue;
        const index = isNumber(fragment.index) ? fragment.index : state.calls.size;
        let call = state.calls.get(index);
        if (call === undefined) {
          call = { id: '', name: '', args: '' };
          state.calls.set(index, call);
        }
        if (typeof fragment.id === 'string' && fragment.id !== '') call.id = fragment.id;
        const fn: Obj = isRecord(fragment.function) ? fragment.function : {};
        if (typeof fn.name === 'string' && fn.name !== '') call.name = fn.name;
        if (typeof fn.arguments === 'string') call.args += fn.arguments;
      }
    }
    const finish = mapFinishReason(choice.finish_reason);
    if (finish !== undefined) {
      state.finishReason = finish;
      events.push(...flushCalls(state));
      events.push({ type: 'step-finish', finishReason: finish });
    }
  }
  return events;
}

/** Parse one SSE line; returns the JSON object of a `data:` frame, or undefined for anything else. */
function parseFrame(line: string): Obj | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith('data:')) return undefined;
  const payload = trimmed.slice('data:'.length).trim();
  if (payload === '' || payload === '[DONE]') return undefined;
  try {
    const parsed: unknown = JSON.parse(payload);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

async function* decodeStream(chunks: AsyncIterable<string> | Iterable<string>): AsyncGenerator<InternalLLMEvent> {
  const state: StreamState = { started: false, calls: new Map() };
  let buffer = '';
  const handleLine = (line: string): InternalLLMEvent[] => {
    const frame = parseFrame(line);
    return frame === undefined ? [] : handleFrame(frame, state);
  };
  for await (const chunk of chunks) {
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      yield* handleLine(line);
      newline = buffer.indexOf('\n');
    }
  }
  if (buffer.trim() !== '') yield* handleLine(buffer);
  yield* flushCalls(state);
  if (state.finishReason !== undefined) yield { type: 'finish', finishReason: state.finishReason };
}

/** Encode LLM events as chat-completion chunk SSE frames; usage and finish trail the content, then `[DONE]`. */
async function* encodeStream(events: AsyncIterable<InternalLLMEvent> | Iterable<InternalLLMEvent>): AsyncGenerator<string> {
  const created = Math.floor(Date.now() / 1000);
  let meta: { id?: string | undefined; model?: string | undefined } = {};
  const frame = (payload: Obj): string => {
    const base: Obj = {
      id: meta.id ?? 'chatcmpl-aitoolgate',
      object: 'chat.completion.chunk',
      created,
      ...(meta.model !== undefined ? { model: meta.model } : {}),
    };
    return `data: ${JSON.stringify({ ...base, ...payload })}\n\n`;
  };
  const chunk = (delta: Obj, finish: string | null = null): string => frame({ choices: [{ index: 0, delta, finish_reason: finish }] });
  let roleSent = false;
  const roleChunk = (): string => {
    roleSent = true;
    return chunk({ role: 'assistant' });
  };
  let toolIndex = 0;
  let finishReason: FinishReason | undefined;
  let usage: Usage | undefined;
  for await (const event of events) {
    if (event.type === 'step-start') meta = { id: event.id, model: event.model };
    if (!roleSent) yield roleChunk();
    switch (event.type) {
      case 'text':
        if (event.text !== '') yield chunk({ content: event.text });
        break;
      case 'reasoning':
        if (event.text !== '') yield chunk({ reasoning_content: event.text });
        break;
      case 'tool-call':
        yield chunk({
          tool_calls: [{ index: toolIndex++, id: event.id, type: 'function', function: { name: event.name, arguments: JSON.stringify(event.args) } }],
        });
        break;
      case 'usage':
        usage = event.usage;
        break;
      case 'finish':
      case 'step-finish':
        finishReason = event.finishReason;
        break;
      default:
        break;
    }
  }
  if (!roleSent) yield roleChunk();
  yield chunk({}, encodeOpenAIFinishReason(finishReason));
  if (usage !== undefined) yield frame({ choices: [], usage: encodeOpenAIUsage(usage) });
  yield 'data: [DONE]\n\n';
}

/** Plain text of an OpenAI message content (string or text parts); non-text parts are ignored. */
function decodeOpenAIText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part): part is Obj => isRecord(part) && part.type === 'text')
    .map((part) => String(part.text ?? ''))
    .join('');
}

/** Decode OpenAI request messages; `reasoning_content` is ignored, tool results become `tool` messages. */
function decodeOpenAIMessages(rawMessages: unknown[]): Message[] {
  const out: Message[] = [];
  for (const raw of rawMessages) {
    if (!isRecord(raw)) continue;
    const text = decodeOpenAIText(raw.content);
    if (raw.role === 'system') {
      if (text !== '') out.push({ role: 'system', parts: [{ type: 'text', text }] });
      continue;
    }
    if (raw.role === 'tool') {
      const id = typeof raw.tool_call_id === 'string' ? raw.tool_call_id : '';
      const name = typeof raw.name === 'string' ? raw.name : '';
      out.push({ role: 'tool', parts: [{ type: 'tool-result', id, name, content: text, isError: false }] });
      continue;
    }
    const parts: MessagePart[] = [];
    if (text !== '') parts.push({ type: 'text', text });
    const rawCalls: unknown = raw.tool_calls;
    if (Array.isArray(rawCalls)) {
      for (const call of rawCalls) {
        if (!isRecord(call) || !isRecord(call.function)) continue;
        const fn = call.function;
        parts.push({
          type: 'tool-call',
          id: typeof call.id === 'string' ? call.id : '',
          name: typeof fn.name === 'string' ? fn.name : '',
          args: typeof fn.arguments === 'string' ? parseArgs(fn.arguments) : isRecord(fn.arguments) ? fn.arguments : {},
        });
      }
    }
    // Empty messages keep a single empty text part (translate.ts emits an empty text block).
    if (parts.length === 0) parts.push({ type: 'text', text: '' });
    out.push({ role: raw.role === 'assistant' ? 'assistant' : 'user', parts, plainStringContent: true });
  }
  return out;
}

/** Decode an OpenAI function tool; empty descriptions are dropped and parameters default to an object schema. */
function decodeOpenAITool(tool: Obj): ToolDefinition {
  const fn: Obj = isRecord(tool.function) ? tool.function : {};
  const definition: ToolDefinition = {
    name: typeof fn.name === 'string' ? fn.name : '',
    parameters: isRecord(fn.parameters) ? fn.parameters : { type: 'object' },
  };
  if (typeof fn.description === 'string' && fn.description !== '') definition.description = fn.description;
  const extra = captureRequestExtra('openai-chat', fn, OPENAI_MODELED_FUNCTION_KEYS);
  if (extra !== undefined) definition.extra = extra;
  return definition;
}

function encodeOpenAIFinishReason(reason: FinishReason | undefined): string {
  switch (reason) {
    case 'tool-calls':
      return 'tool_calls';
    case 'length':
      return 'length';
    case 'content-filter':
      return 'content_filter';
    default:
      return 'stop';
  }
}

/** OpenAI `prompt_tokens` is the total input: base input plus the cache hit, which rides on `prompt_tokens_details`. */
function encodeOpenAIUsage(usage: Usage | undefined): Obj {
  const cacheHit = usage?.cacheHitInput ?? 0;
  const promptTokens = (usage?.input ?? 0) + cacheHit;
  const completion = usage?.output ?? 0;
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completion,
    total_tokens: promptTokens + completion,
    ...(cacheHit > 0 ? { prompt_tokens_details: { cached_tokens: cacheHit } } : {}),
  };
}

/** Encode an assistant message: text parts joined (null when none); reasoning parts as `reasoning_content`. */
function encodeOpenAIMessage(parts: MessagePart[]): Obj {
  const textParts = parts.filter((part): part is Extract<MessagePart, { type: 'text' }> => part.type === 'text');
  const calls = parts.filter((part): part is Extract<MessagePart, { type: 'tool-call' }> => part.type === 'tool-call');
  const message: Obj = {
    role: 'assistant',
    content: textParts.length > 0 ? textParts.map((part) => part.text).join('') : null,
  };
  const reasoning = reasoningOf(parts);
  if (reasoning !== '') message.reasoning_content = reasoning;
  if (calls.length > 0) {
    message.tool_calls = calls.map((call) => ({
      id: call.id,
      type: 'function',
      function: { name: call.name, arguments: JSON.stringify(call.args) },
    }));
  }
  return message;
}

/** Create the OpenAI chat-completions protocol (stateless; safe to share). */
export function createOpenAIChatProtocol(): Protocol {
  return {
    id: 'openai-chat',
    encodeRequest(request: InternalRequest): Record<string, unknown> {
      const wire: Record<string, unknown> = { model: request.model, messages: encodeMessages(request.messages) };
      if (request.maxTokens !== undefined) wire.max_tokens = request.maxTokens;
      if (request.temperature !== undefined) wire.temperature = request.temperature;
      if (request.topP !== undefined) wire.top_p = request.topP;
      if (request.tools !== undefined && request.tools.length > 0) {
        wire.tools = request.tools.map((tool) => {
          const fn: Obj = {
            name: tool.name,
            ...(tool.description !== undefined ? { description: tool.description } : {}),
            ...(tool.parameters !== undefined ? { parameters: tool.parameters } : {}),
          };
          mergeNodeExtra(tool.extra, 'openai-chat', fn, OPENAI_MODELED_FUNCTION_KEYS);
          return { type: 'function', function: fn };
        });
      }
      if (request.toolChoice !== undefined) wire.tool_choice = request.toolChoice;
      if (request.stream === true) wire.stream = true;
      // Streams always ask for the trailing usage chunk; client `stream_options` keys are kept.
      if (request.stream === true) wire.stream_options = { ...request.streamOptions, include_usage: true };
      else if (request.streamOptions !== undefined) wire.stream_options = request.streamOptions;
      mergeRequestExtra(request, 'openai-chat', wire, OPENAI_MODELED_REQUEST_KEYS);
      return wire;
    },
    decodeResponse(wire: unknown): InternalResponse | undefined {
      if (!isRecord(wire)) return undefined;
      const choice: unknown = Array.isArray(wire.choices) ? wire.choices[0] : undefined;
      const message = isRecord(choice) && isRecord(choice.message) ? choice.message : undefined;
      const response: InternalResponse = {
        message: { role: 'assistant', parts: message ? decodeMessageParts(message) : [] },
      };
      if (isRecord(choice)) {
        const finishReason = mapFinishReason(choice.finish_reason);
        if (finishReason !== undefined) response.finishReason = finishReason;
      }
      const usage = decodeUsage(wire.usage);
      if (usage !== undefined) response.usage = usage;
      if (typeof wire.id === 'string') response.id = wire.id;
      if (typeof wire.model === 'string') response.model = wire.model;
      // Neither a message nor any carried metadata: not a decodable response.
      if (!message && response.id === undefined && response.model === undefined && usage === undefined) return undefined;
      return response;
    },
    decodeRequest(wire: unknown): InternalRequest | undefined {
      if (!isRecord(wire)) return undefined;
      const rawMessages: unknown = wire.messages;
      if (!Array.isArray(rawMessages)) return undefined;
      const model = wire.model;
      const request: InternalRequest = {
        model: typeof model === 'string' ? model : '',
        messages: decodeOpenAIMessages(rawMessages),
      };
      const maxTokens = wire.max_tokens;
      if (isNumber(maxTokens)) request.maxTokens = maxTokens;
      const temperature = wire.temperature;
      if (isNumber(temperature)) request.temperature = temperature;
      const topP = wire.top_p;
      if (isNumber(topP)) request.topP = topP;
      const rawTools: unknown = wire.tools;
      if (Array.isArray(rawTools) && rawTools.length > 0) request.tools = rawTools.filter(isRecord).map(decodeOpenAITool);
      if (wire.tool_choice !== undefined) request.toolChoice = wire.tool_choice;
      if (wire.stream === true) request.stream = true;
      if (isRecord(wire.stream_options)) request.streamOptions = wire.stream_options;
      const extra = captureRequestExtra('openai-chat', wire, OPENAI_MODELED_REQUEST_KEYS);
      if (extra !== undefined) request.extra = extra;
      return request;
    },
    decodeStream(chunks: AsyncIterable<string> | Iterable<string>): AsyncIterable<InternalLLMEvent> {
      return decodeStream(chunks);
    },
    encodeStream(events: AsyncIterable<InternalLLMEvent> | Iterable<InternalLLMEvent>): AsyncIterable<string> {
      return encodeStream(events);
    },
    applyToolCalls(wire: Obj, toolCalls: readonly ToolCall[]): Obj | undefined {
      const choices = wire.choices;
      if (!Array.isArray(choices) || !choices.some((choice) => isRecord(choice) && isRecord(choice.message))) return undefined;
      // Pure: rewrite a deep copy so the caller's upstream body is never mutated.
      const next = structuredClone(wire);
      for (const choice of next.choices as unknown[]) {
        if (!isRecord(choice) || !isRecord(choice.message)) continue;
        const message = choice.message;
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
      return next;
    },
    encodeResponse(response: InternalResponse): Record<string, unknown> {
      return {
        id: response.id,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: response.model,
        choices: [
          {
            index: 0,
            message: encodeOpenAIMessage(response.message.parts),
            finish_reason: encodeOpenAIFinishReason(response.finishReason),
          },
        ],
        ...(response.usage === undefined ? {} : { usage: encodeOpenAIUsage(response.usage) }),
      };
    },
  };
}

/** Client-facing error body in the OpenAI chat-completions error shape. */
export function encodeOpenAIErrorBody(message: string): Record<string, unknown> {
  return { error: { message, type: 'server_error', param: null, code: null } };
}
