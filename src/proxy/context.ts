import type http from 'node:http';
import type { ClientConfig, ModelConfig, SessionKey, ToolCall } from '../ports/domain';
import type { Pipeline, RequestContext, ResponseContext } from '../ports/pipeline';
import type { TelemetryEmitter, ToolCallEvent, ToolResultEvent, TurnUsageEvent } from '../telemetry/events';
import type { ToolMetricsTracker } from '../telemetry/toolMetrics';
import { monotonicEpochMs } from '../telemetry/toolMetrics';
import { estimateTurnUsage } from '../telemetry/tokenEstimate';
import type { ToolResultStore } from '../telemetry/toolResultStore';
import type { UpstreamClient, UpstreamResult } from './upstream';

/** Read and parse a JSON request body; an empty body resolves to `{}`. */
export function readJSONBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk: Buffer) => {
      data += chunk;
    });
    req.on('end', () => {
      if (data === '') {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(data));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

/** Build the provider-agnostic request context for an incoming client request. */
export function buildRequestContext(
  req: http.IncomingMessage,
  upstream: UpstreamClient,
  raw: unknown,
): RequestContext {
  return {
    client: clientConfig(req, upstream),
    model: modelConfig(upstream),
    sessionKey: sessionKeyFromHeaders(req),
    messages: extractMessages(raw),
    raw,
  };
}

function clientConfig(req: http.IncomingMessage, upstream: UpstreamClient): ClientConfig {
  return { apiKey: extractApiKey(req) ?? 'anonymous', name: 'default', model: upstream.model };
}

function extractApiKey(req: http.IncomingMessage): string | undefined {
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    return auth.slice('Bearer '.length);
  }
  const xApiKey = req.headers['x-api-key'];
  return typeof xApiKey === 'string' ? xApiKey : undefined;
}

function modelConfig(upstream: UpstreamClient): ModelConfig {
  return {
    id: upstream.model,
    baseUrl: upstream.baseUrl,
    model: upstream.model,
    apiKey: upstream.apiKey,
  };
}

function sessionKeyFromHeaders(req: http.IncomingMessage): SessionKey {
  const token = req.headers['x-session-id'];
  return typeof token === 'string' ? { fingerprint: '', token } : { fingerprint: '' };
}

function extractMessages(raw: unknown): unknown[] {
  if (raw !== null && typeof raw === 'object') {
    const messages = (raw as { messages?: unknown }).messages;
    if (Array.isArray(messages)) return messages;
  }
  return [];
}

/**
 * Summarize a client-protocol response body into provider-agnostic tool calls
 * and text content (understands both the OpenAI and Anthropic shapes).
 */
export function summarizeResponse(
  body: unknown,
): { toolCalls: ToolCall[]; content: string; usage?: NormalizedUsage } {
  const record = body as
    | {
        choices?: { message?: { content?: unknown; tool_calls?: unknown[] } }[];
        content?: unknown[];
      }
    | undefined;

  const choice = record?.choices?.[0];
  if (choice?.message) {
    const message = choice.message;
    const toolCalls = (message.tool_calls ?? []).map((toolCall) => toToolCall(toolCall));
    return { toolCalls, content: extractTextContent(message.content), usage: extractUsage(body) };
  }

  if (Array.isArray(record?.content)) {
    const toolCalls: ToolCall[] = [];
    let content = '';
    for (const block of record.content) {
      const recordBlock = block as {
        type?: string;
        text?: string;
        id?: string;
        name?: string;
        input?: Record<string, unknown>;
      };
      if (recordBlock.type === 'text') content += recordBlock.text ?? '';
      else if (recordBlock.type === 'tool_use') {
        toolCalls.push({
          id: recordBlock.id ?? '',
          name: recordBlock.name ?? '',
          arguments: recordBlock.input ?? {},
        });
      }
    }
    return { toolCalls, content, usage: extractUsage(body) };
  }

  return { toolCalls: [], content: '', usage: extractUsage(body) };
}

function toToolCall(toolCall: unknown): ToolCall {
  const t = toolCall as { id?: string; function?: { name?: string; arguments?: string } };
  return {
    id: t?.id ?? '',
    name: t?.function?.name ?? '',
    arguments: parseArgs(t?.function?.arguments),
  };
}

function extractTextContent(content: unknown): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(
        (c): c is { type: string; text?: string } =>
          c !== null && typeof c === 'object' && c.type === 'text',
      )
      .map((c) => c.text ?? '')
      .join('');
  }
  return '';
}

function parseArgs(args: unknown): Record<string, unknown> {
  if (typeof args !== 'string' || args.trim() === '') return {};
  try {
    const parsed: unknown = JSON.parse(args);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Send a JSON response with the given HTTP status. */
export function sendJSON(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

/**
 * Run a request through the pipeline (request-in), forward it to the upstream,
 * then run the response through the pipeline (response-out). Returns the final
 * (possibly stage-modified) response body and the upstream HTTP status.
 */
/** Options for {@link runThroughPipeline}. */
export interface RunPipelineOptions {
  /**
   * Optional telemetry event bus to emit `tool.call` / `tool.result` / `turn.usage` events onto
   * after the response phase. Accepts EITHER the port-level `EventBus` or the
   * telemetry `TelemetryEventBus` (both expose `emit`, so either is structurally
   * compatible). When omitted, no events are emitted (behavior unchanged). `tool.call`
   * emission runs on EVERY path (default and policy alike) and is centralized here, so a
   * policy stage never double-emits; the policy stage owns only intervention events.
   */
  bus?: TelemetryEmitter;
  /**
   * Optional tool-call latency tracker pairing issued calls with their later results
   * across successive requests. When provided, `runThroughPipeline` records this
   * response's tool calls here and emits real `tool.result` events for tool results
   * detected in the incoming request's messages. When omitted, no pairing/emission occurs.
   */
  tracker?: ToolMetricsTracker;
  /**
   * Optional timing source (epoch milliseconds) for this request's telemetry timestamps
   * — the issue time recorded for this response's tool calls AND the arrival time used
   * when pairing incoming results. Defaults to the shared monotonic wall-clock
   * ({@link monotonicEpochMs}); inject a controllable clock for deterministic tests.
   */
  now?: () => number;
  /**
   * Optional raw-tool-result store; when provided, each resolved result's RAW content is
   * held here (keyed by its stable id) for later retrieval over the REST API. The emitted
   * WS event stays metadata-only. When omitted, nothing is stored (behavior unchanged).
   */
  toolResultStore?: ToolResultStore;
}

export async function runThroughPipeline(
  pipeline: Pipeline,
  requestCtx: RequestContext,
  forward: (raw: unknown) => Promise<UpstreamResult>,
  opts?: RunPipelineOptions,
): Promise<{ status: number; body: unknown }> {
  const processedRequest = await pipeline.handleRequest(requestCtx);
  // Reflect any stage edits to the message stream onto the raw wire request before
  // forwarding, so they actually reach the upstream model. No-op when the raw has
  // no `messages` field or the stream was left untouched.
  syncRequestMessages(processedRequest);

  // Tool telemetry has two phases, and BOTH run here UNCONDITIONALLY so that tool-call
  // and tool-result observation are IDENTICAL whether or not a policy stage is present.
  // The policy stage owns ONLY its INTERVENTION events (see createPolicyStage); it no
  // longer emits tool.call on its own (that produced id/token-less duplicates which
  // skipped the tracker and left the pending set empty). Tool-RESULT detection
  // (request phase) reads the incoming role:'tool' / tool_result messages; tool-CALL
  // observation (response phase, below) emits one tool.call (stable id + turn tokens)
  // per issued call and records it into the shared tracker. Pairing assumes sequential
  // single-client per session: each client resends its full history each turn, so a
  // call's result arrives in a LATER request of the same session, where it pairs with
  // the issue recorded here. The response-phase session key is derived from the request
  // context itself (the same sessionKey used for tool.call on the default path), so
  // emission + recording work identically regardless of policy presence and never rely
  // on the policy stage's fragile per-instance "last request" session-key reference.

  // Request-phase tool-RESULT detection: pair incoming results against previously-issued
  // calls via the shared tracker and emit one REAL tool.result per resolved entry. Runs
  // unconditionally; a no-op when no bus/tracker is wired or nothing to pair. It reads
  // the request messages independently (never touches rehydration) and does not disturb
  // policy-stage ordering.
  resolveAndEmitToolResults(opts?.tracker, opts?.bus, requestCtx, opts?.now, opts?.toolResultStore);

  const result = await forward(processedRequest.raw);
  const summary = summarizeResponse(result.body);
  const responseCtx: ResponseContext = {
    client: requestCtx.client,
    model: requestCtx.model,
    sessionKey: requestCtx.sessionKey,
    toolCalls: summary.toolCalls,
    content: summary.content,
    raw: result.body,
  };
  const processedResponse = await pipeline.handleResponse(responseCtx);
  // Rehydrate any stage edits to the tool calls onto the raw wire response before
  // returning it to the client. No-op (byte-identical) when the view is unchanged.
  syncResponseBody(processedResponse, summary);
  // Response-phase tool-CALL emission + issue recording + WHOLE-TURN usage, ALWAYS (default AND
  // policy paths): emit one tool.call (stable id + turn tokens) per issued call, record each into
  // the shared tracker, and emit ONE turn.usage per turn carrying the turn's upstream usage when
  // reported, else an ESTIMATE over ALL request messages + the response content/tool calls — so
  // usage-less turns and tool-call-less (final-answer) turns still contribute honest token mass
  // (not only tool-related content). No synthetic per-response tool.result is emitted here; real
  // results are emitted in the request phase above once the client feeds them back. A no-op when
  // neither a bus nor a tracker is wired (pure passthrough — behavior unchanged).
  emitResponseTelemetry(opts?.bus, opts?.tracker, requestCtx, processedResponse.toolCalls, summary.usage, summary.content, opts?.now);
  return { status: result.status, body: processedResponse.raw };
}

/** Coerce a session key (object or empty) to its canonical string form for telemetry events. */
export function toSessionKeyString(sessionKey: SessionKey): string {
  if (typeof sessionKey.token === 'string' && sessionKey.token !== '') return sessionKey.token;
  if (typeof sessionKey.fingerprint === 'string' && sessionKey.fingerprint !== '') return sessionKey.fingerprint;
  return '';
}

/** Derive a client identifier for telemetry from a client config (`undefined` when anonymous/absent). */
export function toClientId(client: ClientConfig): string | undefined {
  if (typeof client.apiKey === 'string' && client.apiKey !== '' && client.apiKey !== 'anonymous') return client.apiKey;
  return undefined;
}

/** Normalized upstream token usage (provider-agnostic). */
export type NormalizedUsage = { input?: number; output?: number; total?: number };

/**
 * Emit one `tool.call` event per observed tool call (carrying its stable `id` and the
 * turn's upstream `tokens`) and record each issued call into the shared tracker — all in
 * one response-emission pass with a single shared timestamp, so the pairing math stays
 * consistent. A BUFFERED response delivers all of its tool calls at once, so every call
 * in the turn genuinely shares this issue time; the STREAMED path (see
 * `telemetry/stream-extract.ts`) instead records each call's own first-observation time.
 * Does NOT emit a synthetic per-response `tool.result` (removed); real results are
 * emitted later via {@link resolveAndEmitToolResults}. A no-op for both effects when
 * the respective bus/tracker is undefined. Each dispatch is guarded so a throwing/
 * rejecting emitter can never break the request flow. The timestamp comes from the
 * caller's injectable timing source (default: shared monotonic wall-clock).
 *
 * ALWAYS also emits one whole-turn `turn.usage` event per turn that HAS A TOKEN SOURCE
 * (the upstream reported usage, or the response issued tool calls) when a bus is wired,
 * carrying the turn's upstream `tokens` when reported, else an ESTIMATE over ALL request
 * messages + the response content/tool calls (see `telemetry/tokenEstimate.ts`) — so the
 * turn's input/output token calculation includes non-tool message text (system/user/
 * assistant content), not only tool-related content. It shares the same turn-level `at`
 * (and session key) as the emitted tool.call events, so the collector's per-(sessionKey␟at)
 * dedup counts each distinct turn exactly once regardless of which source arrives first.
 * A usage-less, call-free final-answer turn has no token source and emits nothing
 * (omit, don't fabricate).
 */
function emitResponseTelemetry(
  bus: TelemetryEmitter | undefined,
  tracker: ToolMetricsTracker | undefined,
  requestCtx: RequestContext,
  toolCalls: ToolCall[],
  usage: NormalizedUsage | undefined,
  content: string,
  now?: () => number,
): void {
  const sessionKey = toSessionKeyString(requestCtx.sessionKey);
  const clientId = toClientId(requestCtx.client);
  const at = (now ?? monotonicEpochMs)();
  // Assign EVERY issued call a stable, turn-unique id (the upstream tool_call id when present,
  // else a deterministic `${sessionKey}#${at}#${index}` fallback) so sibling calls in one batch
  // turn NEVER share an identical id — the field the dashboard dedups on. The same id feeds both
  // the emitted event and the tracker so a later result stays linked to its originating call.
  const seenIds = new Set<string>();
  const issued = toolCalls.map((call, index) => ({
    call,
    id: stableToolCallId(sessionKey, at, index, call.id, seenIds),
  }));
  if (bus !== undefined) {
    for (const { call, id } of issued) {
      safeEmit(bus, makeToolCallEvent(sessionKey, clientId, call, usage, at, id));
    }
  }
  // Record issued calls so a LATER request carrying their results can pair them. The same `at`
  // as the emitted events keeps durationMs consistent. Every call now carries a non-empty stable
  // id (assigned above) plus its tool name, so a resolved result can surface a REAL toolName
  // (both OpenAI and Anthropic issuance points provide it via the summary view).
  tracker?.recordIssued(
    sessionKey,
    issued.map(({ call, id }) => ({ id, at, ...(call.name !== '' ? { name: call.name } : {}) })),
  );
  // Whole-turn token accounting: one turn.usage per turn THAT HAS A TOKEN SOURCE (the upstream
  // reported usage, or this response issued tool calls) — carrying the reported usage when
  // present, else an ESTIMATE over ALL request messages + the response content/tool calls, so
  // the turn's input/output token calculation includes non-tool message text (system/user/
  // assistant), not only tool-related content. Shares this same turn-level `at` (and session
  // key) with the emitted tool.call events, so the collector's per-(sessionKey␟at) dedup counts
  // each distinct turn exactly once. A usage-less, call-free final-answer turn carries no token
  // source and emits nothing (omit, don't fabricate — pure-passthrough behavior unchanged).
  if (bus !== undefined && (usage !== undefined || toolCalls.length > 0)) {
    const turnTokens = usage ?? estimateTurnUsage(requestCtx.messages, content, toolCalls);
    const input = turnTokens.input ?? 0;
    const output = turnTokens.output ?? 0;
    if (input > 0 || output > 0) {
      safeEmit(bus, makeTurnUsageEvent(sessionKey, clientId, { input, output, total: turnTokens.total ?? (input + output) }, at));
    }
  }
}

/**
 * Build a {@link ToolCallEvent}. `args` and `tokens` are included only when present; `id` is the
 * caller-assigned stable tool-call id (always non-empty on the emitter paths, where every
 * emitted call carries a stable, turn-unique id — the field the dashboard dedups on).
 */
function makeToolCallEvent(
  sessionKey: string,
  clientId: string | undefined,
  call: ToolCall,
  usage: NormalizedUsage | undefined,
  at: number,
  id: string,
): ToolCallEvent {
  const hasArgs = Object.keys(call.arguments ?? {}).length > 0;
  return {
    type: 'tool.call',
    sessionKey,
    toolName: call.name,
    at,
    ...(hasArgs ? { args: call.arguments } : {}),
    ...(id !== '' ? { id } : {}),
    ...(usage !== undefined ? { tokens: usage } : {}),
    ...(clientId !== undefined ? { clientId } : {}),
  };
}

/**
 * Build a {@link TurnUsageEvent}: the whole-turn token account (upstream-reported or estimated
 * over all message content) under the shared turn-level timestamp. `total` is always a number
 * (`input + output` when the reported usage omitted it), so consumers never fabricate fields.
 */
function makeTurnUsageEvent(
  sessionKey: string,
  clientId: string | undefined,
  tokens: { input: number; output: number; total: number },
  at: number,
): TurnUsageEvent {
  return {
    type: 'turn.usage',
    sessionKey,
    tokens,
    ...(clientId !== undefined ? { clientId } : {}),
    at,
  };
}

/**
 * Assign a stable, turn-unique id to one issued tool call. Prefers the upstream tool-call id when
 * present; otherwise synthesizes a deterministic `${sessionKey}#${at}#${index}` id. A monotonic
 * suffix (`~1`, `~2`, …) is appended whenever the computed id would still collide with a sibling
 * already seen in this same turn (e.g. two calls sharing one upstream id), guaranteeing NO two
 * sibling calls in a batch turn ever share an identical id — the field the dashboard dedups on.
 * Mirrors `stableStreamCallId` in `telemetry/stream-extract.ts` so both emission paths produce
 * the same contract.
 */
function stableToolCallId(
  sessionKey: string,
  at: number,
  index: number,
  preferredId: string,
  seen: Set<string>,
): string {
  const base = preferredId !== '' ? preferredId : `${sessionKey}#${at}#${index}`;
  let id = base;
  let n = 0;
  while (seen.has(id)) {
    n += 1;
    id = `${base}~${n}`;
  }
  seen.add(id);
  return id;
}

/**
 * Detect tool results arriving from the incoming request's messages, pair them against
 * previously-issued calls via the shared tracker, and emit one REAL `tool.result` event
 * per resolved entry (`durationMs = resultArrivalAt - issuedCall.at`, plus the result's
 * `chars`). DURATIONS ARE ATTRIBUTED PER CALL BY STABLE ID, NEVER BY MESSAGE POSITION:
 * every result in one request shares ONE honest arrival time (requests arrive atomically),
 * while each result's duration subtracts its OWN matched call's issue time — so
 * interleaved/out-of-order arrivals each take their own span, batched co-arrivals keep an
 * equal (correct, parallel-run) duration, orphaned results are silently skipped, and no
 * bogus/negative/NaN duration can ever reach the event stream. This is now the ONLY
 * source of `tool.result` events on this path (the synthetic per-response result was
 * removed). It reads the request messages independently (does not touch
 * rehydration) and understands both protocols: OpenAI `role:'tool'` messages (paired by
 * `tool_call_id`) and Anthropic `type:'tool_result'` content blocks (paired by
 * `tool_use_id`). Each resolved result carries a REAL `toolName` taken from the recorded
 * issued call (authoritative for both protocol paths); when the tracker held none it falls
 * back to a best-effort name read from the originating message. `ok` is
 * omitted (not reliably knowable from a result arrival). No-op when no bus/tracker is
 * wired, when the request carries no tool results, or when none match a pending issued call.
 *
 * Exported so it can be invoked on EVERY proxied request path — both the buffered
 * {@link runThroughPipeline} path and the streamed `streamSameProtocol` paths — guaranteeing
 * that pending issued calls recorded by an earlier same-session request (whether that response
 * was buffered or streamed) are paired into a REAL `tool.result` regardless of how the later
 * request is delivered. Each path invokes it exactly once, so it never double-resolves. The
 * shared arrival timestamp comes from the caller's injectable timing source (the optional
 * `now` parameter; default: the shared monotonic wall-clock) so tests can pin result
 * arrival times deterministically.
 */
export function resolveAndEmitToolResults(
  tracker: ToolMetricsTracker | undefined,
  bus: TelemetryEmitter | undefined,
  requestCtx: RequestContext,
  now?: () => number,
  store?: ToolResultStore,
): void {
  if (tracker === undefined || bus === undefined) return;
  const incoming = extractIncomingToolResults(requestCtx.messages);
  if (incoming.length === 0) return;
  const sessionKey = toSessionKeyString(requestCtx.sessionKey);
  const clientId = toClientId(requestCtx.client);
  // ONE honest shared arrival time per request (requests arrive atomically), taken from the
  // caller's injectable timing source (default: the shared monotonic wall-clock). Every result
  // in this request subtracts its OWN matched call's issue time from this single arrival time.
  const at = (now ?? monotonicEpochMs)();
  const resolved = tracker.resolveResults(
    sessionKey,
    incoming.map((result) => ({ toolCallId: result.toolCallId, at, chars: result.chars })),
  );
  let seq = 0;
  for (const entry of resolved) {
    // Prefer the recorded issued-call's tool name — captured authoritatively at the point the
    // call was ISSUED (both protocol paths), so every resolved result carries a real toolName.
    // Fall back to a best-effort name read from the originating message when the tracker held
    // none (e.g. a legacy pending entry recorded before the name was threaded through).
    const name =
      entry.toolName ??
      incoming.find((result) => result.toolCallId === entry.toolCallId)?.toolName;
    const event = {
      type: 'tool.result' as const,
      sessionKey,
      toolCallId: entry.toolCallId,
      // Carry a STABLE UNIQUE id equal to the resolved entry's toolCallId — the very value that
      // matched the issued call. Sibling same-name results in one batch turn share
      // type/sessionKey/at/toolName, so this per-result id is the field the dashboard dedups on;
      // without it N same-name same-turn results collapsed onto a single row. Purely additive:
      // aggregation reads only toolName/durationMs, so this never alters aggregates.
      id: entry.toolCallId,
      durationMs: entry.durationMs,
      ...(entry.chars !== undefined ? { chars: entry.chars } : {}),
      ...(name !== undefined && name !== '' ? { toolName: name } : {}),
      ...(clientId !== undefined ? { clientId } : {}),
      at,
    } as ToolResultEvent;
    safeEmit(bus, event);
    // Hold the RAW result content in the optional store, keyed by the SAME stable id
    // the event carries above. The emitted event stays metadata-only — no content is
    // added to it or the WS frame here; only the durable store captures the payload.
    if (store !== undefined) {
      const source = incoming.find((result) => result.toolCallId === entry.toolCallId);
      const stableId =
        typeof entry.toolCallId === 'string' && entry.toolCallId.length > 0
          ? entry.toolCallId
          : `${sessionKey}:${at}:unmatched-${seq}`;
      const stored = rawContentToString(source?.content);
      store.put(stableId, { id: stableId, content: stored.content, chars: stored.chars, at });
    }
    seq += 1;
  }
}

/** A single tool result detected in an incoming request. */
interface IncomingToolResult {
  /** Id of the originating call (OpenAI `tool_call_id` / Anthropic `tool_use_id`), if present. */
  toolCallId?: string;
  /** Best-effort tool name (OpenAI `role:'tool'` `name`), if present. */
  toolName?: string;
  /** Character length of the result payload, if measurable. */
  chars?: number;
  /** Raw result payload (both protocols), captured for the raw-result store. */
  content?: unknown;
}

/**
 * Detect tool results from a provider-agnostic message list (both protocols), reading it
 * without mutation. OpenAI: `role:'tool'` messages paired by `tool_call_id`. Anthropic:
 * `type:'tool_result'` content blocks paired by `tool_use_id`.
 */
function extractIncomingToolResults(messages: unknown[]): IncomingToolResult[] {
  const results: IncomingToolResult[] = [];
  if (!Array.isArray(messages)) return results;
  for (const message of messages) {
    if (!isRecord(message)) continue;
    // OpenAI `role:'tool'` result message, paired by `tool_call_id`.
    if (message.role === 'tool') {
      results.push({
        toolCallId: typeof message.tool_call_id === 'string' ? message.tool_call_id : undefined,
        toolName: typeof message.name === 'string' ? message.name : undefined,
        chars: measureContentLength(message.content),
        content: message.content,
      });
      continue;
    }
    // Anthropic user/assistant message whose content carries `tool_result` blocks.
    if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (isRecord(block) && block.type === 'tool_result') {
          results.push({
            toolCallId: typeof block.tool_use_id === 'string' ? block.tool_use_id : undefined,
            chars: measureContentLength(block.content),
            content: block.content,
          });
        }
      }
    }
  }
  return results;
}

/** Best-effort character length of a tool-result payload (`undefined` when not measurable). */
function measureContentLength(content: unknown): number | undefined {
  if (content == null) return undefined;
  if (typeof content === 'string') return content.length;
  try {
    return JSON.stringify(content).length;
  } catch {
    return undefined;
  }
}

/** Cap applied to the RAW tool-result content held in the in-memory store (caller-side value bound). */
export const MAX_TOOL_RESULT_CONTENT_CHARS = 16384;

/**
 * Convert a raw tool-result payload into bounded stored content: the stringified
 * payload truncated to {@link MAX_TOOL_RESULT_CONTENT_CHARS}, alongside the FULL
 * (uncapped) character length. Returns empty when the payload is absent/unstringifiable.
 */
function rawContentToString(content: unknown): { content: string; chars: number } {
  let full: string;
  if (typeof content === 'string') {
    full = content;
  } else if (content == null) {
    return { content: '', chars: 0 };
  } else {
    try {
      full = JSON.stringify(content);
    } catch {
      return { content: '', chars: 0 };
    }
  }
  return { content: full.slice(0, MAX_TOOL_RESULT_CONTENT_CHARS), chars: full.length };
}

/** True for finite numeric values. */
function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** True when a normalized usage carries at least one numeric field. */
function hasAnyValue(usage: NormalizedUsage): boolean {
  return usage.input !== undefined || usage.output !== undefined || usage.total !== undefined;
}

/**
 * Normalize upstream token usage from the (native or cross-protocol translated) response
 * body into `{ input?, output?, total? }`. The protocol is detected from which usage
 * fields are present — OpenAI `usage.{prompt_tokens,completion_tokens,total_tokens}` vs
 * Anthropic `usage.{input_tokens,output_tokens}` (total = input+output when absent) — so
 * the real upstream numbers are read regardless of translation.
 */
function extractUsage(body: unknown): NormalizedUsage | undefined {
  if (!isRecord(body)) return undefined;
  const usage = body.usage;
  if (!isRecord(usage)) return undefined;
  if (isNumber(usage.prompt_tokens) || isNumber(usage.completion_tokens) || isNumber(usage.total_tokens)) {
    const out: NormalizedUsage = {};
    if (isNumber(usage.prompt_tokens)) out.input = usage.prompt_tokens;
    if (isNumber(usage.completion_tokens)) out.output = usage.completion_tokens;
    if (isNumber(usage.total_tokens)) out.total = usage.total_tokens;
    else if (out.input !== undefined && out.output !== undefined) out.total = out.input + out.output;
    return hasAnyValue(out) ? out : undefined;
  }
  if (isNumber(usage.input_tokens) || isNumber(usage.output_tokens)) {
    const out: NormalizedUsage = {};
    if (isNumber(usage.input_tokens)) out.input = usage.input_tokens;
    if (isNumber(usage.output_tokens)) out.output = usage.output_tokens;
    if (out.input !== undefined && out.output !== undefined) out.total = out.input + out.output;
    return hasAnyValue(out) ? out : undefined;
  }
  return undefined;
}

/** Emit an event through an optional bus without ever letting a failure surface. */
function safeEmit(bus: TelemetryEmitter, event: ToolCallEvent | ToolResultEvent | TurnUsageEvent): void {
  try {
    const maybe = bus.emit(event);
    if (maybe !== null && typeof maybe === 'object' && typeof (maybe as { catch?: unknown }).catch === 'function') {
      (maybe as Promise<unknown>).catch(() => {});
    }
  } catch {
    // A throwing emitter can never break the pipeline/request flow.
  }
}


/** True if `value` is a non-null, non-array object (a plain JSON-like record). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reflect the (possibly-edited) provider-agnostic message stream back onto the raw
 * wire request body's `messages` field. Guarded so that only wire bodies that
 * actually carry a `messages` array are touched (non-message protocols pass through
 * untouched) and every other raw field (e.g. `tools`, already handled by stages such
 * as `hideTool`) is left intact.
 */
function syncRequestMessages(ctx: RequestContext): void {
  const raw = ctx.raw;
  if (!isRecord(raw)) return;
  const existing = raw.messages;
  if (!Array.isArray(existing)) return; // not a message protocol: leave untouched
  if (existing === ctx.messages) return; // stream untouched: already in sync
  raw.messages = ctx.messages;
}

/**
 * Rehydrate the raw wire response body from the (possibly-edited) provider-agnostic
 * tool-call list (+ content), respecting the provider shape the raw body carries
 * (OpenAI `choices[].message.tool_calls`; Anthropic assistant `content[]` with
 * `tool_use` blocks). Mutates the raw body in place and is idempotent: when the view
 * is unchanged from the pre-pipeline `original` summary, the raw body is left
 * byte-for-byte identical to the upstream response.
 */
function syncResponseBody(
  ctx: ResponseContext,
  original: { toolCalls: ToolCall[]; content: string },
): void {
  const raw = ctx.raw;
  if (!isRecord(raw)) return;
  // Only touch the wire when the provider-agnostic view actually differs from what
  // the upstream returned, so an unedited passthrough is returned unchanged.
  if (ctx.content === original.content && toolCallsEqual(ctx.toolCalls, original.toolCalls)) return;
  const protocol = detectResponseProtocol(raw);
  if (protocol === 'openai') rehydrateOpenAIResponse(raw, ctx.toolCalls);
  else if (protocol === 'anthropic') rehydrateAnthropicResponse(raw, ctx.toolCalls);
}

/** Classify a raw response body by provider shape (`unknown` → no rehydration). */
function detectResponseProtocol(raw: Record<string, unknown>): 'openai' | 'anthropic' | 'unknown' {
  const choices = raw.choices;
  if (Array.isArray(choices)) {
    for (const choice of choices) {
      if (isRecord(choice) && isRecord(choice.message)) return 'openai';
    }
  }
  if (Array.isArray(raw.content)) return 'anthropic';
  return 'unknown';
}

/** Overwrite/clear each OpenAI assistant `choices[].message.tool_calls` from the view. */
function rehydrateOpenAIResponse(raw: Record<string, unknown>, toolCalls: ToolCall[]): void {
  const choices = raw.choices;
  if (!Array.isArray(choices)) return;
  for (const choice of choices) {
    if (!isRecord(choice)) continue;
    const message = choice.message;
    if (!isRecord(message)) continue;
    if (toolCalls.length > 0) {
      message.tool_calls = toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: JSON.stringify(tc.arguments ?? {}) },
      }));
    } else {
      delete message.tool_calls;
    }
  }
}

/** Rebuild an Anthropic assistant `content[]` from non-tool blocks + fresh `tool_use` blocks. */
function rehydrateAnthropicResponse(raw: Record<string, unknown>, toolCalls: ToolCall[]): void {
  const content = raw.content;
  if (!Array.isArray(content)) return;
  // Keep non-`tool_use` blocks (e.g. text) in their original order, then emit one
  // `tool_use` block per remaining tool call (drops clear them, rewrites update them).
  const blocks: Record<string, unknown>[] = content.filter(
    (block): block is Record<string, unknown> => isRecord(block) && block.type !== 'tool_use',
  );
  for (const tc of toolCalls) {
    blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.arguments ?? {} });
  }
  raw.content = blocks;
}

/** True when two tool-call lists carry identical provider-agnostic data. */
function toolCallsEqual(a: readonly ToolCall[], b: readonly ToolCall[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (!deepEqual(a[i].id, b[i].id) || !deepEqual(a[i].name, b[i].name) || !deepEqual(a[i].arguments, b[i].arguments)) {
      return false;
    }
  }
  return true;
}

/** Structural equality for plain (JSON-like) values. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  if (typeof a === 'object') {
    const aObj = a as Record<string, unknown>;
    const bObj = b as Record<string, unknown>;
    if (Object.keys(aObj).length !== Object.keys(bObj).length) return false;
    for (const key of Object.keys(aObj)) {
      if (!Object.prototype.hasOwnProperty.call(bObj, key) || !deepEqual(aObj[key], bObj[key])) return false;
    }
    return true;
  }
  return Number.isNaN(a as number) && Number.isNaN(b as number);
}
