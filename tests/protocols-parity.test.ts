import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { convertResponse, reencodeRequest } from '../src/proxy/translate';
import type {
  AnthropicRequest,
  AnthropicResponse,
  AnthropicTool,
  OpenAIChatRequest,
  OpenAIChatResponse,
} from '../src/proxy/types';
import { createOpenAIChatProtocol } from '../src/protocols/openai-chat';
import { createAnthropicMessagesProtocol } from '../src/protocols/anthropic-messages';

// translate.ts is the oracle: new protocol-path output must deep-equal its output for the same input.

const openai = createOpenAIChatProtocol();
const anthropic = createAnthropicMessagesProtocol();
const FIXED_NOW_MS = 1_700_000_000_000;

interface Case {
  name: string;
  input: Record<string, unknown>;
  skip?: string;
}

function runCases(cases: Case[], oracle: (input: Record<string, unknown>) => unknown, actual: (input: Record<string, unknown>) => unknown): void {
  for (const c of cases) {
    it(c.name, c.skip !== undefined ? { skip: c.skip } : {}, () => {
      assert.deepStrictEqual(actual(c.input), oracle(c.input));
    });
  }
}

const required = <T>(value: T | undefined): T => {
  assert.notEqual(value, undefined, 'protocol decode returned undefined');
  return value as T;
};


describe('parity: anthropic -> openai request (anthropic.decodeRequest -> openai.encodeRequest)', () => {
  const weatherTool = { name: 'weather', description: 'get weather', input_schema: { type: 'object', properties: { city: { type: 'string' } } } };
  const cases: Case[] = [
    {
      name: 'plain text user message with system prompt',
      input: { model: 'claude-x', max_tokens: 256, system: 'be brief', messages: [{ role: 'user', content: 'hello' }] },
    },
    {
      name: 'multi-part text blocks with sampling params',
      input: {
        model: 'claude-x',
        max_tokens: 256,
        temperature: 0.2,
        top_p: 0.9,
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] },
          { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
        ],
      },
    },
    {
      name: 'assistant text plus tool call with args',
      input: {
        model: 'claude-x',
        max_tokens: 256,
        messages: [
          { role: 'user', content: 'weather?' },
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'checking' },
              { type: 'tool_use', id: 'tu1', name: 'weather', input: { city: 'Oslo' } },
            ],
          },
        ],
        tools: [weatherTool],
      },
    },
    {
      name: 'tool result with string content',
      input: {
        model: 'claude-x',
        max_tokens: 256,
        messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'sunny' }] }],
      },
    },
    {
      name: 'tool result with text-block content followed by user text',
      input: {
        model: 'claude-x',
        max_tokens: 256,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'tu1', content: [{ type: 'text', text: 'sun' }, { type: 'text', text: 'ny' }] },
              { type: 'text', text: 'thanks' },
            ],
          },
        ],
      },
    },
    {
      name: 'multiple tool calls in one assistant turn',
      input: {
        model: 'claude-x',
        max_tokens: 256,
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'tool_use', id: 'tu1', name: 'weather', input: { city: 'Oslo' } },
              { type: 'tool_use', id: 'tu2', name: 'weather', input: { city: 'Rome' } },
            ],
          },
        ],
      },
    },
    {
      name: 'thinking and redacted_thinking blocks are dropped',
      input: {
        model: 'claude-x',
        max_tokens: 256,
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'hmm', signature: 'sig' },
              { type: 'redacted_thinking', data: 'opaque' },
              { type: 'text', text: 'answer' },
            ],
          },
        ],
      },
    },
    {
      name: 'tool without input_schema defaults schema and empty description is omitted',
      input: {
        model: 'claude-x',
        max_tokens: 256,
        messages: [{ role: 'user', content: 'ping' }],
        tools: [{ name: 'ping' }, { name: 'calc', description: '', input_schema: { type: 'object', properties: {} } }] as unknown as AnthropicTool[],
      },
    },
    {
      name: 'tool_choice present',
      input: { model: 'claude-x', max_tokens: 256, tool_choice: { type: 'auto' }, messages: [{ role: 'user', content: 'hi' }] },
    },
    {
      name: 'empty assistant text (content array empty)',
      input: { model: 'claude-x', max_tokens: 256, messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: [] }] },
    },
  ];
  runCases(
    cases,
    (input) => reencodeRequest('anthropic-messages', 'openai-chat', input as unknown as AnthropicRequest),
    (input) => openai.encodeRequest(required(anthropic.decodeRequest(input))),
  );
});

describe('parity: openai -> anthropic request (openai.decodeRequest -> anthropic.encodeRequest)', () => {
  it('plain text user message with system prompt keeps string form via translate export', () => {
    const wire = reencodeRequest('openai-chat', 'anthropic-messages', {
      model: 'claude-x',
      messages: [{ role: 'system', content: 'be brief' }, { role: 'user', content: 'hello' }],
    } as unknown as OpenAIChatRequest) as AnthropicRequest;
    assert.equal(wire.system, 'be brief');
    assert.deepStrictEqual(wire.messages, [{ role: 'user', content: 'hello' }]);
  });
  const cases: Case[] = [
    {
      name: 'assistant tool call with args and no text',
      input: {
        model: 'claude-x',
        messages: [
          {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'c1', type: 'function', function: { name: 'weather', arguments: '{"city":"Oslo"}' } }],
          },
        ],
      },
    },
    {
      name: 'system prompt with tool result after tool call',
      input: {
        model: 'claude-x',
        max_tokens: 512,
        messages: [
          { role: 'system', content: 'sys' },
          {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'c1', type: 'function', function: { name: 'weather', arguments: '{"city":"Oslo"}' } }],
          },
          { role: 'tool', tool_call_id: 'c1', content: 'sunny' },
        ],
      },
    },
    {
      name: 'multiple tool calls in one assistant turn',
      input: {
        model: 'claude-x',
        messages: [
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              { id: 'c1', type: 'function', function: { name: 'weather', arguments: '{"city":"Oslo"}' } },
              { id: 'c2', type: 'function', function: { name: 'weather', arguments: '{"city":"Rome"}' } },
            ],
          },
        ],
      },
    },
    {
      name: 'reasoning_content ignored; tool defaults applied and empty description omitted',
      input: {
        model: 'claude-x',
        messages: [
          {
            role: 'assistant',
            content: null,
            reasoning_content: 'thinking...',
            tool_calls: [{ id: 'c1', type: 'function', function: { name: 'ping', arguments: '{}' } }],
          },
        ],
        tools: [
          { type: 'function', function: { name: 'ping' } },
          { type: 'function', function: { name: 'calc', description: '', parameters: { type: 'object', properties: {} } } },
        ],
      },
    },
    {
      name: 'tool_choice present',
      input: {
        model: 'claude-x',
        tool_choice: 'auto',
        messages: [
          {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'c1', type: 'function', function: { name: 'ping', arguments: '{}' } }],
          },
        ],
      },
    },
    {
      name: 'empty assistant message',
      input: { model: 'claude-x', messages: [{ role: 'assistant', content: null }] },
    },
  ];
  runCases(
    cases,
    (input) => reencodeRequest('openai-chat', 'anthropic-messages', input as unknown as OpenAIChatRequest),
    (input) => anthropic.encodeRequest(required(openai.decodeRequest(input))),
  );
});

describe('parity: openai -> anthropic response (openai.decodeResponse -> anthropic.encodeResponse)', () => {
  beforeEach(() => {
    mock.method(Date, 'now', () => FIXED_NOW_MS);
  });
  afterEach(() => {
    mock.restoreAll();
  });
  const cases: Case[] = [
    {
      name: 'plain text with usage',
      input: {
        id: 'chatcmpl-1',
        object: 'chat.completion',
        created: 1,
        model: 'gpt-x',
        choices: [{ index: 0, message: { role: 'assistant', content: 'hi there' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
    },
    {
      name: 'tool call with args',
      input: {
        id: 'chatcmpl-2',
        object: 'chat.completion',
        created: 1,
        model: 'gpt-x',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{ id: 'c1', type: 'function', function: { name: 'weather', arguments: '{"city":"Oslo"}' } }],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
    },
    {
      name: 'text plus multiple tool calls',
      input: {
        id: 'chatcmpl-3',
        object: 'chat.completion',
        created: 1,
        model: 'gpt-x',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: 'let me check',
              tool_calls: [
                { id: 'c1', type: 'function', function: { name: 'weather', arguments: '{"city":"Oslo"}' } },
                { id: 'c2', type: 'function', function: { name: 'weather', arguments: '{"city":"Rome"}' } },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
    },
    {
      name: 'cached prompt tokens are split from base input',
      input: {
        id: 'chatcmpl-4',
        object: 'chat.completion',
        created: 1,
        model: 'gpt-x',
        choices: [{ index: 0, message: { role: 'assistant', content: 'cached' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, prompt_tokens_details: { cached_tokens: 4 } },
      },
    },
    {
      name: 'empty text with no tool calls falls back to empty text block',
      input: {
        id: 'chatcmpl-5',
        object: 'chat.completion',
        created: 1,
        model: 'gpt-x',
        choices: [{ index: 0, message: { role: 'assistant', content: null }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 0, total_tokens: 3 },
      },
    },
    {
      name: 'reasoning_content is ignored',
      input: {
        id: 'chatcmpl-6',
        object: 'chat.completion',
        created: 1,
        model: 'gpt-x',
        choices: [{ index: 0, message: { role: 'assistant', content: 'answer', reasoning_content: 'thinking...' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
    },
    {
      name: 'finish_reason length maps to max_tokens',
      input: {
        id: 'chatcmpl-7',
        object: 'chat.completion',
        created: 1,
        model: 'gpt-x',
        choices: [{ index: 0, message: { role: 'assistant', content: 'cut' }, finish_reason: 'length' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
    },
    {
      name: 'finish_reason content_filter maps to refusal',
      input: {
        id: 'chatcmpl-8',
        object: 'chat.completion',
        created: 1,
        model: 'gpt-x',
        choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'content_filter' }],
        usage: { prompt_tokens: 10, completion_tokens: 0, total_tokens: 10 },
      },
    },
    {
      name: 'response without usage',
      input: {
        id: 'chatcmpl-9',
        object: 'chat.completion',
        created: 1,
        model: 'gpt-x',
        choices: [{ index: 0, message: { role: 'assistant', content: 'no usage' }, finish_reason: 'stop' }],
      },
    },
  ];
  runCases(
    cases,
    (input) => convertResponse('openai-chat', 'anthropic-messages', input as unknown as OpenAIChatResponse),
    (input) => anthropic.encodeResponse(required(openai.decodeResponse(input))),
  );
});

describe('parity: anthropic -> openai response (anthropic.decodeResponse -> openai.encodeResponse)', () => {
  beforeEach(() => {
    mock.method(Date, 'now', () => FIXED_NOW_MS);
  });
  afterEach(() => {
    mock.restoreAll();
  });
  const cases: Case[] = [
    {
      name: 'plain text with usage',
      input: {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-x',
        content: [{ type: 'text', text: 'hi' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    },
    {
      name: 'text plus tool_use with args',
      input: {
        id: 'msg_2',
        type: 'message',
        role: 'assistant',
        model: 'claude-x',
        content: [
          { type: 'text', text: 'checking' },
          { type: 'tool_use', id: 'tu1', name: 'weather', input: { city: 'Oslo' } },
        ],
        stop_reason: 'tool_use',
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    },
    {
      name: 'multiple tool_use blocks',
      input: {
        id: 'msg_3',
        type: 'message',
        role: 'assistant',
        model: 'claude-x',
        content: [
          { type: 'tool_use', id: 'tu1', name: 'weather', input: { city: 'Oslo' } },
          { type: 'tool_use', id: 'tu2', name: 'weather', input: { city: 'Rome' } },
        ],
        stop_reason: 'tool_use',
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    },
    {
      name: 'cache_read tokens become cached prompt tokens',
      input: {
        id: 'msg_4',
        type: 'message',
        role: 'assistant',
        model: 'claude-x',
        content: [{ type: 'text', text: 'cached' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 6, output_tokens: 5, cache_read_input_tokens: 4 },
      },
    },
    {
      name: 'cache_creation tokens fold into input',
      input: {
        id: 'msg_5',
        type: 'message',
        role: 'assistant',
        model: 'claude-x',
        content: [{ type: 'text', text: 'written' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 6, output_tokens: 5, cache_creation_input_tokens: 2 },
      },
    },
    {
      name: 'thinking block is dropped',
      input: {
        id: 'msg_6',
        type: 'message',
        role: 'assistant',
        model: 'claude-x',
        content: [
          { type: 'thinking', thinking: 'hmm', signature: 'sig' },
          { type: 'text', text: 'answer' },
        ],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    },
    {
      name: 'empty content array yields null content',
      input: {
        id: 'msg_7',
        type: 'message',
        role: 'assistant',
        model: 'claude-x',
        content: [],
        stop_reason: 'end_turn',
        usage: { input_tokens: 3, output_tokens: 0 },
      },
    },
    {
      name: 'single empty text block yields empty-string content',
      input: {
        id: 'msg_8',
        type: 'message',
        role: 'assistant',
        model: 'claude-x',
        content: [{ type: 'text', text: '' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 3, output_tokens: 0 },
      },
    },
    {
      name: 'stop_reason max_tokens maps to length',
      input: {
        id: 'msg_9',
        type: 'message',
        role: 'assistant',
        model: 'claude-x',
        content: [{ type: 'text', text: 'cut' }],
        stop_reason: 'max_tokens',
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    },
    {
      name: 'stop_reason refusal maps to content_filter',
      input: {
        id: 'msg_10',
        type: 'message',
        role: 'assistant',
        model: 'claude-x',
        content: [{ type: 'text', text: 'no' }],
        stop_reason: 'refusal',
        usage: { input_tokens: 10, output_tokens: 1 },
      },
    },
    {
      name: 'stop_sequence maps to stop',
      input: {
        id: 'msg_11',
        type: 'message',
        role: 'assistant',
        model: 'claude-x',
        content: [{ type: 'text', text: 'seq' }],
        stop_reason: 'stop_sequence',
        usage: { input_tokens: 10, output_tokens: 1 },
      },
    },
    {
      name: 'response without usage',
      input: {
        id: 'msg_12',
        type: 'message',
        role: 'assistant',
        model: 'claude-x',
        content: [{ type: 'text', text: 'no usage' }],
        stop_reason: 'end_turn',
      },
    },
  ];
  runCases(
    cases,
    (input) => convertResponse('anthropic-messages', 'openai-chat', input as unknown as AnthropicResponse),
    (input) => openai.encodeResponse(required(anthropic.decodeResponse(input))),
  );
});

describe('malformed upstream responses: translate exports keep id/model/usage (protocol-owned)', () => {
  beforeEach(() => {
    mock.method(Date, 'now', () => FIXED_NOW_MS);
  });
  afterEach(() => {
    mock.restoreAll();
  });

  it('openai response without choices keeps HEAD id/model/usage and empty text block', () => {
    const out = convertResponse('openai-chat', 'anthropic-messages', {
      id: 'chatcmpl-m1',
      object: 'chat.completion',
      model: 'gpt-x',
      usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
    } as unknown as OpenAIChatResponse);
    assert.deepStrictEqual(out, {
      id: 'chatcmpl-m1',
      type: 'message',
      role: 'assistant',
      model: 'gpt-x',
      content: [{ type: 'text', text: '' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 3, output_tokens: 1 },
    });
  });

  it('openai response with empty choices and no usage yields zero usage', () => {
    const out = convertResponse('openai-chat', 'anthropic-messages', { id: 'chatcmpl-m2', choices: [] } as unknown as OpenAIChatResponse);
    assert.deepStrictEqual(out, {
      id: 'chatcmpl-m2',
      type: 'message',
      role: 'assistant',
      model: undefined,
      content: [{ type: 'text', text: '' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 0, output_tokens: 0 },
    });
  });

  it('anthropic response without content yields null content and created from Date.now', () => {
    const out = convertResponse('anthropic-messages', 'openai-chat', {
      id: 'msg_m1',
      type: 'message',
      role: 'assistant',
      model: 'claude-x',
      stop_reason: 'end_turn',
      usage: { input_tokens: 2, output_tokens: 1 },
    } as unknown as AnthropicResponse);
    assert.deepStrictEqual(out, {
      id: 'msg_m1',
      object: 'chat.completion',
      created: 1_700_000_000,
      model: 'claude-x',
      choices: [{ index: 0, message: { role: 'assistant', content: null }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
    });
  });

  it('anthropic response with empty content array yields null content', () => {
    const out = convertResponse('anthropic-messages', 'openai-chat', {
      id: 'msg_m2',
      type: 'message',
      role: 'assistant',
      model: 'claude-x',
      content: [],
      stop_reason: 'end_turn',
      usage: { input_tokens: 2, output_tokens: 0 },
    } as unknown as AnthropicResponse);
    assert.deepStrictEqual(out, {
      id: 'msg_m2',
      object: 'chat.completion',
      created: 1_700_000_000,
      model: 'claude-x',
      choices: [{ index: 0, message: { role: 'assistant', content: null }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 2, completion_tokens: 0, total_tokens: 2 },
    });
  });

  it('openai response with content but missing usage yields zero usage', () => {
    const out = convertResponse('openai-chat', 'anthropic-messages', {
      id: 'chatcmpl-m3',
      object: 'chat.completion',
      model: 'gpt-x',
      choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
    } as unknown as OpenAIChatResponse);
    assert.deepStrictEqual(out, {
      id: 'chatcmpl-m3',
      type: 'message',
      role: 'assistant',
      model: 'gpt-x',
      content: [{ type: 'text', text: 'hi' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 0, output_tokens: 0 },
    });
  });
});
