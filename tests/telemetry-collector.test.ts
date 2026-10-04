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
