/* ==========================================================================
 * aitoolgate dashboard — dual-source event ingest.
 *
 * A single deduped render path for BOTH the WebSocket primary source and the
 * /api/events polling fallback. Each inbound telemetry event is turned into a
 * stable identity key; the bounded state.seenEventKeys set guarantees each
 * event renders at most once even when it arrives via both sources (or is
 * replayed), keeping the per-type "this session" counters from double-counting.
 * The set is capped at MAX_SEEN_EVENTS most-recent keys so it never grows
 * unbounded. Row rendering itself is delegated to ./live-view.mjs.
 * ========================================================================== */
import { isPlainObject } from './dom.mjs';
import { state } from './state.mjs';
import { MAX_SEEN_EVENTS } from './constants.mjs';
import {
  applyFilters,
  addInterventionRow,
  createCallRow,
  matchAndRenderResult,
  storeInterventionForDrillDown,
  updateLiveCounters
} from './live-view.mjs';

// Build a stable identity key for an event so a row renders at most once.
// The unique event id is included so distinct batched same-name calls (identical
// type/session/at/toolName) never share a key and collapse into one row. Non-call
// events carry no id, so an empty trailing segment preserves the prior behavior.
export function eventKey(ev) {
  var base = ev.type + '|' + (ev.sessionKey || '') + '|' + ev.at + '|' + (ev.toolName || '') + '|' + (ev.id || '');
  // For tool.result events also fold in ev.toolCallId as an extra discriminant: sibling
  // same-name same-turn results share type/sessionKey/at/toolName and may even lack an id
  // (older emitters), so without this they collapse onto ONE key and only the first row
  // resolves. Deterministic + bounded; a legitimate duplicate replay (same toolCallId) still
  // dedupes, and non-result events keep their exact prior key shape (byte-identical).
  if (ev.type === 'tool.result') base += '|' + (ev.toolCallId || '');
  return base;
}

// Render one telemetry event only if its key has not been seen, then record it.
// Accepts an object or a JSON string (the WS onmessage case). Non-telemetry
// frames (e.g. the server's { echo }) are ignored without side effects. This is
// the single dedup gate shared by the WS onmessage handler AND the poll.
export function ingestEvent(raw) {
  var ev = raw;
  if (typeof raw === 'string') { try { ev = JSON.parse(raw); } catch (_e) { return; } }
  if (!isPlainObject(ev)) return;
  var key = eventKey(ev);
  if (state.seenEventKeys.has(key)) return; // already rendered (cross-source or replay)
  state.seenEventKeys.add(key);
  while (state.seenEventKeys.size > MAX_SEEN_EVENTS) { // bound the set (drop oldest)
    state.seenEventKeys.delete(state.seenEventKeys.keys().next().value);
  }
  switch (ev.type) {
    case 'tool.call':
      state.localCounts.calls += 1; createCallRow(ev); updateLiveCounters(); break;
    case 'tool.result':
      state.localCounts.results += 1; matchAndRenderResult(ev); updateLiveCounters(); break;
    case 'policy.intervention':
      state.localCounts.interventions += 1; addInterventionRow(ev); storeInterventionForDrillDown(ev); updateLiveCounters(); applyFilters(); break;
    default:
      break; // echo / unknown frame — nothing to render
  }
}

// Dispatch one inbound WebSocket frame: ANY frame (including the { echo } the
// server returns for each keepalive we send) counts as liveness activity, then
// the single deduped ingest path decides whether a row should be rendered.
export function handleWsMessage(raw) {
  state.wsLastInboundAt = Date.now();
  ingestEvent(raw);
}
