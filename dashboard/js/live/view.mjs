/* ==========================================================================
 * aitoolgate dashboard — live event stream / intervention list rendering.
 *
 * Builds and manages the per-row DOM for tool calls, tool results, and policy
 * interventions in the "stream" and "intervention log" panels. One row per
 * logical call is tracked by call id in state.callRows; a matching tool.result
 * pairs back to its call row (by toolCallId or same-session fallback) and
 * updates it in place, while unmatched results become standalone "orphan" rows
 * so no data is lost. Client-side filters compose tool / status / session /
 * time-window constraints over the visible rows.
 * ========================================================================== */
import { $, el, esc, fmtOpt, fmtTime } from '../core/dom.mjs';
import { formatCount, formatSize } from '../core/format.mjs';
import { state } from '../core/state.mjs';
import { MAX_LIST_ITEMS } from '../core/constants.mjs';
import { inTimeRange } from '../core/time.mjs';
import { bindPolicySection, buildPolicySection } from './policy-actions.mjs';
import { buildSessionContextHtml, clearSessionContext, getSessionContexts, storeSessionContext } from './session-context.mjs';
import { t, getLocale, onLocaleChange } from '../i18n/index.mjs';

// Policy quick-actions live in policy-actions.mjs; re-exported here so existing
// LV.* import paths keep working.
export { buildPolicySection, handlePolicyAction, createPolicyRule } from './policy-actions.mjs';
// Session context rendering lives in session-context.mjs; re-exported for existing LV.* callers.
export { buildSessionContextHtml } from './session-context.mjs';

// Prepend a row to a <ul>, keeping at most `max` children (newest-first).
export function prependTrim(listEl, node, max) {
  listEl.insertBefore(node, listEl.firstChild);
  // Cap counts only data rows: session group headers (li.stream-group-head) are
  // not rows, and any header trimmed here is rebuilt by regroupStream().
  var rows = 0;
  for (var i = 0; i < listEl.children.length; i++) {
    if (listEl.children[i].classList.contains('stream-row')) rows++;
  }
  while (rows > max) {
    var last = listEl.lastChild;
    listEl.removeChild(last);
    if (last.classList.contains('stream-row')) rows--;
  }
}
// Append the three numeric cells (In (est) | Out (est) | Size) to a row's .row-main.
// In = the per-tool call-side token estimate (ev.callTokens, name + arguments, ~chars/4);
// '—' on result rows, which carry no callTokens.
// Out = the per-tool result-side token estimate (the paired tool.result's ev.tokens, a number
// ~chars/4); call rows created before their result show '—' and are filled in-place by
// updateCallRowWithResult; orphan result rows show their own value.
// Size = the paired result payload size (chars) when known.
// In/Out are returned so result pairing can update them in place. Turn totals live in the
// session group header (see buildGroupHead), not on rows.
export function appendTokenAndSizeCells(main, ev) {
  var cells = {
    in: el('span', 's-tokens-in col-num', typeof ev.callTokens === 'number' ? formatCount(ev.callTokens) : '—'),
    out: el('span', 's-tokens-out col-num', typeof ev.tokens === 'number' ? formatCount(ev.tokens) : '—'),
    size: el('span', 's-size col-num', typeof ev.chars === 'number' ? formatSize(ev.chars) : '—')
  };
  applyTokenTitles(cells);
  main.appendChild(cells.in);
  main.appendChild(cells.out);
  main.appendChild(cells.size);
  // Return the token + size cells so callers (result pairing) can update them in place by
  // stored reference (the test stub's querySelector is a no-op).
  return cells;
}
// Set the hover titles of the numeric cells to the active locale.
function applyTokenTitles(cells) {
  cells.in.title = t('live.tokens.inTitle');
  cells.out.title = t('live.tokens.outTitle');
  cells.size.title = t('live.tokens.sizeTitle');
}
// Locale-formatted absolute time for a row's time tooltip ('' when absent).
function localeTimeTitle(at) {
  return typeof at === 'number' ? new Date(at).toLocaleString(getLocale()) : '';
}
// Update a numeric cell's text from an optional value; leave it unchanged ('—') when absent.
export function setNumCellText(cell, v, fmt) {
  if (cell && typeof v === 'number' && isFinite(v)) cell.textContent = (typeof fmt === 'function' ? fmt : fmtOpt)(v);
}



/* ---- stream-head self-healing -------------------------------------- */
// Canonical column headers for the live call stream, matching the shared
// 10-track grid template used by createCallRow() rows. Normalizing the
// header at init guarantees correct structure regardless of the served HTML
// state (stale cache / service worker / older copy); idempotent by design.
// Each entry is [i18n key, class name].
var STREAM_HEAD_CELLS = [
  ['col.status', ''],
  ['col.tool', ''],
  ['col.session', ''],
  ['col.time', ''],
  ['col.durMs', 'num-col'],
  ['col.inEst', 'num-col'],
  ['col.outEst', 'num-col'],
  ['col.size', 'num-col'],
];
// Rebuild the .stream-head so it contains exactly the canonical 9 cells,
// mirroring the .row-main layout. Container attributes are left intact; the
// final empty cell carries aria-hidden instead of scope.
export function normalizeStreamHead() {
  var head = $('stream-head');
  if (!head) return;
  while (head.firstChild) head.removeChild(head.firstChild);
  // Unit suffix per cell index (In/Out -> tok, Size -> ch); CSS ::after renders attr(data-unit).
  var unitKeys = [null, null, null, null, null, 'units.tok', 'units.tok', 'units.chars'];
  STREAM_HEAD_CELLS.forEach(function (c, i) {
    var th = el('th', c[1]);
    th.textContent = t(c[0]);
    th.setAttribute('scope', 'col');
    if (unitKeys[i]) th.setAttribute('data-unit', t(unitKeys[i]));
    head.appendChild(th);
  });
  var empty = el('th', '');
  empty.setAttribute('aria-hidden', 'true');
  head.appendChild(empty);
}

/* ---- unified call-row rendering ---------------------------------------
 * One row per logical tool-call, tracked by call id in `state.callRows`. A
 * matching tool.result pairs back to its call row (by toolCallId or same-
 * session fallback) and updates it in place. Unmatched results are retained
 * as standalone "orphan" rows so no data is lost.
 */
// Build a single call row, register it in state.callRows, and prepend it to the list.
export function createCallRow(ev) {
  var callId = ev.id || '';
  var li = el('li', 'stream-row call-row');
  if (callId) li.dataset.callId = callId;
  li.dataset.tool = ev.toolName || '';
  li.dataset.session = ev.sessionKey || '';
  li.dataset.status = 'pending';
  li.dataset.at = ev.at;
  var batchKey = batchKeyOf(ev);
  if (batchKey) li.dataset.batch = batchKey;
  li.streamSeq = ++state.streamSeq;

  var main = el('div', 'row-main');
  main.appendChild(el('span', 'badge badge-pending', t('live.badge.pending')));
  var tool = el('span', 's-tool', ev.toolName || '');
  tool.title = ev.toolName || '';
  main.appendChild(tool);
  var sess = el('span', 's-session muted', ev.sessionKey || '');
  sess.title = ev.sessionKey || '';
  main.appendChild(sess);
  var timeEl = el('time', 's-time', fmtTime(ev.at));
  timeEl.title = localeTimeTitle(ev.at);
  main.appendChild(timeEl);
  var dur = el('span', 's-duration col-num', '\u2014');
  dur.title = t('live.duration.title');
  main.appendChild(dur);
  var tokenCells = appendTokenAndSizeCells(main, ev);
  var exp = el('span', 's-expand', '\u25BE');
  exp.setAttribute('aria-hidden', 'true');
  main.appendChild(exp);

  var detail = el('div', 'row-detail');
  detail.hidden = true;

  li.appendChild(main);
  li.appendChild(detail);

  // Key the row state by the unique event id so each distinct batched same-name
  // call gets its own row (retaining the empty-id fallback for legacy events).
  var rs = { li: li, callEv: ev, resultEv: null, status: 'pending', expanded: false, tokenCells: tokenCells, batchKey: batchKey };
  if (callId) state.callRows.set(callId, rs);
  prependTrim($('stream-list'), li, MAX_LIST_ITEMS);
  $('stream-empty').hidden = true;
  trimCallData();
  bindRowClick(li, rs);
  applyFilters();
  return rs;
}

// Calls emitted for one assistant response share (sessionKey, at). Rows missing either
// field get no batch key, so they can never group accidentally.
function batchKeyOf(ev) {
  if (!ev || !ev.sessionKey || ev.at === undefined || ev.at === null || ev.at === '') return '';
  return ev.sessionKey + '\u0000' + String(ev.at);
}

// Re-render the batch marker on every row of `key` (incl. `self` when not yet in
// state.callRows). Standalone rows (member count < 2) stay unmarked.
// Batch keys whose member rows are collapsed under their header.
var collapsedBatches = new Set();

// Rebuild batch headers from the current DOM order: one header directly above the first
// member row of each batch with 2+ member rows (so it stays inside its session group).
// Singleton rows get no header and no batch classes.
function layoutBatchHeads(list) {
  var i, c;
  for (i = list.children.length - 1; i >= 0; i--) {
    c = list.children[i];
    if (c.classList.contains('stream-batch-head')) list.removeChild(c);
  }
  var members = new Map();
  for (i = 0; i < list.children.length; i++) {
    c = list.children[i];
    c.classList.remove('batch-child', 'is-batch-collapsed');
    if (!c.classList.contains('stream-row') || !c.dataset.batch) continue;
    if (!members.has(c.dataset.batch)) members.set(c.dataset.batch, []);
    members.get(c.dataset.batch).push(c);
  }
  members.forEach(function (rows, key) {
    if (rows.length < 2) return;
    var visible = rows.filter(function (r) { return r.style.display !== 'none'; }).length;
    var head = buildBatchHead(key, visible);
    head.classList.toggle('is-collapsed', rows[0].classList.contains('is-collapsed'));
    list.insertBefore(head, rows[0]);
    var collapsed = collapsedBatches.has(key);
    rows.forEach(function (r) {
      r.classList.add('batch-child');
      r.classList.toggle('is-batch-collapsed', collapsed);
    });
  });
}

function buildBatchHead(key, visible) {
  var collapsed = collapsedBatches.has(key);
  var head = el('li', 'stream-batch-head');
  head.dataset.batch = key;
  var label = 'Toplu çağrı · ' + visible + ' araç';
  var btn = el('button', 'stream-batch-toggle', collapsed ? '\u25B8' : '\u25BE');
  btn.type = 'button';
  btn.title = label;
  btn.setAttribute('aria-label', label);
  btn.setAttribute('aria-expanded', String(!collapsed));
  // Clicks are delegated from #stream-list (onStreamListClick), like session headers.
  head.appendChild(btn);
  head.appendChild(el('span', 'stream-batch-label', label));
  if (!visible) head.style.display = 'none';
  return head;
}

function focusBatchToggle(key) {
  var list = $('stream-list');
  if (!list) return;
  for (var i = 0; i < list.children.length; i++) {
    var c = list.children[i];
    if (c.classList.contains('stream-batch-head') && c.dataset.batch === key) {
      var b = c.firstChild;
      if (b && typeof b.focus === 'function') b.focus();
      return;
    }
  }
}

// Update an existing call row in place when its tool.result arrives.
export function updateCallRowWithResult(rs, ev) {
  rs.resultEv = ev;
  rs.status = ev.ok === false ? 'fail' : 'ok';
  rs.li.dataset.status = rs.status;
  var badge = rs.li.querySelector('.badge');
  if (badge) {
    badge.className = 'badge ' + (ev.ok === false ? 'badge-fail' : 'badge-ok');
    badge.textContent = t(ev.ok === false ? 'live.badge.fail' : 'live.badge.ok');
  }
  var dur = rs.li.querySelector('.s-duration');
  if (dur && typeof ev.durationMs === 'number') dur.textContent = fmtOpt(ev.durationMs);
  // OUT (est): the result event carries its response-payload token estimate as a number;
  // the per-tool In (call estimate) and the turn-level Total are left untouched. Cell
  // references come from the row's stored tokenCells (works in the real DOM and the test
  // stub, whose querySelector is a no-op).
  var cells = rs.tokenCells;
  setNumCellText(cells && cells.out, typeof ev.tokens === 'number' ? ev.tokens : undefined, formatCount);
  setNumCellText(cells && cells.size, ev.chars, formatSize);
  if (rs.expanded) renderRowDetail(rs);
  applyFilters();
}

// Apply a whole-turn turn.usage event to the call rows of that turn (matched by sessionKey +
// the shared turn-level `at` — every event of one turn shares ONE turn-level timestamp). Every
// matching row gets `turnTokens` set (so its details panel surfaces the turn's reported
// input / cache-hit input / output / total). The turn is also recorded per session (deduped by
// `at`) so the session group header can show the latest turn total, the cumulative session
// total and the cumulative cache hit. Per-row In / Out / Size columns are NOT affected.
export function applyTurnUsageToRows(ev) {
  if (!ev || !ev.tokens || typeof ev.tokens !== 'object') return;
  var tokens = ev.tokens;
  recordTurnUsage(ev);
  state.callRows.forEach(function (rs) {
    var ce = rs.callEv;
    if (!ce || ce.sessionKey !== ev.sessionKey || ce.at !== ev.at) return;
    rs.turnTokens = tokens;
    if (rs.expanded) renderRowDetail(rs);
  });
  if (state.groupBySession) regroupStream();
}
// Record one reported turn per (sessionKey, at). A duplicate of the same turn overwrites the
// total but keeps a previously reported cache-hit when the duplicate omits it.
function recordTurnUsage(ev) {
  var tokens = ev.tokens;
  if (typeof ev.at !== 'number' || !isFinite(ev.at) || typeof tokens.total !== 'number' || !isFinite(tokens.total)) return;
  var sk = ev.sessionKey || '';
  var turns = state.turnUsageBySession.get(sk);
  if (!turns) { turns = new Map(); state.turnUsageBySession.set(sk, turns); }
  var prev = turns.get(ev.at);
  var cache = typeof tokens.cacheHitInput === 'number' && isFinite(tokens.cacheHitInput) ? tokens.cacheHitInput
    : (prev ? prev.cacheHit : undefined);
  turns.set(ev.at, { total: tokens.total, cacheHit: cache });
}
// Summary for a session group header: latest turn total (turn with the greatest `at`), cumulative
// total over distinct turns, and cumulative reported cache-hit (null when no turn reports it).
// Returns null when the session has no recorded turn.
function sessionUsageSummary(key) {
  var turns = state.turnUsageBySession.get(key);
  if (!turns || !turns.size) return null;
  var latestAt = -Infinity, latest = 0, total = 0, cache = 0, hasCache = false;
  turns.forEach(function (turn, at) {
    total += turn.total;
    if (typeof turn.cacheHit === 'number') { cache += turn.cacheHit; hasCache = true; }
    if (at > latestAt) { latestAt = at; latest = turn.total; }
  });
  return { latest: latest, total: total, cache: hasCache ? cache : null };
}
// Clear the on-screen session-group data (per-session context, prompt history, turn usage and
// collapse state). The group-by-session preference and the dedup set are intentionally kept.
export function resetSessionGroupState() {
  clearSessionContext();
  state.turnUsageBySession.clear();
  state.collapsedSessions.clear();
  collapsedBatches.clear(); // reset empties the list, so no batch group survives
}

// Create a standalone row for a tool.result that could not be paired to any call.
export function createOrphanResultRow(ev) {
  var li = el('li', 'stream-row orphan-row');
  li.dataset.tool = ev.toolName || '';
  li.dataset.session = ev.sessionKey || '';
  li.dataset.status = ev.ok === false ? 'fail' : 'ok';
  li.dataset.at = ev.at;
  li.streamSeq = ++state.streamSeq;

  var isErr = ev.ok === false;
  var main = el('div', 'row-main');
  main.appendChild(el('span', 'badge ' + (isErr ? 'badge-fail' : 'badge-ok'), t(isErr ? 'live.badge.fail' : 'live.badge.ok')));
  var tool = el('span', 's-tool', ev.toolName || '');
  tool.title = ev.toolName || '';
  main.appendChild(tool);
  var sess = el('span', 's-session muted', ev.sessionKey || '');
  sess.title = ev.sessionKey || '';
  main.appendChild(sess);
  var timeEl = el('time', 's-time', fmtTime(ev.at));
  timeEl.title = localeTimeTitle(ev.at);
  main.appendChild(timeEl);
  var dur = el('span', 's-duration col-num', typeof ev.durationMs === 'number' ? fmtOpt(ev.durationMs) : '\u2014');
  dur.title = t('live.duration.title');
  main.appendChild(dur);
  var tokenCells = appendTokenAndSizeCells(main, ev);
  var exp = el('span', 's-expand', '\u25BE');
  exp.setAttribute('aria-hidden', 'true');
  main.appendChild(exp);

  var detail = el('div', 'row-detail');
  detail.hidden = true;

  li.appendChild(main);
  li.appendChild(detail);

  var rs = { li: li, callEv: null, resultEv: ev, status: isErr ? 'fail' : 'ok', expanded: false, tokenCells: tokenCells };
  state.orphanResultEntries.push({ li: li, ev: ev, rs: rs });
  prependTrim($('stream-list'), li, MAX_LIST_ITEMS);
  $('stream-empty').hidden = true;
  trimCallData();
  bindRowClick(li, rs);
  applyFilters();
}

// Find the pending call row that a result event belongs to.
export function findCallForResult(ev) {
  if (ev.toolCallId) {
    var rs = state.callRows.get(ev.toolCallId);
    if (rs && !rs.resultEv && rs.li.parentNode === $('stream-list')) return rs;
  }
  // Fallback: most-recent still-pending call in the SAME NON-EMPTY session. A
  // uniform/empty sessionKey identifies no single conversation (many unrelated sessions
  // collapse onto ''), so it must not drive cross-row matching — otherwise an empty-key
  // result could mis-match an unrelated empty-key pending row. The primary id-match above
  // stays authoritative; this only tightens the session fallback (identical for any
  // non-empty sessionKey that was already accepted).
  if (typeof ev.sessionKey === 'string' && ev.sessionKey !== '') {
    var best = null, bestAt = -1;
    state.callRows.forEach(function (rs) {
      if (rs.resultEv) return;
      if (rs.callEv.sessionKey !== ev.sessionKey) return;
      var at = rs.callEv.at || 0;
      if (at >= bestAt) { bestAt = at; best = rs; }
    });
    if (best) return best;
  }
  return null;
}

// Pair a tool.result to its call row (or create an orphan row if unmatched).
export function matchAndRenderResult(ev) {
  var rs = findCallForResult(ev);
  if (rs) { updateCallRowWithResult(rs, ev); }
  else { createOrphanResultRow(ev); }
}

// Store an intervention event for later drill-down lookup by session key.
export function storeInterventionForDrillDown(ev) {
  var sk = ev.sessionKey || '';
  if (!sk) return;
  if (!state.interventionsBySession.has(sk)) state.interventionsBySession.set(sk, []);
  state.interventionsBySession.get(sk).push({ ruleId: ev.ruleId, action: ev.action, at: ev.at, detail: ev.detail });
}

// Session context (system prompt / tools / prompt versions) lives in session-context.mjs; the
// store wrapper regroups the stream so a new context shows in its group immediately.
export function storeContextForDrillDown(ev) {
  if (!storeSessionContext(ev)) return;
  if (state.groupBySession) regroupStream();
}

// Wire the click-to-drill-down handler on a row.
export function bindRowClick(li, rs) {
  li.onclick = null;
  li.addEventListener('click', function (e) {
    if (e.target.closest('.row-detail')) return; // clicks inside detail don't toggle
    rs.expanded = !rs.expanded;
    var detailEl = li.querySelector('.row-detail');
    if (!detailEl) return;
    if (rs.expanded) { renderRowDetail(rs); detailEl.hidden = false; }
    else { detailEl.hidden = true; }
    li.classList.toggle('expanded', rs.expanded);
  });
}

// Fill the inline detail block under a row with a tab strip: Arguments | Response | Details.
// Only one tab panel is visible at a time; the active tab is tracked per row in rs.activeTab.
// The Response tab lazily fetches api/tool-results/<id> on first activation and caches
// the result in rs.response so re-opening never refetches.
export function renderRowDetail(rs) {
  var detailEl = rs.li.querySelector('.row-detail');
  if (!detailEl) return;
  if (!rs.activeTab) rs.activeTab = 'arguments';
  var html = '<div class="rd-tabs">';
  ['arguments', 'response', 'details'].forEach(function (tab) {
    html += '<button type="button" class="rd-tab' + (rs.activeTab === tab ? ' active' : '') + '" data-tab="' + tab + '">' + esc(t(TAB_LABEL_KEYS[tab])) + '</button>';
  });
  html += '</div>';
  html += '<div class="rd-tab-panel" data-panel="arguments">' + buildArgsPanel(rs) + '</div>';
  html += '<div class="rd-tab-panel" data-panel="response">' + renderResponseValue(rs) + '</div>';
  html += '<div class="rd-tab-panel" data-panel="details">' + buildDetailsPanel(rs) + '</div>';
  detailEl.innerHTML = html;
  // Show only the active tab panel; hide the rest.
  detailEl.querySelectorAll('.rd-tab-panel').forEach(function (p) {
    p.hidden = p.dataset.panel !== rs.activeTab;
  });
  // Wire tab-switch click handlers.
  detailEl.querySelectorAll('.rd-tab').forEach(function (btn) {
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      var tab = btn.dataset.tab;
      if (rs.activeTab === tab) return;
      rs.activeTab = tab;
      detailEl.querySelectorAll('.rd-tab').forEach(function (b) { b.classList.toggle('active', b.dataset.tab === tab); });
      detailEl.querySelectorAll('.rd-tab-panel').forEach(function (p) { p.hidden = p.dataset.panel !== tab; });
      if (tab === 'response') maybeFetchResponse(rs, detailEl);
    });
  });
  // If the Response tab was already active when we rebuilt, ensure it is fetched/rendered.
  if (rs.activeTab === 'response') maybeFetchResponse(rs, detailEl);
  bindPolicySection(rs, detailEl);
}

// Dictionary keys for the detail tab strip, keyed by the data-tab value.
var TAB_LABEL_KEYS = {
  arguments: 'live.tab.arguments',
  response: 'live.tab.response',
  details: 'live.tab.details'
};

// Build the Arguments tab panel content from callEv.args.
function buildArgsPanel(rs) {
  if (rs.callEv && rs.callEv.args != null) {
    return '<pre class="rd-pre">' + esc(typeof rs.callEv.args === 'string' ? rs.callEv.args : JSON.stringify(rs.callEv.args, null, 2)) + '</pre>';
  }
  return '<div class="muted small">' + esc(t('live.args.none')) + '</div>';
}

// Build the "Description" section for a row's detail panel: the tool.call
// event's request-provided description (or a '—' placeholder when absent,
// mirroring the stream table's Description column). Text-only — the "Override"
// quick-action now lives in the Policy section's action row (buildPolicySection).
// All text is escaped.
export function buildDescriptionSection(rs) {
  var ev = rs.callEv || rs.resultEv;
  var desc = ev && typeof ev.description === 'string' ? ev.description : '';
  var label = esc(t('live.description'));
  var html = '<div class="rd-section description-section" role="group" aria-label="' + label + '">';
  html += '<div class="rd-label">' + label + '</div>';
  html += '<div class="rd-value">' + (desc !== '' ? esc(desc) : '\u2014') + '</div>';
  html += '</div>';
  return html;
}

// Build the Details tab panel content: description + result metadata + session
// + interventions + the Policy quick-actions. The Description section leads — it
// is the most fundamental detail of a tool call — so the details tab is never
// empty.
export function buildDetailsPanel(rs) {
  var ev = rs.callEv || rs.resultEv;
  var res = rs.resultEv;
  var html = buildDescriptionSection(rs);
  if (res) {
    html += '<div class="rd-section"><div class="rd-label">' + esc(t('live.details.result')) + '</div>';
    html += '<div class="rd-kv"><span>' + esc(t('live.details.ok')) + '</span> ' + esc(String(res.ok === true)) + '</div>';
    html += '<div class="rd-kv"><span>' + esc(t('live.details.chars')) + '</span> ' + (typeof res.chars === 'number' ? formatSize(res.chars) : '\u2014') + '</div>';
    html += '<div class="rd-kv"><span>' + esc(t('live.details.durationMs')) + '</span> ' + (typeof res.durationMs === 'number' ? String(res.durationMs) : '\u2014') + '</div>';
    html += '</div>';
  }
  // The row's effective turn usage (input / cache-hit input / output / total): the applied
  // turn.usage bound via rs.turnTokens, or a result/carried turn-usage object. The per-tool
  // In/Out columns are separate; this surfaces the REPORTED turn usage breakdown. Omitted
  // when unknown.
  var tk = (res && res.tokens && typeof res.tokens.total === 'number') ? res.tokens
       : (rs.turnTokens && typeof rs.turnTokens.total === 'number') ? rs.turnTokens
       : (ev && ev.tokens && typeof ev.tokens.total === 'number') ? ev.tokens
       : null;
  if (tk) {
    var parts = [];
    if (typeof tk.input === 'number') parts.push(t('live.tokens.in', { n: formatCount(tk.input) }));
    if (typeof tk.cacheHitInput === 'number') parts.push(t('live.tokens.cache', { n: formatCount(tk.cacheHitInput) }));
    if (typeof tk.output === 'number') parts.push(t('live.tokens.out', { n: formatCount(tk.output) }));
    if (typeof tk.total === 'number') parts.push(t('live.tokens.total', { n: formatCount(tk.total) }));
    if (parts.length) html += '<div class="rd-kv"><span>' + esc(t('live.details.tokensTurn')) + '</span> ' + parts.join(' · ') + '</div>';
  }
  var fullSession = (ev && ev.sessionKey) || '';
  if (fullSession) {
    html += '<div class="rd-section"><div class="rd-label">' + esc(t('live.details.session')) + '</div><div class="rd-value">' + esc(fullSession) + '</div></div>';
    // System prompt / client tools are shown per session group (buildSessionContextHtml), not here.
    var ivs = state.interventionsBySession.get(fullSession);
    if (ivs && ivs.length) {
      html += '<div class="rd-section"><div class="rd-label">' + esc(t('live.details.intervention')) + '</div>';
      ivs.forEach(function (iv) {
        html += '<div class="rd-kv"><span>' + esc(t('live.details.rule')) + '</span> ' + esc(iv.ruleId || '') + '</div>';
        html += '<div class="rd-kv"><span>' + esc(t('live.details.action')) + '</span> ' + esc(iv.action || '') + '</div>';
        if (iv.detail) html += '<div class="rd-kv"><span>' + esc(t('live.details.detail')) + '</span> ' + esc(iv.detail) + '</div>';
      });
      html += '</div>';
    }
  }
  html += buildPolicySection(rs);
  return html || '<div class="muted small">' + esc(t('live.details.none')) + '</div>';
}

// Derive the stable per-row id used to look up the stored tool result via REST.
function deriveResponseId(rs) {
  var re = rs.resultEv;
  var ce = rs.callEv;
  return (re && (re.toolCallId || re.id)) || (ce && ce.id) || rs.li.dataset.callId || '';
}

// Lazily fetch the tool-result content on first activation of the Response tab.
// Fires exactly one fetch per row; subsequent activations render the cached state.
function maybeFetchResponse(rs, detailEl) {
  var panelEl = detailEl.querySelector('[data-panel="response"]');
  if (!panelEl) return;
  var id = deriveResponseId(rs);
  if (!id) {
    panelEl.innerHTML = '<div class="muted small">' + esc(t('live.response.unavailable')) + '</div>';
    return;
  }
  // Already dispatched (in-flight or settled) — just render the cached state
  // without refetching, so a re-click while loading cannot fire a second fetch.
  if (rs.response) {
    panelEl.innerHTML = renderResponseValue(rs);
    return;
  }
  // First activation: fire exactly one fetch and store the result in row state.
  rs.response = { state: 'loading' };
  panelEl.innerHTML = '<div class="muted small">' + esc(t('live.response.loading')) + '</div>';
  fetch('api/tool-results/' + encodeURIComponent(id))
    .then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    })
    .then(function (data) {
      rs.response = { state: 'ok', data: data };
      if (panelEl.parentNode) panelEl.innerHTML = renderResponseValue(rs);
    })
    .catch(function (err) {
      rs.response = err.message === 'HTTP 404'
        ? { state: 'notfound' }
        : { state: 'error', errMsg: err.message };
      if (panelEl.parentNode) panelEl.innerHTML = renderResponseValue(rs);
    });
}

// Render the Response tab panel content from the cached rs.response state.
function renderResponseValue(rs) {
  var r = rs.response;
  if (!r || r.state === 'loading') return '<div class="muted small">' + esc(t('live.response.loading')) + '</div>';
  if (r.state === 'notfound') return '<div class="muted small">' + esc(t('live.response.notStored')) + '</div>';
  if (r.state === 'error') return '<div class="rd-err">' + esc(r.errMsg || t('live.response.errorFallback')) + '</div>';
  // state === 'ok'
  var content = r.data.content;
  var chars = r.data.chars;
  if (typeof content !== 'string' || content === '') return '<div class="muted small">' + esc(t('live.response.empty')) + '</div>';
  var html;
  try {
    html = '<pre class="rd-pre">' + esc(JSON.stringify(JSON.parse(content), null, 2)) + '</pre>';
  } catch (_e) {
    html = '<pre class="rd-pre">' + esc(content) + '</pre>';
  }
  if (typeof chars === 'number' && content.length < chars) {
    html += '<div class="muted small rd-trunc">' + t('live.response.truncated', { size: formatSize(chars) }) + '</div>';
  }
  return html;
}

// Remove data entries whose DOM rows have been trimmed from the list.
export function trimCallData() {
  var list = $('stream-list');
  var toDelete = [];
  state.callRows.forEach(function (rs, id) {
    if (rs.li.parentNode !== list) toDelete.push(id);
  });
  toDelete.forEach(function (id) { state.callRows.delete(id); });
  state.orphanResultEntries = state.orphanResultEntries.filter(function (e) { return e.li.parentNode === list; });
  var ivList = $('intervention-list');
  state.interventionRowData.forEach(function (_d, li) {
    if (li.parentNode !== ivList) state.interventionRowData.delete(li);
  });
  // Render-dedup map: drop sessions whose single row has been trimmed out of the list.
  state.interventionRowBySession.forEach(function (li, sk) {
    if (li.parentNode !== ivList) state.interventionRowBySession.delete(sk);
  });
}

/* ---- client-side filters ------------------------------------------ */
// Centralize the four stream filters (tool / status / session / time-window)
// into a single re-render path. readStreamFilters() normalizes the three
// text/select controls; rowPassesFilters() is the one AND-combined predicate —
// a row shows only when it passes EVERY active constraint, including the shared
// time window held in state.timeRange. applyFilters() is the ONLY place that
// toggles row visibility: both manual control changes and newly-streamed rows
// funnel through it, so the live view stays consistent while filtering. A
// control left at its "All"/empty value imposes no constraint, so clearing any
// input (or re-selecting its "All" option) cleanly restores the full set.
export function readStreamFilters() {
  // Read each control defensively: a missing element yields its "all"/empty
  // default instead of throwing, while an existing element behaves identically.
  var toolEl = $('filter-tool');
  var statusEl = $('filter-status');
  var sessionEl = $('filter-session');
  return {
    tool: (toolEl && toolEl.value ? String(toolEl.value) : '').trim().toLowerCase(),
    status: statusEl ? String(statusEl.value || '') : '',
    session: (sessionEl && sessionEl.value ? String(sessionEl.value) : '').trim().toLowerCase()
  };
}
// True when `row` satisfies every active filter constraint (tool AND status AND
// session AND time window). An absent/empty control value skips its constraint.
export function rowPassesFilters(row, f) {
  f = f || readStreamFilters();
  // All four constraints combine as AND: a row shows only when it passes every
  // active filter (tool AND status AND session AND time window). An absent/empty
  // control value skips that constraint. A concrete status (pending/ok/fail) is
  // never the category of an orphan ("Unmatched result") row — orphans are their
  // own category and match only "unmatched" or all — so they are excluded here.
  if (f.tool && (row.dataset.tool || '').toLowerCase().indexOf(f.tool) === -1) return false;
  if (f.status) {
    var isOrphan = !!row.classList.contains('orphan-row');
    var statusMatch = false;
    if (f.status === 'unmatched') statusMatch = isOrphan;
    else if (f.status === 'intervention') {
      var sess = row.dataset.session || '';
      var ivs = sess ? state.interventionsBySession.get(sess) : null;
      statusMatch = !!(ivs && ivs.length);
    } else if (isOrphan) statusMatch = false;
    else statusMatch = ((row.dataset.status || '') === f.status);
    if (!statusMatch) return false;
  }
  if (f.session && (row.dataset.session || '').toLowerCase().indexOf(f.session) === -1) return false;
  return inTimeRange(row.dataset.at);
}
// Show/hide rows in the stream list + intervention log per the active filters;
// update the "showing X of Y" count display. The single re-render path for all
// four filters (see readStreamFilters / rowPassesFilters above).
export function applyFilters() {
  var f = readStreamFilters();
  var list = $('stream-list');
  var visible = 0, total = 0;

  for (var i = 0; i < list.children.length; i++) {
    var child = list.children[i];
    if (!child.classList.contains('stream-row')) continue;
    total++;
    var show = rowPassesFilters(child, f);
    child.style.display = show ? '' : 'none';
    if (show) visible++;
  }
  var countEl = $('stream-count');
  if (countEl) {
    var anyFilter = !!(f.tool || f.status || f.session || state.timeRange.mode !== 'all');
    countEl.textContent = anyFilter ? t('live.count.showing', { visible: visible, total: total }) : '';
  }

  regroupStream();

  // The intervention log has no tool/status, so it is constrained only by the
  // session filter (when present) and the shared time-window.
  var ivList = $('intervention-list');
  for (var j = 0; j < ivList.children.length; j++) {
    var ivRow = ivList.children[j];
    if (!ivRow.classList.contains('stream-row')) continue;
    var ivShow = true;
    if (f.session && (ivRow.dataset.session || '').toLowerCase().indexOf(f.session) === -1) ivShow = false;
    if (ivShow && !inTimeRange(ivRow.dataset.at)) ivShow = false;
    ivRow.style.display = ivShow ? '' : 'none';
  }
}

// Wire up the tool / status / session filter listeners. The fourth filter — the
// time-window <select> — is wired in ../ui/controls.mjs (onTimeRangeChange). Every
// control funnels through the single applyFilters() re-render above, so live-
// appended rows and manual re-renders both honor the active filters. Each
// binding is guarded so a missing control can never abort app boot.
// Persisted "Group by session" preference (same try/catch pattern as theme.mjs).
// Only the exact string 'false' turns grouping off; anything else (missing, malformed) is the default true.
var GROUP_KEY = 'aitoolgate.groupBySession';
function readGroupPref() {
  try {
    state.groupBySession = localStorage.getItem(GROUP_KEY) !== 'false';
  } catch (e) {
    state.groupBySession = true; /* storage unavailable: keep default */
  }
}
function writeGroupPref(on) {
  try {
    localStorage.setItem(GROUP_KEY, on ? 'true' : 'false');
  } catch (e) {
    /* storage unavailable: preference applies for this page only */
  }
}

export function bindFilterEvents() {
  var toolEl = $('filter-tool');
  if (toolEl) toolEl.addEventListener('input', applyFilters);
  var sessionEl = $('filter-session');
  if (sessionEl) sessionEl.addEventListener('input', applyFilters);
  var statusEl = $('filter-status');
  if (statusEl) statusEl.addEventListener('change', applyFilters);
  var listEl = $('stream-list');
  if (listEl && boundStreamList !== listEl) {
    listEl.addEventListener('click', onStreamListClick);
    boundStreamList = listEl;
  }
  var groupEl = $('group-by-session');
  if (groupEl) {
    readGroupPref();
    groupEl.checked = !!state.groupBySession;
    groupEl.addEventListener('change', function () {
      state.groupBySession = !!groupEl.checked;
      writeGroupPref(state.groupBySession);
      applyFilters();
    });
    regroupStream();
  }
}

// "Group by session" layout. Rebuilds the whole list from the rows' own state
// (session key + streamSeq), so it is cheap at the MAX_LIST_ITEMS cap. With the
// mode off and no headers present it returns without touching the DOM, keeping
// the default flat newest-first list byte-identical.
export function regroupStream() {
  var list = $('stream-list');
  if (!list) return;
  list.classList.toggle('is-grouped', !!state.groupBySession);
  var head = $('stream-head');
  if (head) head.classList.toggle('is-grouped', !!state.groupBySession);
  var rows = [], heads = 0;
  for (var i = 0; i < list.children.length; i++) {
    var c = list.children[i];
    if (c.classList.contains('stream-group-head')) heads++;
    else if (c.classList.contains('stream-row')) rows.push(c);
  }
  if (!state.groupBySession && !heads) {
    layoutBatchHeads(list);
    return;
  }

  rows.sort(function (a, b) { return (b.streamSeq || 0) - (a.streamSeq || 0); });
  while (list.firstChild) list.removeChild(list.firstChild);

  if (!state.groupBySession) {
    rows.forEach(function (row) { row.classList.remove('is-collapsed', 'session-child'); list.appendChild(row); });
    layoutBatchHeads(list);
    return;
  }

  // Map insertion order = first (most recent) appearance of each session.
  var groups = new Map();
  rows.forEach(function (row) {
    var key = row.dataset.session || '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  });
  // Sessions that have a request/context but no call rows yet still get a group.
  // A zero-row session cannot match a tool/status filter, so only the session and
  // time-window filters apply to it.
  var f = readStreamFilters();
  getSessionContexts().forEach(function (ctx, key) {
    if (groups.has(key)) return; // already has rows: one group per session
    if (f.tool || f.status) return;
    if (f.session && key.toLowerCase().indexOf(f.session) === -1) return;
    if (!inTimeRange(ctx.at)) return;
    groups.set(key, []);
  });
  groups.forEach(function (groupRows, key) {
    var visible = groupRows.filter(function (r) { return r.style.display !== 'none'; }).length;
    var head = buildGroupHead(key, visible);
    if (!groupRows.length) head.style.display = ''; // context-only group stays visible
    list.appendChild(head);
    var collapsed = state.collapsedSessions.has(key);
    var ctxHtml = buildSessionContextHtml(key);
    if (ctxHtml && !collapsed && (visible > 0 || !groupRows.length)) {
      var ctxLi = el('li', 'stream-group-context');
      ctxLi.dataset.session = key;
      ctxLi.innerHTML = ctxHtml;
      list.appendChild(ctxLi);
    }
    groupRows.forEach(function (row) {
      row.classList.toggle('is-collapsed', collapsed);
      row.classList.add('session-child');
      list.appendChild(row);
    });
  });
  layoutBatchHeads(list);
}

function buildGroupHead(key, visible) {
  var collapsed = state.collapsedSessions.has(key);
  var head = el('li', 'stream-group-head');
  head.dataset.session = key;
  var name = key || t('stream.group.noSession');
  var btn = el('button', 'stream-group-toggle', collapsed ? '\u25B8' : '\u25BE');
  btn.type = 'button';
  btn.title = t('stream.group.toggleTitle');
  btn.setAttribute('aria-expanded', String(!collapsed));
  // Clicks are handled by the stable #stream-list delegate (onStreamListClick), so
  // rerendering/detaching this node cannot drop a click.
  var label = el('span', 'stream-group-label', name);
  label.title = name;
  var count = el('span', 'stream-group-count muted small',
    visible === 1 ? t('stream.group.execOne') : t('stream.group.execMany', { n: visible }));
  head.appendChild(btn);
  head.appendChild(label);
  head.appendChild(count);
  var usage = sessionUsageSummary(key);
  if (usage) {
    var parts = { context: formatCount(usage.latest), total: formatCount(usage.total) };
    var meta = el('span', 'stream-group-meta muted',
      usage.cache == null ? t('stream.group.usage', parts)
        : t('stream.group.usageCache', { context: parts.context, total: parts.total, cache: formatCount(usage.cache) }));
    meta.title = meta.textContent;
    head.appendChild(meta);
  }
  if (!visible) head.style.display = 'none';
  return head;
}
// Delegated click for group headers on the stable #stream-list. Any click inside a
// header (label, count, usage, or the keyboard-activated button) toggles it once.
function onStreamListClick(e) {
  var list = $('stream-list');
  var n = e && e.target;
  while (n && n !== list && !(n.classList && (n.classList.contains('stream-group-head') || n.classList.contains('stream-batch-head')))) n = n.parentNode;
  if (!n || n === list) return;
  if (n.classList.contains('stream-batch-head')) {
    var bkey = n.dataset.batch || '';
    if (collapsedBatches.has(bkey)) collapsedBatches.delete(bkey);
    else collapsedBatches.add(bkey);
    layoutBatchHeads(list);
    focusBatchToggle(bkey);
    return;
  }
  var key = n.dataset.session || '';
  if (state.collapsedSessions.has(key)) state.collapsedSessions.delete(key);
  else state.collapsedSessions.add(key);
  regroupStream();
  focusGroupToggle(key);
}
var boundStreamList = null;

// Restore keyboard focus on a group's toggle after regroupStream() rebuilt the header.
function focusGroupToggle(key) {
  var list = $('stream-list');
  if (!list) return;
  for (var i = 0; i < list.children.length; i++) {
    var c = list.children[i];
    if (c.classList.contains('stream-group-head') && c.dataset.session === key) {
      var b = c.firstChild;
      if (b && typeof b.focus === 'function') b.focus();
      return;
    }
  }
}

// Append a policy.intervention row to the intervention log as distinct cells:
// Time | Rule id | Action (type badge) | Detail (message). Reuses the
// InterventionEvent fields (at, ruleId, action, detail?). Built via DOM so
// untrusted text is escaped automatically. DEDUP: an already-seen sessionKey
// updates that session's EXISTING row IN PLACE (to the latest event, keeping the
// row in its current position — no re-prepend) instead of adding a new <li>; a
// new sessionKey gets a new row. Empty/absent sessionKeys keep the per-event
// behavior (every such event still gets its own row). The render-dedup map
// (state.interventionRowBySession) is trimmed in trimCallData() and cleared in
// clearOnScreenHistory(); it does NOT touch state.interventionsBySession
// (drill-down / the 'intervention' status filter), which still appends every
// event.
export function addInterventionRow(ev) {
  var sk = typeof ev.sessionKey === 'string' ? ev.sessionKey : '';
  var li = sk ? state.interventionRowBySession.get(sk) : undefined;
  if (li) {
    // A row for this session already exists: refresh its 4 cells + dataset in
    // place to the latest event. The row keeps its current position (no re-prepend).
    setInterventionRowCells(li, ev);
  } else {
    li = el('li', 'stream-row intervention-row');
    setInterventionRowCells(li, ev);
    if (sk) state.interventionRowBySession.set(sk, li);
    prependTrim($('intervention-list'), li, MAX_LIST_ITEMS);
    trimCallData();
  }
  state.interventionRowData.set(li, { ruleId: ev.ruleId || '', action: ev.action || '', at: ev.at, detail: ev.detail || '', sessionKey: sk });
  $('intervention-empty').hidden = true;
}

// Build (on creation) or refresh (on update) the four fixed-order intervention
// cells (Time | Rule id | Action | Detail) on a row so it reflects the given
// event. On creation the cells are absent and are appended in fixed order; on
// update the existing cells are located by class and refreshed IN PLACE so the
// same <li> (and its position) is preserved across repeated sessionKey events.
function setInterventionRowCells(li, ev) {
  li.dataset.at = ev.at;
  li.dataset.session = ev.sessionKey || '';
  var when = localeTimeTitle(ev.at);

  var timeEl = childByClass(li, 'iv-time') || el('time', 'iv-time');
  timeEl.textContent = fmtTime(ev.at);
  if (when) timeEl.title = when;

  var ruleEl = childByClass(li, 'iv-rule') || el('span', 'iv-rule muted');
  ruleEl.textContent = ev.ruleId || '';
  if (ev.ruleId) ruleEl.title = t('live.intervention.ruleId', { id: ev.ruleId });

  var actionEl = childByClass(li, 'iv-action') || el('span', 'badge badge-interv iv-action');
  actionEl.textContent = ev.action || t('live.action.fallback');

  var detailEl = childByClass(li, 'iv-detail') || el('span', 'iv-detail');
  detailEl.textContent = ev.detail || '';
  if (ev.detail) detailEl.title = ev.detail;

  // Append only on creation (a fresh <li> has no children); on update the cells
  // already exist in place and keep their current positions (no reordering).
  if (!li.children.length) {
    li.appendChild(timeEl);
    li.appendChild(ruleEl);
    li.appendChild(actionEl);
    li.appendChild(detailEl);
  }
}

// Locate a direct child of `li` by class name (works on the real DOM and the test
// stub, whose querySelector is a no-op). Returns null when no child has the class.
function childByClass(li, cls) {
  var kids = li.children;
  for (var i = 0; i < kids.length; i++) {
    var c = kids[i];
    if (c.classList && c.classList.contains(cls)) return c;
  }
  return null;
}

// Refresh the "this session" per-type counters driven by WS events.
export function updateLiveCounters() {
  $('live-calls').textContent = String(state.localCounts.calls);
  $('live-results').textContent = String(state.localCounts.results);
  $('live-interventions').textContent = String(state.localCounts.interventions);
}

// Re-render the runtime-generated text of this module in the active locale:
// stream head, row badges / tooltips, open detail panels, intervention rows and
// the filter count. Row structure and state are kept; only text is rewritten.
function relabelStreamRow(rs) {
  var badge = rs.li.querySelector('.badge');
  if (badge) badge.textContent = t('live.badge.' + rs.status);
  var dur = rs.li.querySelector('.s-duration');
  if (dur) dur.title = t('live.duration.title');
  var timeEl = rs.li.querySelector('.s-time');
  var ev = rs.callEv || rs.resultEv;
  if (timeEl && ev) timeEl.title = localeTimeTitle(ev.at);
  if (rs.tokenCells) applyTokenTitles(rs.tokenCells);
  if (rs.expanded) renderRowDetail(rs);
}
function refreshLiveViewText() {
  normalizeStreamHead();
  state.callRows.forEach(function (rs) { relabelStreamRow(rs); });
  state.orphanResultEntries.forEach(function (entry) { relabelStreamRow(entry.rs); });
  state.interventionRowData.forEach(function (d, li) { setInterventionRowCells(li, d); });
  if ($('stream-list')) applyFilters();
}
onLocaleChange(refreshLiveViewText);
