/**
 * JSON wire shape + validation for API-provider definitions managed over the
 * `/api/api-providers/*` REST routes. Mirrors {@link ./ruleSpec} style: pure,
 * dependency-free record types plus a validator the HTTP layer runs before any
 * add/update, keeping the store free of input-parsing concerns.
 */

/** The protocol the upstream model provider speaks. */
export type ProviderProtocol = 'openai' | 'anthropic';

/** A persisted API-provider definition (the dashboard-facing / DB-backed shape). */
export interface ApiProvider {
  /** Stable unique id (assigned by the store when omitted on create). */
  id: string;
  /** Human display label. */
  name: string;
  /** Base URL forwarded to (e.g. http://host/v1). */
  baseUrl: string;
  /** Model name passed to the upstream provider. */
  model: string;
  /** Optional provider API key (`null` = none). */
  apiKey: string | null;
  /** Protocol spoken by the provider. */
  protocol: ProviderProtocol;
  /** Whether this is the active (live) provider — at most one may be true. */
  isActive: boolean;
  /** Unix-ms creation timestamp (informational). */
  createdAt: number;
}

/** The fields a client may send in a create/patch body; everything else ignored. */
const KNOWN_FIELDS = [
  'name',
  'baseUrl',
  'model',
  'apiKey',
  'protocol',
  'isActive',
] as const;

type KnownField = (typeof KNOWN_FIELDS)[number];

/** Type guard: a non-null, non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True when `value` is a whitespace-trimmed-non-empty string. */
export function isNonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Normalize an optional `apiKey`: absent/null → `null`; a string is trimmed and
 * collapsed to `null` when empty after trimming. Non-string values are rejected
 * up front by {@link validateProviderSpec}.
 */
export function normalizeApiKey(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/** True when `value` is exactly one of the known provider protocols. */
function isKnownProtocol(value: unknown): value is ProviderProtocol {
  return value === 'openai' || value === 'anthropic';
}

/** Validate a single known field's format when present; `null` means valid/absent. */
function validateKnownField(key: KnownField, value: unknown): string | null {
  switch (key) {
    case 'name':
      // Present-but-must-be-non-empty enforced here; absence handled by callers
      // that require it (e.g. POST). Empty/whitespace-only strings are rejected so
      // both create and patch reject degenerate values uniformly.
      if (value !== undefined && (!isNonEmptyString(value))) {
        return '"name" must be a non-empty string';
      }
      break;
    case 'baseUrl':
      if (value !== undefined && !isNonEmptyString(value)) {
        return '"baseUrl" must be a non-empty string';
      }
      break;
    case 'model':
      // Optional: absent/empty/blank are all valid; a present value must still be a string.
      if (value !== undefined && typeof value !== 'string') {
        return '"model" must be a string';
      }
      break;
    case 'apiKey':
      if (value !== undefined && value !== null && typeof value !== 'string') {
        return '"apiKey" must be a string or null';
      }
      break;
    case 'protocol':
      if (value !== undefined && !isKnownProtocol(value)) {
        return '"protocol" must be exactly "openai" or "anthropic"';
      }
      break;
    case 'isActive':
      if (value !== undefined && typeof value !== 'boolean') {
        return '"isActive" must be a boolean';
      }
      break;
  }
  return null;
}

/**
 * Validate an unknown candidate API-provider body against the KNOWN_FIELDS
 * format rules. Returns `null` when every *present* known field is well-formed,
 * else a human-readable error message. Unknown extra fields are ignored (mirrors
 * {@link ./ruleSpec.validateSpec}, which also tolerates unmodeled keys); presence
 * requirements for a full CREATE are enforced separately by the HTTP layer.
 */
export function validateProviderSpec(input: unknown): string | null {
  if (!isRecord(input)) return 'provider must be a JSON object';
  for (const key of KNOWN_FIELDS) {
    if (!(key in input)) continue;
    const error = validateKnownField(key, input[key]);
    if (error !== null) return error;
  }
  return null;
}
