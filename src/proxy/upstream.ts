import type http from 'node:http';
import { Readable, type Transform } from 'node:stream';
import type { UpstreamProtocol } from '../../config/config';
import {
  anthropicResponseToOpenAI,
  anthropicToOpenAIRequest,
  openaiResponseToAnthropic,
  openaiToAnthropicRequest,
} from './translate';
import type {
  AnthropicRequest,
  AnthropicResponse,
  OpenAIChatRequest,
  OpenAIChatResponse,
} from './types';

/** A fetch-compatible function (defaults to the global `fetch`). */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Configuration for the upstream model client. */
export interface UpstreamClient {
  /** Base URL of the upstream, e.g. http://localhost:4000/v1 */
  baseUrl: string;
  /** Configured model name (returned by `GET /v1/models`). */
  model: string;
  /** Resolved provider API key — model metadata only; request headers come from `headers`. */
  apiKey?: string;
  /** Resolved auth/provider headers attached to every upstream POST (supplied by the composition root). */
  headers?: Record<string, string>;
  /** Protocol the upstream speaks. */
  protocol: UpstreamProtocol;
  /** Optional per-request header decorator (e.g. Copilot); receives the outgoing request messages. Must not throw. */
  decorateRequest?: (messages: ReadonlyArray<{ role: string; content?: unknown }> | undefined) => Record<string, string>;
  /** Injectable fetch (defaults to the global fetch) — used by tests. */
  fetchImpl?: FetchLike;
}

/** The JSON error body returned (HTTP 503) when no upstream provider is configured — no active provider and no programmatic upstream (empty baseUrl). */
export const UNCONFIGURED_UPSTREAM = {
  error: 'No active upstream provider configured. Add one via the dashboard Settings or POST /api/api-providers.',
};

/** True when the upstream has no forwarding target (empty baseUrl = unconfigured). */
export function isUnconfiguredUpstream(client: UpstreamClient): boolean {
  return client.baseUrl === '';
}

/** A synthetic 503 `Response` for the UNCONFIGURED case on the streaming path (no fetch is ever attempted; `pipeUpstreamStream` preserves the 503 status + JSON body). */
function unconfiguredUpstreamResponse(): Response {
  return new Response(JSON.stringify(UNCONFIGURED_UPSTREAM), {
    status: 503,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Result of forwarding a request to the upstream. */
export interface UpstreamResult {
  status: number;
  ok: boolean;
  /** Parsed JSON body (raw text if unparseable). */
  body: unknown;
}

function fetchFor(client: UpstreamClient): FetchLike {
  return client.fetchImpl ?? fetch;
}

function joinUrl(baseUrl: string, path: string): string {
  return baseUrl.replace(/\/+$/, '') + path;
}

/** HTTP headers shared by every upstream POST: JSON content type plus the resolved provider headers. */
/** Legacy auth rule (pre-T1): Bearer + x-api-key for both protocols when a key is set. */
function legacyAuthHeaders(apiKey: string | undefined): Record<string, string> {
  if (!apiKey) return {};
  return { Authorization: `Bearer ${apiKey}`, 'x-api-key': apiKey };
}

function requestMessagesOf(body: unknown): ReadonlyArray<{ role: string; content?: unknown }> | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const messages = (body as { messages?: unknown }).messages;
  return Array.isArray(messages) ? (messages as ReadonlyArray<{ role: string; content?: unknown }>) : undefined;
}

/** Static resolved headers, plus per-request decoration (when the active adapter supplies one). Never throws. */
function buildHeaders(client: UpstreamClient, body: unknown): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(client.headers ?? legacyAuthHeaders(client.apiKey)),
  };
  if (client.decorateRequest === undefined) return headers;
  try {
    return { ...headers, ...client.decorateRequest(requestMessagesOf(body)) };
  } catch {
    return headers;
  }
}

/** How long a NON-streaming upstream request may take before we abort it (5 min). */
const REQUEST_TIMEOUT_MS = 300_000;

// The active provider's model (when set) overrides the client-sent model on every outgoing body.
function withUpstreamModel(client: UpstreamClient, body: unknown): unknown {
  const model = client.model.trim();
  if (model === '' || typeof body !== 'object' || body === null) return body;
  return { ...body, model };
}

async function postJSON(
  client: UpstreamClient,
  path: string,
  body: unknown,
): Promise<UpstreamResult> {
  const url = joinUrl(client.baseUrl, path);
  // Time out the whole non-streaming request (headers AND body) so a slow/hung
  // upstream surfaces as a 504 instead of holding the client request open forever.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchFor(client)(url, {
      method: 'POST',
      headers: buildHeaders(client, body),
      body: JSON.stringify(withUpstreamModel(client, body)),
      signal: controller.signal,
    });
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
    return { status: response.status, ok: response.ok, body: parsed };
  } catch (err) {
    // A timeout-abort becomes a 504 "upstream timed out" result; any other error
    // (network failure, etc.) is rethrown for the caller/server to handle.
    if (controller.signal.aborted) {
      return { status: 504, ok: false, body: { error: 'upstream_timeout' } };
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Perform the upstream POST and return the raw `Response` WITHOUT reading its body. */
async function streamToEndpoint(
  client: UpstreamClient,
  path: string,
  body: unknown,
): Promise<Response> {
  // No short timeout: a stream can run for minutes, so we simply wait for the
  // upstream to close the connection (the caller owns the read + teardown).
  return fetchFor(client)(joinUrl(client.baseUrl, path), {
    method: 'POST',
    headers: buildHeaders(client, body),
    body: JSON.stringify(withUpstreamModel(client, body)),
  });
}

/** Forward an OpenAI client request to the upstream, returning an OpenAI response. */
export async function forwardOpenAIRequest(
  client: UpstreamClient,
  request: OpenAIChatRequest,
): Promise<UpstreamResult> {
  if (isUnconfiguredUpstream(client)) return { status: 503, ok: false, body: UNCONFIGURED_UPSTREAM };
  if (client.protocol === 'openai') {
    return postJSON(client, '/chat/completions', request);
  }
  const result = await postJSON(client, '/messages', openaiToAnthropicRequest(request));
  return { ...result, body: anthropicResponseToOpenAI(result.body as AnthropicResponse) };
}

/** Forward an Anthropic client request to the upstream, returning an Anthropic response. */
export async function forwardAnthropicRequest(
  client: UpstreamClient,
  request: AnthropicRequest,
): Promise<UpstreamResult> {
  if (isUnconfiguredUpstream(client)) return { status: 503, ok: false, body: UNCONFIGURED_UPSTREAM };
  if (client.protocol === 'anthropic') {
    return postJSON(client, '/messages', request);
  }
  const result = await postJSON(client, '/chat/completions', anthropicToOpenAIRequest(request));
  return { ...result, body: openaiResponseToAnthropic(result.body as OpenAIChatResponse) };
}

/**
 * POST an OpenAI client request to the upstream and return the raw `Response` without
 * consuming its body, so the caller can stream it. Same-protocol requests hit
 * `/chat/completions`; cross-protocol requests are translated first (the route handler
 * only invokes this on same-protocol streams — see that file).
 */
export async function streamOpenAIRequest(
  client: UpstreamClient,
  request: OpenAIChatRequest,
): Promise<Response> {
  if (isUnconfiguredUpstream(client)) return unconfiguredUpstreamResponse();
  if (client.protocol === 'openai') {
    return streamToEndpoint(client, '/chat/completions', request);
  }
  return streamToEndpoint(client, '/messages', openaiToAnthropicRequest(request));
}

/**
 * POST an Anthropic client request to the upstream and return the raw `Response` without
 * consuming its body, so the caller can stream it. Same-protocol requests hit
 * `/messages`; cross-protocol requests are translated first.
 */
export async function streamAnthropicRequest(
  client: UpstreamClient,
  request: AnthropicRequest,
): Promise<Response> {
  if (isUnconfiguredUpstream(client)) return unconfiguredUpstreamResponse();
  if (client.protocol === 'anthropic') {
    return streamToEndpoint(client, '/messages', request);
  }
  return streamToEndpoint(client, '/chat/completions', anthropicToOpenAIRequest(request));
}

/**
 * Pipe a raw upstream `Response` (SSE / chunked) straight through to the HTTP client as a
 * `text/event-stream` response instead of buffering it. The upstream web-body stream is
 * bridged into a Node `Readable` and piped onto `res`; when the client disconnects we
 * destroy the source so a long-lived upstream stream is not forced to keep flowing into
 * a closed response. A read/pipe error terminates the connection rather than crashing
 * the server (both cases are still surfaced by the server-level catch where relevant).
 */
export function pipeUpstreamStream(
  res: http.ServerResponse,
  upstreamResponse: Response,
  transformer?: Transform,
): void {
  res.writeHead(upstreamResponse.status, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const body = upstreamResponse.body;
  if (body === null) {
    res.end();
    return;
  }
  const source = Readable.fromWeb(body as unknown as import('node:stream/web').ReadableStream<Uint8Array>);
  res.once('close', () => {
    source.destroy();
    if (transformer !== undefined) transformer.destroy();
  });
  source.on('error', () => {
    res.end();
  });
  if (transformer !== undefined) {
    // Insert the (passthrough) transformer between the upstream source and the client so
    // it can observe the stream (e.g. extract tool-call telemetry) without altering bytes.
    transformer.on('error', () => {
      // A best-effort transform failure must never crash the server or drop the response.
    });
    source.pipe(transformer).pipe(res);
  } else {
    source.pipe(res);
  }
}
