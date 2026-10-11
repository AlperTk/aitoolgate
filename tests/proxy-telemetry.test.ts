import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type http from 'node:http';
import { createProxyHandler } from '../src/proxy/index';
import type { UpstreamClient } from '../src/proxy/upstream';
import { makeMockFetch } from './helpers';
import { createSqliteStorage } from '../src/storage/sqlite';
import { flagshipLoopRule } from '../src/policy/ruleEngine';


/** Minimal ServerResponse-shaped sink capturing status + body for inspection. */
interface MockResponse extends http.ServerResponse {
  status: number;
  body: string;
}

function makeResponse(): MockResponse {
  const res = {
    status: 0,
    body: '',
    writeHead(status: number) {
      res.status = status;
    },
    end(chunk?: unknown) {
      res.body += chunk == null ? '' : String(chunk);
    },
  };
  return res as unknown as MockResponse;
}

/**
 * A minimal IncomingMessage: an EventEmitter (so `readJSONBody`'s data/end
 * listeners work) with the fields the route handler reads. Callers emit the
 * body via `send()` AFTER invoking the handler, so the listener is registered
 * first (mirrors real HTTP framing).
 */
function makeRequest(url: string, body: unknown): { req: http.IncomingMessage; send: () => void } {
  // An explicit `any` event emitter lets us attach the minimal IncomingMessage
  // fields without asserting on every required Node property.
  const emitter: any = new EventEmitter();
  emitter.method = 'POST';
  emitter.url = url;
  emitter.headers = { 'content-type': 'application/json', 'x-session-id': 'sess-1' };
  return {
    req: emitter as unknown as http.IncomingMessage,
    send: () => {
      emitter.emit('data', Buffer.from(JSON.stringify(body)));
      emitter.emit('end');
    },
  };
}

/** A request whose message history ENDS in a 4× identical tool-call loop. */
function buildLoopRequestBody(): Record<string, unknown> {
  const messages: unknown[] = [{ role: 'user', content: 'What is the weather in Paris?' }];
  for (let i = 0; i < 4; i += 1) {
    messages.push({
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: `call_${i}`, type: 'function', function: { name: 'get_weather', arguments: JSON.stringify({ city: 'Paris' }) } },
      ],
    });
    messages.push({ role: 'tool', tool_call_id: `call_${i}`, content: 'sunny 20°C' });
  }
  return { model: 'gpt-4o-mini', messages };
}

test('proxy with policy + telemetry exposes live aggregates and persists to sqlite', async () => {
  const storage = createSqliteStorage({ file: ':memory:' });
  try {
    // Upstream response returning two tool calls (drives `tool.call` events).
    const canned = {
      id: 'chatcmpl-tel',
      object: 'chat.completion',
      created: 1700000000,
      model: 'gpt-4o-mini',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              { id: 'resp_0', type: 'function', function: { name: 'get_weather', arguments: JSON.stringify({ city: 'Paris' }) } },
              { id: 'resp_1', type: 'function', function: { name: 'get_time', arguments: JSON.stringify({ tz: 'Europe/Paris' }) } },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
    };
    const upstream: UpstreamClient = {
      baseUrl: 'http://mock.test/v1',
      model: 'gpt-4o-mini',
      protocol: 'openai',
      fetchImpl: makeMockFetch(canned),
    };

    const handler = createProxyHandler({
      upstream,
      policy: { rules: [flagshipLoopRule()] },
      telemetry: { storage },
    });

    // The telemetry view is exposed on the handler (and only via it) when a
    // policy is configured; the call signature is unchanged.
    assert.ok(handler.telemetry, 'telemetry view should be present when a policy is configured');
    const tel = handler.telemetry;
    assert.equal(tel!.storage, storage, 'exposed storage is exactly the one we configured');
    assert.ok(tel!.collector, 'a live collector is attached to the bus');
    // Exposed as a NON-ENUMERABLE property so it does not leak into iteration.
    assert.equal(Object.prototype.propertyIsEnumerable.call(handler, 'telemetry'), false);

    // Send a request whose history ends in a 4-call loop; the upstream returns
    // tool calls. The flagship rule fires (intervention) and the response's
    // tool calls are observed (tool.call events).
    const { req, send } = makeRequest('/v1/chat/completions', buildLoopRequestBody());
    const res = makeResponse();
    const pending = handler(req, res);
    send();
    const handled = await pending;
    assert.equal(handled, true);
    assert.equal(res.status, 200);

    // Live collector aggregates read from the EXPOSED view.
    const summary = tel!.collector.summary();
    assert.ok(summary.totalCalls > 0, `expected tool calls in the collector, got ${summary.totalCalls}`);
    assert.ok(
      tel!.collector.getInterventions().length > 0,
      'expected at least one recorded intervention on the collector',
    );

    // The in-memory sqlite storage mirrors the collector (matching rows).
    const counts = storage.getCounts();
    assert.ok(counts.totalCalls > 0, 'storage should have persisted the tool calls');
    assert.equal(counts.totalCalls, summary.totalCalls, 'storage call count matches the collector');
    const storedInterventions = storage.getInterventions();
    assert.ok(storedInterventions.length > 0, 'storage should have persisted the interventions');
    assert.equal(
      storedInterventions.length,
      tel!.collector.getInterventions().length,
      'storage intervention count matches the collector',
    );
    assert.equal(storedInterventions[0].ruleId, 'flagship-loop-rule');
  } finally {
    storage.close();
  }
});

test('proxy WITHOUT policy exposes no .telemetry (behavior unchanged)', async () => {
  const upstream: UpstreamClient = {
    baseUrl: 'http://mock.test/v1',
    model: 'gpt-4o-mini',
    protocol: 'openai',
    fetchImpl: makeMockFetch({
      id: 'chatcmpl-none',
      object: 'chat.completion',
      created: 1700000000,
      model: 'gpt-4o-mini',
      choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
    }),
  };

  const handler = createProxyHandler({ upstream });
  assert.equal(handler.telemetry, undefined, 'no telemetry view without a policy');
  assert.equal(Object.prototype.hasOwnProperty.call(handler, 'telemetry'), false);

  // The handler still works exactly as before when telemetry is not requested.
  const { req, send } = makeRequest('/v1/chat/completions', {
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: 'hello' }],
  });
  const res = makeResponse();
  const pending = handler(req, res);
  send();
  const handled = await pending;
  assert.equal(handled, true);
  assert.equal(res.status, 200);
  assert.equal(handler.telemetry, undefined);
});
