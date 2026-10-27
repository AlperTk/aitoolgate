/** Write-through rule store over a base in-memory store + SQLite: the base store is the primary read path (only add/update/remove mirror to SQLite); rules persist as JSON `RuleSpec` (matcher/action are closures that can't round-trip), rehydrated via `buildRuleFromSpec`; the flagship rule is never persisted; persistence is best-effort so boot never fails. */
import { DatabaseSync } from 'node:sqlite';
import type { RuleStore } from './ruleStore';
import type { SqliteStorage } from '../storage/sqlite';
import type { Rule } from '../ports/domain';
import type { PolicyRule } from '../policy/ruleEngine';
import { buildRuleFromSpec, describeRule, validateSpec } from './ruleSpec';
import type { RuleSpec } from './ruleSpec';
import { createPersistentStore, openDb } from './crudStore';

/** Built-in loop-detection rule id; never persisted across restarts. */
const FLAGSHIP_RULE_ID = 'flagship-loop-rule';

export interface PersistentRuleStoreOptions {
  /** Base in-memory store backing every read (its entries carry the submitted `RuleSpec`); also seeded from persisted rules at boot. */
  base: RuleStore;
  /** SQLite-backed storage created via `createSqliteStorage` (read/save surface). */
  storage: SqliteStorage;
  /** Resolved DB file path; used for the synchronous boot seed and row deletion on remove(). */
  dbFile: string;
}

/** Wrap a base rule store so user-created/changed rules mirror through to SQLite (surviving restarts) while the base store stays the primary read path; see the module doc for the write-through mapping. */
export function createPersistentRuleStore(options: PersistentRuleStoreOptions): RuleStore {
  const { base, storage, dbFile } = options;

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
        // Store the faithful persisted spec alongside the rule, keyed by the actual rule id assigned by `buildRuleFromSpec`.
        base.add(built, { ...spec, id: built.id });
      }
    } catch (err) {
      console.warn('aitoolgate: could not load persisted rules:', err);
    } finally {
      db?.close();
    }
  };

  // Persist the current rule at `id` as its `RuleSpec`, skipping the flagship rule; prefer the exact submitted/merged spec, else a best-effort descriptor.
  const persistId = (id: string): void => {
    const current = base.entry(id);
    if (current === undefined || current.rule.id === FLAGSHIP_RULE_ID) return;
    const spec = (current.spec as RuleSpec | undefined) ?? describeRule(current.rule);
    const toStore: RuleSpec = { ...spec, id: current.rule.id };
    void storage.saveRule(toStore as unknown as Rule).catch((err) => {
      console.warn(`aitoolgate: could not persist rule ${id}:`, err);
    });
  };

  const persistent = createPersistentStore<PolicyRule, RuleStore>({
    base,
    dbFile,
    table: 'rules',
    entity: 'rule',
    seed: seedFromDb,
    persist: persistId,
  });

  // The shared core forwards only the rule to the base, so the spec-carrying mutations are wired here with the same deferred write-through.
  const schedulePersist = (id: string): void => {
    queueMicrotask(() => persistId(id));
  };
  return {
    ...persistent,
    entry: (id) => base.entry(id),
    add: (rule: PolicyRule, spec?: unknown) => {
      const stored = base.add(rule, spec);
      schedulePersist(stored.id);
      return stored;
    },
    update: (id, patch, spec) => {
      const updated = base.update(id, patch, spec);
      if (updated !== undefined) schedulePersist(updated.id);
      return updated;
    },
  };
}
