import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createToolMetricsTracker, monotonicEpochMs } from '../src/telemetry/toolMetrics';

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

// --- per-call duration attribution (batched / interleaved / orphaned) -----------

test('a batched same-arrival batch resolves with EQUAL per-id durations, paired by id not position', () => {
  const clock = makeClock(3000); // fresh relative to every issue/arrival time below
  const tracker = createToolMetricsTracker({ now: clock.now });

  // Three sibling calls observed together in ONE turn share the same issue time.
  tracker.recordIssued('sess-1', [
    { id: 'a', at: 1000, name: 't_a' },
    { id: 'b', at: 1000, name: 't_b' },
    { id: 'c', at: 1000, name: 't_c' },
  ]);
  assert.equal(tracker.pendingCount(), 3);

  // All three results arrive TOGETHER (one atomic request) but listed in reversed order:
  // each pairs by its OWN id and they correctly share an EQUAL duration (parallel run) —
  // no fabricated spread, no single bogus shared value detached from the ids.
  assert.deepEqual(
    tracker.resolveResults('sess-1', [
      { toolCallId: 'c', at: 2500, chars: 3 },
      { toolCallId: 'a', at: 2500, chars: 1 },
      { toolCallId: 'b', at: 2500, chars: 2 },
    ]),
    [
      { toolCallId: 'c', durationMs: 1500, toolName: 't_c', chars: 3 },
      { toolCallId: 'a', durationMs: 1500, toolName: 't_a', chars: 1 },
      { toolCallId: 'b', durationMs: 1500, toolName: 't_b', chars: 2 },
    ],
  );
  assert.equal(tracker.pendingCount(), 0);
});

test('interleaved / out-of-order arrivals each take their OWN span (matched by id)', () => {
  const clock = makeClock(5000); // fresh relative to every issue/arrival time below
  const tracker = createToolMetricsTracker({ now: clock.now });

  tracker.recordIssued('sess-1', [
    { id: 'a', at: 1000 },
    { id: 'b', at: 1200 },
    { id: 'c', at: 1400 },
  ]);

  // Results arrive INTERLEAVED across successive requests, in an order matching NEITHER the
  // issue order NOR the arrival chronology of the later batch: c first, then a, then b.
  assert.deepEqual(tracker.resolveResults('sess-1', [{ toolCallId: 'c', at: 3000 }]), [
    { toolCallId: 'c', durationMs: 1600 },
  ]);
  assert.equal(tracker.pendingCount(), 2);
  assert.deepEqual(
    tracker.resolveResults('sess-1', [
      { toolCallId: 'a', at: 3500 },
      { toolCallId: 'b', at: 4000 },
    ]),
    [
      { toolCallId: 'a', durationMs: 2500 },
      { toolCallId: 'b', durationMs: 2800 },
    ],
  );
  assert.equal(tracker.pendingCount(), 0);
});

test('an orphaned (never-resolved) call never yields a bogus duration; nothing matches after its TTL sweep', () => {
  const clock = makeClock(0);
  const tracker = createToolMetricsTracker({ now: clock.now, ttlMs: 1000 });

  tracker.recordIssued('sess-1', [{ id: 'orphan', at: 0 }]);
  assert.equal(tracker.pendingCount(), 1);

  // No result arrives: while it stays pending, nothing is measured or emitted.
  assert.deepEqual(tracker.resolveResults('sess-1', []), []);
  assert.equal(tracker.pendingCount(), 1);

  // After the TTL sweep a late result can no longer match it — no negative/NaN duration exists:
  clock.set(2000);
  assert.deepEqual(tracker.resolveResults('sess-1', [{ toolCallId: 'orphan', at: 2000 }]), []);
  assert.equal(tracker.pendingCount(), 0);
});

test('empty / zero batches are safe on both record and resolve sides', () => {
  const clock = makeClock(1000);
  const tracker = createToolMetricsTracker({ now: clock.now });

  tracker.recordIssued('sess-1', []); // empty issued batch: no-op
  assert.equal(tracker.pendingCount(), 0);
  assert.deepEqual(tracker.resolveResults('sess-1', []), []); // empty results batch: no-op
  // A result with NO tool-call id cannot match any pending call and is skipped safely:
  tracker.recordIssued('sess-1', [{ id: 'known', at: 1000 }]);
  assert.deepEqual(tracker.resolveResults('sess-1', [{ at: 2000 }]), []);
  assert.equal(tracker.pendingCount(), 1);
});

test('the cross-session fallback still resolves by id with that call OWN span', () => {
  const clock = makeClock(4000);
  const tracker = createToolMetricsTracker({ now: clock.now });

  tracker.recordIssued('sess-A', [{ id: 'x', at: 1000, name: 't_x' }]);
  tracker.recordIssued('sess-B', [{ id: 'y', at: 1500 }]);

  // Resolving from a DIVERGING session key (no exact bucket) falls back to the same id in
  // another session and measures THAT call's own issue→result span:
  assert.deepEqual(tracker.resolveResults('sess-C', [{ toolCallId: 'x', at: 3000 }]), [
    { toolCallId: 'x', durationMs: 2000, toolName: 't_x' },
  ]);
  assert.equal(tracker.pendingCount(), 1); // sess-B's distinct call stays untouched
  assert.deepEqual(tracker.resolveResults('sess-C', [{ toolCallId: 'y', at: 3500 }]), [
    { toolCallId: 'y', durationMs: 2000 },
  ]);
  assert.equal(tracker.pendingCount(), 0);
});

// --- monotonic default clock ----------------------------------------------------

test('monotonicEpochMs never steps backward and stays aligned with the wall clock', () => {
  const t0 = monotonicEpochMs();
  const t1 = monotonicEpochMs();
  assert.ok(t1 >= t0, 'successive readings are monotonically non-decreasing');
  assert.ok(Math.abs(monotonicEpochMs() - Date.now()) < 5000, 'stays within 5s of the wall clock');
});

test('the default (uninjected) clock measures exact issue->result spans via monotonicEpochMs', () => {
  const tracker = createToolMetricsTracker(); // no injected clock -> monotonic default
  const t0 = monotonicEpochMs();
  tracker.recordIssued('sess-1', [{ id: 'a', at: t0 }]);
  const t1 = monotonicEpochMs();
  assert.ok(t1 - t0 >= 0, 'a monotonic default clock cannot produce a negative span');
  assert.deepEqual(tracker.resolveResults('sess-1', [{ toolCallId: 'a', at: t1 }]), [
    { toolCallId: 'a', durationMs: t1 - t0 },
  ]);
});
