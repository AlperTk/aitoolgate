/** JSON wire shape + validation for API-provider definitions over the `/api/api-providers/*` routes; the HTTP layer runs the validator so the store stays free of input-parsing. */

import { lookupProviderAdapter } from '../providers/registry';
import { COPILOT_ADAPTER_ID } from '../providers/copilot/adapter';

export type ProviderProtocol = 'openai' | 'anthropic';

/** How a provider authenticates upstream: a static key, or a device-code OAuth flow. */
export type ProviderAuthType = 'apiKey' | 'deviceOAuth';

const AUTH_TYPES: readonly ProviderAuthType[] = ['apiKey', 'deviceOAuth'];

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
  /** Wire protocol derived from `adapterId` (read-only; never client-supplied). */
  protocol: ProviderProtocol;
  /** Provider type = adapter id from the catalog (default `generic-openai`). */
  adapterId: string;
  /** Upstream auth strategy (default `apiKey`). */
  authType: ProviderAuthType;
  /** Opaque JSON string of adapter auth state (e.g. OAuth token); stored as-is, never returned by list responses. */
  authState: string | null;
  /** Whether this is the active (live) provider — at most one may be true. */
  isActive: boolean;
  /** Unix-ms creation timestamp (informational). */
  createdAt: number;
}

/** The fields a client may send in a create/patch body; everything else ignored (`authState` is deliberately not client-writable). */
const KNOWN_FIELDS = [
  'name',
  'baseUrl',
  'model',
  'apiKey',
  'isActive',
  'adapterId',
  'authType',
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
    case 'isActive':
      if (value !== undefined && typeof value !== 'boolean') {
        return '"isActive" must be a boolean';
      }
      break;
    case 'adapterId':
      // Absent defaults to the generic-openai type; a present id must be a catalog type.
      if (value === undefined) break;
      if (!isNonEmptyString(value)) return '"adapterId" must be a non-empty string';
      if (lookupProviderAdapter(value as string) === null) return `"adapterId" "${value}" is not a registered provider adapter`;
      break;
    case 'authType':
      if (value !== undefined && !(AUTH_TYPES as readonly unknown[]).includes(value)) {
        return '"authType" must be exactly "apiKey" or "deviceOAuth"';
      }
      break;
  }
  return null;
}

/**
 * Validate a candidate body against KNOWN_FIELDS format rules; `null` when well-formed, else an error.
 * Unknown fields ignored; CREATE presence rules enforced by the HTTP layer. `current` is the stored row on PATCH,
 * used when the body omits `adapterId`/`authType`. A copilot provider must be deviceOAuth with no apiKey.
 */
export function validateProviderSpec(
  input: unknown,
  current?: { adapterId: string; authType: ProviderAuthType },
): string | null {
  if (!isRecord(input)) return 'provider must be a JSON object';
  for (const key of KNOWN_FIELDS) {
    if (!(key in input)) continue;
    const error = validateKnownField(key, input[key]);
    if (error !== null) return error;
  }
  const adapterId = 'adapterId' in input ? input.adapterId : current?.adapterId;
  if (adapterId === COPILOT_ADAPTER_ID) {
    const authType = 'authType' in input ? input.authType : current?.authType;
    if (authType !== undefined && authType !== 'deviceOAuth') {
      return `"authType" for a ${COPILOT_ADAPTER_ID} provider must be "deviceOAuth"`;
    }
    if (input.apiKey !== undefined && input.apiKey !== null) {
      return `"apiKey" cannot be set on a ${COPILOT_ADAPTER_ID} provider`;
    }
  }
  return null;
}
