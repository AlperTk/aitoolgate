import { test } from 'node:test';
import assert from 'node:assert/strict';
import { syncResponseBody } from '../src/proxy/translate';
import type { ResponseContext } from '../src/ports/pipeline';
import type { ToolCall } from '../src/ports/domain';
import { createOpenAIChatProtocol } from '../src/protocols/openai-chat';
import { createAnthropicMessagesProtocol } from '../src/protocols/anthropic-messages';

const openai = createOpenAIChatProtocol();
const anthropic = createAnthropicMessagesProtocol();

function ctxFor(raw: unknown, toolCalls: ToolCall[], content = 'hi'): ResponseContext {
  return { toolCalls, content, raw } as unknown as ResponseContext;
}

function openaiBody(): Record<string, unknown> {
  return {
    id: 'chatcmpl-1',
    model: 'gpt-4o-mini',
    choices: [
      {
        index: 0,
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: 'calling',
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } }],
        },
      },
    ],
  };
}

function anthropicBody(): Record<string, unknown> {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude',
    content: [
      { type: 'text', text: 'calling' },
      { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'Paris' } },
    ],
    stop_reason: 'tool_use',
  };
}

test('unchanged view leaves an OpenAI body untouched (same reference, same content)', () => {
  const raw = openaiBody();
  const snapshot = structuredClone(raw);
  syncResponseBody(ctxFor(raw, []));
  assert.deepEqual(raw, snapshot);
});

test('unchanged view leaves an Anthropic body untouched (same reference, same content)', () => {
  const raw = anthropicBody();
  const snapshot = structuredClone(raw);
  syncResponseBody(ctxFor(raw, []));
  assert.deepEqual(raw, snapshot);
});

test('OpenAI applyToolCalls returns a copy with rewritten tool_calls on the message', () => {
  const raw = openaiBody();
  const updated = openai.applyToolCalls(raw, [{ id: 'call_2', name: 'search', arguments: { q: 'x' } }]) as Record<string, unknown>;
  assert.notEqual(updated, raw);
  const message = (updated.choices as Record<string, unknown>[])[0].message as Record<string, unknown>;
  assert.deepEqual(message.tool_calls, [
    { id: 'call_2', type: 'function', function: { name: 'search', arguments: '{"q":"x"}' } },
  ]);
});

test('OpenAI applyToolCalls with no calls deletes tool_calls on the copy', () => {
  const raw = openaiBody();
  const updated = openai.applyToolCalls(raw, []) as Record<string, unknown>;
  const message = (updated.choices as Record<string, unknown>[])[0].message as Record<string, unknown>;
  assert.equal('tool_calls' in message, false);
});

test('Anthropic applyToolCalls returns a copy keeping text blocks and replacing tool_use blocks', () => {
  const raw = anthropicBody();
  const updated = anthropic.applyToolCalls(raw, [{ id: 'toolu_2', name: 'search', arguments: { q: 'x' } }]) as Record<string, unknown>;
  assert.notEqual(updated, raw);
  assert.deepEqual(updated.content, [
    { type: 'text', text: 'calling' },
    { type: 'tool_use', id: 'toolu_2', name: 'search', input: { q: 'x' } },
  ]);
});

test('applyToolCalls never mutates its input body (OpenAI and Anthropic)', () => {
  const rawO = openaiBody();
  const snapO = structuredClone(rawO);
  const outO = openai.applyToolCalls(rawO, [{ id: 'call_4', name: 'search', arguments: { q: 'y' } }]) as Record<string, unknown>;
  assert.deepEqual(rawO, snapO);
  const messageO = (outO.choices as Record<string, unknown>[])[0].message as Record<string, unknown>;
  assert.deepEqual(messageO.tool_calls, [
    { id: 'call_4', type: 'function', function: { name: 'search', arguments: '{"q":"y"}' } },
  ]);

  const rawA = anthropicBody();
  const snapA = structuredClone(rawA);
  const outA = anthropic.applyToolCalls(rawA, [{ id: 'toolu_4', name: 'search', arguments: { q: 'y' } }]) as Record<string, unknown>;
  assert.deepEqual(rawA, snapA);
  assert.deepEqual(outA.content, [
    { type: 'text', text: 'calling' },
    { type: 'tool_use', id: 'toolu_4', name: 'search', input: { q: 'y' } },
  ]);
});

test('applyToolCalls returns undefined for the other protocol shape', () => {
  assert.equal(openai.applyToolCalls(anthropicBody(), []), undefined);
  assert.equal(anthropic.applyToolCalls(openaiBody(), []), undefined);
});

test('syncResponseBody rewrites an OpenAI body when tool calls changed', () => {
  const ctx = ctxFor(openaiBody(), [{ id: 'call_3', name: 'lookup', arguments: { id: 7 } }]);
  syncResponseBody(ctx);
  const message = ((ctx.raw as Record<string, unknown>).choices as Record<string, unknown>[])[0].message as Record<string, unknown>;
  assert.deepEqual(message.tool_calls, [
    { id: 'call_3', type: 'function', function: { name: 'lookup', arguments: '{"id":7}' } },
  ]);
});

test('syncResponseBody rewrites an Anthropic body when tool calls changed', () => {
  const ctx = ctxFor(anthropicBody(), [{ id: 'toolu_3', name: 'lookup', arguments: { id: 7 } }]);
  syncResponseBody(ctx);
  assert.deepEqual((ctx.raw as Record<string, unknown>).content, [
    { type: 'text', text: 'calling' },
    { type: 'tool_use', id: 'toolu_3', name: 'lookup', input: { id: 7 } },
  ]);
});

test('syncResponseBody ignores non-record raw bodies', () => {
  assert.doesNotThrow(() => syncResponseBody(ctxFor('not-json', [])));
});
