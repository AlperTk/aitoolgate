import type http from 'node:http';
import { Readable, type Transform } from 'node:stream';
import type { UpstreamProtocol } from '../../config/config';
import type { InternalResponse, InternalLLMEvent } from '../ports/llm';
import type { Protocol } from '../ports/protocol';
import {
  clientErrorBody,
  type ProtocolId,
  protocolRegistration,
  upstreamErrorMessage,
  WIRE_PROTOCOL_IDS,
} from '../protocols/registry';
import { encodeConvertedResponse, reencodeRequest } from './translate';

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

/**
 * Non-streaming forward keyed by client protocol id: generic re-encode to the upstream protocol, then conform the
 * response to the client protocol.
 */
export async function forwardRequest(client: UpstreamClient, clientId: ProtocolId, request: unknown): Promise<UpstreamResult> {
  if (isUnconfiguredUpstream(client)) return { status: 503, ok: false, body: UNCONFIGURED_UPSTREAM };
  const upstreamId = WIRE_PROTOCOL_IDS[client.protocol];
  const { streamPath } = protocolRegistration(upstreamId);
  const body = reencodeRequest(clientId, upstreamId, request, client.model);
  if (body === undefined) return { status: 400, ok: false, body: clientErrorBody(clientId, UNDECODABLE_REQUEST_MESSAGE) };
  return conformResult(await postJSON(client, streamPath, body), upstreamId, clientId);
}

/**
 * Brings a non-streaming upstream result into the client protocol, mirroring the stream path: a non-2xx body
 * becomes the client error envelope (status kept); a 2xx body with no content becomes a 502. Undecodable 2xx bodies pass through.
 */
function conformResult(result: UpstreamResult, upstream: ProtocolId, client: ProtocolId): UpstreamResult {
  if (!result.ok) {
    const message = upstreamErrorMessage(result.body) ?? `upstream returned HTTP ${result.status}`;
    return { ...result, body: clientErrorBody(client, message) };
  }
  const response = protocolRegistration(upstream).create().decodeResponse(result.body);
  if (response === undefined || !responseEvents(response).some(carriesContent)) {
    return { status: 502, ok: false, body: clientErrorBody(client, NO_CONTENT_MESSAGE) };
  }
  return { ...result, body: encodeConvertedResponse(client, response) };
}

/**
 * Streams from the upstream in the registry-resolved protocol. Every stream goes upstream SSE →
 * decodeStream → InternalLLMEvent → encodeStream (client protocol), including same-protocol streams.
 */
// TEMPORARY debug tap (DEBUG_UPSTREAM_SSE=1): logs raw upstream chunks to stderr; the client gets the original chunks.
const DEBUG_UPSTREAM_SSE_ENABLED = process.env.DEBUG_UPSTREAM_SSE === '1';
function debugTapUpstream(upstream: Response): Response {
  if (!DEBUG_UPSTREAM_SSE_ENABLED || upstream.body === null) return upstream;
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

/** Streaming entrypoint keyed by client protocol id; the unconfigured upstream answers 503 without any fetch. */
export async function streamForClient(
  client: UpstreamClient,
  clientId: ProtocolId,
  request: unknown,
  tap?: Transform,
): Promise<Response> {
  if (isUnconfiguredUpstream(client)) return unconfiguredUpstreamResponse();
  const upstreamId = WIRE_PROTOCOL_IDS[client.protocol];
  const { streamPath } = protocolRegistration(upstreamId);
  const body = reencodeRequest(clientId, upstreamId, request, client.model);
  if (body === undefined) return clientErrorResponse(protocolRegistration(clientId).create(), UNDECODABLE_REQUEST_MESSAGE, 400);
  const upstream = debugTapUpstream(await streamToEndpoint(client, streamPath, body));
  return bridgeStream(upstream, protocolRegistration(upstreamId).create(), protocolRegistration(clientId).create(), tap);
}

/** Re-encodes an upstream SSE body: decode (upstream protocol) → InternalLLMEvent → encode (client protocol). Non-2xx bodies are converted to the client error envelope. */
async function bridgeStream(upstream: Response, from: Protocol, to: Protocol, tap?: Transform): Promise<Response> {
  if (!upstream.ok) return upstreamErrorResponse(upstream, to);
  if (upstream.body === null) return upstream;
  prepareTap(tap);
  if (isEventStream(upstream)) {
    const frames = to.encodeStream(teeEvents(from.decodeStream(sseTextChunks(upstream.body)), tap));
    return new Response(byteStreamOf(frames), { status: upstream.status });
  }
  // A non-SSE 2xx body (e.g. JSON) is read whole so it can be decoded as a response.
  let raw = '';
  for await (const text of sseTextChunks(upstream.body)) raw += text;
  const events = await eventsOfBody(raw, from);
  for (const event of events) tapWrite(tap, event);
  tapEnd(tap);
  // Undecodable or content-less bodies (events empty or metadata-only) become a client-protocol 502.
  if (!events.some(carriesContent)) return clientErrorResponse(to, NO_CONTENT_MESSAGE);
  return new Response(byteStreamOf(to.encodeStream(events)), { status: upstream.status });
}

/** Telemetry tap setup: swallow tap errors and keep it flowing so it never back-pressures the client stream. */
function prepareTap(tap?: Transform): void {
  if (tap === undefined) return;
  tap.on('error', () => {});
  tap.resume();
}

/** Best-effort write into the telemetry tap; a throwing tap never affects the client. */
function tapWrite(tap: Transform | undefined, chunk: unknown): void {
  if (tap === undefined) return;
  try {
    tap.write(chunk);
  } catch {
    // Best-effort telemetry: a throwing tap must never break the client stream.
  }
}

/** Best-effort tap finalisation (emits stream-end telemetry). */
function tapEnd(tap: Transform | undefined): void {
  if (tap === undefined) return;
  try {
    tap.end();
  } catch {
    // Best-effort telemetry finalisation.
  }
}

/** Mirror each decoded event into the tap, forwarding it unchanged to the encoder; the tap ends when the stream does. */
async function* teeEvents(events: AsyncIterable<InternalLLMEvent>, tap?: Transform): AsyncGenerator<InternalLLMEvent> {
  try {
    for await (const event of events) {
      tapWrite(tap, event);
      yield event;
    }
  } finally {
    tapEnd(tap);
  }
}

/** A non-2xx upstream body becomes the client protocol's error envelope, keeping the upstream status. */
async function upstreamErrorResponse(upstream: Response, to: Protocol): Promise<Response> {
  let raw = '';
  if (upstream.body !== null) for await (const text of sseTextChunks(upstream.body)) raw += text;
  const message = upstreamErrorMessage(parseJSON(raw)) ?? `upstream returned HTTP ${upstream.status}`;
  return clientErrorResponse(to, message, upstream.status);
}

const NO_CONTENT_MESSAGE = 'upstream returned a non-streaming response without content';
const UNDECODABLE_REQUEST_MESSAGE = 'request body could not be decoded';

/** Step-start and usage events are metadata; any other event (text, tool, reasoning, finish) is content. */
function carriesContent(event: InternalLLMEvent): boolean {
  return event.type !== 'step-start' && event.type !== 'usage';
}

/** 502 JSON error in the client protocol's own error shape. */
function clientErrorResponse(client: Protocol, message: string, status = 502): Response {
  return new Response(JSON.stringify(clientErrorBody(client.id, message)), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function isEventStream(response: Response): boolean {
  return (response.headers.get('content-type') ?? '').includes('text/event-stream');
}

/** The one place a streamed response's Content-Type is chosen: a body its producer already typed (JSON errors, passthrough) keeps that type; an untyped body is the SSE stream. */
function responseContentType(response: Response): string {
  return response.headers.get('content-type') ?? 'text/event-stream';
}

/** Events for a fully buffered body: a decodable JSON response is synthesised; otherwise the body is read as SSE. */
async function eventsOfBody(raw: string, from: Protocol): Promise<InternalLLMEvent[]> {
  const wire = parseJSON(raw);
  if (wire !== undefined) {
    const response = from.decodeResponse(wire);
    return response === undefined ? [] : responseEvents(response);
  }
  const events: InternalLLMEvent[] = [];
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
function responseEvents(response: InternalResponse): InternalLLMEvent[] {
  type DecodedPart = Exclude<InternalResponse['message']['parts'][number], { type: 'opaque' }>;
  const events: InternalLLMEvent[] = [
    {
      type: 'step-start',
      ...(response.id !== undefined ? { id: response.id } : {}),
      ...(response.model !== undefined ? { model: response.model } : {}),
    },
  ];
  const isDecoded = (part: InternalResponse['message']['parts'][number]): part is DecodedPart => part.type !== 'opaque';
  events.push(...response.message.parts.filter(isDecoded));
  if (response.usage !== undefined) events.push({ type: 'usage', usage: response.usage });
  if (response.finishReason !== undefined) events.push({ type: 'finish', finishReason: response.finishReason });
  return events;
}

/** Decode the upstream SSE bytes into text chunks (telemetry is taken from the decoded events, not these bytes). */
async function* sseTextChunks(body: NonNullable<Response['body']>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      yield decoder.decode(value, { stream: true });
    }
  } catch {
    // An upstream read failure ends the stream (mirrors pipeUpstreamStream's error handling).
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
export function pipeUpstreamStream(res: http.ServerResponse, upstreamResponse: Response): void {
  res.writeHead(upstreamResponse.status, {
    'Content-Type': responseContentType(upstreamResponse),
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
  });
  source.on('error', () => {
    res.end();
  });
  source.pipe(res);
}
