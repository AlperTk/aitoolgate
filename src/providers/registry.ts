import type { ProviderAdapter, WireProtocol } from '../ports/provider';
import { createGenericAdapter, GENERIC_ANTHROPIC_ADAPTER_ID, GENERIC_OPENAI_ADAPTER_ID } from './generic/adapter';
import { createCopilotAdapter, COPILOT_ADAPTER_ID } from './copilot/adapter';

/** Registry id used when a provider does not name a type. */
export const DEFAULT_PROVIDER_ADAPTER_ID = GENERIC_OPENAI_ADAPTER_ID;

/** Human-readable labels of the catalog types, keyed by adapter (type) id. */
const PROVIDER_TYPE_LABELS: Readonly<Record<string, string>> = {
  [GENERIC_OPENAI_ADAPTER_ID]: 'Generic OpenAI-compatible',
  [GENERIC_ANTHROPIC_ADAPTER_ID]: 'Generic Anthropic-compatible',
  [COPILOT_ADAPTER_ID]: 'GitHub Copilot',
};

/** Registry mapping adapter (provider type) ids to their adapters; a new type needs only its module + one entry here. */
export const PROVIDER_ADAPTERS: Readonly<Record<string, ProviderAdapter>> = {
  [GENERIC_OPENAI_ADAPTER_ID]: createGenericAdapter('openai'),
  [GENERIC_ANTHROPIC_ADAPTER_ID]: createGenericAdapter('anthropic'),
  [COPILOT_ADAPTER_ID]: createCopilotAdapter(),
};

/** One entry of the provider-type catalog exposed to clients. */
export interface ProviderTypeInfo {
  /** The provider type id (= adapter id). */
  id: string;
  label: string;
  /** Wire protocol the type speaks; derived, never client-supplied. */
  wireProtocol: WireProtocol;
}

/** The catalog of provider types, in registration order. */
export function listProviderTypes(): ProviderTypeInfo[] {
  return Object.values(PROVIDER_ADAPTERS).map((adapter) => ({
    id: adapter.id,
    label: PROVIDER_TYPE_LABELS[adapter.id] ?? adapter.id,
    wireProtocol: adapter.wireProtocol,
  }));
}

/** Look up a provider adapter by id; returns null for unknown ids (non-throwing). */
export function lookupProviderAdapter(id: string): ProviderAdapter | null {
  return Object.prototype.hasOwnProperty.call(PROVIDER_ADAPTERS, id) ? PROVIDER_ADAPTERS[id] : null;
}

/** Wire protocol derived from a provider type; unknown ids fall back to the default type's protocol. */
export function wireProtocolFor(adapterId: string): WireProtocol {
  return lookupProviderAdapter(adapterId)?.wireProtocol ?? 'openai';
}
