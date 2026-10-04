import type http from 'node:http';
import type { ClientConfig, ModelConfig, SessionKey, ToolCall } from '../ports/domain';
import type { Pipeline, RequestContext, ResponseContext } from '../ports/pipeline';
import type { TelemetryEmitter, ToolCallEvent, ToolResultEvent } from '../telemetry/events';
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
export function summarizeResponse(body: unknown): { toolCalls: ToolCall[]; content: string } {
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
    return { toolCalls, content: extractTextContent(message.content) };
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
    return { toolCalls, content };
  }

  return { toolCalls: [], content: '' };
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
   * Optional telemetry event bus to emit `tool.call` / `tool.result` events onto
   * after the response phase. Accepts EITHER the port-level `EventBus` or the
   * telemetry `TelemetryEventBus` (both expose `emit`, so either is structurally
   * compatible). When omitted, no events are emitted (behavior unchanged). Emission
   * is skipped when the pipeline already contains a `policy` stage — that stage owns
   * tool-call observation for policy-enabled requests, so this avoids double-counting.
   */
  bus?: TelemetryEmitter;
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
  // Emit tool-call/result telemetry directly onto the provided bus (independent of
  // any policy stage). Skipped when a policy stage is present (it observes/emits these
  // same calls), or when no bus is wired (pure passthrough — behavior unchanged).
  const policyHandledTelemetry = pipeline.stages.some((stage) => stage.name === 'policy');
  if (!policyHandledTelemetry) {
    emitResponseTelemetry(opts?.bus, requestCtx, processedResponse.toolCalls, result.status);
  }
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

/**
 * Emit one `tool.call` event per observed tool call plus a single `tool.result` event
 * (per request, not per call) onto the given bus. A no-op when `bus` is undefined. Each
 * dispatch is guarded so a throwing/rejecting emitter can never break the request flow.
 */
function emitResponseTelemetry(
  bus: TelemetryEmitter | undefined,
  requestCtx: RequestContext,
  toolCalls: ToolCall[],
  status: number,
): void {
  if (bus === undefined) return;
  const sessionKey = toSessionKeyString(requestCtx.sessionKey);
  const clientId = toClientId(requestCtx.client);
  const at = Date.now();
  for (const call of toolCalls) {
    safeEmit(bus, makeToolCallEvent(sessionKey, clientId, call.name, call.arguments, at));
  }
  const first = toolCalls[0];
  const resultEvent: ToolResultEvent = {
    type: 'tool.result',
    sessionKey,
    toolName: first ? first.name : '',
    ok: status >= 200 && status < 300,
    at,
    ...(clientId !== undefined ? { clientId } : {}),
  };
  safeEmit(bus, resultEvent);
}

/** Build a {@link ToolCallEvent}; `args` is included only when it is a non-empty object. */
function makeToolCallEvent(
  sessionKey: string,
  clientId: string | undefined,
  toolName: string,
  args: Record<string, unknown>,
  at: number,
): ToolCallEvent {
  const hasArgs = Object.keys(args).length > 0;
  return {
    type: 'tool.call',
    sessionKey,
    toolName,
    at,
    ...(hasArgs ? { args } : {}),
    ...(clientId !== undefined ? { clientId } : {}),
  };
}

/** Emit an event through an optional bus without ever letting a failure surface. */
function safeEmit(bus: TelemetryEmitter, event: ToolCallEvent | ToolResultEvent): void {
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
