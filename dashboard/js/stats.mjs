/* ==========================================================================
 * mcp-manager dashboard — stats / top tools panel.
 *
 * Renders the aggregate stat tiles and the ranked top-tools table from a
 * GET /api/stats response. Fetched on load and every STATS_POLL_MS so the
 * numbers stay current even if the WebSocket drops.
 * ========================================================================== */
import { $, esc, fmtOpt, setStatValue, showNotice, clearNotice, errMsg } from './dom.mjs';
import { NO_DATA_TIP } from './constants.mjs';

// Render one duration/token number cell, attaching the "no data yet" tooltip
// only when the value is still absent (early in the run).
export function statNumCell(v) {
  var t = fmtOpt(v);
  return '<td class="num-col"' + (t === '\u2014' ? ' title="' + NO_DATA_TIP + '"' : '') + '>' + t + '</td>';
}

/* ---- Top Tools sortable state (module-local, not in state.mjs) ---- */
var sortKey = null;   // null = no sort applied (preserve server order)
var sortDir = 'desc'; // used when a column is first activated
var _lastTop = null;  // cached top array for re-render on sort click
var NATURAL_DIR = { tool: 'asc', calls: 'desc', avg: 'desc', max: 'desc' };

function getSortVal(t, key) {
  switch (key) {
    case 'tool':  return t.toolName;
    case 'calls': return t.count;
    case 'avg':   return t.avgDurationMs;
    case 'max':   return t.maxDurationMs;
  }
  return undefined;
}

function isAbsent(v) { return v == null || v === undefined; }

function sortTop(top) {
  if (!sortKey || !top || !top.length) return top;
  var sorted = top.slice();
  sorted.sort(function (a, b) {
    var va = getSortVal(a, sortKey), vb = getSortVal(b, sortKey);
    var aAbs = isAbsent(va), bAbs = isAbsent(vb);
    if (aAbs && bAbs) return 0;
    if (aAbs) return 1;  // absent always sorts last
    if (bAbs) return -1;
    var cmp;
    if (sortKey === 'tool') {
      cmp = String(va).toLowerCase().localeCompare(String(vb).toLowerCase());
    } else {
      cmp = Number(va) - Number(vb);
    }
    return sortDir === 'asc' ? cmp : -cmp;
  });
  return sorted;
}

function updateSortIndicators() {
  var ths = document.querySelectorAll('.top-tools thead th.sortable');
  ths.forEach(function (th) {
    var key = th.getAttribute('data-sort');
    var ind = th.querySelector('.sort-ind');
    if (key === sortKey) {
      th.setAttribute('aria-sort', sortDir === 'asc' ? 'ascending' : 'descending');
      if (ind) ind.textContent = sortDir === 'asc' ? '\u25B2' : '\u25BC';
      th.classList.add('active');
    } else {
      th.setAttribute('aria-sort', 'none');
      if (ind) ind.textContent = '';
      th.classList.remove('active');
    }
  });
}

// Render the ranked top-tools table from a CollectorSummary.topTools array.
// Attaches the "no data yet" tooltip to empty cells and to the Avg/Max column
// headers whenever any duration value is still absent.
export function renderTopTools(top) {
  _lastTop = top;
  _renderTopRows();
}

function _renderTopRows() {
  var tb = $('top-tools');
  tb.textContent = '';
  var table = tb.closest('table');
  var hasDash = false;
  var html = '';
  var top = _lastTop;
  if (!top || !top.length) {
    hasDash = true;
    html = '<tr><td colspan="4" class="muted" title="' + NO_DATA_TIP + '">—</td></tr>';
  } else {
    sortTop(top).forEach(function (t) {
      var avg = fmtOpt(t.avgDurationMs), max = fmtOpt(t.maxDurationMs);
      if (avg === '\u2014' || max === '\u2014') hasDash = true;
      html += '<tr><td>' + esc(t.toolName) + '</td>' +
        '<td class="num-col">' + esc(String(t.count)) + '</td>' +
        statNumCell(t.avgDurationMs) + statNumCell(t.maxDurationMs) + '</tr>';
    });
  }
  tb.innerHTML = html;
  var ths = table.querySelectorAll('th');
  [2, 3].forEach(function (i) {
    if (!ths[i]) return;
    if (hasDash) ths[i].title = NO_DATA_TIP; else ths[i].removeAttribute('title');
  });
}

// Attach click-to-sort handlers on the four .top-tools thead th.sortable headers.
// First click on a column applies its natural direction; subsequent clicks toggle.
export function initTopToolsSort() {
  var ths = document.querySelectorAll('.top-tools thead th.sortable');
  ths.forEach(function (th) {
    th.addEventListener('click', function () {
      var key = th.getAttribute('data-sort');
      if (sortKey === key) {
        sortDir = sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        sortKey = key;
        sortDir = NATURAL_DIR[key] || 'desc';
      }
      updateSortIndicators();
      _renderTopRows();
    });
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
    renderTopTools(s.topTools);
    setStatValue('total-tokens', s.totalTokens);
    setStatValue('input-tokens', s.totalInputTokens);
    setStatValue('output-tokens', s.totalOutputTokens);
    setStatValue('avg-duration', s.avgDurationMs);
    $('interventions-retained').textContent = String(Array.isArray(s.interventions) ? s.interventions.length : 0);
    clearNotice();
  } catch (e) {
    showNotice('Stats unavailable: ' + errMsg(e));
  }
}
