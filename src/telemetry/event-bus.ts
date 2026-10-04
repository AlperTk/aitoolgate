/**
 * In-memory telemetry event bus (Observer pattern). Synchronous, timer-free
 * dispatch for the {@link TelemetryEvent} union.
 *
 * Relationship to the port's `EventBus` (`src/ports/event-bus.ts`):
 *
 * This mirrors that port's **observable method surface** — the same method names
 * (`subscribe` returns an unsubscribe function; `emit` returns `Promise<void>`)
 * and the same synchronous-dispatch semantics — but **specialized** so handlers
 * receive the concrete, field-typed {@link TelemetryEvent} union rather than the
 * generic {@link PolicyEvent} payload bag. Because `TelemetryEvent` is a strict
 * narrowing of the port's event space, the returned bus is used wherever a
 * telemetry `TelemetryEventBus` is expected (e.g. wiring the live dashboard),
 * rather than as a raw structural subtype of the generic `EventBus` interface.
 */
import type { TelemetryEvent } from './events';

/** A telemetry subscriber: invoked synchronously with each published event. */
export type EventHandler = (event: TelemetryEvent) => void | Promise<void>;

/** An in-memory, telemetry-specialized event bus. */
export interface TelemetryEventBus {
  /** Subscribe a handler; returns an unsubscribe function. */
  subscribe(handler: EventHandler): () => void;
  /** Emit an event to all current subscribers (synchronous dispatch). */
  emit(event: TelemetryEvent): Promise<void>;
}

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
