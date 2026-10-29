import type { ProviderAdapter, WireProtocol } from '../../ports/provider';
import { createApiKeyAuth } from './apiKeyAuth';

/** Registry id of the generic OpenAI-compatible provider type. */
export const GENERIC_OPENAI_ADAPTER_ID = 'generic-openai';

/** Registry id of the generic Anthropic-compatible provider type. */
export const GENERIC_ANTHROPIC_ADAPTER_ID = 'generic-anthropic';

/** Generic adapter for a given wire protocol: the base URL is used as stored, auth is the API-key strategy, and the protocol is fixed by the type. */
export function createGenericAdapter(wireProtocol: WireProtocol): ProviderAdapter {
  return {
    id: `generic-${wireProtocol}`,
    wireProtocol,
    auth: createApiKeyAuth(),
    resolveEndpoint(config) {
      return { baseUrl: config.baseUrl, protocol: wireProtocol };
    },
  };
}
