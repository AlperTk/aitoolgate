/**
 * SQLite schema + ordered migrations for the storage layer, built on Node's
 * built-in {@link https://nodejs.org/api/sqlite.html `node:sqlite`}
 * (`DatabaseSync`) — no external dependency.
 *
 * Column naming mirrors the telemetry event fields
 * (`src/telemetry/events.ts`) so the persistence mapping stays obvious:
 * `session_key` ← `sessionKey`, `client_id` ← `clientId`, `tool_name` ←
 * `toolName`, `args_json` ← `args`, `created_at` ← `at`, `rule_id` ← `ruleId`,
 * `action` ← `action`, `detail` ← `detail`.
 */
import type { DatabaseSync } from 'node:sqlite';

/** The highest migration version applied by {@link applyMigrations}. */
export const SCHEMA_VERSION = 3;

export interface Migration {
  /** Monotonically increasing, unique, ascending version number. */
  version: number;
  /** One or more SQL statements (separated by `;`) run via `db.exec`. */
  sql: string;
}

/**
 * Ordered list of schema migrations. Version 1 creates the two core tables
 * backing the telemetry stream plus their indexes, all `IF NOT EXISTS` so the
 * DDL is safe to re-run.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS tool_calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_key TEXT NOT NULL,
        client_id TEXT,
        tool_name TEXT NOT NULL,
        args_json TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tool_calls_tool_name ON tool_calls (tool_name);
      CREATE INDEX IF NOT EXISTS idx_tool_calls_session_key ON tool_calls (session_key);
      CREATE TABLE IF NOT EXISTS interventions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_key TEXT NOT NULL,
        rule_id TEXT NOT NULL,
        action TEXT NOT NULL,
        detail TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_interventions_rule_id ON interventions (rule_id);
      CREATE INDEX IF NOT EXISTS idx_interventions_created_at ON interventions (created_at);
    `,
  },
  {
    version: 2,
    sql: `
      CREATE TABLE IF NOT EXISTS tool_results (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        chars INTEGER NOT NULL,
        ok INTEGER,
        at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tool_results_at ON tool_results (at);
    `,
  },
  {
    // Version 3 adds the typed API-provider registry backing runtime-switchable
    // upstream configuration (`/api/api-providers/*`). All DDL stays idempotent so
    // re-running migrations on an existing database remains a safe no-op.
    version: 3,
    sql: `
      CREATE TABLE IF NOT EXISTS api_providers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        base_url TEXT NOT NULL,
        model TEXT NOT NULL,
        api_key TEXT,
        protocol TEXT NOT NULL DEFAULT 'openai',
        is_active INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
    `,
  },
];

/**
 * Apply every not-yet-recorded {@linkcode MIGRATIONS} entry in ascending order
 * to the given database, recording each applied version in a `migrations`
 * tracking table.
 *
 * Idempotent: calling it again on the same database is a no-op (already-applied
 * versions are skipped and no duplicate tracking rows are inserted). Each
 * migration's `sql` may contain multiple statements; it is executed with
 * `db.exec`, which runs them as a batch.
 */
export function applyMigrations(db: DatabaseSync): void {
  db.exec('CREATE TABLE IF NOT EXISTS migrations (version INTEGER PRIMARY KEY)');

  const applied = new Set(
    db.prepare('SELECT version FROM migrations').all().map((row) => Number(row.version)),
  );

  // Apply in ascending order regardless of declaration order.
  for (const migration of [...MIGRATIONS].sort((a, b) => a.version - b.version)) {
    if (applied.has(migration.version)) continue;
    db.exec(migration.sql);
    db.prepare('INSERT INTO migrations (version) VALUES (?)').run(migration.version);
  }
}
