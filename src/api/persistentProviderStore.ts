/** Write-through ApiProviderStore over a base in-memory store + SQLite; the base is the primary read path and mutations mirror to the `api_providers` table (best-effort, seeded from disk). */
import { applyMigrations } from '../storage/schema';
import type { ApiProvider } from './providerSpec';
import type { ApiProviderStore } from './providerStore';
import { createApiProviderStore } from './providerStore';
import { createPersistentStore, openDb } from './crudStore';

export interface PersistentProviderStoreOptions {
  /** Resolved DB file path (same file as the rules database). Defaults to `':memory:'`. */
  dbFile?: string;
  /** Default provider seeded as the sole auto-active row only when no rows exist yet; omit to seed purely from disk. */
  seedFallback?: ApiProvider;
}

type Row = Record<string, unknown>;

const UPSERT_PROVIDER_SQL = `INSERT INTO api_providers (id, name, base_url, model, api_key, protocol, is_active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         base_url = excluded.base_url,
         model = excluded.model,
         api_key = excluded.api_key,
         protocol = excluded.protocol,
         is_active = excluded.is_active`;

/** Storage keeps the wire `null` ("From Request") as '' (TEXT NOT NULL, no migration); see rowToProvider for the reverse. */
function toStoredModel(model: string | null): string {
  return model ?? '';
}

function rowToProvider(row: Row): ApiProvider {
  const rawModel = row.model == null ? '' : String(row.model);
  const rawKey = row.api_key == null ? '' : String(row.api_key);
  const protocol: ApiProvider['protocol'] = row.protocol === 'anthropic' ? 'anthropic' : 'openai';
  return {
    id: String(row.id),
    name: String(row.name),
    baseUrl: String(row.base_url),
    model: rawModel.length === 0 ? null : rawModel,
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
    db.prepare(UPSERT_PROVIDER_SQL).run(
      provider.id,
      provider.name,
      provider.baseUrl,
      toStoredModel(provider.model),
      provider.apiKey,
      provider.protocol,
      provider.isActive ? 1 : 0,
      provider.createdAt,
    );
  } finally {
    db.close();
  }
}

/** Write every in-memory row (and delete `removedId`) in ONE transaction so the single-active flag stays consistent on disk. */
function writeAllRows(dbFile: string, providers: ApiProvider[], removedId?: string): void {
  const db = openDb(dbFile);
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      if (removedId !== undefined) db.prepare('DELETE FROM api_providers WHERE id = ?').run(removedId);
      const stmt = db.prepare(UPSERT_PROVIDER_SQL);
      for (const provider of providers) {
        stmt.run(
          provider.id,
          provider.name,
          provider.baseUrl,
          toStoredModel(provider.model),
          provider.apiKey,
          provider.protocol,
          provider.isActive ? 1 : 0,
          provider.createdAt,
        );
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  } finally {
    db.close();
  }
}

export function createPersistentProviderStore(options: PersistentProviderStoreOptions = {}): ApiProviderStore {
  const dbFile = options.dbFile ?? ':memory:';

  // Ensure the schema (incl. the v3 api_providers table) exists; idempotent, runs even if rule persistence never opened it.
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

  // Any mutation can move the single-active flag between rows, so mirror the whole set (best-effort).
  const persistAll = (removedId?: string): void => {
    try {
      writeAllRows(dbFile, base.list(), removedId);
    } catch (err) {
      console.warn(`aitoolgate: could not persist providers${removedId === undefined ? '' : ` (removed ${removedId})`}:`, err);
    }
  };

  return createPersistentStore({
    base,
    dbFile,
    table: 'api_providers',
    entity: 'provider',
    persist: () => persistAll(),
    // The provider's ≤1-active surface: getActive passthrough + setActive/remove write-through.
    extras: (ctx) => ({
      getActive: () => base.getActive(),
      setActive: (id: string) => {
        const activated = base.setActive(id);
        if (activated) ctx.schedulePersist(id);
        return activated;
      },
      remove: (id: string) => {
        const removed = base.remove(id);
        // Deferred like other writes; also persists any row promoted to active by the removal.
        if (removed) queueMicrotask(() => persistAll(id));
        return removed;
      },
    }),
  });
}
