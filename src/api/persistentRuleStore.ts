/**
 * Write-through {@link RuleStore} over a base in-memory store + a SQLite-backed
 * {@link SqliteStorage}, so user-created/changed rules survive restarts.
 *
 * The base in-memory store remains the PRIMARY read path (list / get / size /
 * reset); only mutations mirror through to SQLite:
 *   - `add`    -> saveRule (deferred one microtask so the REST layer's spec map
 *                 has landed for full fidelity)
 *   - `update` -> saveRule (only when a rule was actually updated; skipped when
 *                 the id is unknown)
 *   - `remove` -> DELETE FROM rules WHERE id = ?
 *
 * Rules are stored as their JSON-serializable {@link RuleSpec}: a {@link PolicyRule}'s
 * matcher/action are closures that would be dropped by `JSON.stringify`, so they
 * cannot round-trip on their own. On boot the persisted specs are rehydrated via
 * {@link buildRuleFromSpec}. The built-in `flagshipLoopRule` is never persisted.
 *
 * The shared {@link createPersistentStore} base holds the `openDb` / queueMicrotask
 * defer / `DELETE … WHERE id = ?` + warn + finally-close boilerplate; the
 * domain-specific "skip the flagship" behavior lives in the `seed` / `persist`
 * callbacks below. Persistence is best-effort: a failing read/write logs a
 * warning and leaves the in-memory store untouched, so the server always boots
 * (see requirement: fall back to a non-persistent store).
 */
import { DatabaseSync } from 'node:sqlite';
import type { RuleStore } from './ruleStore';
import type { SqliteStorage } from '../storage/sqlite';
import type { Rule } from '../ports/domain';
import { buildRuleFromSpec, describeRule, validateSpec } from './ruleSpec';
import type { RuleSpec } from './ruleSpec';
import { createPersistentStore, openDb } from './crudStore';

/** Built-in loop-detection rule id; never persisted across restarts. */
const FLAGSHIP_RULE_ID = 'flagship-loop-rule';

/** Options for {@link createPersistentRuleStore}. */
export interface PersistentRuleStoreOptions {
  /** Base in-memory store backing every read; also seeded from persisted rules at boot. */
  base: RuleStore;
  /** SQLite-backed storage created via `createSqliteStorage` (read/save surface). */
  storage: SqliteStorage;
  /** Resolved DB file path; used for the synchronous boot seed and row deletion on remove(). */
  dbFile: string;
  /**
   * Shared spec registry (owned by the REST API) so a mutation persists the exact
   * submitted/merged {@link RuleSpec} losslessly. Optional — falls back to a
   * best-effort {@link describeRule} descriptor when absent.
   */
  specs?: Map<string, RuleSpec>;
}

/**
 * Wrap a base {@link RuleStore} so that user-created/changed rules are mirrored
 * through to SQLite (surviving restarts) while the base store stays the primary
 * read path. See the module doc comment for the write-through mapping.
 */
export function createPersistentRuleStore(options: PersistentRuleStoreOptions): RuleStore {
  const { base, storage, dbFile, specs } = options;

  // Rehydrate persisted {@link RuleSpec}s into the base store (idempotent upsert).
  // Best-effort: a failure must not block boot. The built-in flagship rule is
  // skipped so it is never resurrected from disk.
  const seedFromDb = (): void => {
    let db: DatabaseSync | undefined;
    try {
      db = openDb(dbFile);
      const rows = db.prepare('SELECT data_json FROM rules').all() as Array<Record<string, unknown>>;
      for (const row of rows) {
        let spec: RuleSpec;
        try {
          spec = JSON.parse(String(row.data_json)) as RuleSpec;
        } catch {
          continue; // corrupt / non-JSON row: skip
        }
        if (validateSpec(spec) !== null) continue; // not a valid rule spec: skip
        if (spec.id === FLAGSHIP_RULE_ID) continue; // never resurrect the built-in rule
        const built = buildRuleFromSpec(spec);
        base.add(built);
        // Republish the faithful persisted spec into the shared registry so the REST
        // view serializes rehydrated rules losslessly (matching add/update's specs.set),
        // keyed by the actual rule id assigned by buildRuleFromSpec.
        specs?.set(built.id, { ...spec, id: built.id });
      }
    } catch (err) {
      console.warn('aitoolgate: could not load persisted rules:', err);
    } finally {
      db?.close();
    }
  };

  // Persist the current rule at `id` as its {@link RuleSpec}, skipping the flagship
  // rule. Prefer the exact submitted/merged spec; fall back to a best-effort descriptor.
  const persistId = (id: string): void => {
    const current = base.get(id);
    if (current === undefined || current.id === FLAGSHIP_RULE_ID) return;
    const spec = specs?.get(id) ?? describeRule(current);
    const toStore: RuleSpec = { ...spec, id: current.id };
    void storage.saveRule(toStore as unknown as Rule).catch((err) => {
      console.warn(`aitoolgate: could not persist rule ${id}:`, err);
    });
  };

  return createPersistentStore({
    base,
    dbFile,
    table: 'rules',
    entity: 'rule',
    seed: seedFromDb,
    persist: persistId,
  });
}
