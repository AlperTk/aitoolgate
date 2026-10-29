import type { ApiProvider } from './providerSpec';
import { createCrudStore, type CrudCtx } from './crudStore';
import { DEFAULT_PROVIDER_ADAPTER_ID, wireProtocolFor } from '../providers/registry';

export interface ProviderStoreOptions {
  /** Seed providers, stored as defensive copies preserving each row's `isActive` so seeding never re-triggers auto-first activation (only brand-new inserts into an empty store do); omitted → store starts empty. */
  initial?: ApiProvider[];
}

/** A patch over the updatable fields of a stored provider (shallow-merge semantics). */
export type ProviderPatch = Partial<
  Pick<ApiProvider, 'name' | 'baseUrl' | 'model' | 'apiKey' | 'adapterId' | 'authType' | 'authState' | 'isActive'>
>;

/** In-memory provider registry read live per-request; enforces the hard invariant that at most one row is `isActive` (add auto-activates into an empty store, setActive/update clear others, removing the active row promotes the lowest-id row); every accessor returns defensive copies; field-presence validation lives in the HTTP layer (`./providerSpec`). */
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
  size(): number;
}

/** The provider's domain-specific extra surface on top of the shared CRUD base (the ≤1-active invariant). */
interface ProviderStoreExtras {
  /** Make the provider at `id` the sole active row (clears others). `true` if the row existed. */
  setActive(id: string): boolean;
  /** The single currently-active provider (copy), or `undefined` when none is active. */
  getActive(): ApiProvider | undefined;
}

/** Merge a validated {@link ProviderPatch} into an existing record, touching known fields only. */
function mergePatch(existing: ApiProvider, patch: ProviderPatch): ApiProvider {
  const merged = { ...existing };
  if (patch.name !== undefined) merged.name = patch.name;
  if (patch.baseUrl !== undefined) merged.baseUrl = patch.baseUrl;
  if (patch.model !== undefined) merged.model = patch.model;
  if (patch.apiKey !== undefined) merged.apiKey = patch.apiKey;
  if (patch.adapterId !== undefined) merged.adapterId = patch.adapterId;
  merged.protocol = wireProtocolFor(merged.adapterId); // protocol always follows the type
  if (patch.authType !== undefined) merged.authType = patch.authType;
  if (patch.authState !== undefined) merged.authState = patch.authState;
  if (patch.isActive !== undefined) merged.isActive = patch.isActive;
  return merged;
}

function clearAllActive(byId: Map<string, ApiProvider>): void {
  for (const rec of byId.values()) rec.isActive = false;
}

/** Clear every row then mark exactly `id` active (no-op when the id is unknown). */
function markActive(id: string, byId: Map<string, ApiProvider>): void {
  clearAllActive(byId);
  if (byId.has(id)) byId.get(id)!.isActive = true;
}

/** Safety net: collapse any accidental multi-active state down to at most one row. */
function reconcileSingleActive(prefer: string | undefined, byId: Map<string, ApiProvider>): void {
  // The preferred row stays active when it is active; every other active row is cleared.
  let kept: string | undefined = prefer !== undefined && byId.get(prefer)?.isActive ? prefer : undefined;
  for (const rec of byId.values()) {
    if (!rec.isActive || rec.id === kept) continue;
    if (kept === undefined) kept = rec.id;
    else rec.isActive = false;
  }
}

/** Build an in-memory provider store over the shared `createCrudStore` base, preserving the ≤1-active invariant; the base holds the boilerplate while default-filling and the active-invariant hooks stay here. */
export function createApiProviderStore(options: ProviderStoreOptions = {}): ApiProviderStore {
  return createCrudStore<ApiProvider, Partial<ApiProvider>, ProviderPatch, ProviderStoreExtras>({
    initial: options.initial,
    // Apply the provider defaults (a full record); the base assigns a unique id when missing/empty.
    toStored: (provider) => {
      const adapterId = provider.adapterId ?? DEFAULT_PROVIDER_ADAPTER_ID;
      return {
        id: provider.id ?? '',
        name: provider.name ?? '',
        baseUrl: provider.baseUrl ?? '',
        model: provider.model ?? null,
        apiKey: provider.apiKey ?? null,
        protocol: wireProtocolFor(adapterId), // any client-supplied protocol is ignored
        adapterId,
        authType: provider.authType ?? 'apiKey',
        authState: provider.authState ?? null,
        isActive: provider.isActive ?? false,
        createdAt: provider.createdAt ?? Date.now(),
      };
    },
    // Auto-first activation OR an explicit request makes this row THE active one.
    afterStore: (stored, wasEmpty, ctx) => {
      if (wasEmpty || stored.isActive) markActive(stored.id, ctx.byId);
      else reconcileSingleActive(undefined, ctx.byId);
    },
    update: (id, patch, ctx) => {
      const existing = ctx.byId.get(id);
      if (existing === undefined) return undefined;
      const updated = mergePatch(existing, patch);
      ctx.byId.delete(id);
      ctx.byId.set(updated.id, updated);
      // Reconcile the single-active invariant based on whether/what changed here.
      if ('isActive' in patch && updated.isActive) markActive(updated.id, ctx.byId);
      else reconcileSingleActive(updated.isActive ? updated.id : undefined, ctx.byId);
      return ctx.copy(updated);
    },
    remove: (id, ctx) => {
      const target = ctx.byId.get(id);
      const removed = ctx.byId.delete(id);
      if (!removed) return false;
      if (target?.isActive && ctx.byId.size > 0) {
        // Promote the lexicographically-lowest-id remaining provider to active.
        const ids = [...ctx.byId.keys()].sort();
        markActive(ids[0], ctx.byId);
      }
      return true;
    },
    extras: (ctx) => ({
      setActive(id) {
        const exists = ctx.byId.has(id);
        if (exists) markActive(id, ctx.byId);
        return exists;
      },
      getActive() {
        for (const rec of ctx.byId.values()) {
          if (rec.isActive) return ctx.copy(rec);
        }
        return undefined;
      },
    }),
  });
}
