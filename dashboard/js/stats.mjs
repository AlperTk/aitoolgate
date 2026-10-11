/* ==========================================================================
 * mcp-manager dashboard — stats / top tools panel.
 *
 * Renders the aggregate stat tiles and the ranked top-tools table from a
 * GET /api/stats response. Fetched on load and every STATS_POLL_MS so the
 * numbers stay current even if the WebSocket drops. The table itself is the
 * generic, dependency-free widget built by ./table.mjs (createDataTable).
 * ========================================================================== */
import { $, fmtOpt, setStatValue, showNotice, clearNotice, errMsg } from './dom.mjs';
import { NO_DATA_TIP } from './constants.mjs';
import { createDataTable } from './table.mjs';

// Render one duration/token number cell, attaching the "no data yet" tooltip
// only when the value is still absent (early in the run).
export function statNumCell(v) {
  var t = fmtOpt(v);
  return '<td class="num-col"' + (t === '\u2014' ? ' title="' + NO_DATA_TIP + '"' : '') + '>' + t + '</td>';
}

/* ---- Top tools table (module-local; built once via createDataTable) ---- */
var topToolsTable = null; // the created widget API (null until initTopTools runs)
var _lastTop = [];        // latest top-tools array (client-side field mapping)

// Build the top-tools data table exactly once (guard against re-init). The
// component owns its own filter box + visible/total count, sortable headers,
// empty-state row, and re-renders only its <tbody> on data changes.
export function initTopTools() {
  if (topToolsTable) return;
  topToolsTable = createDataTable({
    container: $('top-tools'),
    columns: [
      { key: 'toolName', label: 'Tool' },
      { key: 'count', label: 'Calls', align: 'right' },
      { key: 'totalCacheHitInputTokens', label: 'Cache hit (tok)', align: 'right', headerTitle: NO_DATA_TIP, emptyTitle: NO_DATA_TIP, render: (v) => fmtOpt(v) },
      { key: 'avgRespTokPerCall', label: 'Avg resp (tok/call)', align: 'right', headerTitle: NO_DATA_TIP, emptyTitle: NO_DATA_TIP, render: (v) => fmtOpt(v) }
    ],
    rows: _lastTop,
    filterable: true,
    showCount: true,
    emptyMessage: 'No tool data yet.'
  });
}

// GET /api/stats and refresh the counts + top-tools panel. Fetched on load
// and every STATS_POLL_MS so numbers stay current even if the WS drops.
export async function refreshStats() {
  try {
    var res = await fetch('api/stats');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    var s = await res.json();
    $('total-calls').textContent = String(typeof s.totalCalls === 'number' ? s.totalCalls : 0);
    $('total-results').textContent = String(typeof s.totalResults === 'number' ? s.totalResults : 0);
    setStatValue('total-tokens', s.totalTokens);
    setStatValue('input-tokens', s.totalInputTokens);
    setStatValue('output-tokens', s.totalOutputTokens);
    setStatValue('cache-hit-input-tokens', s.totalCacheHitInputTokens);
    setStatValue('avg-duration', s.avgDurationMs);
    $('interventions-retained').textContent = String(Array.isArray(s.interventions) ? s.interventions.length : 0);
    // Map the server aggregate fields onto the table's column keys, then push
    // them into the table. Only when it exists — app.js may call this before
    // initTopTools(), which then seeds real data via rows:_lastTop.
    _lastTop = (s.topTools || []).map(function (t) {
      // Per-tool average response-payload tokens: estimated from result char count (÷4), divided by resolved results.
      return {
        toolName: t.toolName,
        count: t.count,
        avgRespTokPerCall: t.resolvedCount ? Math.round(t.totalResponseTokens / t.resolvedCount) : null,
        totalCacheHitInputTokens: t.totalCacheHitInputTokens
      };
    });
    if (topToolsTable) topToolsTable.setData(_lastTop);
    clearNotice();
  } catch (e) {
    showNotice('Stats unavailable: ' + errMsg(e));
  }
}

/* ---- clear (reset) server aggregates --------------------------------- */
// POST /api/stats/reset to wipe server-side aggregates, then refresh the panel
// so the cleared state shows. Reuses refreshStats() (no duplicated value logic);
// a refresh success clears the notice, so the error path is the only showNotice.
export async function clearStats() {
  try {
    var res = await fetch('api/stats/reset', { method: 'POST' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    await refreshStats();
  } catch (e) {
    showNotice('Stats clear failed: ' + errMsg(e));
  }
}

// Wire the stats panel's Clear button -> clearStats(). Guarded: attaches only
// when the button exists (matches the module's init* guard style).
export function initClearStats() {
  var btn = $('btn-clear-stats');
  if (!btn) return;
  btn.addEventListener('click', function () { clearStats(); });
}
