import type http from 'node:http';
import type { Pipeline, RequestContext } from '../ports/pipeline';
import type { OpenAIChatRequest, OpenAIModelListResponse } from './types';
import {
  forwardOpenAIRequest,
  pipeUpstreamStream,
  streamOpenAIRequest,
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
import type { ToolMetricsTracker } from '../telemetry/toolMetrics';

/** Dependencies for the OpenAI-compatible route handlers. */
export interface OpenAIHandlerDeps {
  upstream: UpstreamClient;
  pipeline: Pipeline;
  /** Shared telemetry event bus (optional) that observes the response stream for tool-call telemetry. */
  bus?: TelemetryEmitter;
  /** Shared tool-call latency tracker (optional) pairing issued calls with their later results. */
  tracker?: ToolMetricsTracker;
}

/**
 * Handle the OpenAI-compatible routes:
 * - `GET /v1/models` (returns the configured model(s))
 * - `POST /v1/chat/completions` (forward to the upstream, translated if needed)
 *
 * Returns `true` when the route was handled, `false` otherwise.
 */
export async function handleOpenAIRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: OpenAIHandlerDeps,
): Promise<boolean> {
  const url = (req.url ?? '/').split('?')[0] ?? '/';

  if (req.method === 'GET' && url === '/v1/models') {
    sendJSON(res, 200, modelListResponse(deps.upstream.model));
    return true;
  }

  if (req.method === 'POST' && url === '/v1/chat/completions') {
    const raw = await readJSONBody(req);

    // Same-protocol streaming (`stream: true`, upstream speaks OpenAI): bypass the
    // buffered pipeline path and pipe the upstream SSE straight through to the client.
    // Cross-protocol streams (upstream = Anthropic) are intentionally NOT streamed here
    // — streaming translation is out of scope, so they keep using the buffer-and-
    // translate path below.
    if (isStreamRequest(raw) && deps.upstream.protocol === 'openai') {
      await streamSameProtocol(req, res, deps, raw);
      return true;
    }

    const requestCtx = buildRequestContext(req, deps.upstream, raw);
    const { status, body } = await runThroughPipeline(
      deps.pipeline,
      requestCtx,
      (request) => forwardOpenAIRequest(deps.upstream, request as OpenAIChatRequest),
      { bus: deps.bus, tracker: deps.tracker },
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
 * Stream a same-protocol OpenAI request through to the client as raw SSE. Only the
 * REQUEST phase of the pipeline runs (policy edits applied before forwarding); response-
 * phase stages cannot run on a raw SSE pass-through (they would need the full response).
 */
async function streamSameProtocol(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: OpenAIHandlerDeps,
  raw: unknown,
): Promise<void> {
  const requestCtx = buildRequestContext(req, deps.upstream, raw);
  const processed = await deps.pipeline.handleRequest(requestCtx);
  syncRequestMessages(processed);
  const upstreamResponse = await streamOpenAIRequest(deps.upstream, processed.raw as OpenAIChatRequest);
  // Pipe the raw SSE through a passthrough transformer that extracts tool-call/result
  // telemetry onto the shared bus without altering forwarded bytes (a no-op when no
  // bus is wired). The response-phase pipeline stages still cannot run on a raw
  // pass-through, so this is the streaming equivalent of post-response observation.
  const extractor = createSseToolCallExtractor(
    deps.bus,
    toSessionKeyString(requestCtx.sessionKey),
    toClientId(requestCtx.client),
    deps.tracker,
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

/** Return the configured model(s) as an OpenAI model list. */
function modelListResponse(model: string): OpenAIModelListResponse {
  return {
    object: 'list',
    data: [
      {
        id: model,
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'mcp-manager',
      },
    ],
  };
}
