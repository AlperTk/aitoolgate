import { randomUUID } from 'node:crypto';
import type { PolicyRule } from '../policy/ruleEngine';

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

/** Shallow-copy a rule so callers cannot mutate the stored instance via a returned reference. */
function copyRule(rule: PolicyRule): PolicyRule {
  return { ...rule };
}

/**
 * Create an in-memory {@link RuleStore}. Pass {@link RuleStoreOptions.initial}
 * to seed it; otherwise it starts empty. The store holds defensive copies
 * throughout — {@link RuleStore.add}, {@link RuleStore.update},
 * {@link RuleStore.get}, and {@link RuleStore.list} all operate on / return
 * copies, so mutating any returned object cannot corrupt the store. Hand the
 * returned rules to `createRuleEngine` via a getter (`() => store.list()`) for
 * live add/remove reflected on each evaluation.
 */
export function createRuleStore(options: RuleStoreOptions = {}): RuleStore {
  // Detached snapshot of the initial rules (copies) used as the reset baseline.
  const initial: PolicyRule[] = (options.initial ?? []).map(copyRule);
  const rules = new Map<string, PolicyRule>(initial.map((rule) => [rule.id, rule]));

  function restoreInitial(): void {
    rules.clear();
    for (const rule of initial) {
      rules.set(rule.id, rule);
    }
  }

  return {
    list() {
      return [...rules.values()].map(copyRule);
    },
    get(id) {
      const found = rules.get(id);
      return found === undefined ? undefined : copyRule(found);
    },
    add(rule) {
      const id = typeof rule.id === 'string' && rule.id.length > 0 ? rule.id : randomUUID();
      const stored: PolicyRule = { ...rule, id };
      rules.set(id, stored);
      return copyRule(stored);
    },
    update(id, patch) {
      const existing = rules.get(id);
      if (existing === undefined) return undefined;
      const { matcher, action, ...rest } = patch;
      const updated: PolicyRule = { ...existing, ...rest };
      if (matcher !== undefined) updated.matcher = matcher;
      if (action !== undefined) updated.action = action;
      if (updated.id !== id) rules.delete(id);
      rules.set(updated.id, updated);
      return copyRule(updated);
    },
    remove(id) {
      return rules.delete(id);
    },
    reset() {
      restoreInitial();
    },
    size() {
      return rules.size;
    },
  };
}
