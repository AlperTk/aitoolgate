import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCollector } from '../src/telemetry/collector';
import { createEventBus } from '../src/telemetry/event-bus';
import type {
  TelemetryEvent,
  ToolCallEvent,
  ToolResultEvent,
  InterventionEvent,
} from '../src/telemetry/events';

const AT = 1_700_000_000_000;

/** Build a ToolCallEvent with sensible defaults plus optional overrides. */
function toolCall(overrides: Partial<ToolCallEvent> = {}): ToolCallEvent {
  const base: ToolCallEvent = {
    type: 'tool.call',
    sessionKey: 'sess-1',
    toolName: 'bash',
    at: AT,
  };
  return { ...base, ...overrides };
}

/** Build a ToolResultEvent with sensible defaults plus optional overrides. */
function toolResult(overrides: Partial<ToolResultEvent> = {}): ToolResultEvent {
  const base: ToolResultEvent = {
    type: 'tool.result',
    sessionKey: 'sess-1',
    toolName: 'bash',
    ok: true,
    at: AT,
  };
  return { ...base, ...overrides };
}

/** Build an InterventionEvent with sensible defaults plus optional overrides. */
function intervention(overrides: Partial<InterventionEvent> = {}): InterventionEvent {
  const base: InterventionEvent = {
    type: 'policy.intervention',
    sessionKey: 'sess-1',
    ruleId: 'rule-loop',
    action: 'injectMessage',
    at: AT,
  };
  return { ...base, ...overrides };
}

// --- top tools ------------------------------------------------------------

test('top tools are ranked by call count (desc) and tie-broken alphabetically', async () => {
  const bus = createEventBus();
  const collector = createCollector({ bus });

  const emitMany = async (count: number, toolName: string): Promise<void> => {
    for (let i = 0; i < count; i++) await bus.emit(toolCall({ toolName }));
  };
  await emitMany(3, 'bash');
  await emitMany(3, 'ls');
  await emitMany(5, 'read'); // read=5 is the leader; bash & ls tie at 3

  assert.deepEqual(collector.getTopTools(), [
    { toolName: 'read', count: 5 },
    { toolName: 'bash', count: 3 },
    { toolName: 'ls', count: 3 },
  ]);
  // capping to the top N returns only the N highest
  assert.deepEqual(collector.getTopTools(2), [
    { toolName: 'read', count: 5 },
    { toolName: 'bash', count: 3 },
  ]);
  // summary reflects the same aggregates
  assert.equal(collector.summary().totalCalls, 11);
  assert.deepEqual(collector.summary().topTools, [
    { toolName: 'read', count: 5 },
    { toolName: 'bash', count: 3 },
    { toolName: 'ls', count: 3 },
  ]);
});

// --- interventions --------------------------------------------------------

test('interventions are retained newest-first and bounded to maxInterventions', async () => {
  const bus = createEventBus();
  const collector = createCollector({ bus, maxInterventions: 3 });

  await bus.emit(intervention({ ruleId: 'r1', at: AT + 1 }));
  await bus.emit(intervention({ ruleId: 'r2', at: AT + 2 }));
  await bus.emit(intervention({ ruleId: 'r3', at: AT + 3 }));
  // newest-first: r3, r2, r1
  assert.deepEqual(collector.getInterventions().map((e) => e.ruleId), ['r3', 'r2', 'r1']);

  // exceeding the cap evicts the oldest; only the three newest survive
  await bus.emit(intervention({ ruleId: 'r4', at: AT + 4 }));
  await bus.emit(intervention({ ruleId: 'r5', at: AT + 5 }));
  assert.deepEqual(collector.getInterventions().map((e) => e.ruleId), ['r5', 'r4', 'r3']);
  assert.equal(collector.getInterventions().length, 3);

  // an explicit limit further caps the (already-bounded) list
  assert.deepEqual(collector.getInterventions(2).map((e) => e.ruleId), ['r5', 'r4']);
});

test('a bus-injected collector with no explicit cap retains events up to the default', async () => {
  const bus = createEventBus();
  const collector = createCollector({ bus }); // no maxInterventions -> default (500)
  for (let i = 0; i < 10; i++) {
    await bus.emit(intervention({ ruleId: `r${i}`, at: AT + i }));
  }
  assert.equal(collector.getInterventions().length, 10); // 10 < default cap
  assert.equal(collector.getInterventions()[0].ruleId, 'r9'); // newest-first
});

// --- tool.result vs tool.call --------------------------------------------

test('tool.result events increment totalResults but do not count as tool calls', async () => {
  const bus = createEventBus();
  const collector = createCollector({ bus });

  await bus.emit(toolCall({ toolName: 'bash' }));
  await bus.emit(toolResult({ toolName: 'bash' }));
  await bus.emit(toolResult({ toolName: 'read' }));

  assert.equal(collector.summary().totalCalls, 1); // only the single tool.call
  assert.equal(collector.summary().totalResults, 2); // the two tool.results
  // results never appear in the top-tools ranking nor per-tool counts
  assert.deepEqual(collector.getTopTools(), [{ toolName: 'bash', count: 1 }]);
  assert.equal(collector.perTool.has('read'), false);
});

test('unknown event types are ignored safely', async () => {
  const bus = createEventBus();
  const collector = createCollector({ bus });
  await bus.emit({ type: 'something.unknown', at: AT } as unknown as TelemetryEvent);
  assert.equal(collector.totalCalls, 0);
  assert.equal(collector.totalResults, 0);
  assert.equal(collector.getInterventions().length, 0);
});

// --- reset ---------------------------------------------------------------

test('reset clears all aggregates back to zero/empty without unsubscribing', async () => {
  const bus = createEventBus();
  const collector = createCollector({ bus });

  await bus.emit(toolCall({ toolName: 'bash' }));
  await bus.emit(toolResult({ toolName: 'bash' }));
  await bus.emit(intervention());
  assert.equal(collector.totalCalls, 1);
  assert.equal(collector.totalResults, 1);
  assert.equal(collector.getInterventions().length, 1);
  assert.equal(collector.perSession.get('sess-1'), 1);

  collector.reset();
  assert.equal(collector.totalCalls, 0);
  assert.equal(collector.totalResults, 0);
  assert.deepEqual(collector.getTopTools(), []);
  assert.equal(collector.getInterventions().length, 0);
  assert.equal(collector.summary().totalCalls, 0);

  // still subscribed after reset (unlike dispose): a new event is counted
  await bus.emit(toolCall({ toolName: 'ls' }));
  assert.equal(collector.totalCalls, 1);
});

// --- dispose -------------------------------------------------------------

test('dispose stops receiving further events', async () => {
  const bus = createEventBus();
  const collector = createCollector({ bus });

  await bus.emit(toolCall({ toolName: 'bash' }));
  assert.equal(collector.totalCalls, 1);

  collector.dispose();
  await bus.emit(toolCall({ toolName: 'bash' }));
  await bus.emit(intervention());

  assert.equal(collector.totalCalls, 1); // unchanged after dispose
  assert.equal(collector.getInterventions().length, 0); // unchanged after dispose

  // re-emitting more does not change anything either
  await bus.emit(toolCall({ toolName: 'read' }));
  assert.equal(collector.totalCalls, 1);
  assert.deepEqual(collector.getTopTools(), [{ toolName: 'bash', count: 1 }]);
});

// --- defaults ------------------------------------------------------------

test('createCollector with no options returns an empty view', () => {
  const collector = createCollector();
  assert.equal(collector.totalCalls, 0);
  assert.equal(collector.totalResults, 0);
  assert.deepEqual(collector.getTopTools(), []);
  assert.equal(collector.getInterventions().length, 0);
  collector.dispose();
});

// --- token usage (deduped per response turn) -----------------------------

test('tool.call tokens are deduped once per (sessionKey, at) turn and summed globally', async () => {
  const bus = createEventBus();
  const collector = createCollector({ bus });

  // Two calls share one response turn (same sessionKey + at) and repeat identical
  // tokens; the turn must be counted once, not twice.
  await bus.emit(toolCall({ toolName: 'bash', tokens: { input: 1000, output: 50, total: 1050 } }));
  await bus.emit(toolCall({ toolName: 'read', tokens: { input: 1000, output: 50, total: 1050 } }));

  assert.equal(collector.totalCalls, 2); // both still count as calls
  const firstTurn = collector.summary();
  assert.equal(firstTurn.totalInputTokens, 1000); // deduped to a single turn, NOT doubled
  assert.equal(firstTurn.totalOutputTokens, 50);
  assert.equal(firstTurn.totalTokens, 1050);

  // A second, distinct turn accumulates additively.
  await bus.emit(toolCall({ toolName: 'ls', sessionKey: 'sess-2', at: AT + 1, tokens: { input: 200, output: 40, total: 240 } }));
  const twoTurns = collector.summary();
  assert.equal(twoTurns.totalInputTokens, 1200);
  assert.equal(twoTurns.totalOutputTokens, 90);
  assert.equal(twoTurns.totalTokens, 1290);
});

test('a repeated identical call within the same turn is not double-counted', async () => {
  const bus = createEventBus();
  const collector = createCollector({ bus });

  // Identical (sessionKey, at) => same turn key, even if the toolName differs.
  await bus.emit(toolCall({ toolName: 'bash', tokens: { input: 300, output: 70, total: 370 } }));
  await bus.emit(toolCall({ toolName: 'bash', tokens: { input: 300, output: 70, total: 370 } }));

  assert.equal(collector.totalCalls, 2);
  const s = collector.summary();
  assert.equal(s.totalInputTokens, 300);
  assert.equal(s.totalOutputTokens, 70);
  assert.equal(s.totalTokens, 370);
  // Per-tool aggregation mirrors the global turn-dedup: the two same-turn calls attribute the turn's
  // tokens to `bash` ONCE (370), not twice (740).
  const topBash = s.topTools.find((t) => t.toolName === 'bash');
  assert.ok(topBash);
  assert.equal(topBash.count, 2);
  assert.equal(topBash.totalTokens, 370);
});

test('maxTokenTurns bounds the token-turn dedup set, evicting oldest keys', async () => {
  const bus = createEventBus();
  const collector = createCollector({ bus, maxTokenTurns: 1 });

  await bus.emit(toolCall({ toolName: 'a', sessionKey: 'a', at: 1, tokens: { input: 10 } }));
  assert.equal(collector.summary().totalInputTokens, 10);

  // Turn "b" pushes the dedup set over the cap, evicting the oldest key ("a").
  await bus.emit(toolCall({ toolName: 'b', sessionKey: 'b', at: 1, tokens: { input: 10 } }));
  assert.equal(collector.summary().totalInputTokens, 20);

  // "a" was evicted from the bounded set, so re-emitting its turn counts it again.
  await bus.emit(toolCall({ toolName: 'c', sessionKey: 'a', at: 1, tokens: { input: 10 } }));
  assert.equal(collector.summary().totalInputTokens, 30);
});

// --- duration aggregation -------------------------------------------------

test('tool.result durations aggregate per tool and into summary totals', async () => {
  const bus = createEventBus();
  const collector = createCollector({ bus });

  await bus.emit(toolCall({ toolName: 'bash' }));
  await bus.emit(toolCall({ toolName: 'bash' }));
  await bus.emit(toolCall({ toolName: 'read' })); // no results with durationMs -> fields stay undefined
  await bus.emit(toolResult({ toolName: 'bash', durationMs: 100 }));
  await bus.emit(toolResult({ toolName: 'bash', durationMs: 250 }));
  await bus.emit(toolResult({ toolName: 'read' })); // no durationMs -> ignored for duration

  assert.equal(collector.summary().totalCalls, 3);
  assert.equal(collector.summary().totalResults, 3);

  const top = collector.getTopTools();
  const bash = top.find((t) => t.toolName === 'bash');
  assert.ok(bash);
  assert.equal(bash.count, 2);
  assert.equal(bash.totalDurationMs, 350);
  assert.equal(bash.avgDurationMs, 175);
  assert.equal(bash.maxDurationMs, 250);

  // A tool with calls but no duration-carrying result keeps those fields undefined.
  const read = top.find((t) => t.toolName === 'read');
  assert.ok(read);
  assert.equal(read.count, 1);
  assert.equal(read.totalDurationMs, undefined);
  assert.equal(read.avgDurationMs, undefined);
  assert.equal(read.maxDurationMs, undefined);

  const s = collector.summary();
  assert.equal(s.totalDurationMs, 350);
  assert.equal(s.avgDurationMs, 175);
});

test('tools with no result/duration leave duration fields undefined in the summary too', async () => {
  const bus = createEventBus();
  const collector = createCollector({ bus });

  await bus.emit(toolCall({ toolName: 'bash' }));
  const s = collector.summary();
  assert.equal(s.totalDurationMs, undefined);
  assert.equal(s.avgDurationMs, undefined);
  assert.deepEqual(collector.getTopTools(), [{ toolName: 'bash', count: 1 }]);
});

// --- reset of the new aggregates ------------------------------------------

test('reset clears duration and token aggregates', async () => {
  const bus = createEventBus();
  const collector = createCollector({ bus });

  await bus.emit(toolCall({ toolName: 'bash', tokens: { input: 10, output: 5, total: 15 } }));
  await bus.emit(toolResult({ toolName: 'bash', durationMs: 200 }));
  assert.equal(collector.summary().totalInputTokens, 10);
  assert.equal(collector.summary().totalTokens, 15);
  assert.equal(collector.summary().totalDurationMs, 200);
  assert.equal(collector.summary().avgDurationMs, 200);

  collector.reset();
  const s = collector.summary();
  assert.equal(s.totalCalls, 0);
  assert.equal(s.totalResults, 0);
  assert.equal(s.totalDurationMs, undefined);
  assert.equal(s.avgDurationMs, undefined);
  assert.equal(s.totalInputTokens, undefined);
  assert.equal(s.totalOutputTokens, undefined);
  assert.equal(s.totalTokens, undefined);
  assert.deepEqual(collector.getTopTools(), []);

  // still subscribed after reset: a fresh turn is counted again from a clean slate
  await bus.emit(toolCall({ toolName: 'bash', tokens: { input: 7 } }));
  assert.equal(collector.summary().totalInputTokens, 7);
});

// --- aggregate exclusion of wrapper tools (e.g. the `task` sub-session) -------

/**
 * Scenario: N normal tool calls (each with small duration + tokens, results
 * paired) mixed with K `task` wrapper calls whose single call/result carries a
 * WHOLE nested sub-session's large duration + token mass. The `task` wrapper is
 * excluded from every aggregate while its individual events stay in the raw stream.
 */
test('excluded `task` wrapper is filtered from aggregates but kept in the raw event stream', async () => {
  const bus = createEventBus();
  const collector = createCollector({ bus });

  // A recorder mirroring every EMITTED event — proves the filter is
  // aggregation-only and never drops raw events from the stream.
  const seen: TelemetryEvent[] = [];
  bus.subscribe((ev) => { seen.push(ev); });

  // N normal calls (unique `at` so each is its own dedup turn), each paired with a result.
  await bus.emit(toolCall({ toolName: 'bash', sessionKey: 'sess-1', at: AT + 1, tokens: { input: 100, output: 50, total: 150 } }));
  await bus.emit(toolResult({ toolName: 'bash', sessionKey: 'sess-1', at: AT + 2, durationMs: 100 }));
  await bus.emit(toolCall({ toolName: 'bash', sessionKey: 'sess-1', at: AT + 3, tokens: { input: 200, output: 80, total: 280 } }));
  await bus.emit(toolResult({ toolName: 'bash', sessionKey: 'sess-1', at: AT + 4, durationMs: 200 }));
  await bus.emit(toolCall({ toolName: 'read', sessionKey: 'sess-1', at: AT + 5, tokens: { input: 300, output: 60, total: 360 } }));
  await bus.emit(toolResult({ toolName: 'read', sessionKey: 'sess-1', at: AT + 6, durationMs: 150 }));

  // K `task` wrapper calls carrying a whole nested sub-session's large mass.
  await bus.emit(toolCall({ toolName: 'task', sessionKey: 'sub-a', at: AT + 10, tokens: { input: 100000, output: 90000, total: 190000 } }));
  await bus.emit(toolResult({ toolName: 'task', sessionKey: 'sub-a', at: AT + 11, durationMs: 600000 }));
  await bus.emit(toolCall({ toolName: 'task', sessionKey: 'sub-b', at: AT + 12, tokens: { input: 200000, output: 150000, total: 350000 } }));
  await bus.emit(toolResult({ toolName: 'task', sessionKey: 'sub-b', at: AT + 13, durationMs: 900000 }));

  const s = collector.summary();
  // Normal-only counts (the task wrapper is excluded from both sides).
  assert.equal(s.totalCalls, 3);
  assert.equal(s.totalResults, 3);
  // Normal-only duration; the average is NOT inflated by the large task durations.
  assert.equal(s.totalDurationMs, 450); // 100 + 200 + 150
  assert.equal(s.avgDurationMs, 150);    // 450 / 3 normal results, not (450+600000+900000)/5
  // Normal-only token mass; the task wrapper's huge totals are excluded.
  assert.equal(s.totalInputTokens, 600);   // 100 + 200 + 300
  assert.equal(s.totalOutputTokens, 190);  // 50 + 80 + 60
  assert.equal(s.totalTokens, 790);        // 150 + 280 + 360
  // No `task` row in the top tools; other tools present with correct metrics.
  assert.ok(!s.topTools.some((t) => t.toolName.toLowerCase() === 'task'));
  assert.deepEqual(s.topTools, [
    { toolName: 'bash', count: 2, avgDurationMs: 150, maxDurationMs: 200, totalDurationMs: 300, totalTokens: 430 },
    { toolName: 'read', count: 1, avgDurationMs: 150, maxDurationMs: 150, totalDurationMs: 150, totalTokens: 360 },
  ]);

  // The RAW emitted stream still carries every individual task event (aggregation-only filter).
  assert.equal(seen.filter((e) => e.type === 'tool.call' && e.toolName === 'task').length, 2);
  assert.equal(seen.filter((e) => e.type === 'tool.result' && e.toolName === 'task').length, 2);
  const taskResultEv = seen.find((e) => e.type === 'tool.result' && e.toolName === 'task') as ToolResultEvent;
  assert.equal(taskResultEv.durationMs, 600000);
  const taskCallEv = seen.find((e) => e.type === 'tool.call' && e.toolName === 'task') as ToolCallEvent;
  assert.equal(taskCallEv.tokens?.total, 190000);

  // The collector's own retained raw-event buffer also keeps them.
  assert.equal(collector.getRecentEvents().filter((e) => (e.type === 'tool.call' || e.type === 'tool.result') && e.toolName === 'task').length, 4);
  // Per-session tallies stay raw: the task wrapper's sessions are still counted.
  assert.equal(collector.perSession.get('sub-a'), 1);
  assert.equal(collector.perSession.get('sub-b'), 1);
});

test('aggregate exclusion matches tool names case-insensitively (Task / TASK / tAsK)', async () => {
  const bus = createEventBus();
  const collector = createCollector({ bus });
  const seen: TelemetryEvent[] = [];
  bus.subscribe((ev) => { seen.push(ev); });

  await bus.emit(toolCall({ toolName: 'Task', at: AT + 1, tokens: { input: 900, output: 100, total: 1000 } }));
  await bus.emit(toolResult({ toolName: 'Task', at: AT + 2, durationMs: 50000 }));
  await bus.emit(toolCall({ toolName: 'TASK', at: AT + 3, tokens: { input: 400, output: 60, total: 460 } }));
  await bus.emit(toolResult({ toolName: 'TASK', at: AT + 4, durationMs: 70000 }));
  await bus.emit(toolCall({ toolName: 'tAsK', at: AT + 5 }));

  const s = collector.summary();
  // Every differently-cased variant of `task` is excluded from every aggregate.
  assert.equal(s.totalCalls, 0);
  assert.equal(s.totalResults, 0);
  assert.equal(s.totalDurationMs, undefined);
  assert.equal(s.avgDurationMs, undefined);
  assert.equal(s.totalInputTokens, undefined);
  assert.equal(s.totalOutputTokens, undefined);
  assert.equal(s.totalTokens, undefined);
  assert.deepEqual(s.topTools, []);

  // ...but the raw stream retains all of them.
  assert.equal(seen.filter((e) => e.type === 'tool.call' && /^task$/i.test(e.toolName)).length, 3);
  assert.equal(seen.filter((e) => e.type === 'tool.result' && /^task$/i.test(e.toolName)).length, 2);
});

test('excludedTools option customizes the aggregation-exclusion set (default excludes only `task`)', async () => {
  // Default behaviour: a non-`task` tool counts; `task` is excluded.
  const busA = createEventBus();
  const cA = createCollector({ bus: busA });
  await busA.emit(toolCall({ toolName: 'task' }));
  await busA.emit(toolCall({ toolName: 'other' }));
  assert.equal(cA.summary().totalCalls, 1); // only `other`
  assert.deepEqual(cA.getTopTools(), [{ toolName: 'other', count: 1 }]);

  // Custom set: exclude a different name instead of `task` (case-insensitive).
  const busB = createEventBus();
  const cB = createCollector({ bus: busB, excludedTools: ['deploy'] });
  await busB.emit(toolCall({ toolName: 'task' }));   // NOT in the custom set -> counted
  await busB.emit(toolCall({ toolName: 'Deploy' })); // in the set -> excluded
  assert.equal(cB.summary().totalCalls, 1);
  assert.deepEqual(cB.getTopTools(), [{ toolName: 'task', count: 1 }]);

  // Empty set disables exclusion entirely (a `task` call is then counted).
  const busC = createEventBus();
  const cC = createCollector({ bus: busC, excludedTools: [] });
  await busC.emit(toolCall({ toolName: 'task' }));
  assert.equal(cC.summary().totalCalls, 1);
});

// --- token-absent turns ---------------------------------------------------------------

test('a token-less tool.call counts as a call but adds no token mass; its chars-carrying result still counts', async () => {
  const bus = createEventBus();
  const collector = createCollector({ bus });

  // A single-call turn whose response carried no upstream usage: NO `tokens` on the call.
  await bus.emit(toolCall({ toolName: 'bash' }));
  // Its paired result still reports its payload size (`chars`).
  await bus.emit(toolResult({ toolName: 'bash', chars: 128 }));

  const s = collector.summary();
  assert.equal(s.totalCalls, 1, 'the token-less tool.call still counts as a call');
  assert.equal(s.totalResults, 1, 'the paired tool.result is counted');
  assert.equal(s.totalInputTokens, undefined, 'no input-token mass is recorded for a usage-less turn');
  assert.equal(s.totalOutputTokens, undefined, 'no output-token mass is recorded for a usage-less turn');
  assert.equal(s.totalTokens, undefined, 'no total-token mass is recorded for a usage-less turn');
  assert.deepEqual(collector.getTopTools(), [{ toolName: 'bash', count: 1 }]);
});
