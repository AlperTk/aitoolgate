import type { Rule, PolicyEvent } from './domain';

/**
 * Repository over persisted rules and events (Repository pattern).
 * SQLite is the default implementation; swappable (e.g. Postgres) later.
 */
export interface Storage {
  getRule(id: string): Promise<Rule | null>;
  listRules(): Promise<Rule[]>;
  saveRule(rule: Rule): Promise<void>;

  getEvent(id: string): Promise<PolicyEvent | null>;
  listEvents(filter?: Record<string, unknown>): Promise<PolicyEvent[]>;
  saveEvent(event: PolicyEvent): Promise<void>;

  /** Query aggregated statistics (e.g. counts, top tools). */
  queryAggregates(query?: Record<string, unknown>): Promise<Record<string, unknown>>;

  /** Release underlying resources. */
  close(): Promise<void>;
}
