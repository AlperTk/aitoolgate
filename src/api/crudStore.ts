/** Shared in-memory + write-through store bases for the rule/provider registries; domain logic is passed in as callbacks. */
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export function openDb(dbFile: string): DatabaseSync {
  return new DatabaseSync(dbFile);
}

export function assignId(id: string | undefined): string {
  return typeof id === 'string' && id.length > 0 ? id : randomUUID();
}

export interface CrudCtx<T extends { id: string }> {
  byId: Map<string, T>;
  copy(item: T): T;
  restoreInitial(): void;
}

export interface CrudStore<T extends { id: string }, S, P> {
  list(): T[];
  get(id: string): T | undefined;
  add(input: S): T;
  update(id: string, patch: P): T | undefined;
  remove(id: string): boolean;
  reset(): void;
  size(): number;
}

export interface CrudConfig<T extends { id: string }, S, P, E extends object = {}> {
  initial?: T[];
  toStored(input: S, ctx: CrudCtx<T>): T;
  afterStore?(stored: T, wasEmpty: boolean, ctx: CrudCtx<T>): void;
  update(id: string, patch: P, ctx: CrudCtx<T>): T | undefined;
  remove?(id: string, ctx: CrudCtx<T>): boolean;
  extras?(ctx: CrudCtx<T>): E;
}

/** Build an in-memory CRUD store over an id-keyed map; domain logic stays in the callbacks. */
export function createCrudStore<T extends { id: string }, S, P, E extends object = {}>(
  config: CrudConfig<T, S, P, E>,
): CrudStore<T, S, P> & E {
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

export interface PersistentStore<T extends { id: string }> {
  list(): T[];
  get(id: string): T | undefined;
  size(): number;
  reset(): void;
  add(input: any): T;
  update(id: string, patch: any): T | undefined;
  remove(id: string): boolean;
}

export interface PersistentCtx<T extends { id: string }, B extends PersistentStore<T>> {
  base: B;
  dbFile: string;
  openDb(): DatabaseSync;
  /** Defer `persist(id)` by one microtask (so the REST spec map has landed first). */
  schedulePersist(id: string): void;
  deleteRow(id: string): void;
}

export interface PersistentConfig<T extends { id: string }, B extends PersistentStore<T>, E extends object = {}> {
  base: B;
  dbFile: string;
  table: string;
  entity?: string;
  seed?(): void;
  persist(id: string): void;
  extras?(ctx: PersistentCtx<T, B>): E;
}

/** Wrap a base store so its mutations are mirrored to SQLite (best-effort; the base stays the read path). */
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
      console.warn(`aitoolgate: could not delete persisted ${config.entity ?? 'row'} ${id}:`, err);
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
