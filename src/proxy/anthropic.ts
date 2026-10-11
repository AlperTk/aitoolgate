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
  resolveAndEmitToolResults,
  runThroughPipeline,
  sendJSON,
  toClientId,
  toSessionKeyString,
} from './context';
import type {
  TelemetryEventBus,
  ToolMetricsTracker,
  TelemetryHelpers,
  SseExtractorFactory,
} from '../ports/telemetry';
import type { ToolResultStore } from '../telemetry/toolResultStore';

/** Dependencies for the Anthropic-compatible route handlers. */
export interface AnthropicHandlerDeps {
  upstream: UpstreamClient;
  pipeline: Pipeline;
  /** Shared telemetry event bus (optional) that observes the response stream for tool-call telemetry. */
  bus?: TelemetryEventBus;
  /** Shared tool-call latency tracker (optional) pairing issued calls with their later results. */
  tracker?: ToolMetricsTracker;
  /** Optional raw-tool-result store capturing each resolved result's RAW content (keyed by stable id). */
  toolResultStore?: ToolResultStore;
  /** SSE tool-call extractor factory (injected port) for streamed pass-through telemetry. */
  sseExtractor: SseExtractorFactory;
  /** Timing + token-estimation helpers (injected port) threaded into every request path. */
  usage: TelemetryHelpers;
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
      { bus: deps.bus, tracker: deps.tracker, toolResultStore: deps.toolResultStore, usage: deps.usage },
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
  // Request-phase tool-RESULT detection runs on EVERY proxied request — including streamed ones —
  // so pending issued calls recorded by an earlier same-session request pair into a REAL
  // tool.result even when this response itself is streamed (a no-op when nothing matches).
  resolveAndEmitToolResults(deps.tracker, deps.bus, requestCtx, undefined, deps.toolResultStore, deps.usage);
  const upstreamResponse = await streamAnthropicRequest(deps.upstream, processed.raw as AnthropicRequest);
  // Pipe the raw SSE through a passthrough transformer that extracts tool-call telemetry
  // onto the shared bus WITHOUT altering forwarded bytes (a no-op when no bus is wired).
  // The extractor is PROTOCOL-AWARE: it captures BOTH the native Anthropic `content_block_*`
  // frames streamed here (each `tool_use` block → a tool.call carrying its stable id + name
  // + turn tokens, recorded into the shared tracker for later result pairing) AND any
  // OpenAI-shaped fragments, emitting NO synthetic per-stream tool.result. The raw SSE bytes
  // are passed through to the client byte-for-byte unchanged either way.
  const extractor = deps.sseExtractor(
    deps.bus,
    toSessionKeyString(requestCtx.sessionKey),
    toClientId(requestCtx.client),
    deps.tracker,
    // Default timing source; precomputed estimated input-token mass of THIS request's full message
    // content, so a usage-less streamed turn WITH issued tool calls still gets its final
    // `turn.usage` event carrying honest input tokens over all message text.
    undefined,
    deps.usage.estimateInputTokens(requestCtx.messages),
    // The request's raw body (carrying the client's `tools`), so each streamed tool.call can
    // carry the request-provided tool description (matched by the call's name) — mirroring the
    // buffered emission path. Uses `requestCtx.raw` (the original request) like the other fields
    // threaded into the extractor above.
    requestCtx.raw,
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
