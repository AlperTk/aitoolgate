import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeResponse } from '../src/proxy/context';
import { openaiResponseToAnthropic, anthropicResponseToOpenAI } from '../src/proxy/translate';
import { estimateTurnUsage } from '../src/telemetry/tokenEstimate';
import { createSseToolCallExtractor } from '../src/telemetry/stream-extract';
import { createCollector } from '../src/telemetry/collector';
import { createEventBus } from '../src/telemetry/event-bus';
import type {
  TelemetryEvent,
  ToolCallEvent,
  ToolResultEvent,
  TurnUsageEvent,
} from '../src/telemetry/events';

const AT = 1_700_000_000_000;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// --- (a) OpenAI SYNC: prompt_tokens includes cached_tokens -----------------

test('OpenAI sync splits prompt_tokens into base input + cacheHitInput', () => {
  const body = {
    id: 'x',
    object: 'chat.completion',
    created: 1,
    model: 'gpt-4o-mini',
    choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
    // prompt_tokens INCLUDES cached_tokens (a subset): base = 1320 - 1024, hit = 1024.
    usage: { prompt_tokens: 1320, completion_tokens: 42, total_tokens: 1362, prompt_tokens_details: { cached_tokens: 1024 } },
  };
  const { usage } = summarizeResponse(body);
  assert.ok(usage);
  assert.equal(usage.input, 296, 'base input = prompt_tokens - cached_tokens');
  assert.equal(usage.cacheHitInput, 1024, 'cache hit = cached_tokens');
  assert.equal(usage.output, 42);
  // total is the TRUE turn total (base + cache hit + output) and still equals total_tokens.
  assert.equal(usage.total, 296 + 1024 + 42);
  assert.equal(usage.total, 1362);
});

test('OpenAI sync with no cached tokens reports cacheHitInput = 0 (unchanged)', () => {
  const body = {
    id: 'x',
    object: 'chat.completion',
    created: 1,
    model: 'gpt-4o-mini',
    choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
  const { usage } = summarizeResponse(body);
  assert.ok(usage);
  assert.equal(usage.input, 10);
  assert.equal(usage.cacheHitInput, 0, 'no cache fields -> cache hit is 0');
  assert.equal(usage.output, 5);
  assert.equal(usage.total, 15);
});

test('OpenAI sync with prompt_tokens_details absent reports cacheHitInput=0, input=prompt_tokens', () => {
  const body = {
    id: 'x',
    object: 'chat.completion',
    created: 1,
    model: 'gpt-4o-mini',
    choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
    // prompt_tokens_details is ABSENT (a non-cache-supporting model): base input = prompt_tokens, hit = 0.
    usage: { prompt_tokens: 1320, completion_tokens: 42, total_tokens: 1362 },
  };
  const { usage } = summarizeResponse(body);
  assert.ok(usage);
  assert.equal(usage.input, 1320, 'base input = prompt_tokens (no cached_tokens)');
  assert.equal(usage.cacheHitInput, 0, 'absent prompt_tokens_details -> cache hit is 0');
  assert.equal(usage.output, 42);
  assert.equal(usage.total, 1362, 'total reconciles with total_tokens');
});

test('OpenAI sync with cached_tokens > prompt_tokens clamps base input to 0 (no negative/NaN in input/total/aggregate)', async () => {
  const body = {
    id: 'x',
    object: 'chat.completion',
    created: 1,
    model: 'gpt-4o-mini',
    choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
    // cached_tokens > prompt_tokens (corrupt): base input clamped to 0; no negative/NaN anywhere.
    usage: { prompt_tokens: 500, completion_tokens: 42, total_tokens: 542, prompt_tokens_details: { cached_tokens: 1320 } },
  };
  const { usage } = summarizeResponse(body);
  assert.ok(usage);
  assert.equal(usage.input, 0, 'base input clamped to 0 (cached_tokens > prompt_tokens)');
  assert.equal(usage.cacheHitInput, 1320, 'cache hit = cached_tokens (positive)');
  assert.equal(usage.output, 42);
  assert.ok(Number.isFinite(usage.total), 'total is finite (no NaN)');
  assert.equal(usage.total, 542, 'total = upstream total_tokens (non-negative; not recomputed on the sync path)');
  // The aggregate (collector) is also non-negative (no negative/NaN in the aggregate).
  const bus = createEventBus();
  const collector = createCollector({ bus });
  await bus.emit(turnUsage({ tokens: { input: 0, output: 42, total: 542, cacheHitInput: 1320 } }));
  const s = collector.summary();
  assert.equal(s.totalInputTokens, 0, 'aggregate input is 0 (non-negative)');
  assert.equal(s.totalCacheHitInputTokens, 1320, 'aggregate cache-hit is non-negative');
  assert.equal(s.totalTokens, 542, 'aggregate total is non-negative');
});

// --- (b) Anthropic SYNC: input_tokens excludes cache tokens ----------------

test('Anthropic sync folds cache_creation into base input and carries cache_read as the hit', () => {
  const body = {
    id: 'x',
    type: 'message',
    role: 'assistant',
    model: 'claude-3-opus',
    content: [{ type: 'text', text: 'hi' }],
    stop_reason: 'end_turn',
    // input_tokens EXCLUDES cache tokens: base = input_tokens + cache_creation; hit = cache_read.
    usage: { input_tokens: 25, cache_creation_input_tokens: 100, cache_read_input_tokens: 1024, output_tokens: 150 },
  };
  const { usage } = summarizeResponse(body);
  assert.ok(usage);
  assert.equal(usage.input, 125, 'base input = input_tokens + cache_creation_input_tokens');
  assert.equal(usage.cacheHitInput, 1024, 'cache hit = cache_read_input_tokens');
  assert.equal(usage.output, 150);
  assert.equal(usage.total, 125 + 1024 + 150, 'total = base + hit + output (true total)');
});

test('Anthropic sync with no cache tokens reports cacheHitInput = 0 (unchanged)', () => {
  const body = {
    id: 'x',
    type: 'message',
    role: 'assistant',
    model: 'claude-3-opus',
    content: [{ type: 'text', text: 'hi' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 10, output_tokens: 5 },
  };
  const { usage } = summarizeResponse(body);
  assert.ok(usage);
  assert.equal(usage.input, 10);
  assert.equal(usage.cacheHitInput, 0);
  assert.equal(usage.output, 5);
  assert.equal(usage.total, 15);
});

test('Anthropic sync with null cache fields reports cacheHitInput=0, input=input_tokens', () => {
  const body = {
    id: 'x',
    type: 'message',
    role: 'assistant',
    model: 'claude-3-opus',
    content: [{ type: 'text', text: 'hi' }],
    stop_reason: 'end_turn',
    // cache fields present but NULL (explicit prompt caching not used): base input = input_tokens, hit = 0.
    usage: { input_tokens: 25, cache_creation_input_tokens: null, cache_read_input_tokens: null, output_tokens: 150 },
  };
  const { usage } = summarizeResponse(body);
  assert.ok(usage);
  assert.equal(usage.input, 25, 'base input = input_tokens (null cache_creation)');
  assert.equal(usage.cacheHitInput, 0, 'null cache_read -> cache hit is 0');
  assert.equal(usage.output, 150);
  assert.equal(usage.total, 175, 'total = input + output (no cache hit)');
});

// --- (c) STREAMING: cache fields survive the stream -----------------------

function feedExtractor(sse: string): { events: TelemetryEvent[]; extractor: ReturnType<typeof createSseToolCallExtractor> } {
  const events: TelemetryEvent[] = [];
  const bus = { emit: (event: TelemetryEvent): void => { events.push(event); } };
  const extractor = createSseToolCallExtractor(bus, 'sess-cache', undefined);
  extractor.end(Buffer.from(sse));
  return { events, extractor };
}

test('OpenAI stream carries cached_tokens onto the turn.usage', async () => {
  const sse =
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'search_web', arguments: '{}' } }] } }] })}\n\n` +
    `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 1320, completion_tokens: 42, total_tokens: 1362, prompt_tokens_details: { cached_tokens: 1024 } } })}\n\n` +
    `data: [DONE]\n\n`;
  const { events } = feedExtractor(sse);
  await sleep(25);

  const turn = events.find((e) => e.type === 'turn.usage') as TurnUsageEvent | undefined;
  assert.ok(turn, 'a whole-turn usage event is emitted for the stream');
  assert.equal(turn.tokens.input, 296, 'base input = prompt_tokens - cached_tokens');
  assert.equal(turn.tokens.cacheHitInput, 1024, 'cache hit survives streaming');
  assert.equal(turn.tokens.output, 42);
  assert.equal(turn.tokens.total, 1362, 'total = base + hit + output');
});

test('OpenAI stream with a batched multi-call turn omits per-call tokens; the merged usage rides on the turn.usage', async () => {
  // A batched turn: two tool calls (index 0 and 1), then a trailing usage frame, then [DONE].
  // Both calls are emitted at stream end WITHOUT per-call tokens (the turn's token mass is
  // carried once by the whole-turn turn.usage, not duplicated on every per-call event).
  const sse =
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_a', function: { name: 'search_web', arguments: '{}' } }] } }] })}\n\n` +
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 1, id: 'call_b', function: { name: 'read_file', arguments: '{}' } }] } }] })}\n\n` +
    `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } })}\n\n` +
    `data: [DONE]\n\n`;
  const { events } = feedExtractor(sse);
  await sleep(25);

  const calls = events.filter((e) => e.type === 'tool.call') as ToolCallEvent[];
  assert.equal(calls.length, 2, 'both batched streamed tool.calls were captured');
  assert.equal(new Set(calls.map((c) => c.at)).size, 1, 'every tool.call in the turn shares one turn-level `at`');
  for (const call of calls) {
    assert.equal(
      call.tokens,
      undefined,
      `the batched call ${call.id} omits per-call tokens (the turn.usage carries the merged usage)`,
    );
  }
  const turn = events.find((e) => e.type === 'turn.usage') as TurnUsageEvent | undefined;
  assert.ok(turn, 'a whole-turn turn.usage is emitted for the batched turn');
  assert.equal(turn.tokens.input, 10, 'the turn.usage carries the merged turn input');
  assert.equal(turn.tokens.output, 20, 'the turn.usage carries the merged turn output');
  assert.equal(turn.tokens.total, 30, 'the turn.usage carries the merged turn total');
});

test('Anthropic stream: final message_delta output/cache_read win over the preliminary message_start values', async () => {
  // REALISTIC Anthropic frame sequence: `message_start` carries input_tokens +
  // cache_creation_input_tokens + cache_read_input_tokens AND a preliminary (stale)
  // output_tokens; `message_delta` carries the FINAL output_tokens + cache_read_input_tokens.
  // Before the field-aware merge fix the preliminary message_start output_tokens (1) won and
  // total was under-counted (1150 instead of 1299); this sequence now yields the true total.
  const sse =
    `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'claude-3-opus', usage: { input_tokens: 25, output_tokens: 1, cache_creation_input_tokens: 100, cache_read_input_tokens: 0 } } })}\n\n` +
    `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'search_web' } })}\n\n` +
    `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } })}\n\n` +
    `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n` +
    `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 150, cache_read_input_tokens: 1024 } })}\n\n` +
    `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`;
  const { events } = feedExtractor(sse);
  await sleep(25);

  const turn = events.find((e) => e.type === 'turn.usage') as TurnUsageEvent | undefined;
  assert.ok(turn, 'a whole-turn usage event is emitted for the stream');
  // input + cache_creation survive from message_start (input_tokens is only reported there).
  assert.equal(turn.tokens.input, 125, 'base input = input_tokens + cache_creation (from message_start)');
  // The FINAL values (message_delta) win over the preliminary message_start values.
  assert.equal(turn.tokens.cacheHitInput, 1024, 'final cache_read (message_delta) wins over the preliminary value');
  assert.equal(turn.tokens.output, 150, 'final output_tokens (message_delta) wins over the preliminary value');
  // total reconciles with the upstream true total (input_tokens + cache_creation + cache_read + output).
  assert.equal(turn.tokens.total, 125 + 1024 + 150, 'total = base + hit + output (true total)');
});

test('Anthropic stream: cache_creation on message_start survives into the final usage', async () => {
  // cache_creation_input_tokens arrives on message_start (before any cache field on
  // message_delta); it must survive into the FINAL merged usage (folded into base input).
  const sse =
    `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'claude-3-opus', usage: { input_tokens: 25, cache_creation_input_tokens: 100 } } })}\n\n` +
    `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 150 } })}\n\n` +
    `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`;
  const { events } = feedExtractor(sse);
  await sleep(25);

  const turn = events.find((e) => e.type === 'turn.usage') as TurnUsageEvent | undefined;
  assert.ok(turn, 'a whole-turn usage event is emitted for the stream');
  assert.equal(turn.tokens.input, 125, 'base input includes cache_creation from message_start');
  assert.equal(turn.tokens.output, 150, 'output from message_delta');
  assert.equal(turn.tokens.cacheHitInput, 0, 'no cache_read reported -> cache hit is 0');
  assert.equal(turn.tokens.total, 125 + 150, 'total = base + output');
});

test('streamed tool.call carries the merged turn tokens incl. cacheHitInput', async () => {
  const sse =
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'search_web', arguments: '{}' } }] } }] })}\n\n` +
    `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 1320, completion_tokens: 42, total_tokens: 1362, prompt_tokens_details: { cached_tokens: 1024 } } })}\n\n` +
    `data: [DONE]\n\n`;
  const { events } = feedExtractor(sse);
  await sleep(25);

  const call = events.find((e) => e.type === 'tool.call') as ToolCallEvent | undefined;
  assert.ok(call, 'the streamed tool.call is captured');
  assert.ok(call.tokens, 'the finalised call carries the full turn usage');
  assert.equal(call.tokens.cacheHitInput, 1024, 'the merged usage carries cacheHitInput on the call too');
});

// --- cross-protocol TRANSLATION carries cache fields so extractUsage reads them ---

test('OpenAI -> Anthropic conversion maps cached_tokens onto cache_read_input_tokens', () => {
  const resp = {
    id: 'x',
    object: 'chat.completion',
    created: 1,
    model: 'gpt-4o-mini',
    choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1320, completion_tokens: 42, total_tokens: 1362, prompt_tokens_details: { cached_tokens: 1024 } },
  } as unknown as Parameters<typeof openaiResponseToAnthropic>[0];
  const anth = openaiResponseToAnthropic(resp);
  assert.equal(anth.usage.input_tokens, 296, 'Anthropic base input = prompt_tokens - cached_tokens');
  assert.equal(anth.usage.output_tokens, 42);
  const usage = anth.usage as Record<string, unknown>;
  assert.equal(usage.cache_read_input_tokens, 1024, 'cache hit carried onto cache_read_input_tokens');
});

test('Anthropic -> OpenAI conversion maps cache_read_input_tokens onto cached_tokens', () => {
  const resp = {
    id: 'x',
    type: 'message',
    role: 'assistant',
    model: 'claude-3-opus',
    content: [{ type: 'text', text: 'hi' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 25, cache_creation_input_tokens: 100, cache_read_input_tokens: 1024, output_tokens: 150 },
  } as unknown as Parameters<typeof anthropicResponseToOpenAI>[0];
  const openai = anthropicResponseToOpenAI(resp);
  const usage = openai.usage as unknown as Record<string, unknown>;
  assert.equal(usage.prompt_tokens, 25 + 100 + 1024, 'OpenAI prompt_tokens = total input (base + creation + read)');
  assert.equal(usage.completion_tokens, 150);
  assert.equal((usage.prompt_tokens_details as { cached_tokens?: number })?.cached_tokens, 1024, 'cache hit carried onto prompt_tokens_details.cached_tokens');
});

test('OpenAI -> Anthropic translation total reconciles with the source true total (no cache_write over-count)', () => {
  const resp = {
    id: 'x',
    object: 'chat.completion',
    created: 1,
    model: 'gpt-4o-mini',
    choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
    // cache_write_tokens is a SEPARATE metric; it must NOT be folded into base input (which would over-count the total).
    usage: { prompt_tokens: 1320, completion_tokens: 42, total_tokens: 1362, prompt_tokens_details: { cached_tokens: 1024, cache_write_tokens: 500 } },
  } as unknown as Parameters<typeof openaiResponseToAnthropic>[0];
  const anth = openaiResponseToAnthropic(resp);
  const usage = anth.usage as unknown as Record<string, number | undefined>;
  assert.equal(usage.input_tokens, 1320 - 1024, 'base input = prompt_tokens - cached_tokens');
  assert.equal(usage.cache_read_input_tokens, 1024, 'cache hit = cached_tokens');
  assert.equal(usage.cache_creation_input_tokens, undefined, 'cache_write_tokens is NOT folded into base input');
  // The translated total (input + cache_hit + output) reconciles with the source's true total (prompt + completion).
  const total = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.output_tokens ?? 0);
  assert.equal(total, 1320 - 1024 + 1024 + 42, 'translated total = source true total (no over-count)');
  assert.equal(total, 1362);
});

test('Anthropic -> OpenAI translation total reconciles with the source true total', () => {
  const resp = {
    id: 'x',
    type: 'message',
    role: 'assistant',
    model: 'claude-3-opus',
    content: [{ type: 'text', text: 'hi' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 25, cache_creation_input_tokens: 100, cache_read_input_tokens: 1024, output_tokens: 150 },
  } as unknown as Parameters<typeof anthropicResponseToOpenAI>[0];
  const openai = anthropicResponseToOpenAI(resp);
  const usage = openai.usage as unknown as { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  // Source true total = input_tokens + cache_creation + cache_read + output_tokens.
  assert.equal(usage.prompt_tokens, 25 + 100 + 1024, 'prompt_tokens = total input');
  assert.equal(usage.completion_tokens, 150);
  assert.equal(usage.total_tokens, 25 + 100 + 1024 + 150, 'translated total = source true total');
});

// --- (d) ESTIMATE fallback reports cacheHitInput = 0 ----------------------

test('estimateTurnUsage reports cacheHitInput = 0 and total = input + output', () => {
  const est = estimateTurnUsage([{ role: 'user', content: 'hello world, this is some history text' }], 'some model output', []);
  assert.equal(est.cacheHitInput, 0, 'the estimate path never fabricates cache-hit input');
  assert.equal(est.total, est.input + est.output, 'estimate total is unchanged (base + output)');
  assert.ok(est.input > 0, 'the estimate still produces a non-zero input mass');
  assert.ok(est.output > 0, 'the estimate still produces a non-zero output mass');
});

// --- (e) COLLECTOR: totalCacheHitInputTokens (global + per-tool) ---------

function turnUsage(overrides: Partial<TurnUsageEvent> = {}): TurnUsageEvent {
  const base: TurnUsageEvent = { type: 'turn.usage', sessionKey: 'sess-1', tokens: { input: 100, output: 50, total: 150, cacheHitInput: 0 }, at: AT };
  return { ...base, ...overrides };
}

function toolCall(overrides: Partial<ToolCallEvent> = {}): ToolCallEvent {
  const base: ToolCallEvent = { type: 'tool.call', sessionKey: 'sess-1', toolName: 'bash', at: AT };
  return { ...base, ...overrides };
}

test('collector sums totalCacheHitInputTokens across distinct turns (global + per-tool)', async () => {
  const bus = createEventBus();
  const collector = createCollector({ bus });

  // Two calls share one response turn (same sessionKey + at) and repeat identical tokens,
  // so the turn's cache-hit mass is counted once, not twice.
  await bus.emit(toolCall({ toolName: 'bash', tokens: { input: 1000, output: 50, total: 2074, cacheHitInput: 1024 } }));
  await bus.emit(toolCall({ toolName: 'read', tokens: { input: 1000, output: 50, total: 2074, cacheHitInput: 1024 } }));

  let s = collector.summary();
  assert.equal(s.totalCacheHitInputTokens, 1024, 'global cache-hit summed once for the turn');
  assert.equal(s.totalInputTokens, 1000);
  assert.equal(s.totalTokens, 2074);

  // A second, distinct turn accumulates additively.
  await bus.emit(toolCall({ toolName: 'bash', sessionKey: 'sess-2', at: AT + 1, tokens: { input: 200, output: 40, total: 390, cacheHitInput: 150 } }));
  s = collector.summary();
  assert.equal(s.totalCacheHitInputTokens, 1174, '1024 + 150 across the two distinct turns');
  assert.equal(s.totalInputTokens, 1200);
  assert.equal(s.totalTokens, 2464);

  // Per-tool: bash's distinct turns contribute 1024 + 150 = 1174; read's single turn contributes 1024.
  const top = collector.getTopTools();
  const bash = top.find((t) => t.toolName === 'bash');
  const read = top.find((t) => t.toolName === 'read');
  assert.ok(bash && read);
  assert.equal(bash.totalCacheHitInputTokens, 1174);
  assert.equal(read.totalCacheHitInputTokens, 1024);
});

test('collector: whole-turn turn.usage cacheHitInput is deduped per turn and summed globally', async () => {
  const bus = createEventBus();
  const collector = createCollector({ bus });

  // A turn carrying BOTH a tool.call (with tokens) and a whole-turn turn.usage contributes exactly once.
  await bus.emit(toolCall({ toolName: 'bash', tokens: { input: 100, output: 50, total: 250, cacheHitInput: 100 } }));
  await bus.emit(turnUsage({ tokens: { input: 100, output: 50, total: 250, cacheHitInput: 100 } }));

  const s = collector.summary();
  assert.equal(s.totalInputTokens, 100, 'deduped to a single turn');
  assert.equal(s.totalCacheHitInputTokens, 100, 'cache-hit deduped to a single turn');

  const topBash = collector.getTopTools().find((t) => t.toolName === 'bash');
  assert.ok(topBash);
  assert.equal(topBash.totalCacheHitInputTokens, 100, 'per-tool cache-hit counted once for the turn');
});

test('collector: a token-less turn records no cache-hit mass (totalCacheHitInputTokens undefined)', async () => {
  const bus = createEventBus();
  const collector = createCollector({ bus });
  await bus.emit(toolCall({ toolName: 'bash' }));
  await bus.emit(toolResult({ toolName: 'bash' }));
  const s = collector.summary();
  assert.equal(s.totalCacheHitInputTokens, undefined, 'no cache-hit mass without any token usage');
});

function toolResult(overrides: Partial<ToolResultEvent> = {}): ToolResultEvent {
  const base: ToolResultEvent = { type: 'tool.result', sessionKey: 'sess-1', toolName: 'bash', ok: true, at: AT };
  return { ...base, ...overrides };
}
