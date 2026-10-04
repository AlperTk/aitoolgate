import type { PolicyContext, PolicyMatcher } from '../types';

/**
 * Configuration for {@link createArgPatternMatcher}.
 *
 * A tool call matches when its serialized arguments match `pattern`. Optionally
 * restrict to the named tool(s) via `toolName` / `toolNames`; when no name is
 * given, it applies to all tool calls.
 */
export interface ArgPatternMatcherConfig {
  /** Restrict matching to this tool name (omit to apply to all tool calls). */
  toolName?: string;
  /** Restrict matching to these tool names (OR-ed with `toolName`; omit for all). */
  toolNames?: string[];
  /** Case-sensitive pattern tested against the serialized arguments. */
  pattern: string | RegExp;
}

/**
 * Create a {@link PolicyMatcher} that fires when a tool call's serialized
 * arguments match `pattern`. A string `pattern` is treated as a case-sensitive
 * regular expression. Optionally restricted to the named tool(s) via
 * `toolName` / `toolNames`.
 *
 * Example intent: `{ toolName: 'bash', pattern: 'curl' }` matches a `bash`
 * call whose arguments contain `curl`.
 */
export function createArgPatternMatcher(config: ArgPatternMatcherConfig): PolicyMatcher {
  const regex = typeof config.pattern === 'string' ? new RegExp(config.pattern) : config.pattern;
  const patternLabel = typeof config.pattern === 'string' ? `"${config.pattern}"` : config.pattern.source;
  const names = configuredToolNames(config);
  const restrictToNames = names.size > 0;
  return {
    matches(ctx) {
      for (const call of extractToolCalls(ctx)) {
        if (restrictToNames && !names.has(call.name)) continue;
        const match = testAtZero(regex, call.serializedArgs);
        if (!match) continue;
        const excerpt = excerptAround(call.serializedArgs, match);
        return {
          matched: true,
          reason: `Argument pattern ${patternLabel} matched on tool '${call.name}': ${excerpt}`,
          details: {
            toolName: call.name,
            pattern: patternLabel,
            matchedArguments: call.serializedArgs,
            excerpt,
          },
        };
      }
      return null;
    },
  };
}

/** Collect the configured tool names into a `Set` (dropping empty entries). */
function configuredToolNames(config: ArgPatternMatcherConfig): Set<string> {
  const names = new Set<string>();
  if (typeof config.toolName === 'string' && config.toolName !== '') names.add(config.toolName);
  for (const name of config.toolNames ?? []) {
    if (typeof name === 'string' && name !== '') names.add(name);
  }
  return names;
}

/** A tool call normalized for matcher inspection. */
interface ExtractedCall {
  /** Tool name. */
  name: string;
  /** The tool call's arguments, serialized to a string. */
  serializedArgs: string;
}

/**
 * Serialize a tool call's arguments to a string for pattern matching: the raw
 * JSON string if it is already a string, otherwise `JSON.stringify` (falling
 * back to `String` for non-serializable values). `null` / `undefined` → `''`.
 */
function serializeArguments(args: unknown): string {
  if (typeof args === 'string') return args;
  if (args === null || args === undefined) return '';
  try {
    return JSON.stringify(args);
  } catch {
    return String(args);
  }
}

/**
 * Extract tool calls from a policy context.
 *
 * Prefers the parsed `ToolCall[]` (`ResponseContext.toolCalls`); when that
 * yields nothing, falls back to parsing OpenAI-shape `tool_calls`
 * (`function.name` + `function.arguments`, a JSON string) out of assistant
 * messages (`RequestContext.messages`). Tolerates `arguments` being either a
 * JSON string or an already-parsed object.
 */
function extractToolCalls(ctx: PolicyContext): ExtractedCall[] {
  const calls: ExtractedCall[] = [];
  if ('toolCalls' in ctx) {
    for (const call of ctx.toolCalls ?? []) {
      calls.push({ name: call.name, serializedArgs: serializeArguments(call.arguments) });
    }
  }
  if (calls.length === 0 && 'messages' in ctx) {
    for (const message of ctx.messages ?? []) {
      if (!isRecord(message) || message.role !== 'assistant') continue;
      const toolCalls = message.tool_calls;
      if (!Array.isArray(toolCalls)) continue;
      for (const raw of toolCalls) {
        const fn = isRecord(raw) ? raw.function : undefined;
        if (!isRecord(fn)) continue;
        calls.push({
          name: typeof fn.name === 'string' ? fn.name : String(fn.name ?? ''),
          serializedArgs: serializeArguments(fn.arguments),
        });
      }
    }
  }
  return calls;
}

/** Type guard: is the value a non-null, non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Run the regex on `text` with `lastIndex` reset first, so global (`g`) and
 * sticky (`y`) flags behave statelessly across successive matches.
 */
function testAtZero(regex: RegExp, text: string): RegExpExecArray | null {
  regex.lastIndex = 0;
  return regex.exec(text);
}

/** A short excerpt of `text` centered on the given regex match. */
function excerptAround(text: string, match: RegExpExecArray, radius = 16): string {
  const start = Math.max(0, match.index - radius);
  const end = Math.min(text.length, match.index + match[0].length + radius);
  let excerpt = text.slice(start, end);
  if (start > 0) excerpt = `…${excerpt}`;
  if (end < text.length) excerpt = `${excerpt}…`;
  return excerpt;
}
