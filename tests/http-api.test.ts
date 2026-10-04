import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import { createRuleStore } from '../src/api/ruleStore';
import type { RuleStore } from '../src/api/ruleStore';
import { createCollector } from '../src/telemetry/collector';
import type { Collector } from '../src/telemetry/collector';
import { createEventBus } from '../src/telemetry/event-bus';
import { createApiHandler } from '../src/api/http';
import type { RuleSpec } from '../src/api/ruleSpec';

/**
 * Each test boots a real HTTP server on an EPHEMERAL port (`listen(0)`) wrapping
 * the API handler with a fall-through 404 (mirroring how the server chains the
 * proxy). The server is always closed in `afterEach` so the event loop drains.
 */
let server: http.Server | undefined;
let base = '';

async function startServer(ruleStore: RuleStore, collector: Collector): Promise<string> {
  const handler = createApiHandler({ ruleStore, collector });
  const srv = http.createServer((req, res) => {
    void (async () => {
      const handled = await handler(req, res);
      if (!handled) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not_found' }));
      }
    })().catch(() => {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'internal_error' }));
      }
    });
  });
  await srv.listen(0); // ephemeral port — never hang on an un-listened helper
  const address = srv.address();
  if (address === null || typeof address === 'string') {
    throw new Error('server is not listening on a TCP port');
  }
  server = srv;
  base = `http://127.0.0.1:${address.port}`;
  return base;
}

async function closeServer(): Promise<void> {
  if (server === undefined) return;
  const srv = server;
  server = undefined;
  srv.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    srv.close((error) => (error ? reject(error) : resolve()));
  });
}

afterEach(async () => {
  await closeServer();
});

/** Post a valid spec and return its assigned id (also used as a setup helper). */
async function postRule(baseUrl: string, spec: RuleSpec): Promise<RuleSpec & { id: string }> {
  const res = await fetch(`${baseUrl}/api/rules`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(spec),
  });
  assert.equal(res.status, 201);
  const created = (await res.json()) as RuleSpec & { id: string };
  assert.ok(typeof created.id === 'string' && created.id.length > 0);
  return created;
}

const LOOP_INJECT_SPEC: RuleSpec = {
  enabled: true,
  matcher: { type: 'loop', window: 4 },
  action: { type: 'injectMessage', role: 'user', content: 'hi' },
};

test('GET /api/stats returns a summary-shaped object with numeric totals and arrays', async () => {
  const bus = createEventBus();
  const collector = createCollector({ bus }); // standalone, driven by our own bus
  const ruleStore = createRuleStore();
  const baseUrl = await startServer(ruleStore, collector);

  // Empty state: still the right shape.
  const first = await fetch(`${baseUrl}/api/stats`);
  assert.equal(first.status, 200);
  assert.match(first.headers.get('content-type') ?? '', /application\/json/);
  const empty = (await first.json()) as { totalCalls: number; totalResults: number; topTools: unknown[]; interventions: unknown[] };
  assert.equal(typeof empty.totalCalls, 'number');
  assert.equal(typeof empty.totalResults, 'number');
  assert.ok(Array.isArray(empty.topTools));
  assert.ok(Array.isArray(empty.interventions));

  // Seed some events through our own bus and confirm they aggregate.
  await bus.emit({ type: 'tool.call', sessionKey: 'k', toolName: 'bash', at: Date.now() });
  await bus.emit({ type: 'tool.call', sessionKey: 'k', toolName: 'bash', at: Date.now() });
  await bus.emit({ type: 'policy.intervention', sessionKey: 'k', ruleId: 'flagship-loop-rule', action: 'injectMessage', at: Date.now() });

  const second = await fetch(`${baseUrl}/api/stats`);
  assert.equal(second.status, 200);
  const filled = (await second.json()) as {
    totalCalls: number;
    topTools: { toolName: string; count: number }[];
    interventions: { ruleId: string }[];
  };
  assert.equal(filled.totalCalls, 2);
  assert.equal(filled.topTools.length, 1);
  assert.deepEqual(filled.topTools[0], { toolName: 'bash', count: 2 });
  assert.equal(filled.interventions.length, 1);
  assert.equal(filled.interventions[0].ruleId, 'flagship-loop-rule');
});

test('POST /api/rules creates a rule (201) with an id; GET /api/rules lists it (fidelity)', async () => {
  const baseUrl = await startServer(createRuleStore(), createCollector());

  const created = await postRule(baseUrl, LOOP_INJECT_SPEC);
  assert.equal(created.enabled, true);
  assert.deepEqual(created.matcher, { type: 'loop', window: 4 });
  assert.deepEqual(created.action, { type: 'injectMessage', role: 'user', content: 'hi' });

  const res = await fetch(`${baseUrl}/api/rules`);
  assert.equal(res.status, 200);
  const rules = (await res.json()) as RuleSpec[];
  assert.equal(rules.length, 1);
  assert.equal(rules[0].id, created.id);
  assert.equal(rules[0].enabled, true);
  // the stored spec round-trips exactly (not a lossy describeRule placeholder)
  assert.deepEqual(rules[0].matcher, { type: 'loop', window: 4 });
  assert.deepEqual(rules[0].action, { type: 'injectMessage', role: 'user', content: 'hi' });
});

test('PATCH /api/rules/{id} toggling enabled -> 200 and reflected in a subsequent GET', async () => {
  const baseUrl = await startServer(createRuleStore(), createCollector());
  const created = await postRule(baseUrl, LOOP_INJECT_SPEC);

  const patchRes = await fetch(`${baseUrl}/api/rules/${created.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: false }),
  });
  assert.equal(patchRes.status, 200);
  const patched = (await patchRes.json()) as RuleSpec & { id: string };
  assert.equal(patched.id, created.id);
  assert.equal(patched.enabled, false);

  const rules = (await (await fetch(`${baseUrl}/api/rules`)).json()) as RuleSpec[];
  assert.equal(rules.length, 1);
  assert.equal(rules[0].id, created.id);
  assert.equal(rules[0].enabled, false); // toggle persisted
});

test('PATCH /api/rules/{id} replacing matcher/action rebuilds the rule from the merged spec', async () => {
  const baseUrl = await startServer(createRuleStore(), createCollector());
  const created = await postRule(baseUrl, LOOP_INJECT_SPEC);

  const patchRes = await fetch(`${baseUrl}/api/rules/${created.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ matcher: { type: 'toolName', toolNames: ['bash'] } }),
  });
  assert.equal(patchRes.status, 200);
  const rules = (await (await fetch(`${baseUrl}/api/rules`)).json()) as RuleSpec[];
  assert.equal(rules[0].matcher.type, 'toolName');
  assert.deepEqual(rules[0].matcher.toolNames, ['bash']);
  assert.equal(rules[0].action.type, 'injectMessage'); // unchanged
});

test('DELETE /api/rules/{id} removes the rule (204) and it is gone from GET; repeat DELETE is 404', async () => {
  const baseUrl = await startServer(createRuleStore(), createCollector());
  const created = await postRule(baseUrl, LOOP_INJECT_SPEC);

  const del = await fetch(`${baseUrl}/api/rules/${created.id}`, { method: 'DELETE' });
  assert.equal(del.status, 204);
  assert.equal(await del.text(), '');

  const rules = (await (await fetch(`${baseUrl}/api/rules`)).json()) as RuleSpec[];
  assert.ok(!rules.some((rule) => rule.id === created.id));

  const delAgain = await fetch(`${baseUrl}/api/rules/${created.id}`, { method: 'DELETE' });
  assert.equal(delAgain.status, 404);
});

test('POST /api/rules with an invalid spec returns 400 { error }', async () => {
  const ruleStore = createRuleStore();
  const baseUrl = await startServer(ruleStore, createCollector());

  const res = await fetch(`${baseUrl}/api/rules`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: true, matcher: { type: 'nope' }, action: { type: 'injectMessage', content: 'x' } }),
  });
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: string };
  assert.ok(typeof body.error === 'string' && body.error.length > 0);
  assert.equal(ruleStore.size(), 0); // nothing stored on an invalid POST
});

test('PATCH an unknown id returns 404 { error: "not_found" }', async () => {
  const baseUrl = await startServer(createRuleStore(), createCollector());
  const res = await fetch(`${baseUrl}/api/rules/does-not-exist`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: false }),
  });
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: 'not_found' });
});

test('a non-/api path falls through (handler returns false) to a 404 from the chain', async () => {
  const baseUrl = await startServer(createRuleStore(), createCollector());
  const res = await fetch(`${baseUrl}/v1/models`);
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: 'not_found' });
});
