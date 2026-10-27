import type { PolicyRule, RuleRegistryEntry } from '../policy/ruleEngine';
import { assignId } from './crudStore';

export interface RuleStoreOptions {
  /** Seed rules, stored as defensive copies (mutating the array later won't corrupt the store); omitted → store starts empty. */
  initial?: PolicyRule[];
}

/** Patch that shallow-merges provided fields; `matcher`/`action` may be replaced wholesale, omitting them leaves the existing one untouched. */
export type RulePatch = Partial<Omit<PolicyRule, 'matcher' | 'action'>> & {
  matcher?: PolicyRule['matcher'];
  action?: PolicyRule['action'];
};

/** In-memory rule registry fed to the engine via `() => store.list()`; every accessor returns defensive copies (mutating a result never corrupts internal state). Entries pair each rule with its optional originally-submitted spec. */
export interface RuleStore {
  /** A fresh array copy of the current rules (not the internal reference). */
  list(): PolicyRule[];
  /** A copy of the rule at `id`, or `undefined` when absent. */
  get(id: string): PolicyRule | undefined;
  /** A copy of the registry entry (rule + stored spec) at `id`, or `undefined` when absent. */
  entry(id: string): RuleRegistryEntry | undefined;
  /** Store a copy of `rule` with its optional `spec`, assigning a unique id when `rule.id` is missing/empty. Returns the stored copy (with its id). */
  add(rule: PolicyRule, spec?: unknown): PolicyRule;
  /** Shallow-merge `patch` into the rule at `id`; a provided `spec` replaces the stored one (otherwise it is kept). Return the updated copy, or `undefined` if not found. */
  update(id: string, patch: RulePatch, spec?: unknown): PolicyRule | undefined;
  /** Remove the rule at `id`. Returns `true` when a rule was removed. */
  remove(id: string): boolean;
  /** Restore the store to its `initial` state (empty when none was provided). */
  reset(): void;
  size(): number;
}

/** Create an in-memory rule store keyed by rule id; returns defensive copies throughout; hand rules to `createRuleEngine` via `() => store.list()`. */
export function createRuleStore(options: RuleStoreOptions = {}): RuleStore {
  const fromInitial = (): Array<[string, RuleRegistryEntry]> =>
    (options.initial ?? []).map((rule): [string, RuleRegistryEntry] => [rule.id, { rule: { ...rule } }]);
  const byId = new Map<string, RuleRegistryEntry>(fromInitial());
  const copyEntry = (entry: RuleRegistryEntry): RuleRegistryEntry => ({ ...entry, rule: { ...entry.rule } });

  return {
    list: () => [...byId.values()].map((entry) => ({ ...entry.rule })),
    get: (id) => {
      const found = byId.get(id);
      return found === undefined ? undefined : { ...found.rule };
    },
    entry: (id) => {
      const found = byId.get(id);
      return found === undefined ? undefined : copyEntry(found);
    },
    add: (rule, spec) => {
      const id = assignId(rule.id);
      const stored: PolicyRule = { ...rule, id };
      byId.set(id, { spec, rule: stored });
      return { ...stored };
    },
    update: (id, patch, spec) => {
      const existing = byId.get(id);
      if (existing === undefined) return undefined;
      const { matcher, action, ...rest } = patch;
      const updated: PolicyRule = { ...existing.rule, ...rest };
      if (matcher !== undefined) updated.matcher = matcher;
      if (action !== undefined) updated.action = action;
      if (updated.id !== id) byId.delete(id);
      byId.set(updated.id, { spec: spec ?? existing.spec, rule: updated });
      return { ...updated };
    },
    remove: (id) => byId.delete(id),
    reset: () => {
      byId.clear();
      for (const [id, entry] of fromInitial()) byId.set(id, entry);
    },
    size: () => byId.size,
  };
}
