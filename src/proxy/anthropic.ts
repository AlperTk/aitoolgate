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
  /** Optional tool-error patterns (additive to the built-in heuristic); threaded into every request path. */
  toolErrorPatterns?: string[];
  /** SSE tool-call extractor factory (injected port) for streamed pass-through telemetry. */
  sseExtractor: SseExtractorFactory;
  /** Timing + token-estimation helpers (injected port) threaded into every request path. */
  usage: TelemetryHelpers;
}

/** Handle the Anthropic-compatible route (`POST /v1/messages`); returns `true` when handled. */
export async function handleAnthropicRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: AnthropicHandlerDeps,
): Promise<boolean> {
  const url = (req.url ?? '/').split('?')[0] ?? '/';

  if (req.method === 'POST' && url === '/v1/messages') {
    const raw = await readJSONBody(req);

    // Same-protocol streaming: pipe the upstream SSE straight through; cross-protocol streams keep the buffer-and-translate path.
    if (isStreamRequest(raw) && deps.upstream.protocol === 'anthropic') {
      await streamSameProtocol(req, res, deps, raw);
      return true;
    }

    const requestCtx = buildRequestContext(req, deps.upstream, raw);
    const { status, body } = await runThroughPipeline(
      deps.pipeline,
      requestCtx,
      (request) => forwardAnthropicRequest(deps.upstream, request as AnthropicRequest),
      {
        bus: deps.bus,
        tracker: deps.tracker,
        toolResultStore: deps.toolResultStore,
        toolErrorPatterns: deps.toolErrorPatterns,
        usage: deps.usage,
      },
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

/** Stream a same-protocol Anthropic request as raw SSE; only the request-phase pipeline runs. */
async function streamSameProtocol(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: AnthropicHandlerDeps,
  raw: unknown,
): Promise<void> {
  const requestCtx = buildRequestContext(req, deps.upstream, raw);
  const processed = await deps.pipeline.handleRequest(requestCtx);
  syncRequestMessages(processed);
  // Request-phase tool-RESULT detection runs on every proxied request (a no-op when nothing matches).
  resolveAndEmitToolResults(deps.tracker, deps.bus, requestCtx, undefined, deps.toolResultStore, deps.usage, deps.toolErrorPatterns);
  const upstreamResponse = await streamAnthropicRequest(deps.upstream, processed.raw as AnthropicRequest);
  // Pipe the raw SSE through a protocol-aware passthrough extractor that captures tool telemetry onto the bus without altering forwarded bytes.
  const extractor = deps.sseExtractor(
    deps.bus,
    toSessionKeyString(requestCtx.sessionKey),
    toClientId(requestCtx.client),
    deps.tracker,
    // Precomputed estimated input-token mass, so a usage-less streamed turn still emits an honest `turn.usage`.
    undefined,
    deps.usage.estimateInputTokens(requestCtx.messages),
    // The request's raw body (carrying `tools`), so each streamed tool.call carries the request-provided description.
    requestCtx.raw,
  );
  pipeUpstreamStream(res, upstreamResponse, extractor);
}

/** Reflect provider-agnostic message edits onto the raw wire body's `messages` field; no-op when there is none or it's untouched. */
function syncRequestMessages(ctx: RequestContext): void {
  const raw = ctx.raw;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return;
  const record = raw as Record<string, unknown>;
  if (!Array.isArray(record.messages)) return;
  if (record.messages === ctx.messages) return;
  record.messages = ctx.messages;
}
