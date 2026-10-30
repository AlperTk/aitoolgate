import type http from 'node:http';
import type { Pipeline } from '../ports/pipeline';
import type { OpenAIChatRequest, OpenAIModelListResponse } from './types';
import {
  forwardRequest,
  streamForClient,
  type UpstreamClient,
} from './upstream';
import {
  buildRequestContext,
  readJSONBody,
  runThroughPipeline,
  sendJSON,
  streamSameProtocolRequest,
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
      (request) => forwardRequest(deps.upstream, 'openai-chat', request as OpenAIChatRequest),
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
  return streamSameProtocolRequest<OpenAIChatRequest>(req, res, deps, raw, (upstream, request, tap) =>
    streamForClient(upstream, 'openai-chat', request, tap),
  );
}

/** Reflect provider-agnostic message edits onto the raw wire body's `messages` field; no-op when there is none or it's untouched. */
/** Force `stream_options.include_usage` so the upstream emits a trailing `usage` chunk; preserves other `stream_options`; mutates and returns the body. */

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
