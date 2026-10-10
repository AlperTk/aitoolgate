import { randomUUID } from 'node:crypto';
import type { ApiProvider } from './providerSpec';

/** Options for {@link createApiProviderStore}. */
export interface ProviderStoreOptions {
  /**
   * Providers to seed the store with. Stored as defensive copies preserving each
   * row's existing `isActive`, so seeding many persisted rows never re-triggers the
   * auto-first activation that only applies to brand-new inserts into an empty store.
   * When omitted the store starts empty; {@link ApiProviderStore.reset} restores it here.
   */
  initial?: ApiProvider[];
}

/** A patch over the updatable fields of a stored provider (shallow-merge semantics). */
export type ProviderPatch = Partial<
  Pick<ApiProvider, 'name' | 'baseUrl' | 'model' | 'apiKey' | 'protocol' | 'isActive'>
>;

/**
 * An in-memory registry of {@link ApiProvider}s supporting runtime CRUD, intended
 * to be read live per-request. Enforces the HARD invariant **at most one** row may
 * be `isActive` at any time (zero or one allowed, never more):
 * - `add`: inserting into an otherwise-empty store ALWAYS activates the new row
 *   (auto-first); afterwards a new row is active only when explicitly requested.
 * - `update`/`setActive`: setting a row active clears every other row first.
 * - `remove`: deleting the active row promotes the lexicographically-lowest-id
 *   remaining row active (or leaves none active when no rows remain).
 *
 * Every accessor returns DEFENSIVE COPIES; mutating a returned object cannot
 * corrupt the store's internal state. Field-presence validation belongs to the HTTP
 * layer ({@link ./providerSpec}); this layer just stores what it is given.
 */
export interface ApiProviderStore {
  /** A fresh array copy of all providers, in insertion/create order. */
  list(): ApiProvider[];
  /** A copy of the provider at `id`, or `undefined` when absent. */
  get(id: string): ApiProvider | undefined;
  /** Store a copy, assigning a unique id and defaults for missing optionals; returns the stored copy. */
  add(provider: Partial<ApiProvider>): ApiProvider;
  /** Shallow-merge `patch` onto the provider at `id`; return the updated copy or `undefined`. */
  update(id: string, patch: ProviderPatch): ApiProvider | undefined;
  /** Make the provider at `id` the sole active row (clears others). `true` if the row existed. */
  setActive(id: string): boolean;
  /** The single currently-active provider (copy), or `undefined` when none is active. */
  getActive(): ApiProvider | undefined;
  /** Remove the provider at `id`; returns `true` when a row was removed. */
  remove(id: string): boolean;
  /** Restore the store to its seeded `initial` state (empty when none was provided). */
  reset(): void;
  /** Number of providers currently stored. */
  size(): number;
}

/** Shallow-copy a provider so callers can't mutate the stored instance via a reference. */
function copyProvider(provider: ApiProvider): ApiProvider {
  return { ...provider };
}

/** Merge a validated {@link ProviderPatch} into an existing record, touching known fields only. */
function mergePatch(existing: ApiProvider, patch: ProviderPatch): ApiProvider {
  const merged = { ...existing };
  if (patch.name !== undefined) merged.name = patch.name;
  if (patch.baseUrl !== undefined) merged.baseUrl = patch.baseUrl;
  if (patch.model !== undefined) merged.model = patch.model;
  if (patch.apiKey !== undefined) merged.apiKey = patch.apiKey;
  if (patch.protocol !== undefined) merged.protocol = patch.protocol;
  if (patch.isActive !== undefined) merged.isActive = patch.isActive;
  return merged;
}

/** Build an in-memory {@link ApiProviderStore}, preserving the ≤1-active invariant throughout. */
export function createApiProviderStore(options: ProviderStoreOptions = {}): ApiProviderStore {
  // Detached snapshot of the initial rows (copies) used as the reset baseline. Inserted
  // verbatim (flags preserved) — seeding never forces activation on its own.
  const initial: ApiProvider[] = (options.initial ?? []).map(copyProvider);
  const byId = new Map<string, ApiProvider>(initial.map((p) => [p.id, p]));

  function restoreInitial(): void {
    byId.clear();
    for (const p of initial) byId.set(p.id, p);
  }

  function clearAllActive(): void {
    for (const rec of byId.values()) rec.isActive = false;
  }

  /** Clear every row then mark exactly `id` active (no-op when the id is unknown). */
  function markActive(id: string): void {
    clearAllActive();
    if (byId.has(id)) byId.get(id)!.isActive = true;
  }

  /** Safety net: collapse any accidental multi-active state down to at most one row. */
  function reconcileSingleActive(prefer?: string): void {
    let kept: string | undefined;
    for (const rec of byId.values()) {
      if (!rec.isActive) continue;
      if (prefer === undefined && kept === undefined) kept = rec.id;
      else rec.isActive = false;
    }
  }

  return {
    list() {
      return [...byId.values()].map(copyProvider);
    },
    get(id) {
      const found = byId.get(id);
      return found === undefined ? undefined : copyProvider(found);
    },
    add(provider) {
      const wasEmpty = byId.size === 0;
      const wantsActive = provider.isActive === true;
      const stored: ApiProvider = {
        id: typeof provider.id === 'string' && provider.id.length > 0 ? provider.id : randomUUID(),
        name: provider.name ?? '',
        baseUrl: provider.baseUrl ?? '',
        model: provider.model ?? '',
        apiKey: provider.apiKey ?? null,
        protocol: provider.protocol ?? 'openai',
        isActive: provider.isActive ?? false,
        createdAt: provider.createdAt ?? Date.now(),
      };
      byId.set(stored.id, stored);
      // Auto-first activation OR an explicit request makes this row THE active one.
      if (wasEmpty || wantsActive) markActive(stored.id);
      else reconcileSingleActive(undefined);
      return copyProvider(stored);
    },
    update(id, patch) {
      const existing = byId.get(id);
      if (existing === undefined) return undefined;
      const updated = mergePatch(existing, patch);
      byId.delete(id);
      byId.set(updated.id, updated);
      // Reconcile the single-active invariant based on whether/what changed here.
      if ('isActive' in patch && updated.isActive) markActive(updated.id);
      else reconcileSingleActive(updated.isActive ? updated.id : undefined);
      return copyProvider(updated);
    },
    setActive(id) {
      const exists = byId.has(id);
      if (exists) markActive(id);
      return exists;
    },
    getActive() {
      for (const rec of byId.values()) {
        if (rec.isActive) return copyProvider(rec);
      }
      return undefined;
    },
    remove(id) {
      const target = byId.get(id);
      const removed = byId.delete(id);
      if (!removed) return false;
      if (target?.isActive && byId.size > 0) {
        // Promote the lexicographically-lowest-id remaining provider to active.
        const ids = [...byId.keys()].sort();
        markActive(ids[0]);
      }
      return true;
    },
    reset() {
      restoreInitial();
    },
    size() {
      return byId.size;
    },
  };
}
