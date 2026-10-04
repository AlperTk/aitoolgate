/**
 * Streaming tool-call telemetry extractor (dependency-free).
 *
 * {@link createSseToolCallExtractor} returns a passthrough {@link Transform} that
 * can be inserted into an SSE pipe chain WITHOUT altering the bytes forwarded to the
 * client. It is PROTOCOL-AWARE: it accumulates both OpenAI-compatible streaming fragments
 * (`choices[].delta.tool_calls[]`, each carrying an `index` and optional `id` /
 * `function: { name?, arguments? }`) AND native Anthropic streaming events
 * (`content_block_start` for a `tool_use` block — capturing its stable `id` + `name` —
 * plus `content_block_delta` `input_json_delta` argument fragments, finalised on
 * `content_block_stop`, with turn usage read from `message_start` / `message_delta`).
 * It then emits telemetry onto an optional event bus:
 *
 * - A `tool.call` event whenever a NEW tool-call `index` starts (finalising the
 *   previously-accumulated call) — i.e. "when a new tool call starts".
 * - Any remaining accumulated calls when the stream ends (`flush`), i.e. "when the
 *   stream ends" (also covers a `data: [DONE]` terminator and client-disconnect/error
 *   teardown). Each call carrying a stable id is ALSO recorded into an optional shared
 *   latency tracker so its LATER result (fed back by the client) pairs into a REAL
 *   `tool.result`; no synthetic per-stream `tool.result` is emitted. Every tool.call in one
 *   streamed turn shares ONE turn-level `at` (so the collector's per-(sessionKey, at) token
 *   dedup collapses multi-call turns into a single contribution) and carries the turn's
 *   `tokens` (normalized from the stream's usage — an OpenAI trailing `usage` chunk OR an
 *   Anthropic `message_start` / `message_delta` `usage` frame) when the provider reports
 *   usage on the stream — omitted rather than fabricated when no usage is present.
 *
 * Best-effort throughout: unparseable lines are ignored, a missing/undefined `bus`
 * yields a pure passthrough, and no internal error can propagate into the stream.
 */
import { Transform } from 'node:stream';
import type { TelemetryEmitter, ToolCallEvent, ToolResultEvent } from './events';
import type { ToolMetricsTracker } from './toolMetrics';

/** Accumulated state for one in-progress streaming tool call, keyed by SSE `index`. */
interface StreamToolCall {
  /** The tool name (assembled from `function.name` fragments). */
  name: string;
  /** The accumulating raw `function.arguments` string. */
  args: string;
  /** The stable tool-call id (`tool_calls[].id` / Anthropic `tool_use.id`), when present. */
  id: string;
}

/**
 * Create a passthrough {@link Transform} extracting tool-call telemetry from an SSE byte
 * stream. See the module doc for the exact emission semantics. Safe with an undefined
 * `bus` (pure passthrough); `clientId` is attached to emitted events only when provided.
 */
export function createSseToolCallExtractor(
  bus: TelemetryEmitter | undefined,
  sessionKey: string,
  clientId?: string,
  tracker?: ToolMetricsTracker,
): Transform {
  /** Emit through the optional bus, swallowing any synchronous or async failure. */
  const emitEvent = (event: ToolCallEvent | ToolResultEvent): void => {
    if (bus === undefined) return;
    try {
      const maybe = bus.emit(event);
      if (maybe !== null && typeof maybe === 'object' && typeof (maybe as { catch?: unknown }).catch === 'function') {
        (maybe as Promise<unknown>).catch(() => {});
      }
    } catch {
      // A throwing emitter must never break the stream pass-through.
    }
  };

  const byIndex = new Map<number, StreamToolCall>();
  let maxSeenIndex = -1;
  let buffer = '';
  let finished = false;
  // The turn's upstream usage, parsed once from a trailing `usage` chunk, shared by every tool
  // call emitted this stream so they all carry the same turn-level tokens (or none).
  let streamUsage: { input?: number; output?: number; total?: number } | undefined;
  // A single turn-level timestamp shared by EVERY tool call emitted this stream, so the
  // collector's per-(sessionKey, at) token dedup collapses a multi-call turn into one.
  let turnAt: number | undefined;
  const turnTimestamp = (): number => {
    if (turnAt === undefined) turnAt = Date.now();
    return turnAt;
  };
  // A set of ids already assigned this stream so the stable-id fallback never hands two sibling
  // calls in one batch turn the same id (mirrors stableToolCallId in proxy/context.ts).
  const seenIds = new Set<string>();

  /** Parse an accumulated `arguments` string into an object; `undefined` when absent/non-object. */
  const parseArgs = (raw: string): Record<string, unknown> | undefined => {
    if (raw.trim() === '') return undefined;
    try {
      const parsed: unknown = JSON.parse(raw);
      return isRecord(parsed) ? (parsed as Record<string, unknown>) : undefined;
    } catch {
      return undefined;
    }
  };

  /**
   * Emit and drop the accumulated call at `index` (only when it carries a tool name). When a
   * stable id is present it is ALSO recorded into the shared latency tracker so a LATER request
   * carrying the matching result pairs into a REAL `tool.result` (no synthetic per-stream result).
   */
  const emitCallAt = (index: number): void => {
    const acc = byIndex.get(index);
    if (acc === undefined) return;
    byIndex.delete(index);
    if (acc.name === '') return;
    const args = parseArgs(acc.args);
    // Every tool call emitted this stream shares ONE turn-level `at`, so the collector's
    // per-(sessionKey, at) token dedup collapses a multi-call turn into a single contribution.
    const at = turnTimestamp();
    // Assign a stable, turn-unique id (the upstream id when present, else a deterministic
    // `${sessionKey}#${at}#${index}` fallback) so sibling calls in one batch turn NEVER share an
    // identical id — the field the dashboard dedups on. The same id feeds both the emitted event
    // and the tracker so a later result stays linked to its originating call.
    const id = stableStreamCallId(sessionKey, at, index, acc.id, seenIds);
    emitEvent({
      type: 'tool.call',
      sessionKey,
      toolName: acc.name,
      ...(id !== '' ? { id } : {}),
      ...(args !== undefined ? { args } : {}),
      at,
      // Attach the turn's upstream usage when the provider reported it on the stream (omitted otherwise).
      ...(streamUsage !== undefined ? { tokens: streamUsage } : {}),
      ...(clientId !== undefined ? { clientId } : {}),
    });
    // Record the issued call (sharing the same turn-level timestamp, plus its name so a
    // resolved result can surface a real toolName) so its later result can be paired. Every
    // emitted call now carries a non-empty stable id, so every emitted call is recorded.
    if (tracker !== undefined && id !== '') {
      try {
        tracker.recordIssued(sessionKey, [{ id, at, ...(acc.name !== '' ? { name: acc.name } : {}) }]);
      } catch {
        // A throwing tracker must never break the stream pass-through.
      }
    }
  };

  /** Emit every remaining accumulated call in index order. */
  const flushAllCalls = (): void => {
    for (const index of [...byIndex.keys()].sort((a, b) => a - b)) emitCallAt(index);
  };

  /**
   * Finalise the stream once: emit any remaining accumulated calls. No synthetic per-stream
   * `tool.result` is emitted here — real results are paired against the tracker (see
   * {@link emitCallAt}) when the client resends with the matching result message.
   */
  const finish = (): void => {
    if (finished) return;
    finished = true;
    flushAllCalls();
  };

  /** Accumulate one `choices[].delta.tool_calls[]` fragment, keyed by its `index`. */
  const accumulate = (entry: unknown): void => {
    const record = entry as { index?: number; id?: string; function?: { name?: string; arguments?: string } };
    const index = typeof record.index === 'number' ? record.index : byIndex.size;
    // A strictly-new higher index means every lower-index call is complete: finalise them.
    if (maxSeenIndex >= 0 && index > maxSeenIndex) {
      for (const key of [...byIndex.keys()]) {
        if (key < index) emitCallAt(key);
      }
    }
    let acc = byIndex.get(index);
    if (acc === undefined) {
      acc = { name: '', args: '', id: '' };
      byIndex.set(index, acc);
    }
    if (typeof record.id === 'string' && record.id !== '') acc.id = record.id;
    const fn = record.function;
    if (isRecord(fn)) {
      if (typeof fn.name === 'string' && fn.name !== '') acc.name = fn.name;
      if (typeof fn.arguments === 'string') acc.args += fn.arguments;
    }
    if (index > maxSeenIndex) maxSeenIndex = index;
  };

  /**
   * Handle one NATIVE Anthropic streaming event frame. Only `tool_use` content blocks produce
   * pending tool-call state: `content_block_start` opens a call (capturing its stable `id` +
   * `name`) and `content_block_delta` (`input_json_delta.partial_json`) appends raw arguments.
   * Text blocks and `content_block_stop` are not tracked; every accumulated `tool_use` call is
   * finalised (emit + record) when the stream ends ({@link finish} → {@link flushAllCalls}),
   * exactly mirroring the OpenAI-shaped path so each call carries the FULL turn-level `tokens`
   * (read from `message_start` / `message_delta`) under ONE shared turn-level `at`. `message_*`
   * frames contribute only via the turn-level usage merge in {@link processLine}.
   */
  const handleAnthropicEvent = (parsed: Record<string, unknown>): void => {
    switch (parsed.type) {
      case 'content_block_start': {
        const block = parsed.content_block;
        if (!isRecord(block) || block.type !== 'tool_use') return; // only tool_use blocks open a call
        const index = typeof parsed.index === 'number' ? parsed.index : byIndex.size;
        let acc = byIndex.get(index);
        if (acc === undefined) {
          acc = { name: '', args: '', id: '' };
          byIndex.set(index, acc);
        }
        if (typeof block.id === 'string' && block.id !== '') acc.id = block.id;
        if (typeof block.name === 'string' && block.name !== '') acc.name = block.name;
        break;
      }
      case 'content_block_delta': {
        const delta = parsed.delta;
        if (!isRecord(delta)) return;
        const jsonDelta = delta.input_json_delta;
        if (!isRecord(jsonDelta) || typeof jsonDelta.partial_json !== 'string') return;
        const index = typeof parsed.index === 'number' ? parsed.index : -1;
        const acc = byIndex.get(index);
        if (acc !== undefined) acc.args += jsonDelta.partial_json;
        break;
      }
      default:
        // message_start / message_delta / message_stop / content_block_stop: no per-block work here;
        // usage is merged in processLine and tool_use calls are finalised at stream end.
        break;
    }
  };

  /** Parse one SSE `data:` line and accumulate any tool-call fragments it carries. */
  const processLine = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return;
    const payload = trimmed.slice('data:'.length).trim();
    if (payload === '' || payload === '[DONE]') return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return; // Non-JSON data line (comment / keep-alive): ignore.
    }
    if (!isRecord(parsed)) return;
    // Turn-level usage: present on an OpenAI trailing `usage` chunk OR an Anthropic
    // `message_start` (`message.usage`) / `message_delta` (`usage`) frame. Read from either
    // location and MERGED across frames so split input/output numbers collapse into ONE
    // turn-level usage shared by every emitted call (or none when no usage is present).
    const nestedUsage = isRecord(parsed.message) ? parsed.message.usage : undefined;
    const usage = normalizeStreamUsage(parsed.usage ?? nestedUsage);
    if (usage !== undefined) streamUsage = mergeUsage(streamUsage, usage);
    // OpenAI-shaped streaming tool-call fragments.
    const choices = parsed.choices;
    if (Array.isArray(choices)) {
      for (const choice of choices) {
        if (!isRecord(choice)) continue;
        const delta = choice.delta;
        if (!isRecord(delta)) continue;
        const toolCalls = delta.tool_calls;
        if (Array.isArray(toolCalls)) for (const tc of toolCalls) accumulate(tc);
      }
      return;
    }
    // Native Anthropic streaming events (same-protocol pass-through): content_block_* frames
    // create/finalise tool_use calls; message_* frames are handled via the usage merge above.
    handleAnthropicEvent(parsed);
  };

  /** Fold a chunk into the buffer and process each completed line. */
  const handleChunk = (chunk: Buffer | string): void => {
    buffer += chunk.toString('utf8');
    let newlineIndex = buffer.indexOf('\n');
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      processLine(line);
      newlineIndex = buffer.indexOf('\n');
    }
  };

  return new Transform({
    transform(chunk: Buffer, _encoding: string | undefined, callback: () => void): void {
      try {
        handleChunk(chunk as Buffer);
      } catch {
        // Best-effort extraction must never break the pass-through.
      }
      this.push(chunk); // Forward the raw bytes unchanged.
      callback();
    },
    flush(callback: () => void): void {
      try {
        if (buffer.trim() !== '') processLine(buffer); // Flush any trailing partial line.
        finish();
      } catch {
        // Best-effort finalisation must never throw out of the stream.
      }
      callback();
    },
  });
}

/**
 * Normalize a streamed `usage` object into the provider-agnostic `{ input?, output?, total? }`
 * shape (matching {@link ToolCallEvent.tokens}). Understands both the OpenAI
 * `prompt_tokens/completion_tokens/total_tokens` and Anthropic `input_tokens/output_tokens`
 * shapes (`total` computed as input+output when the provider omits it). Best-effort: returns
 * `undefined` when no numeric usage field is present, so callers omit tokens rather than fabricate.
 */
function normalizeStreamUsage(usage: unknown): { input?: number; output?: number; total?: number } | undefined {
  if (!isRecord(usage)) return undefined;
  const out: { input?: number; output?: number; total?: number } = {};
  const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
  let hasAny = false;
  if (isNumber(usage.prompt_tokens)) {
    out.input = usage.prompt_tokens;
    hasAny = true;
  }
  if (isNumber(usage.completion_tokens)) {
    out.output = usage.completion_tokens;
    hasAny = true;
  }
  if (isNumber(usage.total_tokens)) {
    out.total = usage.total_tokens;
    hasAny = true;
  } else if (out.input !== undefined && out.output !== undefined) {
    out.total = out.input + out.output;
  }
  if (!hasAny) {
    if (isNumber(usage.input_tokens)) {
      out.input = usage.input_tokens;
      hasAny = true;
    }
    if (isNumber(usage.output_tokens)) {
      out.output = usage.output_tokens;
      hasAny = true;
    }
    if (out.input !== undefined && out.output !== undefined) out.total = out.input + out.output;
  }
  return hasAny ? out : undefined;
}

/**
 * Merge two normalized usages into one, keeping the first value seen for each field (union of
 * fields) and deriving `total = input + output` once both are known — so an Anthropic stream
 * reporting `input_tokens` on `message_start` and `output_tokens` on `message_delta` collapses
 * into ONE complete turn usage rather than the last frame overwriting the prior one.
 */
function mergeUsage(
  prev: { input?: number; output?: number; total?: number } | undefined,
  next: { input?: number; output?: number; total?: number },
): { input?: number; output?: number; total?: number } {
  const out: { input?: number; output?: number; total?: number } = { ...(prev ?? {}) };
  for (const key of ['input', 'output', 'total'] as const) {
    if (next[key] !== undefined && out[key] === undefined) out[key] = next[key];
  }
  if (out.total === undefined && out.input !== undefined && out.output !== undefined) out.total = out.input + out.output;
  return out;
}

/**
 * Assign a stable, turn-unique id to one streamed tool call. Prefers the upstream id when present;
 * otherwise synthesizes a deterministic `${sessionKey}#${at}#${index}` id. A monotonic suffix
 * (`~1`, `~2`, …) is appended whenever the computed id would still collide with a sibling already
 * seen in this stream (e.g. two blocks sharing one upstream id), guaranteeing NO two sibling calls
 * in a batch turn ever share an identical id — the field the dashboard dedups on. Mirrors
 * `stableToolCallId` in `proxy/context.ts` so both emission paths produce the same contract.
 */
function stableStreamCallId(
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

/** Type guard: is the value a non-null, non-array object? */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
