import type http from 'node:http';
import type {
  Pipeline,
  PipelineStage,
  RequestContext,
  ResponseContext,
  ResultContext,
} from '../ports/pipeline';
import { createPipeline } from '../pipeline';
import { createPolicyStage } from '../policy/policyStage';
import { createRuleEngine, type PolicyRule } from '../policy/ruleEngine';
import { SessionFeedbackStore } from '../policy/feedbackStore';
import type { FetchLike, UpstreamClient } from './upstream';
import { handleOpenAIRoute } from './openai';
import { handleAnthropicRoute } from './anthropic';
import { createEventBus, type TelemetryEventBus } from '../telemetry/event-bus';
import { createCollector, type Collector } from '../telemetry/collector';
import type { SqliteStorage } from '../storage/sqlite';

export type { FetchLike, UpstreamClient };

/** Default header carrying a client-supplied session token. */
const DEFAULT_SESSION_HEADER = 'x-session-id';

/**
 * Options controlling the optional POLICY enforcement around each request/response.
 *
 * When present on {@link ProxyOptions}, `createProxyHandler` builds a pipeline that
 * includes a policy stage (`createPolicyStage`) so its REQUEST phase runs before
 * the upstream model call and its RESPONSE phase runs after it. The client's
 * session token (read from {@link PolicyOptions.sessionIdHeader}) is surfaced onto
 * the request context so the stage can use it in `deriveSessionKey`.
 */
export interface PolicyOptions {
  /** The rules evaluated by the rule engine against each request/response. */
  rules: PolicyRule[];
  /**
   * Per-session feedback queue bridging response-side actions into the NEXT
   * request. Defaults to a fresh in-memory {@link SessionFeedbackStore}.
   */
  feedback?: SessionFeedbackStore;
  /**
   * Header carrying the client session token (surfaced onto the request context's
   * `sessionKey.token`). Defaults to `x-session-id`.
   */
  sessionIdHeader?: string;
}

/** Options for the model-proxy HTTP handler. */
export interface ProxyOptions {
  /** The upstream client to forward requests to. */
  upstream: UpstreamClient;
  /**
   * The pipeline stages run around each request/response.
   * Defaults to an empty passthrough pipeline (no policy stage yet).
   */
  pipeline?: Pipeline;
  /**
   * Optional policy enforcement. When set, a policy stage is appended to the
   * pipeline (on top of any caller-supplied `pipeline`); when absent the pipeline
   * is used exactly as-is, so no behavior changes.
   */
  policy?: PolicyOptions;
  /**
   * Optional telemetry wiring. Each supplied field is used as-is; otherwise a fresh
   * default sharing the configured bus is created. `storage` is never auto-created —
   * it is wired only when provided. An event bus ALWAYS exists (so emission works
   * even with no policy); the live `.telemetry` view is exposed on the handler
   * whenever this option is present OR a policy stage is configured (absent both,
   * `handler.telemetry` stays `undefined` for backward compatibility).
   */
  telemetry?: ProxyTelemetryOptions;
}

/**
 * Optional telemetry wiring accepted by {@link ProxyOptions}. Each field is used
 * when supplied; otherwise a fresh default that shares the configured bus is
 * created. Supplying any of these (alone or alongside a policy) exposes the live
 * `.telemetry` view on the returned handler.
 */
export interface ProxyTelemetryOptions {
  /** The telemetry event bus to feed the collector / persist from. Defaults to a fresh {@link createEventBus}. */
  bus?: TelemetryEventBus;
  /** A live aggregation view over the bus. Defaults to {@link createCollector} subscribed to the configured bus. */
  collector?: Collector;
  /** Optional SQLite-backed persistence for the event stream; omitted → no persistence (never auto-created). */
  storage?: SqliteStorage;
}

/**
 * The telemetry view exposed on the proxy handler (via {@link ProxyHandler.telemetry})
 * whenever a policy stage is configured. Consumers read live aggregates from
 * {@link ProxyTelemetry.collector}; the same events are persisted through
 * {@link ProxyTelemetry.storage} only when one was configured.
 */
export interface ProxyTelemetry {
  /** The shared telemetry event bus feeding the live collector. */
  readonly bus: TelemetryEventBus;
  /** A live in-memory aggregation view over the event stream. */
  readonly collector: Collector;
  /** Optional SQLite-backed persistence; present only when a storage was configured. */
  readonly storage?: SqliteStorage;
}

/**
 * The request handler returned by {@link createProxyHandler}. It keeps its call
 * signature `(req, res) => Promise<boolean>` and — when a policy stage is wired —
 * carries a NON-ENUMERABLE {@link ProxyHandler.telemetry} view so future
 * dashboard/API layers can read live aggregates without changing how the handler
 * is invoked. When no policy is configured the property is simply absent.
 */
export interface ProxyHandler {
  (req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean>;
  /** Present when a policy stage is configured or a telemetry option is supplied; undefined otherwise. */
  telemetry?: ProxyTelemetry;
}

/**
 * Read a single header value by name (headers are case-insensitive). Returns the
 * first string value, or `undefined` when the header is absent or non-string.
 */
function readStringHeader(headers: http.IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name.toLowerCase()];
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const first = value[0];
    return typeof first === 'string' ? first : undefined;
  }
  return undefined;
}

/**
 * A thin {@link Pipeline} decorator that threads the configured session-token
 * header onto the request context's `sessionKey.token` BEFORE delegating to the
 * wrapped pipeline, so the policy stage can use it in `deriveSessionKey`.
 *
 * The route handlers build the request context internally (surfacing only the
 * default `x-session-id` header) and expose no raw request, so the token for a
 * custom {@link PolicyOptions.sessionIdHeader} is captured per request by
 * `createProxyHandler` (which sees the raw request) and pushed via
 * {@link setSessionToken} immediately before the handlers run. Only a NON-EMPTY
 * token overrides the key token; every other context field and header (e.g. the
 * API-key handling in `clientConfig`) is left untouched. This matches the
 * sequential single-client usage already assumed across the policy layer.
 */
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

/**
 * Build a request handler that serves the model-proxy routes and wires
 * request/response through the {@link Pipeline} (request-in → upstream →
 * response-out):
 * - `GET /v1/models`, `POST /v1/chat/completions` (OpenAI client)
 * - `POST /v1/messages` (Anthropic client)
 *
 * When `options.policy` is present, the pipeline includes a policy stage whose
 * REQUEST phase runs before the upstream call and RESPONSE phase after it, with
 * the client's `sessionIdHeader` token surfaced onto the request context. When
 * `options.policy` is absent, the pipeline is used exactly as-is (no change).
 *
 * A shared telemetry bus always exists (built fresh or reused from
 * `options.telemetry.bus`) so tool-call/result telemetry is emitted regardless of
 * whether a policy is configured; when a policy IS configured it is also fed to the
 * policy stage. A live {@link Collector} subscribed to that bus plus an optional
 * {@link SqliteStorage} (persists when supplied, never auto-created) are exposed on
 * the returned handler as a NON-ENUMERABLE `.telemetry` property
 * ({@link ProxyHandler.telemetry}) without changing the handler's call signature.
 * That view is attached only when a policy is configured OR `options.telemetry` is
 * supplied; absent both, `handler.telemetry` stays `undefined` (unchanged).
 *
 * Returns `true` when a route was handled, `false` to fall through to a 404.
 */
export function createProxyHandler(options: ProxyOptions): ProxyHandler {
  const policy = options.policy;
  const sessionIdHeader = policy?.sessionIdHeader ?? DEFAULT_SESSION_HEADER;

  let tokenPipeline: SessionTokenPipeline | undefined = undefined;
  let pipeline: Pipeline;

  // A shared event bus ALWAYS exists so tool-call/result telemetry can be emitted
  // regardless of whether a policy stage is configured (decoupled from policy). The
  // bus is honored when a caller supplies one; otherwise a fresh default is created.
  // The SAME bus is threaded into every request path below via `deps`, so emission
  // works with or without a policy.
  const tele = options.telemetry;
  const bus = tele?.bus ?? createEventBus();
  const storage = tele?.storage;

  // Expose the live `.telemetry` view ONLY when a policy stage is present OR an
  // explicit telemetry option was supplied; a bare no-policy/no-telemetry handler
  // keeps `handler.telemetry` undefined (behavior unchanged). Emission itself is
  // NOT gated this way — it is always wired through the always-present bus above.
  const shouldAttach = policy !== undefined || tele !== undefined;
  let collector: Collector | undefined = tele?.collector;
  if (shouldAttach && collector === undefined) collector = createCollector({ bus });
  if (shouldAttach && storage !== undefined) {
    // Persist events only when an explicit storage is supplied (never auto-created),
    // guarding each write so a failing store cannot break the pipeline flow.
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
    ? { bus, collector: collector as Collector, storage }
    : undefined;

  if (policy) {
    const engine = createRuleEngine(policy.rules);
    const feedback = policy.feedback ?? new SessionFeedbackStore();

    const base = options.pipeline ?? createPipeline();
    // Append the policy stage (request phase precedes the upstream call, response
    // phase follows it) so its REQUEST/RESPONSE phases emit onto the telemetry bus.
    base.use(createPolicyStage({ engine, feedback, bus }));
    tokenPipeline = new SessionTokenPipeline(base);
    pipeline = tokenPipeline;
  } else {
    pipeline = options.pipeline ?? createPipeline();
  }

  const deps = { upstream: options.upstream, pipeline, bus };

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

  // Expose the telemetry view on the handler as a NON-ENUMERABLE property without
  // changing its call signature, whenever one was built (policy configured and/or a
  // telemetry option supplied); a bare handler leaves `handler.telemetry` undefined.
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