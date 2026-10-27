/**
 * In-memory telemetry event bus (Observer pattern). Synchronous, timer-free
 * dispatch for the {@link TelemetryEvent} union.
 *
 * Relationship to the port (`src/ports/telemetry.ts` {@link TelemetryEventBus}):
 *
 * This mirrors that port's **observable method surface** — the same method names
 * (`subscribe` returns an unsubscribe function; `emit` returns `Promise<void>`)
 * and the same synchronous-dispatch semantics — so the returned bus structurally
 * satisfies the port. Because {@link TelemetryEvent} is a strict, field-typed
 * narrowing of the generic {@link PolicyEvent} payload bag, a returned bus is used
 * wherever a telemetry `TelemetryEventBus` is expected (e.g. wiring the live
 * dashboard or the model proxy).
 */
import type { TelemetryEvent } from './events';
import type { TelemetryEventBus } from '../ports/telemetry';

/** Re-exported so existing `telemetry/event-bus` importers keep resolving to the single port definition. */
export type { TelemetryEventBus };

/** A telemetry subscriber: invoked synchronously with each published event. */
export type EventHandler = (event: TelemetryEvent) => void | Promise<void>;

/**
 * Create an in-memory {@link TelemetryEventBus}.
 *
 * - `subscribe` returns an unsubscribe function that removes the handler; once
 *   unsubscribed (or disposed) it no longer receives events.
 * - `emit` synchronously invokes every *current* subscriber within the same turn
 *   and resolves. Each handler runs in isolation: a handler that throws or
 *   rejects is swallowed so it can never prevent the remaining handlers from
 *   being called.
 * - Purely in-memory: no timers, no I/O, no retained history.
 */
export function createEventBus(): TelemetryEventBus {
  const handlers = new Set<EventHandler>();

  return {
    subscribe(handler: EventHandler): () => void {
      handlers.add(handler);
      let removed = false;
      return () => {
        if (!removed) {
          removed = true;
          handlers.delete(handler);
        }
      };
    },
    emit(event: TelemetryEvent): Promise<void> {
      // Snapshot so a handler unsubscribing itself mid-dispatch cannot corrupt
      // the iteration; every *current* subscriber is dispatched this turn.
      for (const handler of [...handlers]) {
        try {
          const maybe: void | Promise<void> = handler(event);
          if (typeof (maybe as Promise<void>)?.then === 'function') {
            (maybe as Promise<void>).catch(() => {}); // swallow async rejection
          }
        } catch {
          // Swallow synchronous throw so later handlers still run.
        }
      }
      return Promise.resolve();
    },
  };
}
