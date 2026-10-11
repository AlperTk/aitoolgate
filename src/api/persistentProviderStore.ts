/**
 * Write-through {@link ApiProviderStore} over a base in-memory store + Node's
 * built-in SQLite, so provider definitions survive restarts (mirrors
 * {@link ./persistentRuleStore}). The base store remains the PRIMARY read path
 * (`list` / `get` / `size` / `getActive`); only mutations mirror through to the
 * `api_providers` table:
 *   - `add`       → UPSERT the full row (deferred one microtask)
 *   - `update`    → UPSERT (only when a row was actually updated)
 *   - `setActive` → UPSERT (reflects the new single-active state)
 *   - `remove`    → DELETE FROM api_providers WHERE id = ?
 *
 * On init the store SEEDS from any rows already on disk (preserving each row's
 * stored `isActive`, defensively collapsing to ≤1 active). When the table is empty
 * AND a `seedFallback` record is supplied (the env-derived upstream snapshot), that
 * fallback becomes the single auto-active row — so pre-existing env-based deployments
 * gain an equivalent default provider without user action.
 *
 * The shared {@link createPersistentStore} base holds the `openDb` / queueMicrotask
 * defer / `DELETE … WHERE id = ?` + warn + finally-close boilerplate; the row
 * UPSERT mapping, the `seedFallback` boot seed, and the provider's `setActive` /
 * `getActive` write-through stay here. Persistence is best-effort: a failing
 * open/read/write logs a warning and leaves the in-memory store untouched.
 */
import { applyMigrations } from '../storage/schema';
import type { ApiProvider } from './providerSpec';
import type { ApiProviderStore } from './providerStore';
import { createApiProviderStore } from './providerStore';
import { createPersistentStore, openDb } from './crudStore';

/** Options for {@link createPersistentProviderStore}. */
export interface PersistentProviderStoreOptions {
  /** Resolved DB file path (same file as the rules database). Defaults to `':memory:'`. */
  dbFile?: string;
  /**
   * A fully-formed default provider (built from the current effective upstream
   * snapshot) seeded as the sole auto-active row ONLY when no rows exist yet.
   * Omit to seed purely from whatever is already persisted on disk.
   */
  seedFallback?: ApiProvider;
}

/** A row returned by SQLite `StatementSync.all()`: string-keyed values. */
type Row = Record<string, unknown>;

/** Map a stored `api_providers` row back onto an {@link ApiProvider}. */
function rowToProvider(row: Row): ApiProvider {
  const rawKey = row.api_key == null ? '' : String(row.api_key);
  const protocol: ApiProvider['protocol'] = row.protocol === 'anthropic' ? 'anthropic' : 'openai';
  return {
    id: String(row.id),
    name: String(row.name),
    baseUrl: String(row.base_url),
    model: String(row.model),
    apiKey: rawKey.length === 0 ? null : rawKey,
    protocol,
    isActive: Number(row.is_active) === 1,
    createdAt: Number(row.created_at),
  };
}

/** Load every provider row (create-order preserved). THROWS on a genuine I/O failure. */
function loadExistingRows(dbFile: string): ApiProvider[] {
  const db = openDb(dbFile);
  try {
    const rows = db
      .prepare(
        'SELECT id, name, base_url, model, api_key, protocol, is_active, created_at FROM api_providers ORDER BY created_at ASC, id ASC',
      )
      .all() as Row[];
    let activeSeen = false;
    return rows.map((row) => {
      const provider = rowToProvider(row);
      if (!activeSeen && provider.isActive) {
        activeSeen = true; // keep the first active row only; collapse any duplicate flags
      } else {
        provider.isActive = false;
      }
      return provider;
    });
  } finally {
    db.close();
  }
}

/** UPSERT the full record, preserving its existing created_at when it already exists. */
function upsertRecord(dbFile: string, provider: ApiProvider): void {
  const db = openDb(dbFile);
  try {
    db.prepare(
      `INSERT INTO api_providers (id, name, base_url, model, api_key, protocol, is_active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         base_url = excluded.base_url,
         model = excluded.model,
         api_key = excluded.api_key,
         protocol = excluded.protocol,
         is_active = excluded.is_active`,
    ).run(
      provider.id,
      provider.name,
      provider.baseUrl,
      provider.model,
      provider.apiKey,
      provider.protocol,
      provider.isActive ? 1 : 0,
      provider.createdAt,
    );
  } finally {
    db.close();
  }
}

/** Wrap a base {@link ApiProviderStore} so mutations are mirrored through to SQLite. */
export function createPersistentProviderStore(options: PersistentProviderStoreOptions = {}): ApiProviderStore {
  const dbFile = options.dbFile ?? ':memory:';

  // Ensure the schema (incl. the v3 api_providers table) exists on this file first —
  // idempotent and cheap; runs even when rule persistence was never opened for it.
  const ensureDb = openDb(dbFile);
  applyMigrations(ensureDb);
  ensureDb.close();

  let records = loadExistingRows(dbFile);
  // Startup seeding: an empty table + supplied env-derived default becomes the sole auto-active row.
  if (records.length === 0 && options.seedFallback !== undefined) {
    const seeded: ApiProvider = { ...options.seedFallback, createdAt: Date.now(), isActive: true };
    records = [seeded];
    upsertRecord(dbFile, seeded); // persist immediately so the seed survives without a runtime mutation
  }

  const base = createApiProviderStore({ initial: records });

  // Domain-specific persist: UPSERT the current row at `id` (best-effort).
  const persist = (id: string): void => {
    const current = base.get(id);
    if (current === undefined) return;
    try {
      upsertRecord(dbFile, current);
    } catch (err) {
      console.warn(`aitoolgate: could not persist provider ${id}:`, err);
    }
  };

  return createPersistentStore({
    base,
    dbFile,
    table: 'api_providers',
    entity: 'provider',
    persist,
    // The provider's ≤1-active surface: getActive passthrough + setActive write-through.
    extras: (ctx) => ({
      getActive: () => base.getActive(),
      setActive: (id: string) => {
        const activated = base.setActive(id);
        if (activated) ctx.schedulePersist(id);
        return activated;
      },
    }),
  });
}
