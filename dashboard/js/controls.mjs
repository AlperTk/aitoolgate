/* ==========================================================================
 * aitoolgate dashboard — global toolbar controls (time / clear / export).
 *
 * Wires the top-bar controls and serializes the currently-visible stream +
 * intervention rows to CSV / JSON downloads. Pure time-window logic is
 * delegated to the leaf ./time.mjs (shared with the live view); DOM access and
 * formatting helpers come from ./dom.mjs; re-rendering after a filter change
 * goes through ./live-view.mjs's applyFilters(). All shared runtime state is
 * accessed via the single `state` object from ./state.mjs. Zero dependencies
 * beyond sibling modules (no import cycle: this module -> dom/state/constants/
 * live-view/time; time is a leaf).
 * ========================================================================== */
import { $, fmtTime } from './dom.mjs';
import { state } from './state.mjs';
import { TIME_PRESETS } from './constants.mjs';
import { applyFilters, updateLiveCounters } from './live-view.mjs';
import { parseLocalDatetime, stamp } from './time.mjs';

/* ---- CSV / serialization helpers ------------------------------------ */
// Escape a single CSV field (wrap in quotes and double any embedded quotes).
export function csvCell(v) {
  v = (v == null) ? '' : String(v);
  if (/[",\r\n]/.test(v)) v = '"' + v.replace(/"/g, '""') + '"';
  return v;
}
// Trigger a native browser download of text content via Blob + object URL (no deps).
export function downloadFile(filename, text, mime) {
  var blob = new Blob([text], { type: mime });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
}
// Build one export record for a logical tool-call row (call + optional result).
export function callRecordFromRs(rs) {
  var call = rs.callEv, res = rs.resultEv, primary = call || res;
  // Tokens live on the upstream tool.call event (present only when usage is reported);
  // fall back to the paired result if it carries them. Size is the always-available
  // result payload size (chars). Absent fields stay undefined so the CSV leaves a gap.
  var tokens = (call && call.tokens && typeof call.tokens === 'object' ? call.tokens : null) ||
    (res && res.tokens && typeof res.tokens === 'object' ? res.tokens : null);
  return {
    type: call ? 'call' : 'result',
    at: primary && typeof primary.at === 'number' ? primary.at : undefined,
    toolName: (call && call.toolName) || (res && res.toolName) || '',
    sessionKey: (call && call.sessionKey) || (res && res.sessionKey) || '',
    status: rs.status,
    durationMs: res && typeof res.durationMs === 'number' ? res.durationMs : undefined,
    tokensInput: tokens && typeof tokens.input === 'number' ? tokens.input : undefined,
    tokensOutput: tokens && typeof tokens.output === 'number' ? tokens.output : undefined,
    tokensTotal: tokens && typeof tokens.total === 'number' ? tokens.total : undefined,
    sizeChars: res && typeof res.chars === 'number' ? res.chars : undefined
  };
}
// Build one export record from an intervention row's raw data.
export function interventionRecord(d) {
  return {
    type: 'policy.intervention',
    at: typeof d.at === 'number' ? d.at : undefined,
    ruleId: d.ruleId || '',
    action: d.action || '',
    detail: d.detail || '',
    sessionKey: d.sessionKey || ''
  };
}
// Records for every currently-visible (post-filter) stream-list row.
export function getVisibleCalls() {
  var out = [];
  var list = $('stream-list');
  for (var i = 0; i < list.children.length; i++) {
    var li = list.children[i];
    if (!li.classList.contains('stream-row')) continue;
    if (li.style.display === 'none') continue; // only rows passing the active filters
    var rec = null;
    if (li.classList.contains('orphan-row')) {
      for (var k = 0; k < state.orphanResultEntries.length; k++) {
        if (state.orphanResultEntries[k].li === li) { rec = callRecordFromRs(state.orphanResultEntries[k].rs); break; }
      }
    } else if (li.dataset.callId) {
      var rs = state.callRows.get(li.dataset.callId);
      if (rs) rec = callRecordFromRs(rs);
    }
    if (rec) out.push(rec);
  }
  return out;
}
// Records for every currently-visible (post-filter) intervention-list row.
export function getVisibleInterventions() {
  var out = [];
  var list = $('intervention-list');
  for (var i = 0; i < list.children.length; i++) {
    var li = list.children[i];
    if (!li.classList.contains('stream-row')) continue;
    if (li.style.display === 'none') continue; // only rows passing the active filters
    var d = state.interventionRowData.get(li);
    if (d) out.push(interventionRecord(d));
  }
  return out;
}
// Serialize visible call records to RFC-4180 CSV text.
export function buildCallsCsv(rows) {
  var lines = ['type,at,time,toolName,sessionKey,status,durationMs,tokensInput,tokensOutput,tokensTotal,sizeChars'];
  rows.forEach(function (r) {
    lines.push([
      csvCell(r.type),
      csvCell(r.at == null ? '' : String(Math.round(r.at))),
      csvCell(fmtTime(r.at)),
      csvCell(r.toolName || ''),
      csvCell(r.sessionKey || ''),
      csvCell(r.status),
      csvCell(r.durationMs == null ? '' : Math.round(r.durationMs)),
      csvCell(r.tokensInput == null ? '' : Math.round(r.tokensInput)),
      csvCell(r.tokensOutput == null ? '' : Math.round(r.tokensOutput)),
      csvCell(r.tokensTotal == null ? '' : Math.round(r.tokensTotal)),
      csvCell(r.sizeChars == null ? '' : Math.round(r.sizeChars))
    ].join(','));
  });
  return lines.join('\r\n');
}
// Serialize visible intervention records to RFC-4180 CSV text.
export function buildInterventionsCsv(rows) {
  var lines = ['type,at,time,ruleId,action,detail,sessionKey'];
  rows.forEach(function (r) {
    lines.push([
      csvCell(r.type),
      csvCell(r.at == null ? '' : String(Math.round(r.at))),
      csvCell(fmtTime(r.at)),
      csvCell(r.ruleId || ''),
      csvCell(r.action || ''),
      csvCell(r.detail || ''),
      csvCell(r.sessionKey || '')
    ].join(','));
  });
  return lines.join('\r\n');
}
// Download `records` as pretty-printed JSON under a timestamped filename.
export function exportJson(records, name) {
  downloadFile('aitoolgate-' + name + '-' + stamp() + '.json', JSON.stringify(records, null, 2), 'application/json');
}
// Download pre-built CSV text under a timestamped filename.
export function exportCsv(text, name) {
  downloadFile('aitoolgate-' + name + '-' + stamp() + '.csv', text, 'text/csv;charset=utf-8');
}

/* ---- time range ---------------------------------------------------- */
// Apply the custom from/to inputs to the active time window.
export function applyCustomTimeRange() {
  state.timeRange = { mode: 'custom' };
  var f = parseLocalDatetime($('filter-time-from').value);
  var t = parseLocalDatetime($('filter-time-to').value);
  if (f != null) state.timeRange.startMs = f;
  if (t != null) state.timeRange.endMs = t;
  applyFilters();
}
// Handle the time-range preset selector: all / relative presets / custom. A
// relative preset captures "now" at selection time and applies a fixed window.
export function onTimeRangeChange() {
  var v = $('filter-time').value;
  var showCustom = (v === 'custom');
  $('filter-time-from').hidden = !showCustom;
  $('filter-time-to').hidden = !showCustom;
  if (showCustom) { applyCustomTimeRange(); return; }
  if (v === 'all') { state.timeRange = { mode: 'all' }; }
  else {
    var mins = TIME_PRESETS[v];
    var now = Date.now();
    state.timeRange = { mode: 'preset', startMs: now - mins * 60000, endMs: now };
  }
  applyFilters();
}

/* ---- clear on-screen history ---------------------------------------- */
// Clear the client-side buffered events and visible lists only. The dedup set is
// intentionally KEPT so already-seen events are not re-rendered by polling; new
// events still stream in. Server aggregates (stats panel) are NOT touched.
export function clearOnScreenHistory() {
  state.callRows.clear();
  state.orphanResultEntries.length = 0;
  state.interventionsBySession.clear();
  state.interventionRowData.clear();
  state.localCounts.calls = 0; state.localCounts.results = 0; state.localCounts.interventions = 0;
  var sl = $('stream-list'); if (sl) sl.textContent = '';
  var il = $('intervention-list'); if (il) il.textContent = '';
  var se = $('stream-empty'); if (se) se.hidden = false;
  var ie = $('intervention-empty'); if (ie) ie.hidden = false;
  updateLiveCounters();
  applyFilters();
}

/* ---- wiring --------------------------------------------------------- */
// Wire the global controls (time range, clear on-screen history, export).
export function bindControlEvents() {
  var ft = $('filter-time');
  if (ft) ft.addEventListener('change', onTimeRangeChange);
  var tf = $('filter-time-from');
  if (tf) tf.addEventListener('change', applyCustomTimeRange);
  var tt = $('filter-time-to');
  if (tt) tt.addEventListener('change', applyCustomTimeRange);
  var bc = $('btn-clear-history');
  if (bc) bc.addEventListener('click', clearOnScreenHistory);
  var cej = $('btn-export-calls-json');
  if (cej) cej.addEventListener('click', function () { exportJson(getVisibleCalls(), 'calls'); });
  var cec = $('btn-export-calls-csv');
  if (cec) cec.addEventListener('click', function () { exportCsv(buildCallsCsv(getVisibleCalls()), 'calls'); });
  var iij = $('btn-export-interventions-json');
  if (iij) iij.addEventListener('click', function () { exportJson(getVisibleInterventions(), 'interventions'); });
  var iic = $('btn-export-interventions-csv');
  if (iic) iic.addEventListener('click', function () { exportCsv(buildInterventionsCsv(getVisibleInterventions()), 'interventions'); });
}
