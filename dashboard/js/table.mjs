/* ==========================================================================
 * aitoolgate dashboard — generic, dependency-free data-table component.
 *
 * Builds a self-contained widget inside a caller-provided (empty) container:
 * an optional filter toolbar (text filter + visible/total count) and a table
 * whose <thead> is rendered once and whose <tbody> re-renders on data /
 * filter / sort changes. No framework, no build step — only the tiny DOM
 * helpers from ./dom.mjs.
 *
 *   createDataTable({
 *     container      // HTMLElement (required) — receives the whole widget
 *     columns        // required: string[] or Column[] (mixed allowed)
 *     rows=[] , filterable=true , showCount=true ,
 *     filterPlaceholder='Filter…' , emptyMessage='No rows' ,
 *     defaultSort=null            // { key, dir:'asc'|'desc' } applied on init
 *   }) -> { el, setData, setFilter, clearFilter, getVisibleRows, getSort, destroy }
 *
 * Column = a plain string (column name) OR an object:
 *   { key; label; align='left' ('right'|'center') ; get?(row); render?(value,row)
 *     -> string (rendered as text)|node ; emptyValue='—' ; emptyTitle; headerTitle;
 *     sortable=true ; sortCompare?(a,b)->number ; hideInFilter=false }
 * String entries are normalized to { key:s, label:s }.
 * ========================================================================== */
import { el } from './dom.mjs';

// A value counts as "absent" when it is null/undefined or an empty string.
function isAbsent(v) { return v == null || String(v) === ''; }

// Normalize a column entry into a full Column config object.
function normalizeColumn(c) {
  if (typeof c === 'string') {
    return { key: c, label: c, align: 'left', emptyValue: '—', sortable: true };
  }
  var col = {};
  for (var k in c) col[k] = c[k];               // shallow copy preserves every field
  if (col.key == null) throw new Error('column requires a key');
  if (col.label == null) col.label = col.key;
  if (!col.align) col.align = 'left';
  if (col.emptyValue == null) col.emptyValue = '—';
  if (col.sortable == null) col.sortable = true; // sortable by default
  return col;
}

export function createDataTable(options) {
  var container = options && options.container;
  if (!container || typeof container.appendChild !== 'function') {
    throw new Error('createDataTable: options.container must be an element');
  }
  var columns = (options.columns || []).map(normalizeColumn);
  var filterable = options.filterable !== false;
  var showCount = !!options.showCount;
  var filterPlaceholder = options.filterPlaceholder != null ? options.filterPlaceholder : 'Filter\u2026';
  var emptyMessage = options.emptyMessage != null ? options.emptyMessage : 'No rows';
  var defaultOpt = options.defaultSort || null;

  var rows = Array.isArray(options.rows) ? options.rows.slice() : [];
  var _filter = '';       // current filter text (kept across setData)
  var _sortKey = null;    // null => preserve the given row order
  var _sortDir = 'desc';  // direction used when a column is first activated
  var _visible = [];      // currently shown rows (filtered + sorted)
  var destroyed = false;

  var root, thead, theadRow, tbody, countEl, filterInput;

  function findCol(key) {
    for (var i = 0; i < columns.length; i++) if (columns[i].key === key) return columns[i];
    return null;
  }
  function cellValue(col, row) {                 // get(row) ?? row[key]
    var v = typeof col.get === 'function' ? col.get(row) : undefined;
    return v == null ? row[col.key] : v;
  }
  function cellText(col, row) {                  // stringified value for the filter
    var v = cellValue(col, row);
    return isAbsent(v) ? '' : String(v);
  }

  // Natural first-click direction: numeric-valued column -> desc, text -> asc.
  // Honors an explicit defaultSort for this column, otherwise infers from data.
  function naturalDirFor(col) {
    if (defaultOpt && defaultOpt.key === col.key) {
      return defaultOpt.dir === 'asc' ? 'asc' : 'desc';
    }
    var numeric = false, sawPresent = false;
    for (var i = 0; i < rows.length; i++) {
      var v = cellValue(col, rows[i]);
      if (isAbsent(v)) continue;
      sawPresent = true;
      if (!(typeof v === 'number' && isFinite(v))) { numeric = false; break; }
      numeric = true;
    }
    return (numeric && sawPresent) ? 'desc' : 'asc';
  }

  // Smart comparator for two PRESENT values: per-column override wins; then
  // numbers compare numerically, anything else compares case-insensitively.
  function compareValues(a, b, col) {
    if (typeof col.sortCompare === 'function') return col.sortCompare(a, b);
    if (typeof a === 'number' && typeof b === 'number' && isFinite(a) && isFinite(b)) return a - b;
    return String(a).toLowerCase().localeCompare(String(b).toLowerCase());
  }

  function matchFilter(row) {
    if (!_filter) return true;
    var q = _filter.toLowerCase();
    for (var i = 0; i < columns.length; i++) {
      var col = columns[i];
      if (col.hideInFilter) continue;
      if (cellText(col, row).toLowerCase().indexOf(q) !== -1) return true;
    }
    return false;
  }

  function computeVisible() {
    var list = rows.filter(matchFilter);
    if (_sortKey) {
      var col = findCol(_sortKey);
      if (col) {
        var dir = _sortDir;
        list = list.slice().sort(function (a, b) {
          var va = cellValue(col, a), vb = cellValue(col, b);
          var aA = isAbsent(va), bA = isAbsent(vb);
          // absent values always sort LAST regardless of direction
          if (aA || bA) return (aA && bA) ? 0 : (aA ? 1 : -1);
          var c = compareValues(va, vb, col);
          return dir === 'asc' ? c : -c;
        });
      }
    } else {
      list = list.slice();                       // keep given order
    }
    _visible = list;
  }

  function renderHeaders() {
    var ths = theadRow.children;
    for (var i = 0; i < ths.length; i++) {
      var th = ths[i], col = columns[i];
      if (!col.sortable) continue;
      var ind = th.querySelector('.dt-ind');
      var active = _sortKey === col.key;
      if (active) {
        th.setAttribute('aria-sort', _sortDir === 'asc' ? 'ascending' : 'descending');
        th.classList.add('active');
        if (ind) ind.textContent = _sortDir === 'asc' ? '\u25B2' : '\u25BC';
      } else {
        th.setAttribute('aria-sort', 'none');
        th.classList.remove('active');
        if (ind) ind.textContent = '';
      }
    }
  }

  function buildRow(row) {
    var tr = document.createElement('tr');
    columns.forEach(function (col) {
      var td = document.createElement('td');
      if (col.align === 'right') td.classList.add('num-col');
      else if (col.align === 'center') td.classList.add('dt-center');
      var v = cellValue(col, row);
      if (isAbsent(v)) {
        td.textContent = col.emptyValue;
        if (col.emptyTitle) td.title = col.emptyTitle;
      } else {
        var rendered = typeof col.render === 'function' ? col.render(v, row) : undefined;
        if (rendered == null) td.textContent = String(v);   // safe: textContent auto-escapes
        else if (typeof rendered === 'string') td.textContent = rendered; // string is text, never HTML
        else td.appendChild(rendered);                        // a node
      }
      tr.appendChild(td);
    });
    return tr;
  }

  function renderBody() {
    tbody.textContent = '';
    if (!_visible.length) {
      var tr = document.createElement('tr');
      tr.className = 'dt-empty';
      var td = document.createElement('td');
      td.colSpan = columns.length;
      td.textContent = emptyMessage;
      tr.appendChild(td);
      tbody.appendChild(tr);
      return;
    }
    _visible.forEach(function (row) { tbody.appendChild(buildRow(row)); });
  }

  function updateCount() {
    if (countEl) countEl.textContent = _visible.length + ' / ' + rows.length;
  }

  function render() {
    if (destroyed) return;
    computeVisible();
    renderHeaders();
    renderBody();
    updateCount();
  }

  function onSortClick(col) {
    if (!col.sortable) return;
    if (_sortKey === col.key) {
      _sortDir = _sortDir === 'asc' ? 'desc' : 'asc';      // repeated click toggles
    } else {
      _sortKey = col.key;
      _sortDir = naturalDirFor(col);                        // first click uses natural dir
    }
    render();
  }

  /* ---- build the widget DOM ------------------------------------------ */
  root = el('div', 'dt-widget');

  var hasToolbar = filterable || showCount;
  if (hasToolbar) {
    var bar = el('div', 'dt-toolbar');
    if (filterable) {
      filterInput = document.createElement('input');
      filterInput.type = 'text';
      filterInput.className = 'dt-filter';
      filterInput.placeholder = filterPlaceholder;
      filterInput.setAttribute('aria-label', 'Filter rows');
      filterInput.addEventListener('input', function () { setFilter(this.value); });
      bar.appendChild(filterInput);
    }
    if (showCount) {
      countEl = el('span', 'dt-count', '');
      bar.appendChild(countEl);
    }
    root.appendChild(bar);
  }

  var table = document.createElement('table');
  table.className = 'dt-table';
  theadRow = document.createElement('tr');
  columns.forEach(function (col) {
    var th = document.createElement('th');
    th.scope = 'col';
    th.textContent = col.label;
    if (col.align === 'right') th.classList.add('num-col');
    else if (col.align === 'center') th.classList.add('dt-center');
    if (col.headerTitle) th.title = col.headerTitle;
    if (col.sortable) {
      th.classList.add('sortable');          // existing .sortable cursor/hover applies
      th.setAttribute('aria-sort', 'none');
      th.setAttribute('tabindex', '0');
      th.appendChild(el('span', 'dt-ind', ''));
      th.addEventListener('click', function () { onSortClick(col); });
      th.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSortClick(col); }
      });
    }
    theadRow.appendChild(th);
  });
  thead = document.createElement('thead');
  thead.appendChild(theadRow);
  tbody = document.createElement('tbody');
  table.appendChild(thead);
  table.appendChild(tbody);
  root.appendChild(table);
  container.appendChild(root);

  // Optional initial sort (defaultSort): seed the state so the first render is sorted.
  if (defaultOpt && findCol(defaultOpt.key)) {
    _sortKey = defaultOpt.key;
    _sortDir = defaultOpt.dir === 'asc' ? 'asc' : 'desc';
  }

  /* ---- public API ---------------------------------------------------- */
  function setData(newRows) {
    rows = Array.isArray(newRows) ? newRows.slice() : [];   // keep current filter + sort
    render();
  }
  function setFilter(text) {
    _filter = text == null ? '' : String(text);
    if (filterInput) filterInput.value = _filter;
    render();
  }
  function clearFilter() { setFilter(''); }
  function getVisibleRows() { return _visible.slice(); }
  function getSort() { return _sortKey ? { key: _sortKey, dir: _sortDir } : null; }
  function destroy() {
    if (destroyed) return;
    destroyed = true;
    if (root.parentNode) root.parentNode.removeChild(root);
  }

  render();                                                 // initial paint (data + headers)

  return {
    el: root,
    setData: setData,
    setFilter: setFilter,
    clearFilter: clearFilter,
    getVisibleRows: getVisibleRows,
    getSort: getSort,
    destroy: destroy
  };
}
