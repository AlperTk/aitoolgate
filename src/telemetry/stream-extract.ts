/**
 * Streaming tool-call telemetry extractor (dependency-free).
 *
 * {@link createSseToolCallExtractor} returns a passthrough {@link Transform} that
 * can be inserted into an SSE pipe chain WITHOUT altering the bytes forwarded to the
 * client. It accumulates OpenAI-compatible streaming fragments
 * (`choices[].delta.tool_calls[]`, each carrying an `index` and optional `id` /
 * `function: { name?, arguments? }`) and emits telemetry onto an optional event bus:
 *
 * - A `tool.call` event whenever a NEW tool-call `index` starts (finalising the
 *   previously-accumulated call) — i.e. "when a new tool call starts".
 * - Any remaining accumulated calls when the stream ends (`flush`), i.e. "when the
 *   stream ends" (also covers a `data: [DONE]` terminator and client-disconnect/error
 *   teardown). Each call carrying a stable id is ALSO recorded into an optional shared
 *   latency tracker so its LATER result (fed back by the client) pairs into a REAL
 *   `tool.result`; no synthetic per-stream `tool.result` is emitted.
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
    const at = Date.now();
    emitEvent({
      type: 'tool.call',
      sessionKey,
      toolName: acc.name,
      ...(acc.id !== '' ? { id: acc.id } : {}),
      ...(args !== undefined ? { args } : {}),
      at,
      ...(clientId !== undefined ? { clientId } : {}),
    });
    // Record the issued call (sharing the same timestamp) so its later result can be paired.
    if (tracker !== undefined && acc.id !== '') {
      try {
        tracker.recordIssued(sessionKey, [{ id: acc.id, at }]);
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
    const choices = parsed.choices;
    if (!Array.isArray(choices)) return;
    for (const choice of choices) {
      if (!isRecord(choice)) continue;
      const delta = choice.delta;
      if (!isRecord(delta)) continue;
      const toolCalls = delta.tool_calls;
      if (Array.isArray(toolCalls)) for (const tc of toolCalls) accumulate(tc);
    }
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

/** Type guard: is the value a non-null, non-array object? */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
