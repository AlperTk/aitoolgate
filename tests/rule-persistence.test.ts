/**
 * Rule-persistence contract tests ("rules survive restart").
 *
 * These drive the REAL {@link createServer} end-to-end against an EXPLICIT,
 * unique SQLite path under `os.tmpdir()` (never the repo's `data/rules.db`),
 * so a rule written on one server instance is rehydrated by a second instance
 * pointed at the SAME file, and deletions are reflected on disk.
 *
 * Config is controlled through the environment because `createServer` resolves
 * its config via `loadConfig()`: `RULES_DB_PATH` picks the DB file and
 * `RULES_ENABLED` toggles persistence. Each test restores both after itself and
 * cleans up its temp files, so there is no cross-test / cross-file pollution.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { loadConfig } from '../config/config';
import { createServer } from '../src/server/index';
import type { McmServer, McmServerHandle } from '../src/server/index';
import { flagshipLoopRule } from '../src/policy/ruleEngine';
import type { RuleSpec } from '../src/api/ruleSpec';

// --- environment management ---------------------------------------------------

const ORIGINAL_RULES_ENV: { dbPath?: string; enabled?: string } = {
  dbPath: process.env.RULES_DB_PATH,
  enabled: process.env.RULES_ENABLED,
};

function setRulesEnv(opts: { dbPath?: string; enabled?: string }): void {
  if (opts.dbPath === undefined) delete process.env.RULES_DB_PATH;
  else process.env.RULES_DB_PATH = opts.dbPath;
  if (opts.enabled === undefined) delete process.env.RULES_ENABLED;
  else process.env.RULES_ENABLED = opts.enabled;
}

function restoreRulesEnv(): void {
  setRulesEnv(ORIGINAL_RULES_ENV);
}

// --- lifecycle helpers --------------------------------------------------------

let pendingServers: McmServer[] = [];
let tempDirs: string[] = [];
let originalCwd: string | undefined;

function uniqueDbPath(): { dir: string; dbPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rules-persist-'));
  tempDirs.push(dir);
  return { dir, dbPath: path.join(dir, `${randomBytes(6).toString('hex')}.db`) };
}

async function startServer(): Promise<McmServer> {
  const srv = createServer(0); // auto-listens on an ephemeral port
  pendingServers.push(srv);
  await new Promise<void>((resolve) => {
    if (srv.listening) resolve();
    else srv.once('listening', () => resolve());
  });
  const addr = srv.address();
  if (addr === null || typeof addr !== 'object') throw new Error('server did not bind a TCP port');
  if (srv.mcm === undefined) throw new Error('the server.mcm test handle was not attached');
  return srv;
}

function portOf(srv: McmServer): number {
  const addr = srv.address();
  if (addr === null || typeof addr !== 'object') throw new Error('server did not bind a TCP port');
  return addr.port;
}

/** The non-undefined test handle attached to a started server. */
function handle(srv: McmServer): McmServerHandle {
  const mcm = srv.mcm;
  if (mcm === undefined) throw new Error('the server.mcm test handle was not attached');
  return mcm;
}

/** Idempotent + error-tolerant close so a server can be closed by both the test and afterEach. */
async function closeServer(srv?: McmServer): Promise<void> {
  if (srv === undefined) return;
  try {
    srv.closeAllConnections();
  } catch {
    // ignore — already closing/closed
  }
  await new Promise<void>((resolve) => {
    try {
      srv.close(() => resolve());
    } catch {
      resolve();
    }
  });
}

afterEach(async () => {
  for (const srv of pendingServers) await closeServer(srv);
  pendingServers = [];
  restoreRulesEnv();
  if (originalCwd !== undefined) {
    try {
      process.chdir(originalCwd);
    } catch {
      // ignore
    }
    originalCwd = undefined;
  }
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
  tempDirs = [];
});

// --- data helpers -------------------------------------------------------------

/** Yield one macrotask so any deferred write-through microtask has committed to disk. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Read every persisted rule row (parsed `data_json`) from a SQLite file. */
function persistedRules(dbPath: string): Record<string, unknown>[] {
  const db = new DatabaseSync(dbPath);
  try {
    return (db.prepare('SELECT data_json FROM rules').all() as Array<Record<string, unknown>>).map(
      (row) => JSON.parse(String(row.data_json)) as Record<string, unknown>,
    );
  } finally {
    db.close();
  }
}

const baseFor = (port: number): string => `http://127.0.0.1:${port}`;

const SPEC: RuleSpec = {
  enabled: true,
  description: 'persist-me',
  matcher: { type: 'loop', window: 4 },
  action: { type: 'injectMessage', role: 'user', content: 'hello' },
};

/** POST a valid spec over the REST API; returns the assigned id + the faithful response body. */
async function postRule(port: number, spec: RuleSpec): Promise<{ id: string; body: RuleSpec }> {
  const res = await fetch(baseFor(port) + '/api/rules', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(spec),
  });
  assert.equal(res.status, 201);
  const body = (await res.json()) as RuleSpec & { id: string };
  assert.ok(typeof body.id === 'string' && body.id.length > 0);
  return { id: body.id, body };
}

// --- tests --------------------------------------------------------------------

test('a user rule created/updated on server A survives a restart into server B, and DELETE is reflected in the DB', async () => {
  const { dbPath } = uniqueDbPath();
  setRulesEnv({ dbPath });

  // Server A: create via REST, then update (toggle enabled) — both mirror through to SQLite.
  const a = await startServer();
  const { id } = await postRule(portOf(a), SPEC);
  const patch = await fetch(baseFor(portOf(a)) + `/api/rules/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: false }),
  });
  assert.equal(patch.status, 200);
  await flush(); // let the deferred write-through commit
  await closeServer(a);

  // On disk: exactly one row, with the correct (updated) fields.
  const rows = persistedRules(dbPath);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    id,
    enabled: false,
    description: 'persist-me',
    matcher: { type: 'loop', window: 4 },
    action: { type: 'injectMessage', role: 'user', content: 'hello' },
  });

  // Server B against the SAME dbPath: the rule is rehydrated from disk.
  const b = await startServer();
  const listed = (await (await fetch(baseFor(portOf(b)) + '/api/rules')).json()) as Array<{ id: string }>;
  assert.ok(listed.some((rule) => rule.id === id), 'the persisted rule must be present after restart');

  // DELETE on B is written straight back through to the DB file.
  const del = await fetch(baseFor(portOf(b)) + `/api/rules/${id}`, { method: 'DELETE' });
  assert.equal(del.status, 204);
  await flush();
  await closeServer(b);
  assert.ok(!persistedRules(dbPath).some((row) => row.id === id), 'the deleted rule must be gone from the DB');
});

test('default-on: no explicit rules config resolves data/rules.db and now persists via an auto-created parent dir', async () => {
  // (i) The resolved DEFAULT rules config still points at `data/rules.db`, enabled.
  const cfg = loadConfig({});
  assert.equal(cfg.rules.enabled, true);
  assert.equal(cfg.rules.dbPath, 'data/rules.db');

  // (ii) Point RULES_DB_PATH at a unique temp NESTED path whose parent dir does NOT exist yet.
  const { dir, dbPath } = uniqueDbPath();
  const nestedDb = path.join(dir, 'nested', path.basename(dbPath));
  setRulesEnv({ dbPath: nestedDb }); // RULES_ENABLED unset -> defaults to true
  assert.equal(fs.existsSync(path.dirname(nestedDb)), false, 'the nested parent dir must not pre-exist');

  // Boots without throwing; the missing `nested/` parent dir is auto-created so persistence works.
  const a = await startServer();
  const { id } = await postRule(portOf(a), SPEC);
  await flush(); // let the deferred write-through commit
  await closeServer(a);

  assert.ok(fs.existsSync(path.dirname(nestedDb)), 'the nested parent dir must be auto-created before opening the DB');
  assert.ok(fs.existsSync(nestedDb), 'the DB file must exist once its parent dir is auto-created');

  // Restarting against the same nested path rehydrates the rule from disk.
  const b = await startServer();
  const listed = (await (await fetch(baseFor(portOf(b)) + '/api/rules')).json()) as Array<{ id: string }>;
  assert.ok(listed.some((rule) => rule.id === id), 'the persisted rule must survive a restart on the nested path');
  await closeServer(b);
});

test('flagship-loop-rule is never persisted (absent from disk after a save) while other rules are', async () => {
  const { dbPath } = uniqueDbPath();
  setRulesEnv({ dbPath });

  const a = await startServer();
  handle(a).ruleStore.add(flagshipLoopRule()); // write-through skips this id by design
  const { id } = await postRule(portOf(a), SPEC); // a normal user rule that SHOULD persist
  await flush();
  await closeServer(a);

  const rows = persistedRules(dbPath);
  assert.ok(!rows.some((row) => row.id === 'flagship-loop-rule'), 'flagship rule must not be on disk');
  assert.ok(rows.some((row) => row.id === id), 'the user rule must be on disk alongside it');

  // Rehydrated server B sees the user rule but not the flagship.
  const b = await startServer();
  const listed = (await (await fetch(baseFor(portOf(b)) + '/api/rules')).json()) as Array<{ id: string }>;
  assert.ok(listed.some((rule) => rule.id === id));
  assert.ok(!listed.some((rule) => rule.id === 'flagship-loop-rule'));
});

test('rules.enabled=false yields a non-persistent in-memory store (no DB file, nothing survives restart)', async () => {
  const { dbPath } = uniqueDbPath();
  setRulesEnv({ dbPath, enabled: 'false' });

  const a = await startServer();
  const { id } = await postRule(portOf(a), SPEC);
  assert.ok(id.length > 0);
  await flush();
  await closeServer(a);

  assert.equal(fs.existsSync(dbPath), false, 'no SQLite file should exist when rules persistence is disabled');

  const b = await startServer();
  const listed = (await (await fetch(baseFor(portOf(b)) + '/api/rules')).json()) as Array<{ id: string }>;
  assert.equal(listed.length, 0, 'the rule must not survive a restart with persistence disabled');
});

// Representative spec for EACH of the four action types, carrying the params that
// must survive a restart intact in the REST view.
const ACTION_SPECS: RuleSpec[] = [
  {
    enabled: true,
    description: 'block-rule',
    matcher: { type: 'toolName', toolName: 'bash' },
    action: { type: 'block', reason: 'spam', message: 'no spam', template: 'blocked {tool} {reason}' },
  },
  {
    enabled: true,
    description: 'hide-rule',
    matcher: { type: 'toolName', toolName: 'search_web' },
    action: { type: 'hideTool', toolNames: ['search_web', 'fetch_url'] },
  },
  {
    enabled: true,
    description: 'rewrite-rule',
    matcher: { type: 'toolName', toolName: 'bash' },
    action: { type: 'rewriteArgs', toolName: 'bash', arguments: { cmd: 'echo hi' }, mode: 'merge' },
  },
  {
    enabled: true,
    description: 'inject-rule',
    matcher: { type: 'always' },
    action: { type: 'injectMessage', role: 'system', content: 'stay focused' },
  },
];

test('every action type survives a restart with its TYPE AND params unchanged in the REST view', async () => {
  for (const spec of ACTION_SPECS) {
    const { dbPath } = uniqueDbPath();
    setRulesEnv({ dbPath });

    // Server A: create via REST; the faithful spec is mirrored through to SQLite.
    const a = await startServer();
    const { id } = await postRule(portOf(a), spec);
    await flush(); // let the deferred write-through commit to disk
    await closeServer(a);

    // Server B against the SAME dbPath: the rule is rehydrated from disk, and the
    // REST GET must return the identical action type + params (not a placeholder).
    const b = await startServer();
    const listed = (await (await fetch(baseFor(portOf(b)) + '/api/rules')).json()) as RuleSpec[];
    const found = listed.find((rule) => rule.id === id);
    assert.ok(found !== undefined, `the ${spec.action.type} rule must be present after restart`);
    assert.deepEqual(found!.action, spec.action, `${spec.action.type}: action type + params must survive a restart`);
    assert.deepEqual(found!.matcher, spec.matcher, `${spec.action.type}: matcher fields must survive a restart`);
    await closeServer(b);
  }
});
