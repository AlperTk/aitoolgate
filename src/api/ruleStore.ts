import type { PolicyRule } from '../policy/ruleEngine';
import { createCrudStore } from './crudStore';

export interface RuleStoreOptions {
  /** Seed rules, stored as defensive copies (mutating the array later won't corrupt the store); omitted → store starts empty. */
  initial?: PolicyRule[];
}

/** Patch that shallow-merges provided fields; `matcher`/`action` may be replaced wholesale, omitting them leaves the existing one untouched. */
export type RulePatch = Partial<Omit<PolicyRule, 'matcher' | 'action'>> & {
  matcher?: PolicyRule['matcher'];
  action?: PolicyRule['action'];
};

/** In-memory rule registry fed to the engine via `() => store.list()`; every accessor returns defensive copies (mutating a result never corrupts internal state). */
export interface RuleStore {
  /** A fresh array copy of the current rules (not the internal reference). */
  list(): PolicyRule[];
  /** A copy of the rule at `id`, or `undefined` when absent. */
  get(id: string): PolicyRule | undefined;
  /** Store a copy of `rule`, assigning a unique id when `rule.id` is missing/empty. Returns the stored copy (with its id). */
  add(rule: PolicyRule): PolicyRule;
  /** Shallow-merge `patch` into the rule at `id`; return the updated copy, or `undefined` if not found. */
  update(id: string, patch: RulePatch): PolicyRule | undefined;
  /** Remove the rule at `id`. Returns `true` when a rule was removed. */
  remove(id: string): boolean;
  /** Restore the store to its `initial` state (empty when none was provided). */
  reset(): void;
  size(): number;
}

/** Create an in-memory rule store over `createCrudStore`; returns defensive copies throughout; hand rules to `createRuleEngine` via `() => store.list()`. */
export function createRuleStore(options: RuleStoreOptions = {}): RuleStore {
  return createCrudStore<PolicyRule, PolicyRule, RulePatch>({
    initial: options.initial,
    // A full rule needs no defaults; the base assigns a unique id when missing/empty.
    toStored: (rule) => ({ ...rule }),
    update: (id, patch, ctx) => {
      const existing = ctx.byId.get(id);
      if (existing === undefined) return undefined;
      const { matcher, action, ...rest } = patch;
      const updated: PolicyRule = { ...existing, ...rest };
      if (matcher !== undefined) updated.matcher = matcher;
      if (action !== undefined) updated.action = action;
      if (updated.id !== id) ctx.byId.delete(id);
      ctx.byId.set(updated.id, updated);
      return ctx.copy(updated);
    },
  });
}
