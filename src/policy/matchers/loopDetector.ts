import type { PolicyContext, PolicyMatcher, ToolResult } from '../types';
import { normalizeParams } from '../normalize';

/** How to judge whether two values are "identical" for loop detection. */
type Identity = 'exact' | 'normalized';

/** Configuration for {@link createLoopDetector}. */
export interface LoopDetectorOptions {
  /** Number of consecutive identical (tool + params + result) calls to flag (default `4`). */
  window?: number;
  /**
   * When `true` (default), the flagged run must be the LAST `window` pairs in the
   * sequence (adjacent, at the tail) — the flagship "last N consecutive identical
   * calls." When `false`, a run of `window` identical pairs anywhere in the
   * sequence is enough.
   */
  requireConsecutive?: boolean;
  /** How to compare call arguments: `'exact'` (raw) or `'normalized'` (default). */
  paramIdentity?: Identity;
  /** How to compare tool results: `'exact'` (raw) or `'normalized'` (default). */
  resultIdentity?: Identity;
}

/** A single (toolCall → result) pair derived from the context. */
interface CallPair {
  /** Tool name. */
  name: string;
  /** Raw arguments (a parsed object, a JSON string, or `undefined`). */
  args: unknown;
  /** Result content, or `undefined` when no result is available. */
  result: unknown;
  /** Stable id of the tool call, when available (used for result pairing). */
  id?: string;
}

/** Result of a loop scan. */
interface Run {
  /** Index of the first pair in the matched run. */
  index: number;
  /** Number of consecutive identical pairs in the (maximal) run. */
  runLength: number;
  /** The shared signature of the run. */
  signature: string;
}

/**
 * Create a STATELESS {@link PolicyMatcher} that detects a loop of consecutive
 * identical tool calls.
 *
 * "Identical" is judged by the per-pair signature `(toolName, paramsKey,
 * resultKey)`. Under the `'normalized'` identity, key reordering and whitespace
 * differences in arguments/results do NOT count as a difference; under
 * `'exact'` the raw values must match exactly.
 *
 * The matcher is stateless: it derives the ordered sequence of (toolCall →
 * result) pairs directly from the context — the full message history the client
 * resends each turn (primary, flagship path), or the parsed `ToolCall[]` /
 * `ToolResult[]` (fallback). No cross-turn state is required.
 */
export function createLoopDetector(options?: LoopDetectorOptions): PolicyMatcher {
  const window = resolveWindow(options?.window);
  const requireConsecutive = options?.requireConsecutive ?? true;
  const paramIdentity: Identity = options?.paramIdentity ?? 'normalized';
  const resultIdentity: Identity = options?.resultIdentity ?? 'normalized';

  return {
    matches(ctx) {
      const pairs = extractPairs(ctx);
      if (pairs.length < window) return null;
      const keys = pairs.map((pair) => signature(pair, paramIdentity, resultIdentity));
      const run = findRun(keys, window, requireConsecutive);
      if (run === null) return null;
      const toolName = pairs[run.index].name;
      return {
        matched: true,
        reason: `detected ${window} consecutive identical ${toolName} calls`,
        details: {
          toolName,
          window,
          runLength: run.runLength,
          paramIdentity,
          resultIdentity,
          signature: run.signature,
        },
      };
    },
  };
}

/** Coerce a supplied window to a positive integer (default `4`). */
function resolveWindow(window?: number): number {
  if (typeof window === 'number' && Number.isFinite(window) && window >= 1) {
    return Math.floor(window);
  }
  return 4;
}

/**
 * Derive the ordered (toolCall → result) pairs from the context.
 *
 * Primary (flagship): when the context carries `messages`, pair each assistant
 * `tool_calls` entry with its subsequent `role: "tool"` result message(s) — by
 * `tool_call_id` where available, else by order. Fallback: build the same pairs
 * from the parsed `ToolCall[]` (ResponseContext) plus any `ToolResult[]`
 * available on the context (ResultContext / `toolResults`).
 */
function extractPairs(ctx: PolicyContext): CallPair[] {
  if ('messages' in ctx) {
    return pairsFromMessages(ctx.messages);
  }
  return pairsFromContext(ctx);
}

/**
 * Build the ordered (toolCall → result) pairs from a provider-agnostic message
 * list. Each assistant `tool_calls` entry is paired with its subsequent
 * `role: "tool"` result message(s) — by `tool_call_id` where available, else by
 * order (the earliest tool call that has not yet received a result).
 */
function pairsFromMessages(messages: unknown[]): CallPair[] {
  const pairs: CallPair[] = [];
  const byId = new Map<string, number>();
  for (const rawMessage of messages ?? []) {
    if (!isRecord(rawMessage)) continue;
    if (rawMessage.role === 'assistant') {
      const toolCalls = rawMessage.tool_calls;
      if (!Array.isArray(toolCalls)) continue;
      for (const rawCall of toolCalls) {
        if (!isRecord(rawCall)) continue;
        const fn = isRecord(rawCall.function) ? rawCall.function : {};
        const name =
          typeof fn.name === 'string'
            ? fn.name
            : typeof rawCall.name === 'string'
              ? rawCall.name
              : String(fn.name ?? rawCall.name ?? '');
        const id = typeof rawCall.id === 'string' ? rawCall.id : undefined;
        const args = fn.arguments !== undefined ? fn.arguments : rawCall.input;
        const index = pairs.length;
        pairs.push({ name, args, result: undefined, id });
        if (id !== undefined) byId.set(id, index);
      }
    } else if (rawMessage.role === 'tool') {
      const toolCallId = typeof rawMessage.tool_call_id === 'string' ? rawMessage.tool_call_id : undefined;
      let targetIndex: number | undefined = toolCallId !== undefined ? byId.get(toolCallId) : undefined;
      if (targetIndex === undefined) {
        // Pair by order: the earliest tool call that has not received a result yet.
        for (let i = 0; i < pairs.length; i++) {
          if (pairs[i].result === undefined) {
            targetIndex = i;
            break;
          }
        }
      }
      if (targetIndex !== undefined) {
        pairs[targetIndex].result = rawMessage.content;
      }
    }
  }
  return pairs;
}

/**
 * Build the ordered (toolCall → result) pairs from the parsed `ToolCall[]`
 * (ResponseContext) and any `ToolResult[]` available on the context.
 */
function pairsFromContext(ctx: PolicyContext): CallPair[] {
  const pairs: CallPair[] = [];
  if ('toolCalls' in ctx) {
    for (const call of ctx.toolCalls ?? []) {
      pairs.push({ name: call.name, args: call.arguments, result: undefined, id: call.id });
    }
  }
  const results = collectResults(ctx);
  if (results.length === 0) return pairs;
  if (pairs.length === 0) {
    // No tool calls, but results are present: build pairs directly from the results.
    for (const result of results) {
      pairs.push({ name: result.name, args: undefined, result: result.content, id: result.toolCallId });
    }
    return pairs;
  }
  // Pair each result with its tool call by id (best effort).
  for (const result of results) {
    const index = pairs.findIndex((pair) => pair.id === result.toolCallId);
    if (index !== -1) pairs[index].result = result.content;
  }
  return pairs;
}

/** Collect the tool results available on a context (ResultContext / `toolResults`). */
function collectResults(ctx: PolicyContext): ToolResult[] {
  if ('results' in ctx) {
    const results = ctx.results;
    if (Array.isArray(results)) return results;
  }
  // Defensive: a RuleContext-style `toolResults` (not part of the PolicyContext union).
  const maybeToolResults = (ctx as unknown as Record<string, unknown>).toolResults;
  if (Array.isArray(maybeToolResults)) return maybeToolResults as ToolResult[];
  return [];
}

/**
 * The per-pair "call signature": the tool name plus the parameter key and the
 * result key, joined by a unit separator so the three components are
 * unambiguous.
 */
function signature(pair: CallPair, paramIdentity: Identity, resultIdentity: Identity): string {
  const paramsKey = paramIdentity === 'exact' ? serializeValue(pair.args) : normalizeParams(toValue(pair.args));
  const resultKey = resultIdentity === 'exact' ? serializeValue(pair.result) : normalizeParams(toValue(pair.result));
  return `${pair.name}\u0000${paramsKey}\u0000${resultKey}`;
}

/**
 * Parse a JSON-encoded value (a string) into its value so that the
 * `'normalized'` identity is insensitive to key reordering / whitespace inside
 * an encoded object. Non-JSON strings and non-strings pass through unchanged.
 */
function toValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (trimmed.length === 0 || (trimmed[0] !== '{' && trimmed[0] !== '[')) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

/**
 * Raw string form of a value: the raw string if it is one, otherwise
 * `JSON.stringify` (falling back to `String`). `null` / `undefined` → `''`.
 */
function serializeValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Find a run of exactly `window` consecutive identical signatures.
 *
 * - `requireConsecutive === true`: the run must be the LAST `window` pairs (the
 *   flagship "last N consecutive identical calls").
 * - `requireConsecutive === false`: any run of `window` consecutive identical
 *   signatures qualifies (the first such run is returned).
 */
function findRun(keys: string[], window: number, requireConsecutive: boolean): Run | null {
  if (keys.length < window) return null;
  if (requireConsecutive) {
    const start = keys.length - window;
    const candidate = keys[start];
    for (let i = start + 1; i < keys.length; i++) {
      if (keys[i] !== candidate) return null;
    }
    // Maximal run ending at the last pair.
    let runLength = 1;
    for (let i = keys.length - 2; i >= start - 1 && keys[i] === candidate; i--) runLength++;
    return { index: start, runLength, signature: candidate };
  }
  for (let i = 0; i + window <= keys.length; i++) {
    const candidate = keys[i];
    let identical = true;
    for (let j = i + 1; j < i + window; j++) {
      if (keys[j] !== candidate) {
        identical = false;
        break;
      }
    }
    if (!identical) continue;
    // Maximal run starting at i.
    let runLength = 1;
    for (let j = i + 1; j < keys.length && keys[j] === candidate; j++) runLength++;
    return { index: i, runLength, signature: candidate };
  }
  return null;
}

/** Type guard: is the value a non-null, non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
