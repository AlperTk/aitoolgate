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
 * - A `tool.call` event for EVERY accumulated call when the stream ends (`flush`), i.e. "when
 *   the stream ends" (also covers a `data: [DONE]` terminator and client-disconnect/error
 *   teardown). Emission is deferred to stream end (rather than when a new call `index`
 *   starts) so a SINGLE-call turn's per-call event carries the turn's FINAL merged `tokens`:
 *   a provider may report usage only on a trailing frame (OpenAI) or a final frame (Anthropic
 *   `message_delta`), which arrives after every call has been observed. A batched turn (>1
 *   calls) omits per-call `tokens` — the whole-turn `turn.usage` carries the token mass once. Each call carrying a
 *   stable id is ALSO recorded into an optional shared latency tracker so its LATER result
 *   (fed back by the client) pairs into a REAL `tool.result`; no synthetic per-stream
 *   `tool.result` is emitted. Every tool.call in one streamed turn shares ONE turn-level `at`
 *   (so the collector's per-(sessionKey, at) token dedup collapses multi-call turns into a
 *   single contribution) and, for a SINGLE-call turn, carries the turn's `tokens` (normalized
 *   from the stream's usage — an OpenAI trailing `usage` chunk OR an Anthropic `message_start`
 *   / `message_delta` `usage` frame) when the provider reports usage on the stream. A batched
 *   turn omits per-call `tokens` (the whole-turn `turn.usage` carries the token mass once)
 *   rather than duplicating them across its per-call events — and the usage is omitted, never
 *   fabricated, when no usage is present.
 * - A single `turn.usage` event per stream when the stream ends, carrying the WHOLE-TURN token
 *   mass over ALL message content (not only tool calls/results): the stream's reported usage
 *   when present, else an ESTIMATE — `input` from this request's full message content (the
 *   optional `inputTokens` parameter, precomputed by the caller via `estimateInputTokens`) and
 *   `output` from the streamed response text + finalized tool-call arguments — so a usage-less
 *   of zero when the turn has NO stream usage but DID issue tool calls. It shares the turn-level
 *   `at` with any emitted tool.call events, so the collector's per-(sessionKey, at) dedup counts
 *   each distinct turn exactly once. Omitted entirely when the stream reports no usage AND
 *   observes no tool calls (a usage-less, call-free final-answer stream stays silent — omit,
 *   don't fabricate — preserving pure-passthrough silence for such streams).
 *
 * Per-call DURATION attribution, however, rides on the TRACKER, not the events: each
 * call's own FIRST-OBSERVATION time (when it first appeared on the stream) is recorded
 * as its issue time — via an injectable `now` clock, defaulting to the shared monotonic
 * wall-clock — so batched or interleaved calls in one streamed turn each measure their
 * TRUE issue→result span when their results later resolve, without disturbing the
 * shared turn-level event `at` the token-turn dedup depends on.
 *
 * Best-effort throughout: unparseable lines are ignored, a missing/undefined `bus`
 * yields a pure passthrough, and no internal error can propagate into the stream.
 */
import { Transform } from 'node:stream';
import type { TelemetryEmitter, ToolCallEvent, ToolResultEvent, TurnUsageEvent } from './events';
import { monotonicEpochMs, type ToolMetricsTracker } from './toolMetrics';
import { estimateTokensFromChars, estimateCallTokens } from './tokenEstimate';
import { parseArgs, stableCallId, normalizeUsage, isRecord, toolDescriptionMap, type NormalizedUsage } from './protocol-common';

/** Accumulated state for one in-progress streaming tool call, keyed by SSE `index`. */
interface StreamToolCall {
  /** The tool name (assembled from `function.name` fragments). */
  name: string;
  /** The accumulating raw `function.arguments` string. */
  args: string;
  /** The stable tool-call id (`tool_calls[].id` / Anthropic `tool_use.id`), when present. */
  id: string;
  /**
   * When THIS specific call was FIRST observed on the stream (epoch milliseconds), captured
   * once at its first fragment/block. Recorded into the shared tracker as that call's issue
   * time so its later result measures a true per-call span: sibling calls in one batched or
   * interleaved streamed turn generally carry distinct first-observation times even though
   * their EMITTED events share ONE turn-level `at` (which token-turn dedup relies on).
   */
  firstSeenAt?: number;
}

/**
 * Create a passthrough {@link Transform} extracting tool-call telemetry from an SSE byte
 * stream. See the module doc for the exact emission semantics. Safe with an undefined
 * `bus` (pure passthrough); `clientId` is attached to emitted events only when provided.
 * An optional injectable timing source (`now`, epoch milliseconds — defaulting to the
 * shared monotonic wall-clock) controls BOTH the shared turn-level event `at` and each
 * call's per-first-observation issue time recorded into the shared tracker. An OPTIONAL
 * precomputed estimated INPUT-token mass of this stream's REQUEST (`inputTokens`; see
 * `estimateInputTokens` in `tokenEstimate.ts`) lets the final `turn.usage` event carry honest
 * input tokens even when the provider reports no stream usage. An OPTIONAL request `raw`
 * body (`requestRaw`) lets each emitted `tool.call` event carry the request-provided tool
 * description (matched by the call's name — both OpenAI `tools[i].function.description` and
 * Anthropic `tools[i].description`), mirroring the buffered (`proxy/context.ts`) emission path;
 * omitted when the request provides no description for the tool (or no `tools` array at all).
 */
export function createSseToolCallExtractor(
  bus: TelemetryEmitter | undefined,
  sessionKey: string,
  clientId?: string,
  tracker?: ToolMetricsTracker,
  now?: () => number,
  inputTokens?: number,
  requestRaw?: unknown,
): Transform {
  // Injectable timing source (epoch milliseconds); defaults to the shared monotonic wall-clock.
  const clockNow = now ?? monotonicEpochMs;
  // Map each streamed tool name to the request-provided description (both OpenAI
  // tools[i].function.description and Anthropic tools[i].description) so the emitted
  // tool.call event can carry it, mirroring the buffered (proxy/context.ts) path.
  // toolDescriptionMap is non-throwing; a request with no `tools` array yields an empty map.
  const toolDescs = toolDescriptionMap(requestRaw);

  /** Emit through the optional bus, swallowing any synchronous or async failure. */
  const emitEvent = (event: ToolCallEvent | ToolResultEvent | TurnUsageEvent): void => {
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
  let buffer = '';
  let finished = false;
  // The turn's upstream usage, merged field-aware across every usage frame seen this stream;
  // shared by every tool call emitted this stream so they all carry the same FINAL turn-level
  // tokens (or none when the provider reports no usage).
  let streamUsage: NormalizedUsage | undefined;
  // A single turn-level timestamp shared by EVERY tool call emitted this stream, so the
  // collector's per-(sessionKey, at) token dedup collapses a multi-call turn into one.
  let turnAt: number | undefined;
  const turnTimestamp = (): number => {
    if (turnAt === undefined) turnAt = clockNow();
    return turnAt;
  };
  // A set of ids already assigned this stream so the stable-id fallback never hands two sibling
  // calls in one batch turn the same id (shared stableCallId helper in telemetry/protocol-common).
  const seenIds = new Set<string>();
  // Character mass of streamed RESPONSE TEXT (both protocols) plus FINALIZED tool-call arguments —
  // together the full observed model-side output, used to ESTIMATE the turn's output tokens when
  // the provider reports no stream usage (see the `turn.usage` emission at stream end).
  let streamedTextChars = 0;
  let emittedArgsChars = 0;
  // Count of tool.call events actually emitted this stream (gates the final `turn.usage`).
  let callsEmitted = 0;

  /**
   * Emit and drop the accumulated call at `index` (only when it carries a tool name). Called
   * only from flushAllCalls() at stream end, so the emitted event carries the turn's FINAL
   * merged usage (when the provider reported it). Per-call `tokens` are attached only when the
   * turn is a SINGLE call (`totalCalls === 1`); a batched turn (>1 calls) omits per-call tokens
   * so the turn's token mass is carried once by the whole-turn `turn.usage`, not duplicated
   * across the batched per-call events. When a stable id is present it is ALSO recorded into
   * the shared latency tracker so a LATER request carrying the matching result pairs into a
   * REAL `tool.result` (no synthetic per-stream result).
   */
  const emitCallAt = (index: number, totalCalls: number): void => {
    const acc = byIndex.get(index);
    if (acc === undefined) return;
    byIndex.delete(index);
    if (acc.name === '') return;
    const args = parseArgs(acc.args);
    // The EMITTED event keeps ONE shared turn-level `at` so the collector's per-(sessionKey, at)
    // token dedup collapses a multi-call turn into a single contribution. The TRACKER instead
    // records THIS call's own first-observation time (captured when the call first appeared on
    // the stream) as its issue time, so its later result measures a TRUE per-call span — even
    // for batched/interleaved calls in one streamed turn observed at different times. Results
    // that genuinely arrive together keep equal (correct, parallel-run) durations; out-of-order
    // arrivals each take their own span, paired by id (see `toolMetrics`).
    const at = turnTimestamp();
    const issuedAt = acc.firstSeenAt ?? at;
    // Assign a stable, turn-unique id (the upstream id when present, else a deterministic
    // `${sessionKey}#${at}#${index}` fallback) so sibling calls in one batch turn NEVER share an
    // identical id — the field the dashboard dedups on. The same id feeds both the emitted event
    // and the tracker so a later result stays linked to its originating call.
    const id = stableCallId(sessionKey, at, index, acc.id, seenIds);
    // Fold THIS call's raw argument character mass into the whole-turn OUTPUT estimate and count
    // the emitted call (so even a usage-less stream that observed tool calls still emits its
    // final `turn.usage`).
    callsEmitted += 1;
    emittedArgsChars += acc.args.length;
    // The request-provided tool description (matched by the call's name), attached only when
    // present so a tool with no description simply omits the field (mirrors the buffered path).
    const description = toolDescs.get(acc.name);
    emitEvent({
      type: 'tool.call',
      sessionKey,
      toolName: acc.name,
      ...(id !== '' ? { id } : {}),
      ...(args !== undefined ? { args } : {}),
      ...(typeof description === 'string' && description !== '' ? { description } : {}),
      at,
      // Attach the turn's upstream usage when the provider reported it AND the turn is a single
      // call (omitted for a batched turn so the whole-turn turn.usage carries the token mass once).
      ...(totalCalls === 1 && streamUsage !== undefined ? { tokens: streamUsage } : {}),
      // Per-call REQUEST-side token estimate (name + serialized arguments); distinct per tool,
      // mirroring the buffered (proxy/context.ts) emission path.
      ...(acc.name !== '' || acc.args.length > 0 ? { callTokens: estimateCallTokens(acc.name, acc.args) } : {}),
      ...(clientId !== undefined ? { clientId } : {}),
    });
    // Record the issued call with ITS OWN issue time (plus its name so a resolved result can
    // surface a real toolName) so its later result can be paired per-call. Every emitted call
    // now carries a non-empty stable id, so every emitted call is recorded.
    if (tracker !== undefined && id !== '') {
      try {
        tracker.recordIssued(sessionKey, [{ id, at: issuedAt, ...(acc.name !== '' ? { name: acc.name } : {}) }]);
      } catch {
        // A throwing tracker must never break the stream pass-through.
      }
    }
  };

  /** Emit every accumulated call in index order — the SOLE emission point, at stream end. */
  const flushAllCalls = (): void => {
    const indices = [...byIndex.keys()].sort((a, b) => a - b);
    // Count the calls that will actually be emitted (non-empty tool names): a single-call turn
    // attaches the turn's tokens to its per-call event, while a batched turn omits them.
    const totalCalls = indices.reduce((n, index) => n + (byIndex.get(index)?.name ? 1 : 0), 0);
    for (const index of indices) emitCallAt(index, totalCalls);
  };

  /**
   * Finalise the stream once: emit ALL accumulated calls (a single-call turn attaches the turn's
   * final merged usage to its per-call event; a batched turn omits per-call tokens), then emit
   * the whole-turn `turn.usage`. No synthetic per-stream `tool.result` is emitted here — real
   * results are paired against the tracker (see {@link emitCallAt}) when the client resends
   * with the matching result message.
   */
  const finish = (): void => {
    if (finished) return;
    finished = true;
    flushAllCalls();
    // One WHOLE-TURN token account per stream that HAS A TOKEN SOURCE (reported stream usage, or
    // observed tool calls) when a bus is wired: the provider-reported usage when available, else
    // an ESTIMATE — `input` from this request's full message content (`inputTokens`, precomputed
    // by the caller), `output` from the streamed response text plus finalized tool-call arguments
    // — so the turn's input/output token calculation includes non-tool message text, not only
    // tool-related content. Shares the turn-level `at` with any emitted tool.call events, so the
    // collector's per-(sessionKey, at) dedup counts the turn exactly once. A usage-less, call-free
    // (final-answer) stream has no token source and emits nothing (omit, don't fabricate).
    const inputMass = typeof inputTokens === 'number' ? inputTokens : 0;
    if (streamUsage !== undefined || callsEmitted > 0) {
      const input = streamUsage?.input ?? inputMass;
      const cacheHitInput = streamUsage?.cacheHitInput ?? 0;
      const output = streamUsage?.output ?? estimateTokensFromChars(streamedTextChars + emittedArgsChars);
      if (input > 0 || output > 0) {
        // total is always the TRUE turn total (base input + cache-hit input + output); cacheHitInput
        // is 0 when the stream reported no cache fields (and on the estimate path).
        emitEvent({
          type: 'turn.usage',
          sessionKey,
          tokens: { input, output, total: input + cacheHitInput + output, cacheHitInput },
          ...(clientId !== undefined ? { clientId } : {}),
          at: turnTimestamp(),
        });
      }
    }
  };

  /** Accumulate one `choices[].delta.tool_calls[]` fragment, keyed by its `index`; calls are emitted at stream end. */
  const accumulate = (entry: unknown): void => {
    const record = entry as { index?: number; id?: string; function?: { name?: string; arguments?: string } };
    const index = typeof record.index === 'number' ? record.index : byIndex.size;
    let acc = byIndex.get(index);
    if (acc === undefined) {
      acc = { name: '', args: '', id: '' };
      byIndex.set(index, acc);
    }
    // First observation of this call: pin ITS issue time once (per-call duration attribution).
    if (acc.firstSeenAt === undefined) acc.firstSeenAt = clockNow();
    if (typeof record.id === 'string' && record.id !== '') acc.id = record.id;
    const fn = record.function;
    if (isRecord(fn)) {
      if (typeof fn.name === 'string' && fn.name !== '') acc.name = fn.name;
      if (typeof fn.arguments === 'string') acc.args += fn.arguments;
    }
  };

  /**
   * Handle one NATIVE Anthropic streaming event frame. Only `tool_use` content blocks produce
   * pending tool-call state: `content_block_start` opens a call (capturing its stable `id` +
   * `name`) and `content_block_delta` (`input_json_delta.partial_json`) appends raw arguments.
   * TEXT deltas are counted only for the whole-turn OUTPUT token estimate (no block state);
   * every accumulated `tool_use` call is
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
        // First observation of this tool_use block: pin ITS issue time once.
        if (acc.firstSeenAt === undefined) acc.firstSeenAt = clockNow();
        if (typeof block.id === 'string' && block.id !== '') acc.id = block.id;
        if (typeof block.name === 'string' && block.name !== '') acc.name = block.name;
        break;
      }
      case 'content_block_delta': {
        const delta = parsed.delta;
        if (!isRecord(delta)) return;
        // Response-TEXT fragments count toward the whole-turn OUTPUT token estimate.
        const textDelta = delta.text_delta;
        if (isRecord(textDelta) && typeof textDelta.text === 'string') streamedTextChars += textDelta.text.length;
        const jsonDelta = delta.input_json_delta;
        if (isRecord(jsonDelta) && typeof jsonDelta.partial_json === 'string') {
          const index = typeof parsed.index === 'number' ? parsed.index : -1;
          const acc = byIndex.get(index);
          if (acc !== undefined) {
            if (acc.firstSeenAt === undefined) acc.firstSeenAt = clockNow();
            acc.args += jsonDelta.partial_json;
          }
        }
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
    const usage = normalizeUsage(parsed.usage ?? nestedUsage);
    if (usage !== undefined) streamUsage = mergeUsage(streamUsage, usage);
    // OpenAI-shaped streaming tool-call fragments.
    const choices = parsed.choices;
    if (Array.isArray(choices)) {
      for (const choice of choices) {
        if (!isRecord(choice)) continue;
        const delta = choice.delta;
        if (!isRecord(delta)) continue;
        // Response-TEXT fragments count toward the whole-turn OUTPUT token estimate.
        if (typeof delta.content === 'string') streamedTextChars += delta.content.length;
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
 * Merge two normalized usages into one, FIELD-AWARE: each numeric field independently takes
 * the value from the MOST RECENT frame that reports it (last-reported-value-wins per field).
 * This makes a later frame's FINAL value win over an earlier preliminary one — e.g. an
 * Anthropic `message_delta` carries the FINAL `output_tokens` (and the cumulative
 * `cache_read_input_tokens`) that override the preliminary `output_tokens`/cache value on
 * `message_start`, while `input_tokens` (only on `message_start`) keeps its value. The OpenAI
 * path benefits the same way: a later `usage` chunk's values override an earlier one's. Once
 * both input and output are known, `total` is recomputed as input+cacheHitInput+output so the
 * merged (and `finish()`-emitted) total always reconciles with the final field values.
 */
function mergeUsage(prev: NormalizedUsage | undefined, next: NormalizedUsage): NormalizedUsage {
  const out: NormalizedUsage = { ...(prev ?? {}) };
  // Each numeric field is independently last-reported-value-wins: the most recent frame that
  // reports a given field overrides the accumulated value for that field.
  for (const key of ['input', 'output', 'total', 'cacheHitInput'] as const) {
    if (next[key] !== undefined) out[key] = next[key];
  }
  // Recompute total from the merged (final) input + cacheHitInput + output so it reconciles
  // with the final field values (finish() does the same when emitting the turn.usage event).
  if (out.input !== undefined && out.output !== undefined) {
    out.total = (out.input ?? 0) + (out.cacheHitInput ?? 0) + (out.output ?? 0);
  }
  return out;
}