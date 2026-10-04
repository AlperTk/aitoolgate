import { createHash } from 'node:crypto';

/** Options controlling {@link normalizeParams}. */
export interface NormalizeOptions {
  /**
   * Object keys to drop (volatile keys such as timestamps, ids, or nonces) at
   * every object level, so they do not affect the canonical form.
   */
  ignoreKeys?: string[];
}

/**
 * Canonical, order-independent string representation of a value, for comparing
 * tool params/results by "normalized identity."
 *
 * - Objects: keys are sorted alphabetically (so key REORDERING is irrelevant);
 *   any key in `opts.ignoreKeys` is dropped; values are recursed into.
 * - Arrays: element ORDER is preserved (arrays are ordered), each recursed into.
 * - Strings: trimmed and whitespace runs collapsed to a single space.
 * - Primitives: canonical string form (JSON semantics).
 *
 * Semantically-equal inputs produce identical output; key reordering or
 * whitespace differences in strings do NOT change the output. Node built-ins
 * only (no dependencies).
 */
export function normalizeParams(value: unknown, opts?: NormalizeOptions): string {
  return canonicalize(value, opts);
}

/**
 * Hex SHA-256 of {@link normalizeParams}(value) — the "normalized identity."
 * Two values compare as identical after normalization iff their hashes match:
 * `hashValue(a) === hashValue(b)`.
 */
export function hashValue(value: unknown): string {
  return createHash('sha256').update(normalizeParams(value), 'utf8').digest('hex');
}

/** Recursively canonicalize a single value into a stable string. */
function canonicalize(value: unknown, opts?: NormalizeOptions): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      // Trim + collapse whitespace runs, then quote via JSON.stringify so string
      // values are unambiguously distinguished from other types (and escaped).
      return JSON.stringify(collapseWhitespace(value));
    case 'number':
    case 'boolean':
      // JSON semantics (NaN / Infinity serialize to `null`).
      return JSON.stringify(value);
    case 'bigint':
      return value.toString();
    case 'symbol':
      return value.toString();
    case 'undefined':
      return 'undefined';
    case 'object':
      if (Array.isArray(value)) {
        // Arrays are ORDERED: preserve element order, recurse on each element.
        return `[${value.map((element) => canonicalize(element, opts)).join(',')}]`;
      }
      // Objects: sort keys alphabetically (order-independent) and drop any key
      // in opts.ignoreKeys (volatile keys); recurse on each value.
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj).sort();
      const parts: string[] = [];
      for (const key of keys) {
        if (opts?.ignoreKeys?.includes(key)) continue;
        parts.push(`${JSON.stringify(key)}:${canonicalize(obj[key], opts)}`);
      }
      return `{${parts.join(',')}}`;
    case 'function':
      return 'function';
  }
  return String(value);
}

/** Trim a string and collapse runs of whitespace to a single space. */
function collapseWhitespace(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}
