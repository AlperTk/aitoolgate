/** Port contracts for provider authentication; concrete strategies live in `src/providers/<adapter>/`. */

/** Credentials an auth strategy turns into upstream request headers. */
export interface AuthCredentials {
  /** Static provider API key; null/undefined/empty means no credentials. */
  apiKey: string | null | undefined;
}

/** Port: resolves provider credentials into the header set attached to every upstream request. */
export interface AuthStrategy {
  /** Stable identifier of the strategy (e.g. `apiKey`). */
  readonly kind: string;
  /** Headers carrying the credentials (empty object when none apply). */
  resolveHeaders(credentials: AuthCredentials): Record<string, string>;
}
