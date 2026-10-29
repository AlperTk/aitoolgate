import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createOpenAIChatProtocol } from '../src/protocols/openai-chat';
import { createAnthropicMessagesProtocol } from '../src/protocols/anthropic-messages';
import { createSseToolCallExtractor } from '../src/telemetry/stream-extract';
import type { LLMEvent } from '../src/ports/llm';
import type { Protocol } from '../src/ports/protocol';

// Parity: protocol decodeStream output must agree with the telemetry extractor (stream-extract.ts)
// on tool-call and usage for the same SSE bytes. Reasoning is checked on the decoder side only.

const FIXED_NOW_MS = 1_700_000_000_000;
const CHUNK_SIZE = 7; // splits bytes mid-line and mid-JSON so both paths exercise buffering

type Frame = Record<string, unknown>;
type Emitted = { type: string; [key: string]: unknown };

const openaiSse = (frames: Frame[]): string =>
  frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('') + 'data: [DONE]\n\n';

const anthropicSse = (frames: Frame[]): string =>
  frames.map((f) => `event: ${String(f.type)}\ndata: ${JSON.stringify(f)}\n\n`).join('');

const oaiChunk = (delta: Frame, finishReason: string | null = null): Frame => ({
  id: 'chatcmpl-1',
  object: 'chat.completion.chunk',
  choices: [{ index: 0, delta, finish_reason: finishReason }],
});

const oaiUsageChunk: Frame = {
  id: 'chatcmpl-1',
  object: 'chat.completion.chunk',
  choices: [],
  usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150, prompt_tokens_details: { cached_tokens: 20 } },
};

const msgStart: Frame = {
  type: 'message_start',
  message: {
    id: 'msg_1',
    role: 'assistant',
    usage: { input_tokens: 25, cache_creation_input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 1 },
  },
};
const blockStart = (index: number, contentBlock: Frame): Frame => ({ type: 'content_block_start', index, content_block: contentBlock });
const blockDelta = (index: number, delta: Frame): Frame => ({ type: 'content_block_delta', index, delta });
const blockStop = (index: number): Frame => ({ type: 'content_block_stop', index });
const msgDelta = (outputTokens: number): Frame => ({
  type: 'message_delta',
  delta: { stop_reason: 'tool_use' },
  usage: { output_tokens: outputTokens },
});
const msgStop: Frame = { type: 'message_stop' };

const openaiSingleToolCall = openaiSse([
  oaiChunk({ role: 'assistant', content: 'Let me check.' }),
  oaiChunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '' } }] }),
  oaiChunk({ tool_calls: [{ index: 0, function: { arguments: '{"ci' } }] }),
  oaiChunk({ tool_calls: [{ index: 0, function: { arguments: 'ty":"Paris"}' } }] }),
  oaiChunk({}, 'tool_calls'),
  oaiUsageChunk,
]);

const openaiBatchedWithUsage = openaiSse([
  oaiChunk({
    tool_calls: [
      { index: 0, id: 'call_a', type: 'function', function: { name: 'get_weather', arguments: '{"city":' } },
      { index: 1, id: 'call_b', type: 'function', function: { name: 'get_time', arguments: '{"tz"' } },
    ],
  }),
  oaiChunk({ tool_calls: [{ index: 0, function: { arguments: '"Paris"}' } }] }),
  oaiChunk({ tool_calls: [{ index: 1, function: { arguments: ':"UTC"}' } }] }),
  oaiChunk({}, 'tool_calls'),
  oaiUsageChunk,
]);

const openaiBatchedNoUsage = openaiSse([
  oaiChunk({
    tool_calls: [
      { index: 0, id: 'call_a', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } },
      { index: 1, id: 'call_b', type: 'function', function: { name: 'get_time', arguments: '{"tz":"UTC"}' } },
    ],
  }),
  oaiChunk({}, 'tool_calls'),
]);

const openaiReasoningToolCall = openaiSse([
  oaiChunk({ reasoning_content: 'Think' }),
  oaiChunk({ reasoning_content: ' hard' }),
  oaiChunk({ tool_calls: [{ index: 0, id: 'call_r', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } }] }),
  oaiChunk({}, 'tool_calls'),
  oaiUsageChunk,
]);

const anthropicThinkingTextTool = anthropicSse([
  msgStart,
  blockStart(0, { type: 'thinking', thinking: '' }),
  blockDelta(0, { type: 'thinking_delta', thinking: 'Need ' }),
  blockDelta(0, { type: 'thinking_delta', thinking: 'weather.' }),
  blockDelta(0, { type: 'signature_delta', signature: 'sig123' }),
  blockStop(0),
  blockStart(1, { type: 'text', text: '' }),
  blockDelta(1, { type: 'text_delta', text: 'Checking.' }),
  blockStop(1),
  blockStart(2, { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: {} }),
  blockDelta(2, { type: 'input_json_delta', partial_json: '{"ci' }),
  blockDelta(2, { type: 'input_json_delta', partial_json: 'ty":"Paris"}' }),
  blockStop(2),
  msgDelta(42),
  msgStop,
]);

const anthropicTwoToolUses = anthropicSse([
  msgStart,
  blockStart(0, { type: 'tool_use', id: 'toolu_a', name: 'get_weather', input: {} }),
  blockDelta(0, { type: 'input_json_delta', partial_json: '{"city":"Paris"}' }),
  blockStart(1, { type: 'tool_use', id: 'toolu_b', name: 'get_time', input: {} }),
  blockDelta(1, { type: 'input_json_delta', partial_json: '{"tz":"UTC"}' }),
  blockStop(0),
  blockStop(1),
  msgStop,
]);

/** Splits the SSE text into fixed-size string chunks (the decoder receives an iterable of chunks). */
function splitChunks(text: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += CHUNK_SIZE) out.push(text.slice(i, i + CHUNK_SIZE));
  return out;
}

async function decode(protocol: Protocol, chunks: string[]): Promise<LLMEvent[]> {
  const events: LLMEvent[] = [];
  for await (const event of protocol.decodeStream(chunks)) events.push(event);
  return events;
}

/** Feeds the same chunks through the passthrough extractor and returns the bus events it emits. */
async function extract(chunks: string[]): Promise<Emitted[]> {
  const emitted: Emitted[] = [];
  const bus = {
    emit(event: Emitted): unknown {
      emitted.push(event);
      return undefined;
    },
  };
  const transform = createSseToolCallExtractor(bus, 'parity', undefined, undefined, () => FIXED_NOW_MS);
  transform.resume();
  const done = once(transform, 'end');
  for (const chunk of chunks) transform.write(chunk);
  transform.end();
  await done;
  return emitted;
}

interface ToolCallView {
  id: string;
  name: string;
  args: unknown;
}

const decodedToolCalls = (events: LLMEvent[]): ToolCallView[] =>
  events.flatMap((e) => (e.type === 'tool-call' ? [{ id: e.id, name: e.name, args: e.args }] : []));

const extractedToolCalls = (emitted: Emitted[]): ToolCallView[] =>
  emitted
    .filter((e) => e.type === 'tool.call')
    .map((e) => ({ id: e.id as string, name: e.toolName as string, args: e.args }));

const decodedUsage = (events: LLMEvent[]) => {
  const event = events.find((e) => e.type === 'usage');
  return event?.type === 'usage' ? event.usage : undefined;
};

const extractedUsage = (emitted: Emitted[]) => emitted.find((e) => e.type === 'turn.usage')?.tokens;

const decodedReasoning = (events: LLMEvent[]): string =>
  events.flatMap((e) => (e.type === 'reasoning' ? [e.text] : [])).join('');

interface ParityCase {
  name: string;
  protocol: Protocol;
  sse: string;
  /** False when the stream carries no usage: the extractor then emits an estimate, not a parity value. */
  checkUsage: boolean;
}

const cases: ParityCase[] = [
  { name: 'openai: text + fragmented single tool-call + trailing usage', protocol: createOpenAIChatProtocol(), sse: openaiSingleToolCall, checkUsage: true },
  { name: 'openai: batched tool-calls + trailing usage', protocol: createOpenAIChatProtocol(), sse: openaiBatchedWithUsage, checkUsage: true },
  { name: 'openai: batched tool-calls without usage', protocol: createOpenAIChatProtocol(), sse: openaiBatchedNoUsage, checkUsage: false },
  { name: 'openai: reasoning_content + tool-call + usage', protocol: createOpenAIChatProtocol(), sse: openaiReasoningToolCall, checkUsage: true },
  { name: 'anthropic: thinking + text + fragmented tool_use + usage', protocol: createAnthropicMessagesProtocol(), sse: anthropicThinkingTextTool, checkUsage: true },
  { name: 'anthropic: two tool_use blocks (message_start usage only)', protocol: createAnthropicMessagesProtocol(), sse: anthropicTwoToolUses, checkUsage: true },
];

describe('stream parity: decodeStream vs stream-extract', () => {
  for (const c of cases) {
    it(`${c.name}: tool-calls match`, async () => {
      const chunks = splitChunks(c.sse);
      const decoded = decodedToolCalls(await decode(c.protocol, chunks));
      const emitted = extractedToolCalls(await extract(chunks));
      assert.notEqual(decoded.length, 0, 'fixture must carry at least one tool-call');
      assert.deepStrictEqual(emitted, decoded);
    });

    if (c.checkUsage) {
      it(`${c.name}: usage matches`, async () => {
        const chunks = splitChunks(c.sse);
        const decoded = decodedUsage(await decode(c.protocol, chunks));
        const emitted = extractedUsage(await extract(chunks));
        assert.notEqual(decoded, undefined, 'fixture must carry usage');
        assert.deepStrictEqual(emitted, decoded);
      });
    }

    it(`${c.name}: chunk boundaries do not change decoded events`, async () => {
      const whole = await decode(c.protocol, [c.sse]);
      const split = await decode(c.protocol, splitChunks(c.sse));
      assert.deepStrictEqual(split, whole);
    });
  }
});

describe('stream parity: decoded usage and reasoning values', () => {
  it('openai usage: cached tokens are split out of prompt_tokens', async () => {
    const usage = decodedUsage(await decode(createOpenAIChatProtocol(), splitChunks(openaiSingleToolCall)));
    assert.deepStrictEqual(usage, { input: 100, output: 30, cacheHitInput: 20, total: 150 });
  });

  it('anthropic usage: cache creation folds into input, final output_tokens wins', async () => {
    const usage = decodedUsage(await decode(createAnthropicMessagesProtocol(), splitChunks(anthropicThinkingTextTool)));
    assert.deepStrictEqual(usage, { input: 35, output: 42, cacheHitInput: 5, total: 82 });
  });

  it('openai reasoning_content is decoded as reasoning text', async () => {
    const events = await decode(createOpenAIChatProtocol(), splitChunks(openaiReasoningToolCall));
    assert.equal(decodedReasoning(events), 'Think hard');
  });

  it('anthropic thinking is decoded as reasoning text with signature', async () => {
    const events = await decode(createAnthropicMessagesProtocol(), splitChunks(anthropicThinkingTextTool));
    assert.equal(decodedReasoning(events), 'Need weather.');
    const signed = events.find((e) => e.type === 'reasoning' && e.signature !== undefined);
    assert.equal(signed?.type === 'reasoning' ? signed.signature : undefined, 'sig123');
  });
});
