import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEventBus } from '../src/telemetry/event-bus';
import type {
  TelemetryEvent,
  ToolCallEvent,
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

// --- delivery ---------------------------------------------------------------

test('a published ToolCallEvent is delivered to a subscribed handler with all fields', async () => {
  const bus = createEventBus();
  const received: ToolCallEvent[] = [];
  bus.subscribe((event) => {
    if (event.type === 'tool.call') received.push(event);
  });
  await bus.emit(toolCall({ clientId: 'client-A', args: { cmd: 'ls' } }));
  assert.equal(received.length, 1);
  const event = received[0];
  assert.equal(event.type, 'tool.call');
  assert.equal(event.sessionKey, 'sess-1');
  assert.equal(event.clientId, 'client-A');
  assert.equal(event.toolName, 'bash');
  assert.deepEqual(event.args, { cmd: 'ls' });
  assert.equal(event.at, AT);
});

// --- multiple subscribers ---------------------------------------------------

test('multiple subscribers all receive the same event', async () => {
  const bus = createEventBus();
  const a: string[] = [];
  const b: string[] = [];
  bus.subscribe((event) => {
    a.push(event.sessionKey);
  });
  bus.subscribe((event) => {
    b.push(event.sessionKey);
  });
  await bus.emit(toolCall());
  assert.deepEqual(a, ['sess-1']);
  assert.deepEqual(b, ['sess-1']);
});

// --- unsubscribe ------------------------------------------------------------

test('unsubscribing stops delivery', async () => {
  const bus = createEventBus();
  const seenAt: number[] = [];
  const off = bus.subscribe((event) => {
    seenAt.push(event.at);
  });
  await bus.emit(toolCall({ at: AT }));
  off();
  await bus.emit(toolCall({ at: AT + 1 }));
  assert.deepEqual(seenAt, [AT]); // only the first emit was observed
});

test('calling the unsubscribe function twice is a no-op', async () => {
  const bus = createEventBus();
  let count = 0;
  const off = bus.subscribe(() => {
    count++;
  });
  off();
  off();
  await bus.emit(toolCall());
  assert.equal(count, 0);
});

// --- isolation of throwing subscribers ---------------------------------------

test('a throwing subscriber does not prevent another subscriber from receiving the event', async () => {
  const bus = createEventBus();
  let secondRan = false;
  bus.subscribe(() => {
    throw new Error('boom');
  });
  bus.subscribe(() => {
    secondRan = true;
  });
  await bus.emit(toolCall());
  assert.equal(secondRan, true);
});

test('a rejecting (async) subscriber does not prevent later subscribers', async () => {
  const bus = createEventBus();
  let secondRan = false;
  bus.subscribe(async () => {
    throw new Error('rejects');
  });
  bus.subscribe(() => {
    secondRan = true;
  });
  await bus.emit(toolCall());
  assert.equal(secondRan, true);
});

// --- intervention flow ------------------------------------------------------

test('an InterventionEvent flows through correctly with its discriminated action', async () => {
  const bus = createEventBus();
  const received: TelemetryEvent[] = [];
  bus.subscribe((event) => {
    received.push(event);
  });
  await bus.emit(intervention({ ruleId: 'rule-loop', action: 'injectMessage', detail: 'you are looping' }));
  assert.equal(received.length, 1);
  const event = received[0];
  assert.equal(event.type, 'policy.intervention');
  if (event.type !== 'policy.intervention') throw new Error('expected an intervention');
  assert.equal(event.sessionKey, 'sess-1');
  assert.equal(event.ruleId, 'rule-loop');
  assert.equal(event.action, 'injectMessage');
  assert.equal(event.detail, 'you are looping');
});
