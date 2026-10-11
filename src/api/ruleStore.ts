import type { PolicyRule } from '../policy/ruleEngine';
import { createCrudStore } from './crudStore';

/**
 * Options for {@link createRuleStore}.
 */
export interface RuleStoreOptions {
  /**
   * Rules to seed the store with. Stored defensively (a copy is taken), so later
   * mutation of this array or its rules cannot corrupt the store. When omitted,
   * the store starts empty and {@link RuleStore.reset} restores it to empty.
   */
  initial?: PolicyRule[];
}

/**
 * A patch that can update any updatable field of a stored rule.
 *
 * Shallow-merge semantics: only the provided fields change. `matcher` and
 * `action` may be replaced wholesale by assigning them in the patch; omitting
 * them leaves the existing matcher/action untouched.
 */
export type RulePatch = Partial<Omit<PolicyRule, 'matcher' | 'action'>> & {
  matcher?: PolicyRule['matcher'];
  action?: PolicyRule['action'];
};

/**
 * An in-memory registry of {@link PolicyRule}s supporting runtime add/update/
 * remove, intended to feed the rule engine dynamically via a getter source
 * (`() => store.list()`).
 *
 * Every accessor returns DEFENSIVE COPIES: mutating a returned rule (or the
 * array from {@link RuleStore.list}) never corrupts the store's internal state.
 */
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
  /** Number of rules currently stored. */
  size(): number;
}

/**
 * Create an in-memory {@link RuleStore} over the shared {@link createCrudStore}
 * base (which holds the defensive-copy / initial-seed / reset / id-assignment
 * boilerplate). Pass {@link RuleStoreOptions.initial} to seed it; otherwise it
 * starts empty. The store holds defensive copies throughout — `add`, `update`,
 * `get`, and `list` all operate on / return copies, so mutating any returned
 * object cannot corrupt the store. Hand the returned rules to `createRuleEngine`
 * via a getter (`() => store.list()`) for live add/remove reflected on each
 * evaluation.
 */
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
