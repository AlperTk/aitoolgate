/** Write-through rule store over a base in-memory store + SQLite: the base store is the primary read path (only add/update/remove mirror to SQLite); rules persist as JSON `RuleSpec` (matcher/action are closures that can't round-trip), rehydrated via `buildRuleFromSpec`; the flagship rule is never persisted; persistence is best-effort so boot never fails. */
import { DatabaseSync } from 'node:sqlite';
import type { RuleStore } from './ruleStore';
import type { SqliteStorage } from '../storage/sqlite';
import type { Rule } from '../ports/domain';
import { buildRuleFromSpec, describeRule, validateSpec } from './ruleSpec';
import type { RuleSpec } from './ruleSpec';
import { createPersistentStore, openDb } from './crudStore';

/** Built-in loop-detection rule id; never persisted across restarts. */
const FLAGSHIP_RULE_ID = 'flagship-loop-rule';

export interface PersistentRuleStoreOptions {
  /** Base in-memory store backing every read; also seeded from persisted rules at boot. */
  base: RuleStore;
  /** SQLite-backed storage created via `createSqliteStorage` (read/save surface). */
  storage: SqliteStorage;
  /** Resolved DB file path; used for the synchronous boot seed and row deletion on remove(). */
  dbFile: string;
  /** Shared spec registry (owned by the REST API) so a mutation persists the exact submitted/merged `RuleSpec` losslessly; optional — falls back to a best-effort `describeRule` descriptor when absent. */
  specs?: Map<string, RuleSpec>;
}

/** Wrap a base rule store so user-created/changed rules mirror through to SQLite (surviving restarts) while the base store stays the primary read path; see the module doc for the write-through mapping. */
export function createPersistentRuleStore(options: PersistentRuleStoreOptions): RuleStore {
  const { base, storage, dbFile, specs } = options;

  // Rehydrate persisted `RuleSpec`s into the base store (idempotent upsert); best-effort (a failure must not block boot) and skips the built-in flagship rule so it's never resurrected from disk.
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
        // Republish the faithful persisted spec into the shared registry so the REST view serializes rehydrated rules losslessly, keyed by the actual rule id assigned by `buildRuleFromSpec`.
        specs?.set(built.id, { ...spec, id: built.id });
      }
    } catch (err) {
      console.warn('aitoolgate: could not load persisted rules:', err);
    } finally {
      db?.close();
    }
  };

  // Persist the current rule at `id` as its `RuleSpec`, skipping the flagship rule; prefer the exact submitted/merged spec, else a best-effort descriptor.
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
