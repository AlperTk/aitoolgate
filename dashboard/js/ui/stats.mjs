/* ==========================================================================
 * aitoolgate dashboard — stats / top tools panel.
 *
 * Renders the aggregate stat tiles and the ranked top-tools table from a
 * GET /api/stats response. Fetched on load and every STATS_POLL_MS so the
 * numbers stay current even if the WebSocket drops. The table itself is the
 * generic, dependency-free widget built by ../core/table.mjs (createDataTable).
 * ========================================================================== */
import { $, fmtOpt, setStatValue, showNotice, clearNotice, errMsg } from '../core/dom.mjs';
import { formatCount } from '../core/format.mjs';
import { createDataTable } from '../core/table.mjs';
import { t, onLocaleChange } from '../i18n/index.mjs';

// Render one duration/token number cell, attaching the "no data yet" tooltip
// only when the value is still absent (early in the run).
export function statNumCell(v) {
  var t0 = fmtOpt(v);
  return '<td class="num-col"' + (t0 === '\u2014' ? ' title="' + t('noData.tip') + '"' : '') + '>' + t0 + '</td>';
}

/* ---- Top tools table (module-local; built once via createDataTable) ---- */
var topToolsTable = null; // the created widget API (null until initTopTools runs)
var _lastTop = [];        // latest top-tools array (client-side field mapping)

// Build the top-tools data table exactly once (guard against re-init). The
// component owns its own filter box + visible/total count, sortable headers,
// empty-state row, and re-renders only its <tbody> on data changes.
export function initTopTools() {
  if (topToolsTable) return;
  var noDataTip = t('noData.tip');
  topToolsTable = createDataTable({
    container: $('top-tools'),
    columns: [
      { key: 'toolName', label: t('stats.top.tool') },
      { key: 'count', label: t('stats.top.calls'), align: 'right' },
      { key: 'avgCallTokPerCall', label: t('stats.top.avgCall'), align: 'right', headerTitle: noDataTip, emptyTitle: noDataTip, render: (v) => fmtOpt(v) },
      { key: 'avgRespTokPerCall', label: t('stats.top.avgResp'), align: 'right', headerTitle: noDataTip, emptyTitle: noDataTip, render: (v) => fmtOpt(v) }
    ],
    rows: _lastTop,
    filterable: true,
    showCount: true,
    emptyMessage: t('stats.top.empty')
  });
}

// Re-render the top-tools table so its headers, placeholder and empty text use the
// active locale (the widget's labels are fixed at creation, so it is rebuilt).
function relabelTopTools() {
  if (!topToolsTable) return;
  topToolsTable.destroy();
  topToolsTable = null;
  initTopTools();
}
onLocaleChange(relabelTopTools);

// GET /api/stats and refresh the counts + top-tools panel. Fetched on load
// and every STATS_POLL_MS so numbers stay current even if the WS drops.
export async function refreshStats() {
  try {
    var res = await fetch('api/stats');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    var s = await res.json();
    $('total-calls').textContent = String(typeof s.totalCalls === 'number' ? s.totalCalls : 0);
    $('total-results').textContent = String(typeof s.totalResults === 'number' ? s.totalResults : 0);
    setStatValue('total-tokens', s.totalTokens, formatCount);
    setStatValue('input-tokens', s.totalInputTokens, formatCount);
    setStatValue('output-tokens', s.totalOutputTokens, formatCount);
    setStatValue('cache-hit-input-tokens', s.totalCacheHitInputTokens, formatCount);
    $('interventions-retained').textContent = String(Array.isArray(s.interventions) ? s.interventions.length : 0);
    // Map the server aggregate fields onto the table's column keys, then push
    // them into the table. Only when it exists — app.js may call this before
    // initTopTools(), which then seeds real data via rows:_lastTop.
    _lastTop = (s.topTools || []).map(function (t0) {
      // Per-tool average call tokens (÷call count) and average response-payload tokens (÷resolved
      // results); each null (= —) when there is nothing to divide by.
      return {
        toolName: t0.toolName,
        count: t0.count,
        avgCallTokPerCall: (t0.totalCallTokens != null && t0.count > 0) ? Math.round(t0.totalCallTokens / t0.count) : null,
        avgRespTokPerCall: t0.resolvedCount ? Math.round(t0.totalResponseTokens / t0.resolvedCount) : null
      };
    });
    if (topToolsTable) topToolsTable.setData(_lastTop);
    clearNotice();
  } catch (e) {
    showNotice(t('stats.error.unavailable', { detail: errMsg(e) }));
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
    showNotice(t('stats.error.clearFailed', { detail: errMsg(e) }));
  }
}

// Wire the stats panel's Clear button -> clearStats(). Guarded: attaches only
// when the button exists (matches the module's init* guard style).
export function initClearStats() {
  var btn = $('btn-clear-stats');
  if (!btn) return;
  btn.addEventListener('click', function () { clearStats(); });
}
