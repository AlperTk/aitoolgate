import type http from 'node:http';
import type { ClientConfig, ModelConfig, SessionKey, ToolCall } from '../ports/domain';
import type { Pipeline, RequestContext, ResponseContext } from '../ports/pipeline';
import type { TelemetryEmitter, ToolCallEvent, ToolResultEvent, TurnUsageEvent } from '../telemetry/events';
import type { ToolMetricsTracker, TelemetryHelpers } from '../ports/telemetry';
import type { ToolResultStore } from '../telemetry/toolResultStore';
import { parseArgs, stableCallId, normalizeUsage, isRecord, toolDescriptionMap, isErrorResultContent, isErrorResultContentByPatterns } from '../telemetry/protocol-common';
import type { NormalizedUsage } from '../telemetry/protocol-common';
import { estimateTokensFromChars, estimateCallTokens } from '../telemetry/tokenEstimate';
import { syncResponseBody } from './translate';
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

/** Summarize a client-protocol response body into provider-agnostic tool calls and text content (both OpenAI and Anthropic shapes). */
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
    arguments: parseArgs(t?.function?.arguments) ?? {},
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

/** Send a JSON response with the given HTTP status. */
export function sendJSON(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** Run a request through the pipeline, forward it upstream, then run the response through the pipeline; returns the final body + upstream status. */
/** Options for {@link runThroughPipeline}. */
export interface RunPipelineOptions {
  /** Optional telemetry event bus to emit `tool.call` / `tool.result` / `turn.usage` events onto; omitted → no emission. */
  bus?: TelemetryEmitter;
  /** Optional tool-call latency tracker pairing issued calls with their later results; omitted → no pairing/emission. */
  tracker?: ToolMetricsTracker;
  /** Optional timing source (epoch ms) for telemetry timestamps; defaults to the helper's `now` (or a wall-clock). */
  now?: () => number;
  /** Optional raw-tool-result store holding each resolved result's RAW content (keyed by stable id); omitted → nothing stored. */
  toolResultStore?: ToolResultStore;
  /** Optional timing + token-estimation helpers used as the primary source; omitted → wall-clock default. */
  usage?: TelemetryHelpers;
  /** Optional tool-error patterns (additive to the built-in heuristic); omitted → heuristic only. */
  toolErrorPatterns?: string[];
}

export async function runThroughPipeline(
  pipeline: Pipeline,
  requestCtx: RequestContext,
  forward: (raw: unknown) => Promise<UpstreamResult>,
  opts?: RunPipelineOptions,
): Promise<{ status: number; body: unknown }> {
  const processedRequest = await pipeline.handleRequest(requestCtx);
  // Reflect any stage edits to the message stream onto the raw wire request before forwarding.
  syncRequestMessages(processedRequest);

  // Tool telemetry has two phases (request + response), both run unconditionally so observation is identical with or without a policy stage.
  // Request-phase tool-RESULT detection: pair incoming results against previously-issued calls and emit one `tool.result` per resolved entry (a no-op when nothing matches).
  resolveAndEmitToolResults(opts?.tracker, opts?.bus, requestCtx, opts?.now, opts?.toolResultStore, opts?.usage, opts?.toolErrorPatterns);

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
  // Rehydrate any stage edits to the tool calls onto the raw wire response before returning it to the client.
  syncResponseBody(processedResponse, summary);
  // Response-phase tool-CALL emission + issue recording + whole-turn usage, ALWAYS (default + policy paths); a no-op when neither a bus nor a tracker is wired.
  emitResponseTelemetry(opts?.bus, opts?.tracker, requestCtx, processedResponse.toolCalls, summary.usage, summary.content, opts?.now, opts?.usage);
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

/** Re-exported from `telemetry/protocol-common` (the single source of truth for this shape). */
export type { NormalizedUsage };

//** Emit one `tool.call` per observed tool call (each with a stable id), record each into the shared tracker, and emit one whole-turn `turn.usage` per turn that has a token source. Per-call `tokens` are attached only for a SINGLE tool call; a batched turn (>1 calls) omits them so the turn's token mass is carried once by the `turn.usage` (not duplicated on every per-call event, which would make each batched row look identical). A no-op when the bus/tracker is undefined. */
function emitResponseTelemetry(
  bus: TelemetryEmitter | undefined,
  tracker: ToolMetricsTracker | undefined,
  requestCtx: RequestContext,
  toolCalls: ToolCall[],
  usage: NormalizedUsage | undefined,
  content: string,
  now?: () => number,
  helpers?: TelemetryHelpers,
): void {
  const sessionKey = toSessionKeyString(requestCtx.sessionKey);
  const clientId = toClientId(requestCtx.client);
  const at = (now ?? helpers?.now ?? Date.now)();
  // Assign every issued call a stable, turn-unique id (the dashboard dedup key), shared by the emitted event and the tracker.
  const seenIds = new Set<string>();
  const issued = toolCalls.map((call, index) => ({
    call,
    id: stableCallId(sessionKey, at, index, call.id, seenIds),
  }));
  // Map each issued tool name to the request-provided description so the emitted tool.call can carry it (omitted when absent).
  const descByTool = toolDescriptionMap(requestCtx.raw);
  if (bus !== undefined) {
    // Per-call `tokens` are attached only for a SINGLE tool call; a batched turn (>1 calls) omits
    // them so the turn's token mass is carried once by the whole-turn turn.usage (below) instead
    // of being duplicated on every per-call event.
    const singleCall = toolCalls.length === 1;
    for (const { call, id } of issued) {
      safeEmit(bus, makeToolCallEvent(sessionKey, clientId, call, singleCall ? usage : undefined, at, id, descByTool.get(call.name)));
    }
  }
  // Record issued calls so a LATER request carrying their results can pair them (same `at` keeps durationMs consistent).
  tracker?.recordIssued(
    sessionKey,
    issued.map(({ call, id }) => ({ id, at, ...(call.name !== '' ? { name: call.name } : {}) })),
  );
  // Whole-turn token accounting: one turn.usage per turn that has a token source (upstream usage, else an estimate); shares the turn-level `at`.
  if (bus !== undefined && (usage !== undefined || toolCalls.length > 0)) {
    // Estimate only when the injected helper provides it; otherwise report zeros (no fabricated token mass).
    const estimate = helpers?.estimateTurnUsage;
    const turnTokens =
      usage ??
      (estimate !== undefined
        ? estimate(requestCtx.messages, content, toolCalls)
        : { input: 0, output: 0, total: 0, cacheHitInput: 0 });
    const input = turnTokens.input ?? 0;
    const cacheHitInput = turnTokens.cacheHitInput ?? 0;
    const output = turnTokens.output ?? 0;
    if (input > 0 || output > 0) {
      // total is always the TRUE turn total (base input + cache-hit input + output), recomputed rather than read raw.
      safeEmit(bus, makeTurnUsageEvent(sessionKey, clientId, { input, output, total: input + cacheHitInput + output, cacheHitInput }, at));
    }
  }
}

/** Build a `ToolCallEvent`; `args`, `tokens`, `id`, and `description` are included only when present. */
function makeToolCallEvent(
  sessionKey: string,
  clientId: string | undefined,
  call: ToolCall,
  usage: NormalizedUsage | undefined,
  at: number,
  id: string,
  description?: string,
): ToolCallEvent {
  const hasArgs = Object.keys(call.arguments ?? {}).length > 0;
  const hasName = call.name !== '';
  return {
    type: 'tool.call',
    sessionKey,
    toolName: call.name,
    at,
    ...(hasArgs ? { args: call.arguments } : {}),
    ...(id !== '' ? { id } : {}),
    ...(usage !== undefined ? { tokens: usage } : {}),
    // Per-call REQUEST-side token estimate (name + serialized arguments), distinct per tool;
    // omitted only for a nameless, argument-less call.
    ...(hasName || hasArgs ? { callTokens: estimateCallTokens(call.name, hasArgs ? call.arguments : undefined) } : {}),
    ...(clientId !== undefined ? { clientId } : {}),
    ...(typeof description === 'string' && description !== '' ? { description } : {}),
  };
}

/** Build a `TurnUsageEvent`: the whole-turn token account under the shared turn-level timestamp (`total` always a number). */
function makeTurnUsageEvent(
  sessionKey: string,
  clientId: string | undefined,
  tokens: { input: number; output: number; total: number; cacheHitInput: number },
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

/** Detect tool results from the incoming request's messages, pair them against previously-issued calls, and emit one `tool.result` per resolved entry; exported so it runs on every proxied request path (buffered and streamed). */
export function resolveAndEmitToolResults(
  tracker: ToolMetricsTracker | undefined,
  bus: TelemetryEmitter | undefined,
  requestCtx: RequestContext,
  now?: () => number,
  store?: ToolResultStore,
  helpers?: TelemetryHelpers,
  patterns?: string[],
): void {
  if (tracker === undefined || bus === undefined) return;
  const incoming = extractIncomingToolResults(requestCtx.messages, patterns);
  if (incoming.length === 0) return;
  const sessionKey = toSessionKeyString(requestCtx.sessionKey);
  const clientId = toClientId(requestCtx.client);
  // ONE honest shared arrival time per request (requests arrive atomically); each result subtracts its OWN matched call's issue time from it.
  const at = (now ?? helpers?.now ?? Date.now)();
  const resolved = tracker.resolveResults(
    sessionKey,
    incoming.map((result) => ({ toolCallId: result.toolCallId, at, chars: result.chars })),
  );
  let seq = 0;
  for (const entry of resolved) {
    // Hoist the originating-message lookup so both the name and ok computation share it.
    const source = incoming.find((result) => result.toolCallId === entry.toolCallId);
    // Prefer the recorded issued-call's tool name (authoritative); fall back to the originating message's name.
    const name = entry.toolName ?? source?.toolName;
    // `ok` reflects the result's error flag or a leading error marker in the content; defaults to `true`.
    const ok = !(source?.isError === true);
    const event = {
      type: 'tool.result' as const,
      sessionKey,
      toolCallId: entry.toolCallId,
      // Carry a STABLE UNIQUE id (the resolved entry's toolCallId) — the field the dashboard dedups on.
      id: entry.toolCallId,
      durationMs: entry.durationMs,
      ok,
      ...(entry.chars !== undefined ? { chars: entry.chars } : {}),
      // Per-result response-payload token estimate (round(chars/4)), mirroring the
      // collector's totalResponseTokens accounting; omitted when chars is unknown.
      ...(typeof entry.chars === 'number' && Number.isFinite(entry.chars) && entry.chars > 0 ? { tokens: estimateTokensFromChars(entry.chars) } : {}),
      ...(name !== undefined && name !== '' ? { toolName: name } : {}),
      ...(clientId !== undefined ? { clientId } : {}),
      at,
    } as ToolResultEvent;
    safeEmit(bus, event);
    // Hold the RAW result content in the optional store, keyed by the same stable id the event carries (the event stays metadata-only).
    if (store !== undefined) {
      const stableId =
        typeof entry.toolCallId === 'string' && entry.toolCallId.length > 0
          ? entry.toolCallId
          : `${sessionKey}:${at}:unmatched-${seq}`;
      const stored = rawContentToString(source?.content);
      store.put(stableId, { id: stableId, content: stored.content, chars: stored.chars, ok, at });
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
  /** Whether the result indicates an error: Anthropic `is_error: true`, OR a leading error marker in the content (see {@link isErrorResultContent}). */
  isError?: boolean;
  /** Character length of the result payload, if measurable. */
  chars?: number;
  /** Raw result payload (both protocols), captured for the raw-result store. */
  content?: unknown;
}

/** True when a tool result indicates a failure: the built-in heuristic always applies, additively any matching user pattern (never throws). */
function isResultError(content: unknown, patterns?: string[]): boolean {
  if (isErrorResultContent(content)) return true;
  return patterns !== undefined && patterns.length > 0 && isErrorResultContentByPatterns(content, patterns);
}

/** Detect tool results from a provider-agnostic message list (both protocols); a result with no native error flag is also an error when `patterns` match it. */
function extractIncomingToolResults(messages: unknown[], patterns?: string[]): IncomingToolResult[] {
  const results: IncomingToolResult[] = [];
  if (!Array.isArray(messages)) return results;
  for (const message of messages) {
    if (!isRecord(message)) continue;
    // OpenAI `role:'tool'` result message, paired by `tool_call_id`.
    if (message.role === 'tool') {
      results.push({
        toolCallId: typeof message.tool_call_id === 'string' ? message.tool_call_id : undefined,
        toolName: typeof message.name === 'string' ? message.name : undefined,
        // The OpenAI wire has no native error flag, so detect it from the content (built-in heuristic + any user patterns).
        isError: isResultError(message.content, patterns),
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
            // `is_error` is authoritative when present; the content heuristic additionally catches an UNFLAGGED error.
            isError: block.is_error === true || isResultError(block.content, patterns),
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

/** Convert a raw tool-result payload into bounded stored content (truncated to `MAX_TOOL_RESULT_CONTENT_CHARS`) plus the full character length. */
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

/** Normalize a response body's `usage` field into the provider-agnostic shape, delegating to the shared `normalizeUsage`. */
function extractUsage(body: unknown): NormalizedUsage | undefined {
  if (!isRecord(body)) return undefined;
  return normalizeUsage(body.usage);
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


/** Reflect the (possibly-edited) message stream back onto the raw wire request's `messages` field; only wire bodies carrying a `messages` array are touched. */
function syncRequestMessages(ctx: RequestContext): void {
  const raw = ctx.raw;
  if (!isRecord(raw)) return;
  const existing = raw.messages;
  if (!Array.isArray(existing)) return; // not a message protocol: leave untouched
  if (existing === ctx.messages) return; // stream untouched: already in sync
  raw.messages = ctx.messages;
}