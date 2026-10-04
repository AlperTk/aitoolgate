/* ==========================================================================
 * mcp-manager dashboard — shared time-window helpers (leaf module).
 *
 * Pure, framework-free time logic shared by the live view (client-side row
 * filtering) and the global controls (time-range presets + export file names).
 * This is a leaf: it imports only from ./state.mjs and never from feature
 * modules such as live-view or controls, so both can import it without an
 * import cycle. The active window is read from the shared `state.timeRange`
 * object (mode 'all' | 'preset' | 'custom', plus optional startMs/endMs epoch ms).
 * ========================================================================== */
import { state } from './state.mjs';

// True when an event timestamp (epoch ms) falls inside the active time window
// (state.timeRange). 'all' keeps every row; a row with an unknown timestamp is
// excluded from any specific window (it cannot be proven to fall within it).
export function inTimeRange(at) {
  if (state.timeRange.mode === 'all') return true;
  var t = (typeof at === 'number' && isFinite(at)) ? at : Number(at);
  if (!isFinite(t)) return false;
  if (state.timeRange.startMs != null && t < state.timeRange.startMs) return false;
  if (state.timeRange.endMs != null && t > state.timeRange.endMs) return false;
  return true;
}
// Parse a <input type="datetime-local"> value (local time) into epoch-ms or null.
export function parseLocalDatetime(v) {
  if (!v) return null;
  var d = new Date(v);
  return isNaN(d.getTime()) ? null : d.getTime();
}
// Compact local stamp for export file names, e.g. 20261004-143005.
export function stamp() {
  var d = new Date();
  function p(n) { return (n < 10 ? '0' : '') + n; }
  return '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) +
    '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}
