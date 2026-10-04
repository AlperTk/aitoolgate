import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createToolMetricsTracker } from '../src/telemetry/toolMetrics';

/** A controllable clock so time-dependent behavior stays deterministic. */
function makeClock(start = 0) {
  let t = start;
  return {
    now: () => t,
    set: (value: number): void => {
      t = value;
    },
  };
}

// --- happy path -------------------------------------------------------------

test('issue then resolve yields the measured duration and clears the pending slot', () => {
  const clock = makeClock(1000); // pinned so issued times are never swept away
  const tracker = createToolMetricsTracker({ now: clock.now });

  tracker.recordIssued('sess-1', [{ id: 'a', at: 1000 }]);
  assert.equal(tracker.pendingCount(), 1);

  assert.deepEqual(tracker.resolveResults('sess-1', [{ toolCallId: 'a', at: 2500 }]), [
    { toolCallId: 'a', durationMs: 1500 },
  ]);
  assert.equal(tracker.pendingCount(), 0);
});

// --- multiple distinct durations -------------------------------------------

test('multiple distinct calls resolve with correct per-id durations', () => {
  const clock = makeClock(1050); // fresh relative to every recorded issue time
  const tracker = createToolMetricsTracker({ now: clock.now });

  tracker.recordIssued('sess-1', [
    { id: 'a', at: 1000 },
    { id: 'b', at: 1050 },
  ]);
  assert.equal(tracker.pendingCount(), 2);

  assert.deepEqual(
    tracker.resolveResults('sess-1', [
      { toolCallId: 'a', at: 2500 },
      { toolCallId: 'b', at: 1100 },
    ]),
    [
      { toolCallId: 'a', durationMs: 1500 },
      { toolCallId: 'b', durationMs: 50 },
    ],
  );
  assert.equal(tracker.pendingCount(), 0);
});

// --- unmatched results -----------------------------------------------------

test('an unmatched result is omitted and leaves the pending count unchanged', () => {
  const clock = makeClock(1000);
  const tracker = createToolMetricsTracker({ now: clock.now });

  // no prior issue for this id:
  assert.deepEqual(tracker.resolveResults('sess-1', [{ toolCallId: 'ghost', at: 2000 }]), []);
  assert.equal(tracker.pendingCount(), 0);

  // a known pending call is untouched by an unrelated result:
  tracker.recordIssued('sess-1', [{ id: 'a', at: 1000 }]);
  assert.equal(tracker.pendingCount(), 1);
  assert.deepEqual(tracker.resolveResults('sess-1', [{ toolCallId: 'other', at: 2000 }]), []);
  assert.equal(tracker.pendingCount(), 1);
});

// --- same id resolved twice ------------------------------------------------

test('the same result id resolves only once; the second finds nothing pending', () => {
  const clock = makeClock(1000);
  const tracker = createToolMetricsTracker({ now: clock.now });

  tracker.recordIssued('sess-1', [{ id: 'a', at: 1000 }]);

  const out = tracker.resolveResults('sess-1', [
    { toolCallId: 'a', at: 2500 },
    { toolCallId: 'a', at: 3000 },
  ]);
  assert.deepEqual(out, [{ toolCallId: 'a', durationMs: 1500 }]);
  assert.equal(tracker.pendingCount(), 0);
});

// --- TTL sweep -------------------------------------------------------------

test('stale pending entries are swept so a late result can no longer resolve', () => {
  const clock = makeClock(0);
  const tracker = createToolMetricsTracker({ now: clock.now, ttlMs: 1000 });

  tracker.recordIssued('sess-1', [{ id: 'a', at: 0 }]);
  assert.equal(tracker.pendingCount(), 1); // still fresh at t=0

  clock.set(2000); // advance past the 1000ms TTL
  assert.equal(tracker.pendingCount(), 0); // pendingCount sweeps first
  assert.deepEqual(tracker.resolveResults('sess-1', [{ toolCallId: 'a', at: 2000 }]), []);
});

// --- capacity eviction -----------------------------------------------------

test('exceeding maxPending evicts the oldest entries; only the newest survive', () => {
  const clock = makeClock(1000); // fresh, so TTL never fires in this test
  const tracker = createToolMetricsTracker({ now: clock.now, maxPending: 3 });

  tracker.recordIssued('sess-1', [{ id: 'a', at: 1000 }]);
  tracker.recordIssued('sess-1', [{ id: 'b', at: 1001 }]);
  tracker.recordIssued('sess-1', [{ id: 'c', at: 1002 }]);
  assert.equal(tracker.pendingCount(), 3);

  tracker.recordIssued('sess-1', [{ id: 'd', at: 1003 }]); // evicts 'a' (oldest by `at`)
  tracker.recordIssued('sess-1', [{ id: 'e', at: 1004 }]); // evicts 'b'
  assert.equal(tracker.pendingCount(), 3);

  // resolving all five returns only the three newest survivors, input order kept:
  assert.deepEqual(
    tracker.resolveResults('sess-1', [
      { toolCallId: 'a', at: 2000 },
      { toolCallId: 'b', at: 2001 },
      { toolCallId: 'c', at: 2002 },
      { toolCallId: 'd', at: 2003 },
      { toolCallId: 'e', at: 2004 },
    ]),
    [
      { toolCallId: 'c', durationMs: 1000 },
      { toolCallId: 'd', durationMs: 1000 },
      { toolCallId: 'e', durationMs: 1000 },
    ],
  );
  assert.equal(tracker.pendingCount(), 0);
});

// --- reset -----------------------------------------------------------------

test('reset clears all state and makes prior ids unresolvable', () => {
  const clock = makeClock(1000);
  const tracker = createToolMetricsTracker({ now: clock.now });

  tracker.recordIssued('sess-1', [{ id: 'a', at: 1000 }]);
  assert.equal(tracker.pendingCount(), 1);

  tracker.reset();
  assert.equal(tracker.pendingCount(), 0);
  assert.deepEqual(tracker.resolveResults('sess-1', [{ toolCallId: 'a', at: 2500 }]), []);
});

// --- clamping to non-negative ---------------------------------------------

test('out-of-order timestamps clamp the measured duration to >= 0', () => {
  const clock = makeClock(6000); // fresh relative to the 5000 issue time
  const tracker = createToolMetricsTracker({ now: clock.now });

  tracker.recordIssued('sess-1', [{ id: 'a', at: 5000 }]);
  assert.deepEqual(tracker.resolveResults('sess-1', [{ toolCallId: 'a', at: 1000 }]), [
    { toolCallId: 'a', durationMs: 0 },
  ]);
});

// --- chars pass-through ----------------------------------------------------

test('chars is included on the resolved call only when present on the result', () => {
  const clock = makeClock(1000);
  const tracker = createToolMetricsTracker({ now: clock.now });

  tracker.recordIssued('sess-1', [
    { id: 'with', at: 1000 },
    { id: 'without', at: 1000 },
  ]);

  assert.deepEqual(
    tracker.resolveResults('sess-1', [
      { toolCallId: 'with', at: 2000, chars: 42 },
      { toolCallId: 'without', at: 2000 },
    ]),
    [
      { toolCallId: 'with', durationMs: 1000, chars: 42 },
      { toolCallId: 'without', durationMs: 1000 },
    ],
  );
});

// --- same-session-only matching --------------------------------------------

test('results only match a pending call in the same session', () => {
  const clock = makeClock(1000);
  const tracker = createToolMetricsTracker({ now: clock.now });

  tracker.recordIssued('sess-A', [{ id: 'x', at: 1000 }]);
  tracker.recordIssued('sess-B', [{ id: 'x', at: 1000 }]);
  assert.equal(tracker.pendingCount(), 2);

  // resolving from sess-A must not touch sess-B's identically-named call:
  assert.deepEqual(tracker.resolveResults('sess-A', [{ toolCallId: 'x', at: 2000 }]), [
    { toolCallId: 'x', durationMs: 1000 },
  ]);
  assert.equal(tracker.pendingCount(), 1);
});
