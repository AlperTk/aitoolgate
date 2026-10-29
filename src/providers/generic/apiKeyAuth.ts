import type { AuthCredentials, AuthStrategy } from '../../ports/auth';

/** Static API-key auth: sends the key as both a Bearer token and an `x-api-key` header; no key → no headers. */
export function createApiKeyAuth(): AuthStrategy {
  return {
    kind: 'apiKey',
    resolveHeaders(credentials: AuthCredentials): Record<string, string> {
      const apiKey = credentials.apiKey;
      if (!apiKey) return {};
      return { Authorization: `Bearer ${apiKey}`, 'x-api-key': apiKey };
    },
  };
}
