/**
 * Shared protocol-translation helpers used by BOTH the buffered tool-call emission
 * path (`proxy/context.ts`), the streamed tool-call extraction path
 * (`telemetry/stream-extract.ts`), and the centralized protocol translation
 * (`proxy/translate.ts`).
 *
 * Placed in the `telemetry/` layer (rather than `proxy/`) so that the proxy, which
 * already depends on telemetry (events / toolMetrics / tokenEstimate), reuses these
 * helpers WITHOUT introducing a new cross-impl dependency: the existing proxy→telemetry
 * direction is preserved, and no telemetry→proxy import is added. These helpers are
 * neutral, provider-agnostic building blocks shared across the tool-call emission and
 * protocol-translation code paths.
 */

/**
 * Normalized upstream token usage (provider-agnostic). `cacheHitInput` is the portion
 * of input tokens served from the provider cache (0 when there is none); `total` =
 * input + cacheHitInput + output.
 */
export type NormalizedUsage = { input?: number; output?: number; total?: number; cacheHitInput?: number };

/** True if `value` is a non-null, non-array object (a plain JSON-like record). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True for finite numeric values. */
function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Parse a JSON tool-call argument string into an object. Returns `undefined` when the
 * input is absent, empty, or not a JSON object (so callers can omit `args` rather than
 * fabricate an empty object).
 */
export function parseArgs(args: unknown): Record<string, unknown> | undefined {
  if (typeof args !== 'string' || args.trim() === '') return undefined;
  try {
    const parsed: unknown = JSON.parse(args);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Assign a stable, turn-unique id to one tool call. Prefers the upstream tool-call id
 * when present; otherwise synthesizes a deterministic `${sessionKey}#${at}#${index}` id.
 * A monotonic suffix (`~1`, `~2`, …) is appended whenever the computed id would still
 * collide with a sibling already seen in this same turn (e.g. two calls sharing one
 * upstream id), guaranteeing NO two sibling calls in a batch turn ever share an
 * identical id — the field the dashboard dedups on. Shared across the buffered
 * (`proxy/context.ts`) and streamed (`telemetry/stream-extract.ts`) emission paths so
 * both produce the same contract.
 */
export function stableCallId(
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

/** True when a normalized usage carries at least one numeric field. */
function hasAnyValue(usage: NormalizedUsage): boolean {
  return usage.input !== undefined || usage.output !== undefined || usage.total !== undefined || usage.cacheHitInput !== undefined;
}

/**
 * Normalize upstream token usage from a usage object (the `usage` field of a native or
 * cross-protocol translated response body, or a streamed usage frame) into the
 * provider-agnostic `{ input?, output?, total?, cacheHitInput? }` shape. The protocol is
 * detected from which usage fields are present — OpenAI `usage.{prompt_tokens,
 * completion_tokens, total_tokens}` vs Anthropic `usage.{input_tokens, output_tokens}`
 * (total = input+cacheHitInput+output when absent) — so the real upstream numbers are
 * read regardless of translation. The whole input is split into BASE input (`input`, not
 * served from cache) and cache-hit input (`cacheHitInput`): OpenAI `prompt_tokens`
 * INCLUDES `prompt_tokens_details.cached_tokens` (so base = prompt − cached, cache-hit =
 * cached), whereas Anthropic `input_tokens` EXCLUDES cache tokens (so base = input_tokens
 * + cache_creation, cache-hit = cache_read). Best-effort: returns `undefined` when no
 * recognized usage field is present, so callers omit tokens rather than fabricate.
 */
export function normalizeUsage(usage: unknown): NormalizedUsage | undefined {
  if (!isRecord(usage)) return undefined;
  // OpenAI shape: usage.{prompt_tokens, completion_tokens, total_tokens}. `prompt_tokens`
  // includes cached tokens (a subset), so split it into base input + cache-hit input.
  if (isNumber(usage.prompt_tokens) || isNumber(usage.completion_tokens) || isNumber(usage.total_tokens)) {
    const out: NormalizedUsage = {};
    const prompt = isNumber(usage.prompt_tokens) ? usage.prompt_tokens : undefined;
    const details = isRecord(usage.prompt_tokens_details) ? usage.prompt_tokens_details : undefined;
    const cached = details !== undefined && isNumber(details.cached_tokens) ? details.cached_tokens : 0;
    out.cacheHitInput = cached;
    if (prompt !== undefined) out.input = Math.max(0, prompt - cached);
    else if (cached > 0) out.input = 0;
    if (isNumber(usage.completion_tokens)) out.output = usage.completion_tokens;
    if (isNumber(usage.total_tokens)) out.total = usage.total_tokens;
    else if (out.input !== undefined || out.output !== undefined) {
      out.total = (out.input ?? 0) + out.cacheHitInput + (out.output ?? 0);
    }
    return hasAnyValue(out) ? out : undefined;
  }
  // Anthropic shape: usage.{input_tokens, output_tokens}. `input_tokens` excludes cache
  // tokens, so fold cache-creation into base input and carry cache-read as the cache hit.
  if (isNumber(usage.input_tokens) || isNumber(usage.output_tokens)) {
    const out: NormalizedUsage = {};
    const input = isNumber(usage.input_tokens) ? usage.input_tokens : undefined;
    const cacheRead = isNumber(usage.cache_read_input_tokens) ? usage.cache_read_input_tokens : 0;
    const cacheCreation = isNumber(usage.cache_creation_input_tokens) ? usage.cache_creation_input_tokens : 0;
    // base input and cacheHitInput are clamped >= 0 (mirrors the OpenAI clamp above) so a
    // corrupt negative cache field can never leak a negative input/cacheHitInput/total.
    out.cacheHitInput = Math.max(0, cacheRead);
    if (input !== undefined) out.input = Math.max(0, input + cacheCreation);
    if (isNumber(usage.output_tokens)) out.output = usage.output_tokens;
    if (out.input !== undefined || out.output !== undefined) {
      out.total = (out.input ?? 0) + out.cacheHitInput + (out.output ?? 0);
    }
    return hasAnyValue(out) ? out : undefined;
  }
  return undefined;
}
