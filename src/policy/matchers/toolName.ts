import type { PolicyContext, PolicyMatcher } from '../types';

/**
 * Configuration for {@link createToolNameMatcher}.
 *
 * A tool call matches when its name equals `toolName` OR appears in
 * `toolNames`. If neither is configured, the matcher is a no-op (never
 * matches).
 */
export interface ToolNameMatcherConfig {
  /** A single tool name to match against. */
  toolName?: string;
  /** Additional tool names to match against (OR-ed with `toolName`). */
  toolNames?: string[];
}

/**
 * Create a {@link PolicyMatcher} that fires when ANY tool call in the context
 * has a name in the configured set. Returns a rich `Match` describing which
 * tool name(s) matched, or `null` when none match (or when no name is
 * configured).
 */
export function createToolNameMatcher(config: ToolNameMatcherConfig): PolicyMatcher {
  const names = configuredToolNames(config);
  // No tool names configured → a no-op matcher that never fires.
  if (names.size === 0) {
    return { matches: () => null };
  }
  return {
    matches(ctx) {
      const matchedNames = new Set<string>();
      for (const call of extractToolCalls(ctx)) {
        if (names.has(call.name)) matchedNames.add(call.name);
      }
      if (matchedNames.size === 0) return null;
      const list = [...matchedNames];
      return {
        matched: true,
        reason: `Tool call matched: ${list.join(', ')}`,
        details: { matchedToolNames: list },
      };
    },
  };
}

/** Collect the configured tool names into a `Set` (dropping empty entries). */
function configuredToolNames(config: ToolNameMatcherConfig): Set<string> {
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
