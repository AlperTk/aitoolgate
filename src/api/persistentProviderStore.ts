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
