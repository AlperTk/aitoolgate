import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  anthropicResponseToOpenAI,
  anthropicToOpenAIRequest,
  openaiResponseToAnthropic,
  openaiToAnthropicRequest,
} from '../src/proxy/translate';
import type { OpenAIChatRequest, OpenAIChatResponse } from '../src/proxy/types';

test('OpenAI → Anthropic → OpenAI round-trip preserves essential fields', () => {
  const original: OpenAIChatRequest = {
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Hello' },
      {
        role: 'assistant',
        content: 'Let me check the weather.',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'Sunny, 22C' },
    ],
    tools: [
      {
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Get the weather',
          parameters: { type: 'object', properties: { city: { type: 'string' } } },
        },
      },
    ],
  };

  const anthropic = openaiToAnthropicRequest(original);
  assert.equal(anthropic.model, 'gpt-4o-mini');
  assert.equal(anthropic.system, 'You are a helpful assistant.');
  assert.ok(anthropic.max_tokens);

  const roundTrip = anthropicToOpenAIRequest(anthropic);

  assert.equal(roundTrip.model, 'gpt-4o-mini');
  const systemMessage = roundTrip.messages.find((m) => m.role === 'system');
  assert.equal(systemMessage?.content, 'You are a helpful assistant.');

  const userMessage = roundTrip.messages.find((m) => m.role === 'user' && m.content === 'Hello');
  assert.ok(userMessage);

  const assistantMessage = roundTrip.messages.find((m) => m.role === 'assistant');
  assert.ok(assistantMessage?.tool_calls?.[0]);
  assert.equal(assistantMessage.tool_calls?.[0]?.id, 'call_1');
  assert.equal(assistantMessage.tool_calls?.[0]?.function.name, 'get_weather');
  assert.deepEqual(JSON.parse(assistantMessage.tool_calls?.[0]?.function.arguments ?? '{}'), {
    city: 'Paris',
  });

  const toolMessage = roundTrip.messages.find((m) => m.role === 'tool');
  assert.equal(toolMessage?.tool_call_id, 'call_1');
  assert.equal(toolMessage?.content, 'Sunny, 22C');

  assert.equal(roundTrip.tools?.[0]?.function.name, 'get_weather');
  assert.equal(roundTrip.tools?.[0]?.function.description, 'Get the weather');
  assert.deepEqual(roundTrip.tools?.[0]?.function.parameters, {
    type: 'object',
    properties: { city: { type: 'string' } },
  });
});

test('OpenAI response → Anthropic response → OpenAI response round-trip', () => {
  const openaiResponse: OpenAIChatResponse = {
    id: 'chatcmpl-1',
    object: 'chat.completion',
    created: 1,
    model: 'gpt-4o-mini',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: 'Hi',
          tool_calls: [
            {
              id: 'c1',
              type: 'function',
              function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
            },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };

  const anthropic = openaiResponseToAnthropic(openaiResponse);
  assert.equal(anthropic.type, 'message');
  assert.equal(anthropic.role, 'assistant');
  assert.equal(anthropic.stop_reason, 'tool_use');
  assert.equal(anthropic.usage.input_tokens, 10);
  assert.equal(anthropic.usage.output_tokens, 5);
  assert.ok(anthropic.content.some((b) => b.type === 'text' && b.text === 'Hi'));
  assert.ok(anthropic.content.some((b) => b.type === 'tool_use' && b.name === 'get_weather'));

  const back = anthropicResponseToOpenAI(anthropic);
  assert.equal(back.object, 'chat.completion');
  assert.equal(back.choices[0].finish_reason, 'tool_calls');
  assert.equal(back.usage?.prompt_tokens, 10);
  assert.equal(back.usage?.completion_tokens, 5);
  assert.equal(back.choices[0].message.tool_calls?.[0]?.function.name, 'get_weather');
  assert.deepEqual(
    JSON.parse(back.choices[0].message.tool_calls?.[0]?.function.arguments ?? '{}'),
    { city: 'Paris' },
  );
});
