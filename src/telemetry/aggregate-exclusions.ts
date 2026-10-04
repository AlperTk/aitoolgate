/**
 * Tool names whose telemetry events are excluded from AGGREGATE statistics
 * while still appearing in the raw event stream (slice 6c of telemetry).
 *
 * A single `task` tool-call spawns an entire nested sub-session whose whole
 * wall-time and token mass are written back into that one parent `task` result;
 * counting it in "typical tool call" aggregates therefore skews every total,
 * average, and per-tool ranking. Excluding such wrapper tools keeps those
 * aggregates representative of normal tool calls. The filter is applied ONLY at
 * the aggregation layer — each individual `task` tool.call / tool.result stays
 * fully visible in the live per-row stream and drill-down. The sub-agent's OWN
 * inner tool calls (real names, own session) are never affected: only the
 * `task` wrapper entry is dropped from aggregates.
 *
 * Matching is case-insensitive on the tool name.
 */

/** Default set of tool names excluded from aggregate statistics. */
export const DEFAULT_AGGREGATE_EXCLUDED_TOOLS: readonly string[] = ['task'];

/**
 * Returns `true` when `toolName` (matched case-insensitively against
 * `excludedTools`) should be skipped by the aggregate accumulators. Defaults to
 * {@link DEFAULT_AGGREGATE_EXCLUDED_TOOLS}.
 */
export function isAggregateExcluded(
  toolName: string,
  excludedTools: readonly string[] = DEFAULT_AGGREGATE_EXCLUDED_TOOLS,
): boolean {
  if (excludedTools.length === 0) return false;
  const needle = toolName.toLowerCase();
  return excludedTools.some((name) => name.toLowerCase() === needle);
}
