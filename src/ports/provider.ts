import type { AuthStrategy } from './auth';

/** Port contracts for upstream provider adapters; concrete adapters live in `src/providers/<adapter>/`. */

/** Wire protocol names; `WIRE_PROTOCOL_IDS` in `src/protocols/registry.ts` must cover exactly these keys. */
export const WIRE_PROTOCOLS = ['openai', 'anthropic'] as const;

/** Wire protocol an upstream speaks. */
export type WireProtocol = (typeof WIRE_PROTOCOLS)[number];

/** Stored provider configuration an adapter resolves into an upstream target. */
export interface ProviderConfig {
  baseUrl: string;
  protocol: WireProtocol;
  apiKey: string | null | undefined;
}

/** The resolved upstream target the proxy consumes (it never sees the adapter). */
export interface ResolvedUpstream {
  baseUrl: string;
  protocol: WireProtocol;
  headers: Record<string, string>;
}

/** Per-request context passed to {@link ProviderAdapter.decorateHeaders}. */
export interface DecorateContext {
  headers: Record<string, string>;
  protocol: WireProtocol;
  /** Request messages (chat shape); optional, used for per-request flags such as x-initiator and vision detection. */
  messages?: ReadonlyArray<{ role: string; content?: unknown }>;
  /** Serialized authState of the provider (opaque; parsed by the adapter's auth strategy). */
  authState?: string | null;
}

/** A ready-to-send model-list request; `secrets` are credential values that must be redacted from any error text. */
export interface ModelListRequest {
  url: string;
  headers: Record<string, string>;
  secrets: string[];
}

/** Port: an upstream provider adapter (endpoint shape, auth, optional per-request header decoration). */
export interface ProviderAdapter {
  /** Registry key of the adapter (e.g. `generic`). */
  readonly id: string;
  /** Wire protocol the adapter speaks natively. */
  readonly wireProtocol: WireProtocol;
  /** Credential strategy producing the auth headers. */
  readonly auth: AuthStrategy;
  /** Map stored provider config to the upstream base URL and protocol. */
  resolveEndpoint(config: ProviderConfig): { baseUrl: string; protocol: WireProtocol };
  /** Optional per-request header decoration applied on top of the resolved headers. */
  decorateHeaders?(ctx: DecorateContext): Record<string, string>;
  /** Optional model-list request built from stored config + authState; `null` when no credential is available. */
  listModels?(config: ProviderConfig, authState: string | null | undefined): ModelListRequest | null;
}
