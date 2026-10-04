import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { applyMigrations, SCHEMA_VERSION, MIGRATIONS } from '../src/storage/schema';

/** A row returned by `StatementSync.all()` / `.get()`: string-keyed SQLite values. */
type Row = Record<string, unknown>;

/** Fresh in-memory database with all migrations applied. */
function migratedDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  applyMigrations(db);
  return db;
}

/** Distinct versions recorded in the `migrations` tracking table (ascending). */
function appliedVersions(db: DatabaseSync): number[] {
  const rows = db.prepare('SELECT version FROM migrations').all() as Row[];
  return rows.map((row) => Number(row.version)).sort((a, b) => a - b);
}

/** Names of tables in sqlite_master. */
function tableNames(db: DatabaseSync): string[] {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Row[];
  return rows.map((row) => String(row.name));
}

/** Names of user-created indexes (sqlite-internal ones excluded). */
function indexNames(db: DatabaseSync): string[] {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'")
    .all() as Row[];
  return rows.map((row) => String(row.name));
}

/** Column names of a table via PRAGMA table_info. */
function columnNames(db: DatabaseSync, table: string): string[] {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Row[];
  return rows.map((row) => String(row.name));
}

/** Columns referenced by any user index on a table (union across indexes). */
function indexedColumns(db: DatabaseSync, table: string): Set<string> {
  const list = db.prepare(`PRAGMA index_list(${table})`).all() as Row[];
  const columns = new Set<string>();
  for (const row of list) {
    if (typeof row.name !== 'string') continue; // skip automatic (unnamed) indexes
    const info = db.prepare(`PRAGMA index_info(${row.name})`).all() as Row[];
    for (const column of info) {
      if (typeof column.name === 'string') columns.add(column.name);
    }
  }
  return columns;
}

// --- schema constants -------------------------------------------------------

test('SCHEMA_VERSION equals the highest declared migration version', () => {
  assert.equal(SCHEMA_VERSION, Math.max(...MIGRATIONS.map((migration) => migration.version)));
});

test('MIGRATIONS are unique and ordered ascending', () => {
  const versions = MIGRATIONS.map((migration) => migration.version);
  assert.equal(new Set(versions).size, versions.length);
  assert.deepEqual([...versions].sort((a, b) => a - b), versions);
});

// --- tables + indexes exist -------------------------------------------------

test('applyMigrations creates the expected tables', () => {
  const tables = tableNames(migratedDb());
  assert.ok(tables.includes('tool_calls'), `missing tool_calls in ${tables}`);
  assert.ok(tables.includes('interventions'), `missing interventions in ${tables}`);
  assert.ok(tables.includes('migrations'), `missing migrations in ${tables}`);
});

test('applyMigrations creates the expected indexes', () => {
  const indexes = indexNames(migratedDb());
  for (const expected of [
    'idx_tool_calls_tool_name',
    'idx_tool_calls_session_key',
    'idx_interventions_rule_id',
    'idx_interventions_created_at',
  ]) {
    assert.ok(indexes.includes(expected), `missing index ${expected} in ${indexes}`);
  }
});

test('indexes cover the specified columns', () => {
  const db = migratedDb();
  const toolCallCols = indexedColumns(db, 'tool_calls');
  assert.ok(toolCallCols.has('tool_name'));
  assert.ok(toolCallCols.has('session_key'));
  const interventionCols = indexedColumns(db, 'interventions');
  assert.ok(interventionCols.has('rule_id'));
  assert.ok(interventionCols.has('created_at'));
});

// --- columns ---------------------------------------------------------------

test('tool_calls has the specified columns', () => {
  assert.deepEqual(columnNames(migratedDb(), 'tool_calls'), [
    'id',
    'session_key',
    'client_id',
    'tool_name',
    'args_json',
    'created_at',
  ]);
});

test('interventions has the specified columns', () => {
  assert.deepEqual(columnNames(migratedDb(), 'interventions'), [
    'id',
    'session_key',
    'rule_id',
    'action',
    'detail',
    'created_at',
  ]);
});

// --- idempotency -----------------------------------------------------------

test('re-running applyMigrations on the same db is a no-op with no duplicate rows', () => {
  const db = new DatabaseSync(':memory:');
  applyMigrations(db);
  const before = appliedVersions(db);
  applyMigrations(db); // must not throw
  const after = appliedVersions(db);
  const expected = [...MIGRATIONS].map((migration) => migration.version).sort((a, b) => a - b);
  assert.deepEqual(before, expected);
  assert.deepEqual(after, before);
  assert.equal(new Set(after).size, after.length, 'no duplicate migration versions recorded');
  // schema still present after the second pass
  assert.ok(tableNames(db).includes('tool_calls'));
});

// --- basic insert round-trip ----------------------------------------------

test('inserting a tool_call row and reading it back works after migration', () => {
  const db = migratedDb();
  const at = 1_700_000_000_000;
  const result = db
    .prepare(
      'INSERT INTO tool_calls (session_key, client_id, tool_name, args_json, created_at) VALUES (?, ?, ?, ?, ?)',
    )
    .run('sess-1', 'client-A', 'bash', JSON.stringify({ cmd: 'ls' }), at);
  assert.equal(result.changes, 1);

  const row = (db.prepare('SELECT * FROM tool_calls WHERE session_key = ? AND tool_name = ?').get(
    'sess-1',
    'bash',
  ) as Row | undefined);
  assert.ok(row, 'expected the inserted tool_calls row to be read back');
  assert.equal(row.session_key, 'sess-1');
  assert.equal(row.client_id, 'client-A');
  assert.equal(row.tool_name, 'bash');
  assert.equal(row.args_json, JSON.stringify({ cmd: 'ls' }));
  assert.equal(row.created_at, at);
});

test('inserting an intervention row and reading it back works after migration', () => {
  const db = migratedDb();
  const at = 1_700_000_000_001;
  const result = db
    .prepare(
      'INSERT INTO interventions (session_key, rule_id, action, detail, created_at) VALUES (?, ?, ?, ?, ?)',
    )
    .run('sess-1', 'rule-loop', 'injectMessage', 'you are looping', at);
  assert.equal(result.changes, 1);

  const row = (db.prepare('SELECT * FROM interventions WHERE rule_id = ?').get('rule-loop') as
    | Row
    | undefined);
  assert.ok(row, 'expected the inserted interventions row to be read back');
  assert.equal(row.session_key, 'sess-1');
  assert.equal(row.rule_id, 'rule-loop');
  assert.equal(row.action, 'injectMessage');
  assert.equal(row.detail, 'you are looping');
  assert.equal(row.created_at, at);
});
