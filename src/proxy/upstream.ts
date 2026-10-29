import type http from 'node:http';
import { Readable, type Transform } from 'node:stream';
import type { UpstreamProtocol } from '../../config/config';
import type { CommonResponse, LLMEvent } from '../ports/llm';
import type { Protocol } from '../ports/protocol';
import { clientErrorBody, type ProtocolId, protocolRegistration, WIRE_PROTOCOL_IDS } from '../protocols/registry';
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
 * `/chat/completions`; cross-protocol requests are translated first.
 */
export async function streamOpenAIRequest(
  client: UpstreamClient,
  request: OpenAIChatRequest,
  tap?: Transform,
): Promise<Response> {
  if (isUnconfiguredUpstream(client)) return unconfiguredUpstreamResponse();
  return streamForClient(
    client,
    WIRE_PROTOCOL_IDS.openai,
    request,
    {
      'openai-chat': (body) => body,
      'anthropic-messages': (body) => openaiToAnthropicRequest(body as OpenAIChatRequest),
    },
    tap,
  );
}

/**
 * POST an Anthropic client request to the upstream and return the raw `Response` without
 * consuming its body, so the caller can stream it. Same-protocol requests hit
 * `/messages`; cross-protocol requests are translated first.
 */
export async function streamAnthropicRequest(
  client: UpstreamClient,
  request: AnthropicRequest,
  tap?: Transform,
): Promise<Response> {
  if (isUnconfiguredUpstream(client)) return unconfiguredUpstreamResponse();
  return streamForClient(
    client,
    WIRE_PROTOCOL_IDS.anthropic,
    request,
    {
      'anthropic-messages': (body) => body,
      'openai-chat': (body) => anthropicToOpenAIRequest(body as AnthropicRequest),
    },
    tap,
  );
}

/** Client→upstream request body translation, per upstream protocol id. */
type BodyTranslators = Readonly<Record<ProtocolId, (body: unknown) => unknown>>;

/**
 * Streams from the upstream in the registry-resolved protocol. Every stream goes upstream SSE →
 * decodeStream → LLMEvent → encodeStream (client protocol), including same-protocol streams.
 */
// TEMPORARY debug tap (DEBUG_UPSTREAM_SSE=1): logs raw upstream chunks to stderr; the client gets the original chunks.
function debugTapUpstream(upstream: Response): Response {
  if (process.env.DEBUG_UPSTREAM_SSE !== '1' || upstream.body === null) return upstream;
  const decoder = new TextDecoder();
  const logger = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      try {
        process.stderr.write(`[debug-upstream-sse] ${decoder.decode(chunk, { stream: true })}`);
      } catch {
        // Debug logging must never affect the stream.
      }
      controller.enqueue(chunk);
    },
  });
  return new Response(upstream.body.pipeThrough(logger), {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: upstream.headers,
  });
}

async function streamForClient(
  client: UpstreamClient,
  clientId: ProtocolId,
  request: unknown,
  translators: BodyTranslators,
  tap?: Transform,
): Promise<Response> {
  const upstreamId = WIRE_PROTOCOL_IDS[client.protocol];
  const { streamPath } = protocolRegistration(upstreamId);
  const upstream = debugTapUpstream(await streamToEndpoint(client, streamPath, translators[upstreamId](request)));
  return bridgeStream(upstream, protocolRegistration(upstreamId).create(), protocolRegistration(clientId).create(), tap);
}

/** Re-encodes an upstream SSE body: decode (upstream protocol) → LLMEvent → encode (client protocol). Non-2xx bodies pass through unchanged. */
async function bridgeStream(upstream: Response, from: Protocol, to: Protocol, tap?: Transform): Promise<Response> {
  if (!upstream.ok || upstream.body === null) return upstream;
  if (isEventStream(upstream)) {
    const frames = to.encodeStream(from.decodeStream(sseTextChunks(upstream.body, tap)));
    return new Response(byteStreamOf(frames), { status: upstream.status });
  }
  // A non-SSE 2xx body (e.g. JSON) is read whole so it can be decoded as a response.
  let raw = '';
  for await (const text of sseTextChunks(upstream.body, tap)) raw += text;
  const events = await eventsOfBody(raw, from);
  if (events.length === 0) return rawResponse(upstream, raw);
  if (!events.some(carriesContent)) return clientErrorResponse(to, NO_CONTENT_MESSAGE);
  return new Response(byteStreamOf(to.encodeStream(events)), { status: upstream.status });
}

const NO_CONTENT_MESSAGE = 'upstream returned a non-streaming response without content';

/** Step-start and usage events are metadata; any other event (text, tool, reasoning, finish) is content. */
function carriesContent(event: LLMEvent): boolean {
  return event.type !== 'step-start' && event.type !== 'usage';
}

/** 502 JSON error in the client protocol's own error shape. */
function clientErrorResponse(client: Protocol, message: string): Response {
  return new Response(JSON.stringify(clientErrorBody(client.id, message)), {
    status: 502,
    headers: { 'Content-Type': 'application/json' },
  });
}

function isEventStream(response: Response): boolean {
  return (response.headers.get('content-type') ?? '').includes('text/event-stream');
}

/** Events for a fully buffered body: a decodable JSON response is synthesised; otherwise the body is read as SSE. */
async function eventsOfBody(raw: string, from: Protocol): Promise<LLMEvent[]> {
  const wire = parseJSON(raw);
  if (wire !== undefined) {
    const response = from.decodeResponse(wire);
    return response === undefined ? [] : responseEvents(response);
  }
  const events: LLMEvent[] = [];
  for await (const event of from.decodeStream([raw])) events.push(event);
  return events;
}

function parseJSON(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

/** Synthetic event stream for a decoded non-streaming response. */
function responseEvents(response: CommonResponse): LLMEvent[] {
  const events: LLMEvent[] = [
    {
      type: 'step-start',
      ...(response.id !== undefined ? { id: response.id } : {}),
      ...(response.model !== undefined ? { model: response.model } : {}),
    },
  ];
  events.push(...response.message.parts);
  if (response.usage !== undefined) events.push({ type: 'usage', usage: response.usage });
  if (response.finishReason !== undefined) events.push({ type: 'finish', finishReason: response.finishReason });
  return events;
}

/** The upstream body unchanged; only headers that no longer describe the decoded text are dropped. */
function rawResponse(upstream: Response, raw: string): Response {
  const headers = new Headers(upstream.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  return new Response(raw, { status: upstream.status, headers });
}

/**
 * Decode the upstream SSE into text. When a telemetry `tap` is given, the RAW upstream bytes are
 * mirrored into it; the tap is drained and any tap failure is swallowed so the client stream is never affected.
 */
async function* sseTextChunks(body: NonNullable<Response['body']>, tap?: Transform): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  if (tap !== undefined) {
    tap.on('error', () => {});
    tap.resume();
  }
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (tap !== undefined) {
        try {
          tap.write(value);
        } catch {
          // Best-effort telemetry: a throwing tap must never break the client stream.
        }
      }
      yield decoder.decode(value, { stream: true });
    }
  } catch {
    // An upstream read failure ends the stream (mirrors pipeUpstreamStream's error handling).
  }
  if (tap !== undefined) {
    try {
      tap.end();
    } catch {
      // Best-effort telemetry finalisation.
    }
  }
  yield decoder.decode();
}

function byteStreamOf(frames: AsyncIterable<string>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const iterator = frames[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done === true) controller.close();
        else controller.enqueue(encoder.encode(next.value));
      } catch {
        controller.close();
      }
    },
    async cancel() {
      await iterator.return?.();
    },
  });
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
