import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createSseToolCallExtractor } from '../src/telemetry/stream-extract';

// Event-level telemetry behaviour of the SSE tap: args, cache-preserving usage, and non-throwing emission.

type Emitted = { type: string; [key: string]: unknown };

const anthropicSse = [
  'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":25,"cache_creation_input_tokens":10,"cache_read_input_tokens":5,"output_tokens":1}}}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"get_weather","input":{}}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"city\\":"}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\\"Paris\\"}"}}\n\n',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":42}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
].join('');

async function run(chunks: string[], bus: { emit(event: Emitted): unknown }): Promise<string> {
  const transform = createSseToolCallExtractor(bus, 'telemetry-events', undefined, undefined, () => 1_700_000_000_000);
  const out: string[] = [];
  transform.on('data', (c: Buffer | string) => out.push(c.toString()));
  const done = once(transform, 'end');
  for (const chunk of chunks) transform.write(chunk);
  transform.end();
  await done;
  return out.join('');
}

const splitChunks = (text: string, size = 9): string[] => {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
};

describe('telemetry events: anthropic tap', () => {
  it('tool.call carries the input_json_delta arguments', async () => {
    const emitted: Emitted[] = [];
    await run(splitChunks(anthropicSse), { emit: (e) => void emitted.push(e) });
    const call = emitted.find((e) => e.type === 'tool.call');
    assert.deepStrictEqual(call?.args, { city: 'Paris' });
  });

  it('message_delta without cache fields keeps the cache-hit value from message_start', async () => {
    const emitted: Emitted[] = [];
    await run(splitChunks(anthropicSse), { emit: (e) => void emitted.push(e) });
    const usage = emitted.find((e) => e.type === 'turn.usage')?.tokens;
    assert.deepStrictEqual(usage, { input: 35, output: 42, cacheHitInput: 5, total: 82 });
  });
});

describe('telemetry events: failure isolation', () => {
  it('a throwing bus never alters or breaks the forwarded bytes', async () => {
    const bus = {
      emit(): unknown {
        throw new Error('bus down');
      },
    };
    const forwarded = await run(splitChunks(anthropicSse), bus);
    assert.equal(forwarded, anthropicSse);
  });

  it('a bus returning a rejected promise is swallowed', async () => {
    const bus = {
      emit(): unknown {
        return Promise.reject(new Error('async bus down'));
      },
    };
    const forwarded = await run(splitChunks(anthropicSse), bus);
    assert.equal(forwarded, anthropicSse);
  });
});
