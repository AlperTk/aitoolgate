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
import type { InternalLLMEvent } from '../ports/llm';
import type { TelemetryEmitter, ToolCallEvent, ToolResultEvent, TurnUsageEvent } from './events';
import { monotonicEpochMs, type ToolMetricsTracker } from './toolMetrics';
import { estimateTokensFromChars, estimateCallTokens } from './tokenEstimate';
import { parseArgs, stableCallId, toolDescriptionMap, type NormalizedUsage } from './protocol-common';
import { parseSseDataLine, decodeSseFrame, type SseFrameSink } from './sse-frames';

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

/** One tool call ready for emission, normalised across the event tap and the raw SSE byte path. */
interface PendingCall {
  /** Provider tool-call index (or arrival ordinal); orders calls within a turn. */
  index: number;
  name: string;
  id: string;
  /** Raw argument text (wire string when known, else serialized arguments). */
  raw: string;
  /** Parsed arguments, when known. */
  args: Record<string, unknown> | undefined;
  /** When this call was first observed (epoch milliseconds). */
  firstSeenAt?: number;
}

/** True for a decoded InternalLLMEvent object (as opposed to a raw SSE byte chunk). */
function isInternalEvent(chunk: unknown): chunk is InternalLLMEvent {
  return typeof chunk === 'object' && chunk !== null && !Buffer.isBuffer(chunk) && typeof (chunk as { type?: unknown }).type === 'string';
}

/**
 * Create a passthrough {@link Transform} extracting tool-call telemetry from decoded
 * InternalLLMEvents (primary) or, for undecodable passthrough, from raw SSE bytes.
 * See the module doc for the exact emission semantics. Safe with an undefined
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
  // Tool calls decoded from the event tap (InternalLLMEvent 'tool-call'); flushed with byIndex at stream end.
  const eventCalls: PendingCall[] = [];
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
  const emitCallAt = (call: PendingCall, totalCalls: number): void => {
    if (call.name === '') return;
    // The EMITTED event keeps ONE shared turn-level `at` so the collector's per-(sessionKey, at)
    // token dedup collapses a multi-call turn into a single contribution. The TRACKER records this
    // call's own first-observation time as its issue time, so its later result measures a per-call span.
    const at = turnTimestamp();
    const issuedAt = call.firstSeenAt ?? at;
    // Stable, turn-unique id shared by the emitted event and the tracker (see stableCallId).
    const id = stableCallId(sessionKey, at, call.index, call.id, seenIds);
    callsEmitted += 1;
    emittedArgsChars += call.raw.length;
    const description = toolDescs.get(call.name);
    emitEvent({
      type: 'tool.call',
      sessionKey,
      toolName: call.name,
      ...(id !== '' ? { id } : {}),
      ...(call.args !== undefined ? { args: call.args } : {}),
      ...(typeof description === 'string' && description !== '' ? { description } : {}),
      at,
      // Attach the turn's upstream usage when the provider reported it AND the turn is a single call.
      ...(totalCalls === 1 && streamUsage !== undefined ? { tokens: streamUsage } : {}),
      // Per-call REQUEST-side token estimate (name + serialized arguments); distinct per tool.
      callTokens: estimateCallTokens(call.name, call.raw),
      ...(clientId !== undefined ? { clientId } : {}),
    });
    // Record the issued call with ITS OWN issue time so its later result can be paired per-call.
    if (tracker !== undefined && id !== '') {
      try {
        tracker.recordIssued(sessionKey, [{ id, at: issuedAt, name: call.name }]);
      } catch {
        // A throwing tracker must never break the stream pass-through.
      }
    }
  };

  /** Emit every accumulated call in index order — the SOLE emission point, at stream end. */
  const flushAllCalls = (): void => {
    const byteCalls: PendingCall[] = [...byIndex.entries()].map(([index, acc]) => ({
      index,
      name: acc.name,
      id: acc.id,
      raw: acc.args,
      args: parseArgs(acc.args),
      ...(acc.firstSeenAt !== undefined ? { firstSeenAt: acc.firstSeenAt } : {}),
    }));
    byIndex.clear();
    const calls = [...byteCalls, ...eventCalls.splice(0)].sort((a, b) => a.index - b.index);
    // Count the calls that will actually be emitted (non-empty tool names): a single-call turn
    // attaches the turn's tokens to its per-call event, while a batched turn omits them.
    const totalCalls = calls.reduce((n, call) => n + (call.name !== '' ? 1 : 0), 0);
    for (const call of calls) emitCallAt(call, totalCalls);
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
      // cacheHitInput is omitted unless the provider reported it; it is never estimated.
      const cacheHitInput = streamUsage?.cacheHitInput;
      const output = streamUsage?.output ?? estimateTokensFromChars(streamedTextChars + emittedArgsChars);
      if (input > 0 || output > 0) {
        // total is always the TRUE turn total (base input + cache-hit input + output).
        emitEvent({
          type: 'turn.usage',
          sessionKey,
          tokens: {
            input,
            output,
            total: input + (cacheHitInput ?? 0) + output,
            ...(cacheHitInput !== undefined ? { cacheHitInput } : {}),
          },
          ...(clientId !== undefined ? { clientId } : {}),
          at: turnTimestamp(),
        });
      }
    }
  };

  /** Fold one decoded InternalLLMEvent (event tap) into the telemetry state; calls are emitted at stream end. */
  const handleEvent = (event: InternalLLMEvent): void => {
    switch (event.type) {
      case 'text':
        streamedTextChars += event.text.length;
        break;
      case 'tool-call':
        eventCalls.push({
          index: event.index ?? eventCalls.length,
          name: event.name,
          id: event.id,
          // The exact wire argument string when the provider streamed it; else the serialized arguments.
          raw: event.rawArgs ?? JSON.stringify(event.args),
          args: event.args,
          firstSeenAt: clockNow(),
        });
        break;
      case 'usage':
        streamUsage = mergeUsage(streamUsage, {
          input: event.usage.input,
          output: event.usage.output,
          total: event.usage.total,
          cacheHitInput: event.usage.cacheHitInput,
        });
        break;
      default:
        break;
    }
  };

  /** Get-or-create the accumulator for `index` (single init site). */
  const accumulatorAt = (index: number): StreamToolCall => {
    let acc = byIndex.get(index);
    if (acc === undefined) {
      acc = { name: '', args: '', id: '' };
      byIndex.set(index, acc);
    }
    return acc;
  };

  /** Pin a call's issue time on its FIRST observation only (per-call duration attribution). */
  const pinFirstSeen = (acc: StreamToolCall): void => {
    if (acc.firstSeenAt === undefined) acc.firstSeenAt = clockNow();
  };

  /** Folds decoded frame fragments into the telemetry state; calls are emitted at stream end. */
  const frameSink: SseFrameSink = {
    text: (chars) => {
      streamedTextChars += chars;
    },
    usage: (usage) => {
      streamUsage = mergeUsage(streamUsage, usage);
    },
    toolCall: (fragment) => {
      const acc = accumulatorAt(fragment.index ?? byIndex.size);
      pinFirstSeen(acc);
      if (fragment.id !== undefined) acc.id = fragment.id;
      if (fragment.name !== undefined) acc.name = fragment.name;
      if (fragment.args !== undefined) acc.args += fragment.args;
    },
    toolArgs: (index, args) => {
      const acc = byIndex.get(index);
      if (acc === undefined) return;
      pinFirstSeen(acc);
      acc.args += args;
    },
  };

  /** Parse one SSE `data:` line and fold any frame it carries into the telemetry state. */
  const processLine = (line: string): void => {
    const parsed = parseSseDataLine(line);
    if (parsed !== undefined) decodeSseFrame(parsed, frameSink);
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
    // Object mode: accepts decoded InternalLLMEvents as well as raw SSE byte chunks.
    objectMode: true,
    transform(chunk: unknown, _encoding: string | undefined, callback: () => void): void {
      // Decoded events are telemetry-only (not forwarded); raw SSE bytes are forwarded unchanged.
      if (isInternalEvent(chunk)) {
        try {
          handleEvent(chunk);
        } catch {
          // Best-effort extraction must never break the pass-through.
        }
        callback();
        return;
      }
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