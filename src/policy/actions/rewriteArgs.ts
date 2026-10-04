import type { Action, PolicyContext } from '../types';
import type { ActionEffect } from './block';

/** Configuration for {@link createRewriteArgsAction}. */
export interface RewriteArgsActionConfig {
  /** Target tool call by name (used when `toolCallId` is absent / unmatched). */
  toolName?: string;
  /** Target tool call by id (takes precedence over `toolName`). */
  toolCallId?: string;
  /** Argument changes to apply: a full replacement or a partial merge. */
  arguments: Record<string, unknown>;
  /** How to apply `arguments`: `replace` (default) or `merge` into existing args. */
  mode?: 'replace' | 'merge';
}

/** A tool call resolved for inspection / rewriting. */
interface ResolvedCall {
  /** Tool call id. */
  id: string;
  /** Tool name. */
  name: string;
  /** Parsed arguments of the call. */
  arguments: Record<string, unknown>;
}

/**
 * Create an {@link Action} that rewrites a tool call's arguments before it
 * reaches the executor when a rule fires.
 *
 * The returned action implements the port {@link Action}: its `apply` resolves
 * the target tool call (by `toolCallId`, else by `toolName`) and returns an
 * {@link ActionEffect} of type `'rewriteArgs'`. With `mode: 'merge'` the
 * configured arguments are merged into the target's existing parsed args; with
 * `'replace'` (the default) they replace them. Returns `null` when no target
 * resolves.
 */
export function createRewriteArgsAction(config: RewriteArgsActionConfig): Action {
  return {
    name: 'rewriteArgs',
    apply(ctx: PolicyContext): ActionEffect | null {
      const target = resolveTarget(extractCalls(ctx), config);
      if (!target) return null;
      const effect: Extract<ActionEffect, { type: 'rewriteArgs' }> = {
        type: 'rewriteArgs',
        toolCallId: target.id,
        newArguments: computeArguments(target, config),
      };
      return effect;
    },
  };
}

/** Resolve the target call: prefer `toolCallId`, else first name match. */
function resolveTarget(
  calls: ResolvedCall[],
  config: RewriteArgsActionConfig,
): ResolvedCall | undefined {
  if (config.toolCallId) {
    const byId = calls.find((call) => call.id === config.toolCallId);
    if (byId) return byId;
  }
  if (config.toolName) {
    return calls.find((call) => call.name === config.toolName);
  }
  return undefined;
}

/** Compute the new arguments according to the configured `mode`. */
function computeArguments(
  target: ResolvedCall,
  config: RewriteArgsActionConfig,
): Record<string, unknown> {
  const mode = config.mode ?? 'replace';
  return mode === 'merge' ? { ...target.arguments, ...config.arguments } : config.arguments;
}

/**
 * Extract tool calls from a policy context, keeping each call's id, name, and
 * parsed arguments. Prefers the parsed `ToolCall[]` (`ResponseContext.toolCalls`);
 * when that yields nothing, falls back to parsing OpenAI-shape `tool_calls`
 * out of assistant messages (`RequestContext.messages`). Mirrors the extraction
 * in `../matchers/toolName.ts`.
 */
function extractCalls(ctx: PolicyContext): ResolvedCall[] {
  const calls: ResolvedCall[] = [];
  if ('toolCalls' in ctx) {
    for (const call of ctx.toolCalls ?? []) {
      calls.push({
        id: call.id,
        name: call.name,
        arguments: parseArgs(call.arguments),
      });
    }
  }
  if (calls.length === 0 && 'messages' in ctx) {
    for (const message of ctx.messages ?? []) {
      if (!isRecord(message) || message.role !== 'assistant') continue;
      const toolCalls = message.tool_calls;
      if (!Array.isArray(toolCalls)) continue;
      for (const raw of toolCalls) {
        if (!isRecord(raw)) continue;
        const fn = isRecord(raw.function) ? raw.function : undefined;
        calls.push({
          id: typeof raw.id === 'string' ? raw.id : '',
          name: fn && typeof fn.name === 'string' ? fn.name : String(fn?.name ?? ''),
          arguments: parseArgs(fn?.arguments),
        });
      }
    }
  }
  return calls;
}

/** Parse tool-call arguments into an object; tolerant of JSON strings. */
function parseArgs(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      return isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return isRecord(value) ? value : {};
}

/** Type guard: a non-null, non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
