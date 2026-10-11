/**
 * Shared store bases for the rule and provider registries.
 *
 * Eliminates the boilerplate duplicated across the in-memory stores
 * ({@link ./ruleStore} / {@link ./providerStore}) and the write-through SQLite
 * stores ({@link ./persistentRuleStore} / {@link ./persistentProviderStore}):
 * defensive-copy initial seeding, the id-assignment in `add`, the base `list` /
 * `get` / `size` / `remove` / `reset`, and (for persistence) the `openDb` handle,
 * the queueMicrotask-deferred write-through, and the `DELETE … WHERE id = ?` +
 * warn + finally-close row delete.
 *
 * Domain-specific logic stays OUT of these bases and is passed in as callbacks /
 * options: the provider's ≤1-active invariant (setActive/getActive/isActive), the
 * rule "skip the flagship" behavior, and — per project convention — input
 * validation, which lives in {@link ./ruleSpec} / {@link ./providerSpec}; the
 * store never parses input.
 */
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

/** Open a synchronous {@link DatabaseSync} at `dbFile` (the shared DB-handle factory). */
export function openDb(dbFile: string): DatabaseSync {
  return new DatabaseSync(dbFile);
}

/** Assign a unique id to a record whose id is missing or empty (else keep the provided one). */
export function assignId(id: string | undefined): string {
  return typeof id === 'string' && id.length > 0 ? id : randomUUID();
}

// ---------------------------------------------------------------------------
// In-memory CRUD factory
// ---------------------------------------------------------------------------

/** The backing map + copy/restore helpers handed to a store's domain callbacks. */
export interface CrudCtx<T extends { id: string }> {
  /** The backing id → record map (reads return defensive copies; writes store as-is). */
  byId: Map<string, T>;
  /** Shallow-copy a record so callers cannot mutate the stored instance via a reference. */
  copy(item: T): T;
  /** Restore the store to its seeded initial state. */
  restoreInitial(): void;
}

/** The in-memory CRUD surface (defensive copies on every read). */
export interface CrudStore<T extends { id: string }, S, P> {
  /** A fresh array copy of the current records (not the internal reference). */
  list(): T[];
  /** A copy of the record at `id`, or `undefined` when absent. */
  get(id: string): T | undefined;
  /** Store a copy, assigning a unique id when missing/empty. Returns the stored copy. */
  add(input: S): T;
  /** Domain-specific update; returns the updated copy or `undefined` when absent. */
  update(id: string, patch: P): T | undefined;
  /** Remove the record at `id`; returns `true` when a record was removed. */
  remove(id: string): boolean;
  /** Restore the store to its seeded `initial` state (empty when none was provided). */
  reset(): void;
  /** Number of records currently stored. */
  size(): number;
}

/** Options to {@link createCrudStore}; the callbacks keep domain logic out of the base. */
export interface CrudConfig<T extends { id: string }, S, P, E extends object = {}> {
  /** Records to seed the store with (stored as defensive copies; `reset` restores them). */
  initial?: T[];
  /** Domain transform of an input into the stored record (apply defaults; leave the id empty/absent). */
  toStored(input: S, ctx: CrudCtx<T>): T;
  /** Domain post-store hook (e.g. invariant enforcement), called after the record is stored. */
  afterStore?(stored: T, wasEmpty: boolean, ctx: CrudCtx<T>): void;
  /** Domain update; return the updated copy or `undefined` when the id is unknown. */
  update(id: string, patch: P, ctx: CrudCtx<T>): T | undefined;
  /** Domain remove (defaults to a plain delete when omitted). */
  remove?(id: string, ctx: CrudCtx<T>): boolean;
  /** Domain-specific extra methods (e.g. the provider's `setActive` / `getActive`). */
  extras?(ctx: CrudCtx<T>): E;
}

/**
 * Build an in-memory CRUD store over an id-keyed map of `T`. Centralizes the
 * defensive-copy / seed / reset / id-assignment boilerplate shared by the rule
 * and provider registries; `toStored` / `update` / `remove` / `extras` keep the
 * domain-specific behavior in the caller.
 */
export function createCrudStore<T extends { id: string }, S, P, E extends object = {}>(
  config: CrudConfig<T, S, P, E>,
): CrudStore<T, S, P> & E {
  // Detached snapshot of the initial records (copies) used as the reset baseline.
  const initial: T[] = (config.initial ?? []).map((item) => ({ ...item }));
  const byId = new Map<string, T>(initial.map((item) => [item.id, item]));
  const ctx: CrudCtx<T> = {
    byId,
    copy: (item) => ({ ...item }),
    restoreInitial: () => {
      byId.clear();
      for (const item of initial) byId.set(item.id, item);
    },
  };

  const store: CrudStore<T, S, P> = {
    list: () => [...byId.values()].map(ctx.copy),
    get: (id) => {
      const found = byId.get(id);
      return found === undefined ? undefined : ctx.copy(found);
    },
    add: (input) => {
      const draft = config.toStored(input, ctx);
      const id = assignId(draft.id);
      const stored: T = draft.id === id ? draft : { ...draft, id };
      const wasEmpty = byId.size === 0;
      byId.set(id, stored);
      config.afterStore?.(stored, wasEmpty, ctx);
      return ctx.copy(stored);
    },
    update: (id, patch) => config.update(id, patch, ctx),
    remove: (id) => (config.remove ? config.remove(id, ctx) : byId.delete(id)),
    reset: () => ctx.restoreInitial(),
    size: () => byId.size,
  };

  return { ...store, ...config.extras?.(ctx) } as CrudStore<T, S, P> & E;
}

// ---------------------------------------------------------------------------
// Write-through persistent wrapper
// ---------------------------------------------------------------------------

/** The read-path base a write-through store mirrors mutations through to SQLite. */
export interface PersistentStore<T extends { id: string }> {
  list(): T[];
  get(id: string): T | undefined;
  size(): number;
  reset(): void;
  add(input: any): T;
  update(id: string, patch: any): T | undefined;
  remove(id: string): boolean;
}

/** Helpers handed to a persistent store's domain callbacks. */
export interface PersistentCtx<T extends { id: string }, B extends PersistentStore<T>> {
  base: B;
  dbFile: string;
  /** Open a fresh {@link DatabaseSync} at the store's `dbFile`. */
  openDb(): DatabaseSync;
  /** Defer `persist(id)` by one microtask (so the REST spec map has landed first). */
  schedulePersist(id: string): void;
  /** Delete the persisted row for `id` (`DELETE … WHERE id = ?` + warn + finally-close). */
  deleteRow(id: string): void;
}

/** Options to {@link createPersistentStore}; the callbacks keep domain logic out of the base. */
export interface PersistentConfig<T extends { id: string }, B extends PersistentStore<T>, E extends object = {}> {
  /** Base in-memory store backing every read; also seeded from persisted rows at boot. */
  base: B;
  /** Resolved DB file path (used for the seed + row deletion). */
  dbFile: string;
  /** The SQLite table rows are stored in (used for the row `DELETE`). */
  table: string;
  /** Entity label for the row-delete warning (e.g. `'rule'` / `'provider'`); defaults to `'row'`. */
  entity?: string;
  /** Domain boot callback (rehydrate persisted rows); called once at construction. */
  seed?(): void;
  /** Domain callback run (deferred one microtask) when a record should be persisted. */
  persist(id: string): void;
  /** Domain-specific extra methods (e.g. the provider's `setActive` / `getActive` write-through). */
  extras?(ctx: PersistentCtx<T, B>): E;
}

/**
 * Wrap a base {@link PersistentStore} so its mutations are mirrored through to
 * SQLite (the base stays the primary read path). Centralizes the `openDb` /
 * queueMicrotask-deferred write-through / `DELETE … WHERE id = ?` boilerplate
 * shared by the rule and provider stores; `persist` / `seed` / `extras` keep
 * domain-specific behavior (skip-the-flagship, single-active upsert, …) in the
 * caller. Persistence is best-effort: a failing open/read/write logs a warning
 * and leaves the in-memory store untouched.
 */
export function createPersistentStore<T extends { id: string }, B extends PersistentStore<T>, E extends object = {}>(
  config: PersistentConfig<T, B, E>,
): PersistentStore<T> & E {
  const openDbHandle = (): DatabaseSync => openDb(config.dbFile);
  const schedulePersist = (id: string): void => {
    queueMicrotask(() => config.persist(id));
  };
  const deleteRow = (id: string): void => {
    let db: DatabaseSync | undefined;
    try {
      db = openDbHandle();
      db.prepare(`DELETE FROM ${config.table} WHERE id = ?`).run(id);
    } catch (err) {
      console.warn(`mcp-manager: could not delete persisted ${config.entity ?? 'row'} ${id}:`, err);
    } finally {
      db?.close();
    }
  };
  const ctx: PersistentCtx<T, B> = {
    base: config.base,
    dbFile: config.dbFile,
    openDb: openDbHandle,
    schedulePersist,
    deleteRow,
  };

  config.seed?.();

  const core: PersistentStore<T> = {
    list: () => config.base.list(),
    get: (id) => config.base.get(id),
    size: () => config.base.size(),
    reset: () => config.base.reset(),
    add: (input) => {
      const stored = config.base.add(input);
      schedulePersist(stored.id);
      return stored;
    },
    update: (id, patch) => {
      const updated = config.base.update(id, patch);
      if (updated !== undefined) schedulePersist(updated.id);
      return updated;
    },
    remove: (id) => {
      const removed = config.base.remove(id);
      if (removed) deleteRow(id);
      return removed;
    },
  };

  return { ...core, ...config.extras?.(ctx) } as PersistentStore<T> & E;
}
