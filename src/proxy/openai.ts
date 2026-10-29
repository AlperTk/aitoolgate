import type http from 'node:http';
import type { Transform } from 'node:stream';
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

/** Dependencies for the OpenAI-compatible route handlers. */
export interface OpenAIHandlerDeps {
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

/** Handle the OpenAI-compatible routes (`GET /v1/models`, `POST /v1/chat/completions`); returns `true` when handled. */
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

    // Streaming (same- or cross-protocol) is served by streamSameProtocol; only non-stream requests use the buffered pipeline.
    if (isStreamRequest(raw)) {
      await streamSameProtocol(req, res, deps, raw);
      return true;
    }

    const requestCtx = buildRequestContext(req, deps.upstream, raw);
    const { status, body } = await runThroughPipeline(
      deps.pipeline,
      requestCtx,
      (request) => forwardOpenAIRequest(deps.upstream, request as OpenAIChatRequest),
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

/** Stream an OpenAI request as SSE re-encoded from LLMEvents; only the request-phase pipeline runs (response phases can't run on a stream). */
async function streamSameProtocol(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: OpenAIHandlerDeps,
  raw: unknown,
): Promise<void> {
  const requestCtx = buildRequestContext(req, deps.upstream, raw);
  const processed = await deps.pipeline.handleRequest(requestCtx);
  syncRequestMessages(processed);
  // Request-phase tool-RESULT detection runs on every proxied request (a no-op when nothing matches).
  resolveAndEmitToolResults(deps.tracker, deps.bus, requestCtx, undefined, deps.toolResultStore, deps.usage, deps.toolErrorPatterns);
  // Ask the upstream to include per-turn usage so the SSE carries a trailing `usage` chunk (preserves client `stream_options`).
  ensureStreamUsage(processed.raw);
  // Telemetry extractor: non-throwing; a factory failure only disables the tap, never the stream.
  let extractor: Transform | undefined;
  try {
    extractor = deps.sseExtractor(
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
  } catch {
    extractor = undefined;
  }
  // The extractor taps the UPSTREAM bytes inside the bridge; the client receives SSE encoded from LLMEvents.
  const upstreamResponse = await streamOpenAIRequest(deps.upstream, processed.raw as OpenAIChatRequest, extractor);
  pipeUpstreamStream(res, upstreamResponse);
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

/** Force `stream_options.include_usage` so the upstream emits a trailing `usage` chunk; preserves other `stream_options`; mutates and returns the body. */
function ensureStreamUsage(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return raw;
  const record = raw as Record<string, unknown>;
  const existing = record.stream_options;
  const opts =
    existing !== null && typeof existing === 'object' && !Array.isArray(existing)
      ? (existing as Record<string, unknown>)
      : {};
  record.stream_options = { ...opts, include_usage: true };
  return record;
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
        owned_by: 'aitoolgate',
      },
    ],
  };
}
