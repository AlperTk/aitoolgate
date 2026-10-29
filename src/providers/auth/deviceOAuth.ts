import type { AuthCredentials, AuthStrategy } from '../../ports/auth';

/** Public GitHub OAuth app client id (same value opencode uses for its Copilot device login). */
export const DEFAULT_DEVICE_OAUTH_CLIENT_ID = 'Ov23li8tweQw6odWQebz';
export const DEFAULT_GITHUB_DOMAIN = 'github.com';

const DEVICE_SCOPE = 'read:user';
const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';
const SLOW_DOWN_STEP_SECONDS = 5;
const AUTH_STATE_VERSION = 1;
const HOST_PATTERN = /^[a-z0-9-]+(\.[a-z0-9-]+)*(:\d{1,5})?$/;

export interface DeviceOAuthOptions {
  /** GitHub host (`github.com` default) or enterprise host/base URL, e.g. `company.ghe.com` or `https://company.ghe.com/`. */
  githubDomain?: string;
  /** OAuth app client id; defaults to {@link DEFAULT_DEVICE_OAUTH_CLIENT_ID}. */
  clientId?: string;
  /** Fetch implementation; defaults to global fetch. */
  fetch?: typeof fetch;
}

/** Token material persisted (as opaque JSON) in api_providers.auth_state. */
export interface DeviceOAuthState {
  accessToken: string;
}

/** Result of a successful device-code request; poll with pollDeviceFlow. */
export interface DeviceFlow {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  /** Minimum seconds between polls. */
  interval: number;
  expiresIn: number;
}

export interface DeviceOAuthError {
  code: string;
  message: string;
}

export type DeviceFlowStartResult = { ok: true; flow: DeviceFlow } | { ok: false; error: DeviceOAuthError };

export type DevicePollResult =
  | { status: 'pending'; interval: number }
  | { status: 'slow_down'; interval: number }
  | { status: 'done'; state: DeviceOAuthState }
  | { status: 'expired' }
  | { status: 'denied' }
  | { status: 'error'; error: DeviceOAuthError };

/** Device-code OAuth auth strategy: synchronous header resolution plus async start/poll for the login flow. */
export interface DeviceOAuthAuth extends AuthStrategy {
  readonly kind: 'deviceOAuth';
  /** Bearer header from a serialized authState; empty object when the state is missing or malformed. */
  resolveAuthStateHeaders(authState: string | null | undefined): Record<string, string>;
  startDeviceFlow(): Promise<DeviceFlowStartResult>;
  pollDeviceFlow(flow: DeviceFlow): Promise<DevicePollResult>;
}

type JsonRecord = Record<string, unknown>;
type PostResult = { ok: true; status: number; data: JsonRecord } | { ok: false; error: DeviceOAuthError };

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeDomain(input: string): string | null {
  const host = input.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '').toLowerCase();
  return HOST_PATTERN.test(host) ? host : null;
}

function bearerHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

/** Serializes authState for api_providers.auth_state. */
export function serializeAuthState(state: DeviceOAuthState): string {
  return JSON.stringify({ v: AUTH_STATE_VERSION, accessToken: state.accessToken });
}

/** Parses authState JSON; returns null for missing, malformed, or wrong-version input (never throws). */
export function parseAuthState(raw: string | null | undefined): DeviceOAuthState | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(data) || data.v !== AUTH_STATE_VERSION) return null;
  if (typeof data.accessToken !== 'string' || data.accessToken.length === 0) return null;
  return { accessToken: data.accessToken };
}

async function postJson(fetchImpl: typeof fetch, url: string, body: JsonRecord): Promise<PostResult> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, error: { code: 'network_error', message: 'Device OAuth request failed' } };
  }
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    return { ok: false, error: { code: 'invalid_response', message: 'Device OAuth response was not JSON' } };
  }
  if (!isRecord(data)) {
    return { ok: false, error: { code: 'invalid_response', message: 'Device OAuth response was not an object' } };
  }
  return { ok: true, status: res.status, data };
}

/** Factory for the device-code OAuth strategy (GitHub.com or enterprise host). */
export function createDeviceOAuthAuth(options: DeviceOAuthOptions = {}): DeviceOAuthAuth {
  const host = normalizeDomain(options.githubDomain ?? DEFAULT_GITHUB_DOMAIN);
  const clientId = options.clientId ?? DEFAULT_DEVICE_OAUTH_CLIENT_ID;
  const fetchImpl: typeof fetch = options.fetch ?? ((...args) => fetch(...args));
  const invalidDomain: DeviceOAuthError = { code: 'invalid_domain', message: 'GitHub domain is not a valid host' };

  return {
    kind: 'deviceOAuth',

    resolveHeaders(credentials: AuthCredentials): Record<string, string> {
      const token = credentials.apiKey;
      if (!token) return {};
      return bearerHeaders(token);
    },

    resolveAuthStateHeaders(authState: string | null | undefined): Record<string, string> {
      const state = parseAuthState(authState);
      return state ? bearerHeaders(state.accessToken) : {};
    },

    async startDeviceFlow(): Promise<DeviceFlowStartResult> {
      if (!host) return { ok: false, error: invalidDomain };
      const res = await postJson(fetchImpl, `https://${host}/login/device/code`, {
        client_id: clientId,
        scope: DEVICE_SCOPE,
      });
      if (!res.ok) return { ok: false, error: res.error };
      const { data, status } = res;
      if (typeof data.error === 'string') {
        return { ok: false, error: { code: data.error, message: `Device code request failed: ${data.error}` } };
      }
      if (status < 200 || status >= 300) {
        return { ok: false, error: { code: 'http_error', message: `Device code request failed: HTTP ${status}` } };
      }
      const { device_code, user_code, verification_uri, interval, expires_in } = data;
      if (
        typeof device_code !== 'string' || device_code.length === 0 ||
        typeof user_code !== 'string' || user_code.length === 0 ||
        typeof verification_uri !== 'string' || verification_uri.length === 0 ||
        typeof interval !== 'number' || !Number.isFinite(interval) ||
        typeof expires_in !== 'number' || !(expires_in > 0)
      ) {
        return { ok: false, error: { code: 'invalid_response', message: 'Device code response is incomplete' } };
      }
      return {
        ok: true,
        flow: {
          deviceCode: device_code,
          userCode: user_code,
          verificationUri: verification_uri,
          interval: Math.max(interval, 1),
          expiresIn: expires_in,
        },
      };
    },

    async pollDeviceFlow(flow: DeviceFlow): Promise<DevicePollResult> {
      if (!host) return { status: 'error', error: invalidDomain };
      const res = await postJson(fetchImpl, `https://${host}/login/oauth/access_token`, {
        client_id: clientId,
        device_code: flow.deviceCode,
        grant_type: DEVICE_GRANT_TYPE,
      });
      if (!res.ok) return { status: 'error', error: res.error };
      const { data } = res;
      const token = data.access_token;
      if (typeof token === 'string' && token.length > 0) {
        return { status: 'done', state: { accessToken: token } };
      }
      switch (data.error) {
        case 'authorization_pending':
          return { status: 'pending', interval: flow.interval };
        // RFC 8628 §3.5: slow_down mandates a fixed +5s step for this and all later polls.
        case 'slow_down':
          return { status: 'slow_down', interval: flow.interval + SLOW_DOWN_STEP_SECONDS };
        case 'expired_token':
          return { status: 'expired' };
        case 'access_denied':
          return { status: 'denied' };
        default: {
          const code = typeof data.error === 'string' ? data.error : 'invalid_response';
          return { status: 'error', error: { code, message: `Device authorization failed: ${code}` } };
        }
      }
    },
  };
}

export type CopilotEntitlementResult = { status: 'allowed' } | { status: 'blocked'; message: string };

/**
 * Copilot entitlement on GET /copilot_internal/user (api.github.com for github.com, api.<host> for enterprise).
 * Only `chat_enabled === false` blocks; any other response or a network failure is allowed. Never throws.
 */
export async function checkCopilotEntitlement(
  accessToken: string,
  options: DeviceOAuthOptions = {},
): Promise<CopilotEntitlementResult> {
  const host = normalizeDomain(options.githubDomain ?? DEFAULT_GITHUB_DOMAIN);
  if (!host) return { status: 'allowed' };
  const fetchImpl: typeof fetch = options.fetch ?? ((...args) => fetch(...args));
  const apiHost = host === DEFAULT_GITHUB_DOMAIN ? 'api.github.com' : `api.${host}`;
  try {
    const res = await fetchImpl(`https://${apiHost}/copilot_internal/user`, {
      headers: { Accept: 'application/json', ...bearerHeaders(accessToken) },
    });
    const data: unknown = await res.json();
    if (isRecord(data) && data.chat_enabled === false) {
      return { status: 'blocked', message: 'GitHub Copilot is not enabled for this GitHub account' };
    }
  } catch {
    // Unreachable entitlement endpoint does not block login.
  }
  return { status: 'allowed' };
}
