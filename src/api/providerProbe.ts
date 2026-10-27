/** Probe an upstream provider's model-list endpoint (reachability, auth, model ids); upstream failures are returned as `ok:false`, never thrown. */
import type { ProviderProtocol } from './providerSpec';
import { isNonEmptyString, normalizeApiKey } from './providerSpec';

/** Upper bound for a single probe request (the probe only; proxy traffic is untouched). */
export const PROBE_TIMEOUT_MS = 10_000;

export interface ProbeRequest {
  protocol: ProviderProtocol;
  baseUrl: string;
  /** Resolved key (`null` = probe without auth). */
  apiKey: string | null;
}

export interface ProbeResult {
  ok: boolean;
  status?: number;
  latencyMs: number;
  models: string[];
  error?: string;
}

export type ProbeBodyResult =
  | { ok: true; protocol: ProviderProtocol; baseUrl: string; apiKey: string | null; id?: string }
  | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validate a `POST /api/api-providers/probe` body; `protocol` and `baseUrl` are required, `apiKey`/`id` optional. */
export function parseProbeBody(input: unknown): ProbeBodyResult {
  if (!isRecord(input)) return { ok: false, error: 'body must be a JSON object' };
  if (input.protocol !== 'openai' && input.protocol !== 'anthropic') {
    return { ok: false, error: '"protocol" must be exactly "openai" or "anthropic"' };
  }
  if (!isNonEmptyString(input.baseUrl)) {
    return { ok: false, error: '"baseUrl" is required and must be a non-empty string' };
  }
  const baseUrl = (input.baseUrl as string).trim();
  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('scheme');
  } catch {
    return { ok: false, error: '"baseUrl" must be an absolute http(s) URL' };
  }
  if (input.apiKey !== undefined && input.apiKey !== null && typeof input.apiKey !== 'string') {
    return { ok: false, error: '"apiKey" must be a string or null' };
  }
  if (input.id !== undefined && typeof input.id !== 'string') {
    return { ok: false, error: '"id" must be a string' };
  }
  const result: ProbeBodyResult = {
    ok: true,
    protocol: input.protocol,
    baseUrl,
    apiKey: normalizeApiKey(input.apiKey),
  };
  if (typeof input.id === 'string') result.id = input.id;
  return result;
}

/** Build the model-list URL; a baseUrl already ending in `/v1` is not doubled. */
export function buildModelsUrl(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '');
  return base.endsWith('/v1') ? `${base}/models` : `${base}/v1/models`;
}

/** Auth headers per protocol; no auth header is sent when no key is resolved. */
function buildHeaders(protocol: ProviderProtocol, apiKey: string | null): Record<string, string> {
  if (protocol === 'anthropic') {
    const headers: Record<string, string> = { 'anthropic-version': '2023-06-01' };
    if (apiKey !== null) headers['x-api-key'] = apiKey;
    return headers;
  }
  return apiKey !== null ? { Authorization: `Bearer ${apiKey}` } : {};
}

/** Strip any occurrence of the raw key from text so it never reaches a response. */
function redact(text: string, apiKey: string | null): string {
  return apiKey !== null && apiKey.length > 0 ? text.split(apiKey).join('***') : text;
}

function describeError(error: unknown, timeoutMs: number): string {
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return `probe timed out after ${timeoutMs}ms`;
  }
  return error instanceof Error ? error.message : String(error);
}

/** Collect data[].id into a sorted, de-duplicated list; anything malformed is skipped. */
function extractModelIds(payload: unknown): string[] {
  const data = isRecord(payload) && Array.isArray(payload.data) ? payload.data : [];
  const ids = new Set<string>();
  for (const entry of data) {
    if (isRecord(entry) && typeof entry.id === 'string' && entry.id.length > 0) ids.add(entry.id);
  }
  return [...ids].sort();
}

/** Probe the model-list endpoint; never throws on upstream failure. */
export async function probeProvider(
  request: ProbeRequest,
  fetchImpl: typeof fetch = globalThis.fetch,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<ProbeResult> {
  const started = Date.now();
  const { apiKey } = request;
  const latency = (): number => Date.now() - started;
  try {
    const response = await fetchImpl(buildModelsUrl(request.baseUrl), {
      method: 'GET',
      headers: { Accept: 'application/json', ...buildHeaders(request.protocol, apiKey) },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      // Upstream body is discarded so no provider-echoed text can reach the caller.
      void response.body?.cancel().catch(() => undefined);
      const hint = apiKey === null ? ' (no API key sent)' : '';
      return { ok: false, status: response.status, latencyMs: latency(), models: [], error: `upstream responded ${response.status}${hint}` };
    }
    const models = extractModelIds(await response.json());
    return { ok: true, status: response.status, latencyMs: latency(), models };
  } catch (error) {
    return { ok: false, latencyMs: latency(), models: [], error: redact(describeError(error, timeoutMs), apiKey) };
  }
}
