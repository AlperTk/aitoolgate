import type { PolicyEvent } from './domain';

/** A subscriber to domain events. */
export type EventListener = (event: PolicyEvent) => void | Promise<void>;

/**
 * Observer: publish domain events to subscribers (telemetry, dashboard).
 */
export interface EventBus {
  /** Subscribe a listener; returns an unsubscribe function. */
  subscribe(listener: EventListener): () => void;
  /** Emit an event to all subscribers. */
  emit(event: PolicyEvent): Promise<void>;
}
