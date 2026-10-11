/**
 * SQLite-backed {@link TelemetryStorage} repository (slice 6c-ii of
 * telemetry/storage).
 *
 * Built on Node's built-in {@link https://nodejs.org/api/sqlite.html
 * `node:sqlite`} (`DatabaseSync`) — no external dependency. It persists the
 * telemetry stream (tool calls + policy interventions) over the table layout in
 * {@link module:./schema|`schema.ts`} and answers the aggregate queries the
 * live dashboard needs (counts, top tools, newest-first intervention log).
 *
 * Relationship to the port (`src/ports/telemetry.ts` {@link TelemetryStorage}):
 *
 * It satisfies the port's telemetry-specific write surface
 * ({@link SqliteStorage.recordToolCall} / `recordIntervention`) and adds the
 * concrete field-typed write methods operating on the {@link ToolCallEvent} /
 * {@link InterventionEvent} union plus aggregate queries
 * ({@link SqliteStorage.getCounts} / `getTopTools` / `getInterventions`). It
 * also exposes a broader rule/event persistence surface (the `getRule` /
 * `listRules` / `saveRule`, `getEvent` / `listEvents` / `saveEvent`,
 * `queryAggregates`, `close` methods) which persists as JSON rows so the whole
 * object stays genuinely SQLite-backed and consistent across re-opens.
 *
 * The single deliberate specialization is `close()`: it is **synchronous**
 * (`void`) because `DatabaseSync.close()` is synchronous. Like `TelemetryEventBus`
 * satisfying the {@link TelemetryEventBus} port, a returned {@link SqliteStorage}
 * is used wherever a specialized telemetry storage is expected.
 */
import { DatabaseSync } from 'node:sqlite';
import { applyMigrations } from './schema';
import type { Rule, PolicyEvent } from '../ports/domain';
import type { TelemetryStorage } from '../ports/telemetry';
import type { ToolCallEvent, InterventionEvent } from '../telemetry/events';

/** Options for {@link createSqliteStorage}. */
export interface SqliteStorageOptions {
  /** Path to the SQLite database file. Defaults to `':memory:'` (in-memory). */
  file?: string;
}

/** A ranked entry in the top-tools list. */
export interface TopTool {
  /** The tool name. */
  toolName: string;
  /** How many times it was called. */
  count: number;
}

/** Aggregated tool-call counts (mirrors the in-memory collector's shape). */
export interface Counts {
  /** Count of persisted tool calls. */
  totalCalls: number;
  /** Tool-call counts keyed by tool name. */
  perTool: Record<string, number>;
}

/**
 * A SQLite-backed storage repository specialized for the telemetry stream.
 *
 * Satisfies the {@link TelemetryStorage} port plus the concrete
 * telemetry-specific write/query methods; see the module doc comment for the
 * relationship (the only specialization is the synchronous `close()`).
 */
export interface SqliteStorage {
  // --- concrete telemetry API (the primary purpose) -------------------------
  /** Persist a tool call (`tool_calls` row). */
  recordToolCall(evt: ToolCallEvent): void;
  /** Persist a policy intervention (`interventions` row). */
  recordIntervention(evt: InterventionEvent): void;
  /** Total call count plus per-tool counts. */
  getCounts(): Counts;
  /** Calls ranked descending by count (ties alphabetical); all when `n` omitted. */
  getTopTools(n?: number): TopTool[];
  /** Interventions newest-first, capped at `limit`. */
  getInterventions(limit?: number): InterventionEvent[];
  /** Clear all rows from both telemetry tables (for testing / reset). */
  reset(): void;
  /** Close the underlying database synchronously. */
  close(): void;

  // --- broader rule/event persistence surface ------------------------------
  /** Load a rule by id, or `null` if absent. */
  getRule(id: string): Promise<Rule | null>;
  /** List all rules. */
  listRules(): Promise<Rule[]>;
  /** Create or replace a rule. */
  saveRule(rule: Rule): Promise<void>;
  /** Load an event by id, or `null` if absent. */
  getEvent(id: string): Promise<PolicyEvent | null>;
  /** List events, optionally filtered by matching top-level fields. */
  listEvents(filter?: Record<string, unknown>): Promise<PolicyEvent[]>;
  /** Create or replace an event. */
  saveEvent(event: PolicyEvent): Promise<void>;
  /** Aggregate snapshot (counts + top tools), mirroring the dashboard queries. */
  queryAggregates(query?: Record<string, unknown>): Promise<Record<string, unknown>>;
}

/** A row returned by `StatementSync.all()` / `.get()`: string-keyed values. */
type Row = Record<string, unknown>;

/** Map a stored `interventions` row back onto an {@link InterventionEvent}. */
function toInterventionEvent(row: Row): InterventionEvent {
  return {
    type: 'policy.intervention',
    sessionKey: String(row.session_key),
    ruleId: String(row.rule_id),
    action: row.action as InterventionEvent['action'],
    detail: row.detail == null ? undefined : String(row.detail),
    at: Number(row.created_at),
  };
}

/** Coerce an optional positive-integer bound out of an aggregate query object. */
function readLimit(query?: Record<string, unknown>): number | undefined {
  const value = typeof query === 'object' && query !== null ? (query.n ?? query.limit) : undefined;
  return typeof value === 'number' ? value : undefined;
}

/**
 * Create a {@link SqliteStorage} backed by Node's built-in SQLite.
 *
 * Opens `options.file` (default `':memory:'`) as a {@link DatabaseSync}, applies
 * the ordered schema migrations from `schema.ts`, and returns an object exposing
 * both the concrete telemetry API and the `Storage` port's method surface.
 */
export function createSqliteStorage(options: SqliteStorageOptions = {}): SqliteStorage {
  const file = options.file ?? ':memory:';
  const db = new DatabaseSync(file);
  applyMigrations(db);

  // Extra tables backing the general rule/event side of the Storage port.
  // Kept separate from `schema.ts`'s telemetry migrations so that file stays
  // focused on the telemetry tables while this repository stays fully backed.
  db.exec(
    `CREATE TABLE IF NOT EXISTS rules (id TEXT PRIMARY KEY, data_json TEXT NOT NULL);
     CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, data_json TEXT NOT NULL);`,
  );

  // One shared prepared-statement setup reused across every operation below.
  const insertToolCall = db.prepare(
    'INSERT INTO tool_calls (session_key, client_id, tool_name, args_json, created_at) VALUES (?, ?, ?, ?, ?)',
  );
  const insertIntervention = db.prepare(
    'INSERT INTO interventions (session_key, rule_id, action, detail, created_at) VALUES (?, ?, ?, ?, ?)',
  );
  const GROUP_BY_TOOL =
    'SELECT tool_name, COUNT(*) AS c FROM tool_calls GROUP BY tool_name ORDER BY c DESC, tool_name ASC';
  const groupByTool = db.prepare(GROUP_BY_TOOL);
  const groupByToolLimit = db.prepare(`${GROUP_BY_TOOL} LIMIT ?`);
  const INTERVEN_NEWEST_FIRST =
    'SELECT session_key, rule_id, action, detail, created_at FROM interventions ORDER BY created_at DESC, id DESC';
  const interventionsAll = db.prepare(INTERVEN_NEWEST_FIRST);
  const interventionsLimit = db.prepare(`${INTERVEN_NEWEST_FIRST} LIMIT ?`);
  const insertRule = db.prepare('INSERT OR REPLACE INTO rules (id, data_json) VALUES (?, ?)');
  const selectRule = db.prepare('SELECT data_json FROM rules WHERE id = ?');
  const allRules = db.prepare('SELECT data_json FROM rules');
  const insertEvent = db.prepare('INSERT OR REPLACE INTO events (id, data_json) VALUES (?, ?)');
  const selectEvent = db.prepare('SELECT data_json FROM events WHERE id = ?');
  const allEvents = db.prepare('SELECT data_json FROM events');

  const recordToolCall = (evt: ToolCallEvent): void => {
    insertToolCall.run(
      evt.sessionKey,
      evt.clientId ?? null,
      evt.toolName,
      evt.args == null ? null : JSON.stringify(evt.args),
      Date.now(),
    );
  };

  const recordIntervention = (evt: InterventionEvent): void => {
    insertIntervention.run(
      evt.sessionKey,
      evt.ruleId,
      String(evt.action),
      evt.detail ?? null,
      Date.now(),
    );
  };

  const getCounts = (): Counts => {
    let totalCalls = 0;
    const perTool: Record<string, number> = {};
    for (const row of groupByTool.all() as Row[]) {
      const count = Number(row.c);
      perTool[String(row.tool_name)] = count;
      totalCalls += count;
    }
    return { totalCalls, perTool };
  };

  const getTopTools = (n?: number): TopTool[] => {
    const rows =
      n === undefined
        ? (groupByTool.all() as Row[])
        : (groupByToolLimit.all(Math.max(0, n)) as Row[]);
    return rows.map((row) => ({ toolName: String(row.tool_name), count: Number(row.c) }));
  };

  const getInterventions = (limit?: number): InterventionEvent[] => {
    const rows =
      limit === undefined
        ? (interventionsAll.all() as Row[])
        : (interventionsLimit.all(Math.max(0, limit)) as Row[]);
    return rows.map(toInterventionEvent);
  };

  const reset = (): void => {
    // Both telemetry tables only (see spec); the rule/event tables are left
    // intact so a reset keeps the repository usable, not just the telemetry.
    db.exec('DELETE FROM tool_calls; DELETE FROM interventions;');
  };

  const close = (): void => {
    db.close();
  };

  // Storage-port observable surface ------------------------------------------
  const getRule = async (id: string): Promise<Rule | null> => {
    const row = selectRule.get(id) as Row | undefined;
    return row === undefined ? null : (JSON.parse(String(row.data_json)) as Rule);
  };

  const listRules = async (): Promise<Rule[]> =>
    (allRules.all() as Row[]).map((row) => JSON.parse(String(row.data_json)) as Rule);

  const saveRule = async (rule: Rule): Promise<void> => {
    insertRule.run(rule.id, JSON.stringify(rule));
  };

  const getEvent = async (id: string): Promise<PolicyEvent | null> => {
    const row = selectEvent.get(id) as Row | undefined;
    return row === undefined ? null : (JSON.parse(String(row.data_json)) as PolicyEvent);
  };

  const listEvents = async (filter?: Record<string, unknown>): Promise<PolicyEvent[]> => {
    const events = (allEvents.all() as Row[]).map(
      (row) => JSON.parse(String(row.data_json)) as Record<string, unknown>,
    );
    const filtered = filter
      ? events.filter((event) =>
          Object.entries(filter).every(([key, value]) => event[key] === value),
        )
      : events;
    return filtered.map((event) => event as unknown as PolicyEvent);
  };

  const saveEvent = async (event: PolicyEvent): Promise<void> => {
    insertEvent.run(event.id, JSON.stringify(event));
  };

  const queryAggregates = async (
    query?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => ({
    ...getCounts(),
    topTools: getTopTools(readLimit(query)),
  });

  return {
    recordToolCall,
    recordIntervention,
    getCounts,
    getTopTools,
    getInterventions,
    reset,
    close,
    getRule,
    listRules,
    saveRule,
    getEvent,
    listEvents,
    saveEvent,
    queryAggregates,
  };
}
