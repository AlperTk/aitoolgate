/**
 * Session context (system prompt + client tool definitions): the proxy-side extraction for
 * OpenAI Chat and Anthropic Messages requests, and the dashboard's per-session latest-context
 * state rendered in the details panel (escaped text, empty state, no cross-session leakage).
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDomStub } from './dom-stub';
import { extractSessionContext } from '../src/proxy/context';

const base = '../..' + '/dashboard';

let M: { ingest: any; lv: any };
before(async () => {
  createDomStub();
  const ingest = await import(base + '/js/ingest.mjs');
  const lv = await import(base + '/js/live-view.mjs');
  M = { ingest, lv };
});

test('OpenAI: system messages and tools extracted from the raw client request', () => {
  const out = extractSessionContext({
    messages: [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'hi' },
      { role: 'system', content: [{ type: 'text', text: 'Be brief.' }] },
    ],
    tools: [{ type: 'function', function: { name: 'read', parameters: { type: 'object' } } }],
  });
  assert.equal(out.systemPrompt, 'You are helpful.\n\nBe brief.');
  assert.deepEqual(out.tools, [{ type: 'function', function: { name: 'read', parameters: { type: 'object' } } }]);
});

test('Anthropic: top-level system (string or text blocks) and tools extracted', () => {
  const str = extractSessionContext({ system: 'Sys prompt', messages: [], tools: [{ name: 't1', input_schema: {} }] });
  assert.equal(str.systemPrompt, 'Sys prompt');
  assert.equal(str.tools.length, 1);
  const blocks = extractSessionContext({
    system: [{ type: 'text', text: 'A', cache_control: { type: 'ephemeral' } }, { type: 'text', text: 'B' }],
  });
  assert.equal(blocks.systemPrompt, 'A\nB');
  assert.deepEqual(blocks.tools, []);
});

test('absent system/tools and non-object bodies yield empty context', () => {
  assert.deepEqual(extractSessionContext({ messages: [{ role: 'user', content: 'x' }] }), { systemPrompt: '', tools: [] });
  assert.deepEqual(extractSessionContext(null), { systemPrompt: '', tools: [] });
});

test('dashboard: details show only the session’s latest context, escaped, with empty state', () => {
  const { ingest, lv } = M;
  ingest.ingestEvent({ type: 'session.context', sessionKey: 'A', systemPrompt: 'old A', tools: [], at: 1 });
  ingest.ingestEvent({ type: 'session.context', sessionKey: 'A', systemPrompt: '<img src=x onerror=alert(1)>', tools: [{ name: 'shell' }], at: 2 });
  ingest.ingestEvent({ type: 'session.context', sessionKey: 'B', systemPrompt: 'B secret', tools: [], at: 3 });
  // A stale replay (older at) must not overwrite the latest A context.
  ingest.ingestEvent({ type: 'session.context', sessionKey: 'A', systemPrompt: 'stale A', tools: [], at: 0 });

  // Call Details no longer duplicate the session context (it lives on the session group).
  const callA = lv.buildDetailsPanel({ callEv: { type: 'tool.call', sessionKey: 'A', toolName: 'x', at: 5 } });
  assert.ok(!callA.includes('img src'));
  assert.ok(!callA.includes('shell'));

  const htmlA = lv.buildSessionContextHtml('A');
  assert.ok(htmlA.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(!htmlA.includes('<img'));
  assert.ok(htmlA.includes('shell'));
  assert.ok(!htmlA.includes('B secret'));
  assert.ok(!htmlA.includes('stale A'));
  assert.ok(!htmlA.includes('old A'));

  // Compact by default: every disclosure is closed, full content still present inside it.
  assert.ok(htmlA.includes('<details class="ctx-disclosure">'));
  assert.ok(!/<details[^>]*\bopen\b/.test(htmlA));
  assert.ok(htmlA.includes('<summary class="small">shell</summary>'));

  const htmlB = lv.buildSessionContextHtml('B');
  assert.ok(htmlB.includes('B secret'));
  assert.ok(htmlB.includes('No tools in the latest request'));
  assert.ok(!htmlB.includes('img src'));

  ingest.ingestEvent({ type: 'session.context', sessionKey: 'C', systemPrompt: '', tools: [], at: 9 });
  const htmlC = lv.buildSessionContextHtml('C');
  assert.ok(htmlC.includes('No system prompt in the latest request'));
  assert.ok(htmlC.includes('No tools in the latest request'));
  assert.equal(lv.buildSessionContextHtml('no-such-session'), '');
});
