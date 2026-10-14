import type http from 'node:http';
import type {
  Pipeline,
  PipelineStage,
  RequestContext,
  ResponseContext,
  ResultContext,
} from '../ports/pipeline';
import { createPipeline } from '../pipeline';
import type { PolicyRule } from '../policy/ruleEngine';
import { defaultProxyDefaults } from '../composition';
import type { FetchLike, UpstreamClient } from './upstream';
import { handleOpenAIRoute } from './openai';
import { handleAnthropicRoute } from './anthropic';
import type {
  TelemetryEventBus,
  Collector,
  ToolMetricsTracker,
  TelemetryStorage,
  FeedbackStore,
  ProxyDefaults,
} from '../ports/telemetry';
import type { ToolResultStore } from '../telemetry/toolResultStore';

export type { FetchLike, UpstreamClient };

/** Default header carrying a client-supplied session token. */
const DEFAULT_SESSION_HEADER = 'x-session-id';

/** Options for the optional policy enforcement around each request/response. */
export interface PolicyOptions {
  /** The rules evaluated by the rule engine; a plain array or a getter re-resolved on every evaluation. */
  rules: PolicyRule[] | (() => PolicyRule[]);
  /** Per-session feedback queue bridging response-side actions into the next request; defaults to a fresh store. */
  feedback?: FeedbackStore;
  /** A pre-built policy stage injected from the composition root; when absent, built from `rules` + `feedback`. */
  stage?: PipelineStage;
  /** Header carrying the client session token; defaults to `x-session-id`. */
  sessionIdHeader?: string;
}

/** Options for the model-proxy HTTP handler. */
export interface ProxyOptions {
  /** The upstream client to forward requests to. */
  upstream: UpstreamClient;
  /** The pipeline stages run around each request/response; defaults to an empty passthrough pipeline. */
  pipeline?: Pipeline;
  /** Optional policy enforcement; when set, a policy stage is appended to the pipeline. */
  policy?: PolicyOptions;
  /** Optional telemetry wiring (each field used as-is, else a fresh default); `storage` is never auto-created. */
  telemetry?: ProxyTelemetryOptions;
  /** Optional raw-tool-result store capturing each resolved result's RAW content (keyed by stable id); omitted → nothing stored. */
  toolResultStore?: ToolResultStore;
  /** Optional tool-error patterns (additive to the built-in heuristic); defaults to the proxy-defaults value (`[]`). */
  toolErrorPatterns?: string[];
  /** Default builders for the policy stage + telemetry wiring (used for fields the caller leaves unset); defaults to `defaultProxyDefaults`. */
  defaults?: ProxyDefaults;
}

/** Optional telemetry wiring accepted by `ProxyOptions`; supplying any field (or a policy) exposes the live `.telemetry` view. */
export interface ProxyTelemetryOptions {
  /** The telemetry event bus to feed the collector / persist from. Defaults to a fresh bus (built via the proxy defaults). */
  bus?: TelemetryEventBus;
  /** A live aggregation view over the bus. Defaults to a collector (built via the proxy defaults) subscribed to the configured bus. */
  collector?: Collector;
  /** A live tool-call latency tracker pairing issued calls with their later results. Defaults to a fresh tracker (built via the proxy defaults). */
  tracker?: ToolMetricsTracker;
  /** Optional persistence for the event stream; omitted → no persistence (never auto-created). */
  storage?: TelemetryStorage;
}

/** The telemetry view exposed on the proxy handler when a policy or telemetry option is configured. */
export interface ProxyTelemetry {
  /** The shared telemetry event bus feeding the live collector. */
  readonly bus: TelemetryEventBus;
  /** A live in-memory aggregation view over the event stream. */
  readonly collector: Collector;
  /** A live tool-call latency tracker pairing issued calls with their later results (always present). */
  readonly tracker: ToolMetricsTracker;
  /** Optional persistence; present only when a storage was configured. */
  readonly storage?: TelemetryStorage;
}

/** The request handler returned by `createProxyHandler`; carries a non-enumerable `telemetry` view when a policy or telemetry option is wired. */
export interface ProxyHandler {
  (req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean>;
  /** Present when a policy stage is configured or a telemetry option is supplied; undefined otherwise. */
  telemetry?: ProxyTelemetry;
}

/** Read a single header value by name (case-insensitive); `undefined` when absent or non-string. */
function readStringHeader(headers: http.IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name.toLowerCase()];
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const first = value[0];
    return typeof first === 'string' ? first : undefined;
  }
  return undefined;
}

/** A thin `Pipeline` decorator that threads the configured session-token header onto `sessionKey.token` before delegating to the wrapped pipeline. */
class SessionTokenPipeline implements Pipeline {
  readonly stages: readonly PipelineStage[];
  private token: string | undefined = undefined;

  constructor(private readonly inner: Pipeline) {
    this.stages = inner.stages;
  }

  use(stage: PipelineStage): this {
    this.inner.use(stage);
    return this;
  }

  setSessionToken(token: string | undefined): void {
    this.token = token;
  }

  async handleRequest(ctx: RequestContext): Promise<RequestContext> {
    const next: RequestContext =
      this.token !== undefined && this.token !== ''
        ? { ...ctx, sessionKey: { ...ctx.sessionKey, token: this.token } }
        : ctx;
    return await this.inner.handleRequest(next);
  }

  handleResponse(ctx: ResponseContext): Promise<ResponseContext> {
    return this.inner.handleResponse(ctx);
  }

  handleResult(ctx: ResultContext): Promise<ResultContext> {
    return this.inner.handleResult(ctx);
  }
}

/** Build the model-proxy request handler, wiring request/response through the `Pipeline` (request-in → upstream → response-out) + policy + telemetry. */
export function createProxyHandler(options: ProxyOptions): ProxyHandler {
  const policy = options.policy;
  const sessionIdHeader = policy?.sessionIdHeader ?? DEFAULT_SESSION_HEADER;
  // Default builders for the policy stage + telemetry wiring (the proxy never imports a concrete factory).
  const defaults = options.defaults ?? defaultProxyDefaults;

  let tokenPipeline: SessionTokenPipeline | undefined = undefined;
  let pipeline: Pipeline;

  // A shared event bus always exists (decoupled from policy) and is threaded into every request path.
  const tele = options.telemetry;
  const bus = tele?.bus ?? defaults.makeBus();
  // A shared tool-call latency tracker always exists (like the bus) and is threaded into every request path.
  const tracker = tele?.tracker ?? defaults.makeTracker();
  const storage = tele?.storage;

  // Expose the live `.telemetry` view only when a policy stage or a telemetry option is supplied.
  const shouldAttach = policy !== undefined || tele !== undefined;
  let collector: Collector | undefined = tele?.collector;
  if (shouldAttach && collector === undefined) collector = defaults.makeCollector(bus);
  if (shouldAttach && storage !== undefined) {
    // Persist events only when an explicit storage is supplied, guarding each write so a failing store can't break the flow.
    bus.subscribe((event) => {
      try {
        if (event.type === 'tool.call') storage.recordToolCall(event);
        else if (event.type === 'policy.intervention') storage.recordIntervention(event);
      } catch {
        // A persistence failure must never break the pipeline flow.
      }
    });
  }
  const telemetry: ProxyTelemetry | undefined = shouldAttach
    ? { bus, collector: collector as Collector, tracker, storage }
    : undefined;

  if (policy) {
    const base = options.pipeline ?? createPipeline();
    // Use a pre-built stage injected by the composition root when present; otherwise build one from rules + feedback.
    const stage = policy.stage ?? defaults.makePolicyStage(policy.rules, policy.feedback, bus);
    base.use(stage);
    tokenPipeline = new SessionTokenPipeline(base);
    pipeline = tokenPipeline;
  } else {
    pipeline = options.pipeline ?? createPipeline();
  }

  const deps = {
    upstream: options.upstream,
    pipeline,
    bus,
    tracker,
    toolResultStore: options.toolResultStore,
    toolErrorPatterns: options.toolErrorPatterns ?? defaults.toolErrorPatterns,
    sseExtractor: defaults.makeSseExtractor,
    usage: defaults.usage,
  };

  const handler = async function handleProxyRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<boolean> {
    if (tokenPipeline !== undefined) {
      tokenPipeline.setSessionToken(readStringHeader(req.headers, sessionIdHeader));
    }
    if (await handleOpenAIRoute(req, res, deps)) return true;
    if (await handleAnthropicRoute(req, res, deps)) return true;
    return false;
  };

  // Expose the telemetry view on the handler as a non-enumerable property without changing its call signature.
  if (telemetry !== undefined) {
    Object.defineProperty(handler, 'telemetry', {
      value: telemetry,
      enumerable: false,
      configurable: true,
      writable: false,
    });
  }

  return handler;
}