/** JSON wire shape + validation for API-provider definitions over the `/api/api-providers/*` routes; the HTTP layer runs the validator so the store stays free of input-parsing. */

export type ProviderProtocol = 'openai' | 'anthropic';

/** A persisted API-provider definition (the dashboard-facing / DB-backed shape). */
export interface ApiProvider {
  /** Stable unique id (assigned by the store when omitted on create). */
  id: string;
  name: string;
  /** Base URL forwarded to (e.g. http://host/v1). */
  baseUrl: string;
  /** Upstream model override; `null` = "From Request" (the client request's model is forwarded unchanged). */
  model: string | null;
  /** Optional provider API key (`null` = none). */
  apiKey: string | null;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isNonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Normalize an optional `apiKey`: absent/null/empty → `null`; a string is trimmed; non-strings rejected by `validateProviderSpec`. */
export function normalizeApiKey(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function isKnownProtocol(value: unknown): value is ProviderProtocol {
  return value === 'openai' || value === 'anthropic';
}

/** Validate a single known field's format when present; `null` means valid/absent. */
function validateKnownField(key: KnownField, value: unknown): string | null {
  switch (key) {
    case 'name':
      // Non-empty is enforced here; absence is deferred to callers that require it (e.g. POST), so create/patch reject degenerate values uniformly.
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
      // Optional: absent/null/empty/blank are all valid; a present value must be a string or null.
      if (value !== undefined && value !== null && typeof value !== 'string') {
        return '"model" must be a string or null';
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

/** Validate a candidate body against KNOWN_FIELDS format rules; `null` when well-formed, else an error. Unknown fields ignored; CREATE presence rules enforced by the HTTP layer. */
export function validateProviderSpec(input: unknown): string | null {
  if (!isRecord(input)) return 'provider must be a JSON object';
  for (const key of KNOWN_FIELDS) {
    if (!(key in input)) continue;
    const error = validateKnownField(key, input[key]);
    if (error !== null) return error;
  }
  return null;
}
