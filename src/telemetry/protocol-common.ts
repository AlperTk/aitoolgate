/** Provider-agnostic protocol-translation helpers shared by the buffered, streamed, and centralized tool-call emission paths. */

/** Normalized upstream token usage (provider-agnostic); `total` = input + cacheHitInput + output. */
export type NormalizedUsage = { input?: number; output?: number; total?: number; cacheHitInput?: number };

/** True if `value` is a non-null, non-array object (a plain JSON-like record). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True for finite numeric values. */
function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Parse a JSON tool-call argument string into an object; `undefined` when absent, empty, or non-object. */
export function parseArgs(args: unknown): Record<string, unknown> | undefined {
  if (typeof args !== 'string' || args.trim() === '') return undefined;
  try {
    const parsed: unknown = JSON.parse(args);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** Build a tool-name → description map from a request's `tools` array, handling both OpenAI and Anthropic wire shapes (best-effort). */
export function toolDescriptionMap(raw: unknown): Map<string, string> {
  const map = new Map<string, string>();
  if (!isRecord(raw)) return map;
  const tools = raw.tools;
  if (!Array.isArray(tools)) return map;
  for (const tool of tools) {
    if (!isRecord(tool)) continue;
    const fn = isRecord(tool.function) ? tool.function : undefined;
    const name =
      typeof tool.name === 'string' && tool.name !== ''
        ? tool.name
        : fn !== undefined && typeof fn.name === 'string' && fn.name !== ''
          ? fn.name
          : undefined;
    const description =
      typeof tool.description === 'string' && tool.description !== ''
        ? tool.description
        : fn !== undefined && typeof fn.description === 'string' && fn.description !== ''
          ? fn.description
          : undefined;
    if (name !== undefined && description !== undefined) map.set(name, description);
  }
  return map;
}

/** Assign a stable, turn-unique id to one tool call (preferring the upstream id; deterministic `${sessionKey}#${at}#${index}` fallback, suffixed on collision). */
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

/** Extract the best-effort string content from a tool-result payload (a string, or a record's first non-empty string value). */
function extractResultText(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (isRecord(content)) {
    for (const value of Object.values(content)) {
      if (typeof value === 'string' && value.trim() !== '') return value;
    }
  }
  return undefined;
}

/** Conservative leading-marker heuristic: true only when trimmed tool-result content STARTS with an error marker. */
export function isErrorResultContent(content: unknown): boolean {
  const text = extractResultText(content);
  if (text === undefined) return false;
  const lower = text.trim().toLowerCase();
  if (lower === '') return false;
  return (
    /^error\s*[:\-—–!?]/.test(lower) ||
    /^error\s+(?:executing|occurred|happened|failed|while|when|during|in)\b/.test(lower) ||
    /^tool execution failed\b/.test(lower) ||
    /^internal server error\b/.test(lower)
  );
}

/** Memoized, non-throwing compilation of tool-error patterns into case-insensitive regexes; a malformed entry is skipped with a one-time warning. */
const compiledErrorPatternsCache = new Map<string, RegExp[]>();
function compiledErrorPatterns(patterns: string[]): RegExp[] {
  const key = patterns.join('\u0000');
  const cached = compiledErrorPatternsCache.get(key);
  if (cached !== undefined) return cached;
  const compiled: RegExp[] = [];
  for (const pattern of patterns) {
    try {
      compiled.push(new RegExp(pattern, 'i'));
    } catch (err) {
      console.warn(
        `aitoolgate: skipping invalid TOOL_ERROR_PATTERNS entry ${JSON.stringify(pattern)}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  compiledErrorPatternsCache.set(key, compiled);
  return compiled;
}

/** True when tool-result content matches any user-supplied tool-error pattern (case-insensitive; never throws). */
export function isErrorResultContentByPatterns(content: unknown, patterns: string[]): boolean {
  if (patterns.length === 0) return false;
  const text = extractResultText(content);
  if (text === undefined) return false;
  for (const regex of compiledErrorPatterns(patterns)) {
    if (regex.test(text)) return true;
  }
  return false;
}

/** True when a normalized usage carries at least one numeric field. */
function hasAnyValue(usage: NormalizedUsage): boolean {
  return usage.input !== undefined || usage.output !== undefined || usage.total !== undefined || usage.cacheHitInput !== undefined;
}

/** Normalize upstream token usage into the provider-agnostic `{ input?, output?, total?, cacheHitInput? }` shape; `undefined` when no recognized usage field is present. */
export function normalizeUsage(usage: unknown): NormalizedUsage | undefined {
  if (!isRecord(usage)) return undefined;
  // OpenAI shape: prompt_tokens includes cached tokens, so split into base input + cache-hit input.
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
  // Anthropic shape: input_tokens excludes cache tokens, so fold cache-creation into base input and carry cache-read as the cache hit.
  if (isNumber(usage.input_tokens) || isNumber(usage.output_tokens)) {
    const out: NormalizedUsage = {};
    const input = isNumber(usage.input_tokens) ? usage.input_tokens : undefined;
    const cacheRead = isNumber(usage.cache_read_input_tokens) ? usage.cache_read_input_tokens : 0;
    const cacheCreation = isNumber(usage.cache_creation_input_tokens) ? usage.cache_creation_input_tokens : 0;
    // base input and cacheHitInput are clamped >= 0 so a negative cache field can never leak a negative total.
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
