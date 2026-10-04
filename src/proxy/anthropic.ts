import type http from 'node:http';
import type { Pipeline, RequestContext } from '../ports/pipeline';
import type { AnthropicRequest } from './types';
import {
  forwardAnthropicRequest,
  pipeUpstreamStream,
  streamAnthropicRequest,
  type UpstreamClient,
} from './upstream';
import {
  buildRequestContext,
  readJSONBody,
  runThroughPipeline,
  sendJSON,
  toClientId,
  toSessionKeyString,
} from './context';
import { createSseToolCallExtractor } from '../telemetry/stream-extract';
import type { TelemetryEmitter } from '../telemetry/events';

/** Dependencies for the Anthropic-compatible route handlers. */
export interface AnthropicHandlerDeps {
  upstream: UpstreamClient;
  pipeline: Pipeline;
  /** Shared telemetry event bus (optional) that observes the response stream for tool-call telemetry. */
  bus?: TelemetryEmitter;
}

/**
 * Handle the Anthropic-compatible route:
 * - `POST /v1/messages`
 *
 * Translates the Anthropic client request to the upstream protocol, forwards it
 * to the upstream, and translates the response back to Anthropic format.
 * Returns `true` when the route was handled, `false` otherwise.
 */
export async function handleAnthropicRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: AnthropicHandlerDeps,
): Promise<boolean> {
  const url = (req.url ?? '/').split('?')[0] ?? '/';

  if (req.method === 'POST' && url === '/v1/messages') {
    const raw = await readJSONBody(req);

    // Same-protocol streaming (`stream: true`, upstream speaks Anthropic): bypass the
    // buffered pipeline path and pipe the upstream SSE straight through to the client.
    // Cross-protocol streams (upstream = OpenAI) are intentionally NOT streamed here —
    // streaming translation is out of scope, so they keep using the buffer-and-
    // translate path below.
    if (isStreamRequest(raw) && deps.upstream.protocol === 'anthropic') {
      await streamSameProtocol(req, res, deps, raw);
      return true;
    }

    const requestCtx = buildRequestContext(req, deps.upstream, raw);
    const { status, body } = await runThroughPipeline(
      deps.pipeline,
      requestCtx,
      (request) => forwardAnthropicRequest(deps.upstream, request as AnthropicRequest),
      { bus: deps.bus },
    );
    sendJSON(res, status, body);
    return true;
  }

  return false;
}

/** True when a parsed wire body is a plain object carrying `"stream": true`. */
function isStreamRequest(raw: unknown): boolean {
  return (
    typeof raw === 'object' &&
    raw !== null &&
    !Array.isArray(raw) &&
    (raw as Record<string, unknown>).stream === true
  );
}

/**
 * Stream a same-protocol Anthropic request through to the client as raw SSE. Only the
 * REQUEST phase of the pipeline runs (policy edits applied before forwarding); response-
 * phase stages cannot run on a raw SSE pass-through (they would need the full response).
 */
async function streamSameProtocol(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: AnthropicHandlerDeps,
  raw: unknown,
): Promise<void> {
  const requestCtx = buildRequestContext(req, deps.upstream, raw);
  const processed = await deps.pipeline.handleRequest(requestCtx);
  syncRequestMessages(processed);
  const upstreamResponse = await streamAnthropicRequest(deps.upstream, processed.raw as AnthropicRequest);
  // Pipe the raw SSE through a passthrough transformer that extracts tool-call/result
  // telemetry onto the shared bus without altering forwarded bytes (a no-op when no
  // bus is wired). The extractor parses the OpenAI `choices[].delta.tool_calls[]`
  // shape; Anthropic-native streams simply surface a `tool.result` on completion.
  const extractor = createSseToolCallExtractor(
    deps.bus,
    toSessionKeyString(requestCtx.sessionKey),
    toClientId(requestCtx.client),
  );
  pipeUpstreamStream(res, upstreamResponse, extractor);
}

/**
 * Reflect provider-agnostic message edits from the (request-phase) context onto the raw
 * wire body's `messages` field so they reach the upstream model. No-op when the raw has
 * no `messages` array or the stream was left untouched.
 */
function syncRequestMessages(ctx: RequestContext): void {
  const raw = ctx.raw;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return;
  const record = raw as Record<string, unknown>;
  if (!Array.isArray(record.messages)) return;
  if (record.messages === ctx.messages) return;
  record.messages = ctx.messages;
}
