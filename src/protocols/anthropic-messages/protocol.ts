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
import type { RequestExtra } from '../../ports/llm';
import { captureRequestExtra, mergeNodeExtra, mergeRequestExtra } from '../request-extra';

type Obj = Record<string, unknown>;

const ANTHROPIC_MODELED_REQUEST_KEYS = ['model', 'messages', 'system', 'max_tokens', 'temperature', 'top_p', 'tools', 'tool_choice', 'stream'];
const ANTHROPIC_MODELED_TOOL_KEYS = ['name', 'description', 'input_schema'];
const ANTHROPIC_MODELED_TEXT_KEYS = ['type', 'text'];
const ANTHROPIC_MODELED_TOOL_USE_KEYS = ['type', 'id', 'name', 'input'];
const ANTHROPIC_MODELED_TOOL_RESULT_KEYS = ['type', 'tool_use_id', 'content', 'is_error'];

/** Spread-ready `{ extra }` holding a request block's unmodeled fields (e.g. `cache_control`); empty when none. */
function blockExtra(block: Obj, modeled: readonly string[]): { extra?: RequestExtra } {
  const extra = captureRequestExtra('anthropic-messages', block, modeled);
  return extra !== undefined ? { extra } : {};
}

const DEFAULT_MAX_TOKENS = 4096;

const isRecord = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value);

const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

function parseInput(raw: string): Record<string, unknown> {
  if (raw.trim() === '') return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function mapStopReason(raw: unknown): FinishReason | undefined {
  if (typeof raw !== 'string') return undefined;
  switch (raw) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop';
    case 'max_tokens':
      return 'length';
    case 'tool_use':
      return 'tool-calls';
    case 'refusal':
      return 'content-filter';
    default:
      return 'other';
  }
}

/** Anthropic `input_tokens` excludes cache tokens: fold cache-creation into base input, carry cache-read as the hit. */
function decodeUsage(raw: unknown): Usage | undefined {
  if (!isRecord(raw)) return undefined;
  const input = isNumber(raw.input_tokens) ? raw.input_tokens : undefined;
  const output = isNumber(raw.output_tokens) ? raw.output_tokens : undefined;
  if (input === undefined && output === undefined) return undefined;
  const cacheRead = isNumber(raw.cache_read_input_tokens) ? Math.max(0, raw.cache_read_input_tokens) : undefined;
  const cacheCreation = isNumber(raw.cache_creation_input_tokens) ? raw.cache_creation_input_tokens : 0;
  const base = Math.max(0, (input ?? 0) + cacheCreation);
  const out = output ?? 0;
  const cacheWrite = isNumber(raw.cache_creation_input_tokens) ? { cacheWriteInput: cacheCreation } : {};
  const cacheHit = cacheRead !== undefined ? { cacheHitInput: cacheRead } : {};
  return { input: base, output: out, ...cacheHit, ...cacheWrite, total: base + (cacheRead ?? 0) + out };
}

/** Anthropic thinking block: redacted data verbatim, or signed thinking only (unsigned returns null). */
function encodeReasoningBlock(part: Extract<MessagePart, { type: 'reasoning' }>): Obj | null {
  if (part.redactedData !== undefined) return { type: 'redacted_thinking', data: part.redactedData };
  if (part.signature === undefined) return null;
  return { type: 'thinking', thinking: part.text, signature: part.signature };
}

function encodeBlocks(parts: MessagePart[]): Obj[] {
  const blocks: Obj[] = [];
  for (const part of parts) {
    switch (part.type) {
      case 'text': {
        const block: Obj = { type: 'text', text: part.text };
        mergeNodeExtra(part.extra, 'anthropic-messages', block, ANTHROPIC_MODELED_TEXT_KEYS);
        blocks.push(block);
        break;
      }
      case 'reasoning': {
        const block = encodeReasoningBlock(part);
        if (block !== null) blocks.push(block);
        break;
      }
      case 'tool-call': {
        const block: Obj = { type: 'tool_use', id: part.id, name: part.name, input: part.args };
        mergeNodeExtra(part.extra, 'anthropic-messages', block, ANTHROPIC_MODELED_TOOL_USE_KEYS);
        blocks.push(block);
        break;
      }
      case 'tool-result': {
        const block: Obj = {
          type: 'tool_result',
          tool_use_id: part.id,
          content: part.content,
          ...(part.isError ? { is_error: true } : {}),
        };
        mergeNodeExtra(part.extra, 'anthropic-messages', block, ANTHROPIC_MODELED_TOOL_RESULT_KEYS);
        blocks.push(block);
        break;
      }
      case 'opaque':
        // Same-protocol opaque blocks are re-emitted verbatim; other protocols skip them.
        if (part.protocol === 'anthropic-messages') blocks.push(structuredClone(part.block));
        break;
    }
  }
  return blocks;
}

/** One system text; `extra` is set only for same-protocol fields (e.g. block-form `cache_control`). */
interface SystemText {
  text: string;
  extra?: RequestExtra;
}

/** String form when no system text carries same-protocol fields (unchanged); block form otherwise. */
function encodeSystem(system: SystemText[]): string | Obj[] {
  if (!system.some((entry) => entry.extra !== undefined)) return system.map((entry) => entry.text).join('\n');
  return system.map((entry) => {
    const block: Obj = { type: 'text', text: entry.text };
    mergeNodeExtra(entry.extra, 'anthropic-messages', block, ANTHROPIC_MODELED_TEXT_KEYS);
    return block;
  });
}

function encodeMessages(messages: Message[]): { system: SystemText[]; messages: Obj[] } {
  const system: SystemText[] = [];
  const out: Obj[] = [];
  for (const message of messages) {
    if (message.role === 'system') {
      const texts = message.parts.filter((part): part is Extract<MessagePart, { type: 'text' }> => part.type === 'text');
      const text = texts.map((part) => part.text).join('');
      const extra = texts.find((part) => part.extra?.protocol === 'anthropic-messages')?.extra;
      if (text !== '') system.push({ text, ...(extra !== undefined ? { extra } : {}) });
      continue;
    }
    // `tool` messages carry tool_result blocks, which Anthropic sends as user-role content.
    const blocks = encodeBlocks(message.parts);
    const role = message.role === 'assistant' ? 'assistant' : 'user';
    // A turn with no content (or only empty text) becomes `""`, matching translate.ts.
    const empty = blocks.every((block) => block.type === 'text' && block.text === '');
    out.push({ role, content: empty ? '' : blocks });
  }
  return { system, messages: out };
}

function decodeBlocks(content: unknown[]): MessagePart[] {
  const parts: MessagePart[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push({ type: 'text', text: block.text });
    } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
      parts.push({
        type: 'reasoning',
        text: block.thinking,
        ...(typeof block.signature === 'string' ? { signature: block.signature } : {}),
      });
    } else if (block.type === 'redacted_thinking' && typeof block.data === 'string') {
      parts.push({ type: 'reasoning', text: '', redactedData: block.data });
    } else if (block.type === 'tool_use' && typeof block.name === 'string' && block.name !== '') {
      parts.push({
        type: 'tool-call',
        id: typeof block.id === 'string' ? block.id : '',
        name: block.name,
        args: isRecord(block.input) ? block.input : {},
      });
    }
  }
  return parts;
}

/** Stream block state keyed by content-block index. */
interface StreamBlock {
  kind: string;
  id: string;
  name: string;
  args: string;
}

interface StreamState {
  started: boolean;
  blocks: Map<number, StreamBlock>;
  /** Raw usage fields merged last-reported-wins across message_start / message_delta. */
  usageRaw: Obj;
  usageDirty: boolean;
  finishReason?: FinishReason;
}

function emitToolCall(block: StreamBlock, index: number): InternalLLMEvent[] {
  if (block.name === '') return [];
  return [
    { type: 'tool-call', id: block.id, name: block.name, args: parseInput(block.args), rawArgs: block.args, index },
  ];
}

function flushUsage(state: StreamState): InternalLLMEvent[] {
  if (!state.usageDirty) return [];
  state.usageDirty = false;
  const usage = decodeUsage(state.usageRaw);
  return usage !== undefined ? [{ type: 'usage', usage }] : [];
}

function mergeUsage(state: StreamState, raw: unknown): void {
  if (!isRecord(raw)) return;
  for (const key of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']) {
    const value = raw[key];
    if (isNumber(value)) {
      state.usageRaw[key] = value;
      state.usageDirty = true;
    }
  }
}

/** Upstream id/model carried on a message object; only fields actually present are returned. */
function identityOf(source: Obj): { id?: string; model?: string } {
  return {
    ...(typeof source.id === 'string' ? { id: source.id } : {}),
    ...(typeof source.model === 'string' ? { model: source.model } : {}),
  };
}

function handleFrame(frame: Obj, state: StreamState): InternalLLMEvent[] {
  const events: InternalLLMEvent[] = [];
  switch (frame.type) {
    case 'message_start': {
      if (!state.started) {
        state.started = true;
        events.push({ type: 'step-start', ...(isRecord(frame.message) ? identityOf(frame.message) : {}) });
      }
      if (isRecord(frame.message)) mergeUsage(state, frame.message.usage);
      break;
    }
    case 'content_block_start': {
      if (typeof frame.index !== 'number' || !isRecord(frame.content_block)) break;
      const block = frame.content_block;
      if (block.type === 'text') {
        state.blocks.set(frame.index, { kind: 'text', id: '', name: '', args: '' });
        if (typeof block.text === 'string' && block.text !== '') events.push({ type: 'text', text: block.text });
      } else if (block.type === 'thinking') {
        state.blocks.set(frame.index, { kind: 'thinking', id: '', name: '', args: '' });
        if (typeof block.thinking === 'string' && block.thinking !== '') {
          events.push({ type: 'reasoning', text: block.thinking });
        }
      } else if (block.type === 'redacted_thinking') {
        if (typeof block.data === 'string') events.push({ type: 'reasoning', text: '', redactedData: block.data });
      } else if (block.type === 'tool_use') {
        state.blocks.set(frame.index, {
          kind: 'tool_use',
          id: typeof block.id === 'string' ? block.id : '',
          name: typeof block.name === 'string' ? block.name : '',
          args: '',
        });
      }
      break;
    }
    case 'content_block_delta': {
      if (typeof frame.index !== 'number' || !isRecord(frame.delta)) break;
      const delta = frame.delta;
      if (typeof delta.text === 'string' && delta.text !== '') events.push({ type: 'text', text: delta.text });
      if (typeof delta.thinking === 'string' && delta.thinking !== '') {
        events.push({ type: 'reasoning', text: delta.thinking });
      }
      if (typeof delta.signature === 'string') events.push({ type: 'reasoning', text: '', signature: delta.signature });
      if (typeof delta.partial_json === 'string') {
        const block = state.blocks.get(frame.index);
        if (block !== undefined && block.kind === 'tool_use') block.args += delta.partial_json;
      }
      break;
    }
    case 'content_block_stop': {
      if (typeof frame.index !== 'number') break;
      const block = state.blocks.get(frame.index);
      if (block === undefined) break;
      state.blocks.delete(frame.index);
      if (block.kind === 'tool_use') events.push(...emitToolCall(block, frame.index));
      break;
    }
    case 'message_delta': {
      mergeUsage(state, frame.usage);
      events.push(...flushUsage(state));
      const finish = isRecord(frame.delta) ? mapStopReason(frame.delta.stop_reason) : undefined;
      if (finish !== undefined) {
        state.finishReason = finish;
        events.push({ type: 'step-finish', finishReason: finish });
      }
      break;
    }
    default:
      // message_stop, ping, error and unknown frames carry nothing to map.
      break;
  }
  return events;
}

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
  const state: StreamState = { started: false, blocks: new Map(), usageRaw: {}, usageDirty: false };
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
  // Close any tool_use blocks the stream left open, in index order.
  const open = [...state.blocks.keys()].sort((a, b) => a - b);
  for (const index of open) {
    const block = state.blocks.get(index);
    if (block !== undefined && block.kind === 'tool_use') yield* emitToolCall(block, index);
  }
  state.blocks.clear();
  yield* flushUsage(state);
  if (state.finishReason !== undefined) yield { type: 'finish', finishReason: state.finishReason };
}

/** Encode LLM events as messages SSE frames. Unsigned reasoning has no valid Anthropic wire form and is dropped. */
async function* encodeStream(events: AsyncIterable<InternalLLMEvent> | Iterable<InternalLLMEvent>): AsyncGenerator<string> {
  const frame = (name: string, data: Obj): string => `event: ${name}\ndata: ${JSON.stringify({ type: name, ...data })}\n\n`;
  let index = 0;
  let textOpen = false;
  let finishReason: FinishReason | undefined;
  let usage: Usage | undefined;
  let meta: { id?: string | undefined; model?: string | undefined } = {};
  let started = false;
  // Unsigned thinking text waits here for its signature; unsigned thinking is never emitted.
  let pendingThinking: string | undefined;
  const startFrame = (): string => {
    started = true;
    return frame('message_start', {
      message: {
        id: meta.id ?? 'msg_aitoolgate',
        type: 'message',
        role: 'assistant',
        ...(meta.model !== undefined ? { model: meta.model } : {}),
        content: [],
        stop_reason: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
  };
  for await (const event of events) {
    if (event.type === 'step-start') meta = { id: event.id, model: event.model };
    if (!started) yield startFrame();
    if (event.type === 'text') {
      if (event.text === '') continue;
      if (!textOpen) {
        yield frame('content_block_start', { index, content_block: { type: 'text', text: '' } });
        textOpen = true;
      }
      yield frame('content_block_delta', { index, delta: { type: 'text_delta', text: event.text } });
      continue;
    }
    if (event.type !== 'reasoning') pendingThinking = undefined;
    if (textOpen) {
      yield frame('content_block_stop', { index });
      index++;
      textOpen = false;
    }
    switch (event.type) {
      case 'tool-call':
        yield frame('content_block_start', { index, content_block: { type: 'tool_use', id: event.id, name: event.name, input: {} } });
        yield frame('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(event.args) } });
        yield frame('content_block_stop', { index });
        index++;
        break;
      case 'reasoning':
        if (event.redactedData !== undefined) {
          pendingThinking = undefined;
          yield frame('content_block_start', { index, content_block: { type: 'redacted_thinking', data: event.redactedData } });
          yield frame('content_block_stop', { index });
          index++;
        } else if (event.signature !== undefined) {
          // Decoder emits thinking text and its signature as separate events; join them here.
          const thinking = (pendingThinking ?? '') + event.text;
          pendingThinking = undefined;
          yield frame('content_block_start', { index, content_block: { type: 'thinking', thinking: '', signature: '' } });
          if (thinking !== '') yield frame('content_block_delta', { index, delta: { type: 'thinking_delta', thinking } });
          yield frame('content_block_delta', { index, delta: { type: 'signature_delta', signature: event.signature } });
          yield frame('content_block_stop', { index });
          index++;
        } else {
          pendingThinking = (pendingThinking ?? '') + event.text;
        }
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
  if (!started) yield startFrame();
  if (textOpen) yield frame('content_block_stop', { index });
  yield frame('message_delta', {
    delta: { stop_reason: encodeAnthropicStopReason(finishReason), stop_sequence: null },
    ...(usage === undefined ? {} : { usage: encodeAnthropicUsage(usage) }),
  });
  yield frame('message_stop', {});
}

/** Plain text of a tool_result body (string, text blocks, or JSON); mirrors translate.ts. */
function extractToolResultText(content: unknown): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (c !== null && typeof c === 'object' && 'text' in c ? String((c as { text?: unknown }).text ?? '') : ''))
      .join('');
  }
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

/**
 * Decode Anthropic request messages. Thinking blocks are dropped; a user message's tool_result
 * blocks become a leading `tool` message and its text a following `user` message (translate.ts order).
 */
function decodeAnthropicMessages(rawMessages: unknown[]): Message[] {
  const out: Message[] = [];
  for (const raw of rawMessages) {
    if (!isRecord(raw)) continue;
    const role: 'user' | 'assistant' = raw.role === 'assistant' ? 'assistant' : 'user';
    const content: unknown = raw.content;
    if (typeof content === 'string') {
      out.push({ role, parts: [{ type: 'text', text: content }] });
      continue;
    }
    if (!Array.isArray(content)) continue;
    const parts: MessagePart[] = [];
    const results: MessagePart[] = [];
    for (const block of content) {
      if (!isRecord(block)) continue;
      if (block.type === 'text' && typeof block.text === 'string') {
        parts.push({ type: 'text', text: block.text, ...blockExtra(block, ANTHROPIC_MODELED_TEXT_KEYS) });
      } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
        parts.push({
          type: 'reasoning',
          text: block.thinking,
          ...(typeof block.signature === 'string' ? { signature: block.signature } : {}),
        });
      } else if (block.type === 'redacted_thinking' && typeof block.data === 'string') {
        parts.push({ type: 'reasoning', text: '', redactedData: block.data });
      } else if (block.type === 'tool_use' && role === 'assistant' && typeof block.name === 'string') {
        parts.push({
          type: 'tool-call',
          id: typeof block.id === 'string' ? block.id : '',
          name: block.name,
          args: isRecord(block.input) ? block.input : {},
          ...blockExtra(block, ANTHROPIC_MODELED_TOOL_USE_KEYS),
        });
      } else if (block.type === 'image') {
        // Image blocks are opaque: kept verbatim for the same protocol, skipped by other encoders.
        parts.push({ type: 'opaque', protocol: 'anthropic-messages', block: structuredClone(block) });
      } else if (block.type === 'tool_result' && role === 'user') {
        results.push({
          type: 'tool-result',
          id: typeof block.tool_use_id === 'string' ? block.tool_use_id : '',
          name: '',
          content: extractToolResultText(block.content),
          isError: block.is_error === true,
          ...blockExtra(block, ANTHROPIC_MODELED_TOOL_RESULT_KEYS),
        });
      }
    }
    if (results.length > 0) out.push({ role: 'tool', parts: results });
    if (role === 'assistant' || parts.length > 0) out.push({ role, parts });
  }
  return out;
}

/** Decode an Anthropic tool; empty descriptions are dropped and input_schema defaults to an object schema. */
function decodeAnthropicTool(tool: Obj): ToolDefinition {
  const definition: ToolDefinition = {
    name: typeof tool.name === 'string' ? tool.name : '',
    parameters: isRecord(tool.input_schema) ? tool.input_schema : { type: 'object' },
  };
  if (typeof tool.description === 'string' && tool.description !== '') definition.description = tool.description;
  const extra = captureRequestExtra('anthropic-messages', tool, ANTHROPIC_MODELED_TOOL_KEYS);
  if (extra !== undefined) definition.extra = extra;
  return definition;
}

function encodeAnthropicStopReason(reason: FinishReason | undefined): string {
  switch (reason) {
    case 'tool-calls':
      return 'tool_use';
    case 'length':
      return 'max_tokens';
    case 'content-filter':
      return 'refusal';
    default:
      return 'end_turn';
  }
}

/** Anthropic `input_tokens` is the base input (cache excluded); the cache hit rides on `cache_read_input_tokens`. */
function encodeAnthropicUsage(usage: Usage | undefined): Obj {
  const cacheHit = usage?.cacheHitInput ?? 0;
  return {
    input_tokens: usage?.input ?? 0,
    output_tokens: usage?.output ?? 0,
    ...(cacheHit > 0 ? { cache_read_input_tokens: cacheHit } : {}),
  };
}

/** Encode response content: signed/redacted thinking blocks, one joined text block (or an empty text block), then tool_use blocks. */
function encodeAnthropicContent(parts: MessagePart[]): Obj[] {
  const text = parts
    .filter((part): part is Extract<MessagePart, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('');
  const blocks: Obj[] = [];
  // Thinking blocks precede text, as Anthropic emits them.
  for (const part of parts) {
    if (part.type !== 'reasoning') continue;
    const block = encodeReasoningBlock(part);
    if (block !== null) blocks.push(block);
  }
  if (text !== '') blocks.push({ type: 'text', text });
  for (const part of parts) {
    if (part.type === 'tool-call') blocks.push({ type: 'tool_use', id: part.id, name: part.name, input: part.args });
  }
  if (blocks.length === 0) blocks.push({ type: 'text', text: '' });
  return blocks;
}

/** Create the Anthropic messages protocol (stateless; safe to share). */
export function createAnthropicMessagesProtocol(): Protocol {
  return {
    id: 'anthropic-messages',
    encodeRequest(request: InternalRequest): Record<string, unknown> {
      const encoded = encodeMessages(request.messages);
      // A lone text block is emitted as a plain string only when the source content was a plain string.
      const sourceMessages = request.messages.filter((message) => message.role !== 'system');
      encoded.messages.forEach((message, index) => {
        if (sourceMessages[index]?.plainStringContent !== true) return;
        const blocks = message.content;
        const only = Array.isArray(blocks) && blocks.length === 1 ? blocks[0] : undefined;
        if (isRecord(only) && only.type === 'text') message.content = only.text;
      });
      const wire: Record<string, unknown> = {
        model: request.model,
        max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
        messages: encoded.messages,
      };
      if (encoded.system.length > 0) wire.system = encodeSystem(encoded.system);
      if (request.temperature !== undefined) wire.temperature = request.temperature;
      if (request.topP !== undefined) wire.top_p = request.topP;
      if (request.tools !== undefined && request.tools.length > 0) {
        wire.tools = request.tools.map((tool) => {
          const wireTool: Obj = {
            name: tool.name,
            ...(tool.description !== undefined ? { description: tool.description } : {}),
            input_schema: tool.parameters ?? { type: 'object' },
          };
          mergeNodeExtra(tool.extra, 'anthropic-messages', wireTool, ANTHROPIC_MODELED_TOOL_KEYS);
          return wireTool;
        });
      }
      if (request.toolChoice !== undefined) wire.tool_choice = request.toolChoice;
      if (request.stream === true) wire.stream = true;
      mergeRequestExtra(request, 'anthropic-messages', wire, ANTHROPIC_MODELED_REQUEST_KEYS);
      return wire;
    },
    decodeResponse(wire: unknown): InternalResponse | undefined {
      if (!isRecord(wire)) return undefined;
      const content: unknown[] | undefined = Array.isArray(wire.content) ? wire.content : undefined;
      const response: InternalResponse = {
        message: { role: 'assistant', parts: content ? decodeBlocks(content) : [] },
      };
      const finishReason = mapStopReason(wire.stop_reason);
      if (finishReason !== undefined) response.finishReason = finishReason;
      const usage = decodeUsage(wire.usage);
      if (usage !== undefined) response.usage = usage;
      if (typeof wire.id === 'string') response.id = wire.id;
      if (typeof wire.model === 'string') response.model = wire.model;
      // Neither a content array nor any carried metadata: not a decodable response.
      if (!content && response.id === undefined && response.model === undefined && usage === undefined) return undefined;
      return response;
    },
    decodeRequest(wire: unknown): InternalRequest | undefined {
      if (!isRecord(wire)) return undefined;
      const rawMessages: unknown = wire.messages;
      if (!Array.isArray(rawMessages)) return undefined;
      const model = wire.model;
      const messages = decodeAnthropicMessages(rawMessages);
      const system = wire.system;
      if (typeof system === 'string' && system !== '') {
        messages.unshift({ role: 'system', parts: [{ type: 'text', text: system }] });
      } else if (Array.isArray(system)) {
        // Block-form system prompt: one text part per block; unmodeled fields (cache_control) ride in `extra`.
        const blocks = system.filter(isRecord).filter((b) => b.type === 'text' && typeof b.text === 'string');
        messages.unshift(
          ...blocks.map((b): Message => ({
            role: 'system',
            parts: [{ type: 'text', text: String(b.text), ...blockExtra(b, ANTHROPIC_MODELED_TEXT_KEYS) }],
          })),
        );
      }
      const request: InternalRequest = { model: typeof model === 'string' ? model : '', messages };
      const maxTokens = wire.max_tokens;
      if (isNumber(maxTokens)) request.maxTokens = maxTokens;
      const temperature = wire.temperature;
      if (isNumber(temperature)) request.temperature = temperature;
      const topP = wire.top_p;
      if (isNumber(topP)) request.topP = topP;
      const rawTools: unknown = wire.tools;
      if (Array.isArray(rawTools) && rawTools.length > 0) request.tools = rawTools.filter(isRecord).map(decodeAnthropicTool);
      if (wire.tool_choice !== undefined) request.toolChoice = wire.tool_choice;
      if (wire.stream === true) request.stream = true;
      const extra = captureRequestExtra('anthropic-messages', wire, ANTHROPIC_MODELED_REQUEST_KEYS);
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
      const content = wire.content;
      if (!Array.isArray(content)) return undefined;
      // Pure: build the rewritten copy; the caller's upstream body is never mutated.
      // Keep non-`tool_use` blocks (e.g. text) in their original order, then emit one
      // `tool_use` block per remaining tool call (drops clear them, rewrites update them).
      const next = structuredClone(wire);
      const blocks: Obj[] = (next.content as unknown[]).filter((block): block is Obj => isRecord(block) && block.type !== 'tool_use');
      for (const tc of toolCalls) {
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.arguments ?? {} });
      }
      next.content = blocks;
      return next;
    },
    encodeResponse(response: InternalResponse): Record<string, unknown> {
      return {
        id: response.id,
        type: 'message',
        role: 'assistant',
        model: response.model,
        content: encodeAnthropicContent(response.message.parts),
        stop_reason: encodeAnthropicStopReason(response.finishReason),
        ...(response.usage === undefined ? {} : { usage: encodeAnthropicUsage(response.usage) }),
      };
    },
  };
}

/** Client-facing error body in the Anthropic messages error shape. */
export function encodeAnthropicErrorBody(message: string): Record<string, unknown> {
  return { type: 'error', error: { type: 'api_error', message } };
}
