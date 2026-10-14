import { createHash } from 'node:crypto';

export interface NormalizeOptions {
  /** Object keys to drop (volatile keys such as timestamps, ids, or nonces) at every object level. */
  ignoreKeys?: string[];
}

/** Canonical, order-independent string of a value for "normalized identity"; object keys sorted (order-independent), array order preserved, strings trimmed/collapsed. Node built-ins only. */
export function normalizeParams(value: unknown, opts?: NormalizeOptions): string {
  return canonicalize(value, opts);
}

/** Hex SHA-256 of {@link normalizeParams}(value); two values compare identical after normalization iff their hashes match. */
export function hashValue(value: unknown): string {
  return createHash('sha256').update(normalizeParams(value), 'utf8').digest('hex');
}

function canonicalize(value: unknown, opts?: NormalizeOptions): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      // Quoted via JSON.stringify so string values are distinguished from other types (and escaped).
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
        // Arrays are ORDERED: preserve element order.
        return `[${value.map((element) => canonicalize(element, opts)).join(',')}]`;
      }
      // Objects: sort keys alphabetically (order-independent) and drop opts.ignoreKeys.
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

function collapseWhitespace(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}
