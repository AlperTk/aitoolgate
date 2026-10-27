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
import { $, el, esc, fmtOpt, fmtTime, showNotice } from './dom.mjs';
import { formatCount, formatSize } from './format.mjs';
import { state } from './state.mjs';
import { MAX_LIST_ITEMS } from './constants.mjs';
import { inTimeRange } from './time.mjs';
import { createRule, prefillNewRule, refreshRules, findDuplicatePolicyRule } from './rules.mjs';

// Prepend a row to a <ul>, keeping at most `max` children (newest-first).
export function prependTrim(listEl, node, max) {
  listEl.insertBefore(node, listEl.firstChild);
  while (listEl.children.length > max) {
    listEl.removeChild(listEl.lastChild);
  }
}
// Append the four numeric cells (In (est) | Out (est) | Total | Size) to a row's .row-main.
// In = the per-tool call-side token estimate (ev.callTokens, name + arguments, ~chars/4);
// '—' on result rows, which carry no callTokens.
// Out = the per-tool result-side token estimate (the paired tool.result's ev.tokens, a number
// ~chars/4); call rows created before their result show '—' and are filled in-place by
// updateCallRowWithResult; orphan result rows show their own value.
// Total = the turn-level context size (see applyTurnUsageToRows): rendered exactly once per
// turn on the last tool-call row, '—' elsewhere — NOT the sum of In and Out.
// Size = the paired result payload size (chars) when known.
// The three token cells are returned so the turn-usage application can update them in place.
export function appendTokenAndSizeCells(main, ev) {
  var tokens = ev.tokens && typeof ev.tokens === 'object' ? ev.tokens : null;
  var inCell = el('span', 's-tokens-in col-num', typeof ev.callTokens === 'number' ? formatCount(ev.callTokens) : '—');
  inCell.title = 'Call tokens (est) — estimate of the tokens spent invoking the tool (name + arguments), not provider-reported.';
  main.appendChild(inCell);
  var outCell = el('span', 's-tokens-out col-num', typeof ev.tokens === 'number' ? formatCount(ev.tokens) : '—');
  outCell.title = 'Result tokens (est) — estimate of the resolved result payload (chars/4).';
  main.appendChild(outCell);
  var totCell = el('span', 's-tokens-total col-num', tokens && typeof tokens.total === 'number' ? formatCount(tokens.total) : '—');
  totCell.title = 'Turn tokens — the full upstream turn total (context size), not a per-tool cost.';
  main.appendChild(totCell);
  var sizeCell = el('span', 's-size col-num', typeof ev.chars === 'number' ? formatSize(ev.chars) : '—');
  sizeCell.title = 'Result payload size (characters)';
  main.appendChild(sizeCell);
  // Return the token + size cells so callers (turn-usage application / result pairing) can
  // update them in place by stored reference (the test stub's querySelector is a no-op).
  return { in: inCell, out: outCell, total: totCell, size: sizeCell };
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
var STREAM_HEAD_CELLS = [
  ['Status', ''],
  ['Tool', ''],
  ['Session', ''],
  ['Time', ''],
  ['Dur (ms)', 'num-col'],
  ['In (est)', 'num-col'],
  ['Out (est)', 'num-col'],
  ['Context Size', 'num-col'],
  ['Size', 'num-col'],
];
// Rebuild the .stream-head so it contains exactly the canonical 10 cells,
// mirroring the .row-main layout. Container attributes are left intact; the
// final empty cell carries aria-hidden instead of scope.
export function normalizeStreamHead() {
  var head = $('stream-head');
  if (!head) return;
  while (head.firstChild) head.removeChild(head.firstChild);
  STREAM_HEAD_CELLS.forEach(function (c) {
    var th = el('th', c[1]);
    th.textContent = c[0];
    th.setAttribute('scope', 'col');
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

  var main = el('div', 'row-main');
  main.appendChild(el('span', 'badge badge-pending', 'pending'));
  var tool = el('span', 's-tool', ev.toolName || '');
  tool.title = ev.toolName || '';
  main.appendChild(tool);
  var sess = el('span', 's-session muted', ev.sessionKey || '');
  sess.title = ev.sessionKey || '';
  main.appendChild(sess);
  var t = el('time', 's-time', fmtTime(ev.at));
  t.title = typeof ev.at === 'number' ? new Date(ev.at).toLocaleString() : '';
  main.appendChild(t);
  var dur = el('span', 's-duration col-num', '\u2014');
  dur.title = 'Duration (ms)';
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
  var rs = { li: li, callEv: ev, resultEv: null, status: 'pending', expanded: false, tokenCells: tokenCells };
  if (callId) state.callRows.set(callId, rs);
  prependTrim($('stream-list'), li, MAX_LIST_ITEMS);
  $('stream-empty').hidden = true;
  trimCallData();
  bindRowClick(li, rs);
  applyFilters();
  return rs;
}

// Update an existing call row in place when its tool.result arrives.
export function updateCallRowWithResult(rs, ev) {
  rs.resultEv = ev;
  rs.status = ev.ok === false ? 'fail' : 'ok';
  rs.li.dataset.status = rs.status;
  var badge = rs.li.querySelector('.badge');
  if (badge) {
    badge.className = 'badge ' + (ev.ok === false ? 'badge-fail' : 'badge-ok');
    badge.textContent = ev.ok === false ? 'fail' : 'ok';
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
// input / cache-hit input / output / total), but only the Total cell is rendered on the LAST
// tool-call row of the turn: a batched turn's token mass is a single turn-level value (the
// turn's context size), so showing it once — on the final row — keeps the earlier rows clean
// instead of duplicating it. The per-tool In (call estimate) and Out (result estimate)
// columns are NOT affected: every row keeps its own values. Rows of OTHER turns are untouched.
export function applyTurnUsageToRows(ev) {
  if (!ev || !ev.tokens || typeof ev.tokens !== 'object') return;
  var tokens = ev.tokens;
  var lastRow = null;
  state.callRows.forEach(function (rs) {
    var ce = rs.callEv;
    if (!ce || ce.sessionKey !== ev.sessionKey || ce.at !== ev.at) return;
    rs.turnTokens = tokens;
    if (rs.expanded) renderRowDetail(rs);
    lastRow = rs;
  });
  if (lastRow) {
    var cells = lastRow.tokenCells;
    if (cells) {
      fillTokenCell(cells.total, tokens.total, formatCount);
    }
  }
}
// Set a row's numeric token cell from `v`, but only when it still shows the '—' placeholder
// (a row that already rendered its own token value keeps it).
function fillTokenCell(cell, v, fmt) {
  if (!cell || cell.textContent !== '—') return;
  setNumCellText(cell, v, fmt);
}

// Create a standalone row for a tool.result that could not be paired to any call.
export function createOrphanResultRow(ev) {
  var li = el('li', 'stream-row orphan-row');
  li.dataset.tool = ev.toolName || '';
  li.dataset.session = ev.sessionKey || '';
  li.dataset.status = ev.ok === false ? 'fail' : 'ok';
  li.dataset.at = ev.at;

  var isErr = ev.ok === false;
  var main = el('div', 'row-main');
  main.appendChild(el('span', 'badge ' + (isErr ? 'badge-fail' : 'badge-ok'), isErr ? 'fail' : 'ok'));
  var tool = el('span', 's-tool', ev.toolName || '');
  tool.title = ev.toolName || '';
  main.appendChild(tool);
  var sess = el('span', 's-session muted', ev.sessionKey || '');
  sess.title = ev.sessionKey || '';
  main.appendChild(sess);
  var t = el('time', 's-time', fmtTime(ev.at));
  t.title = typeof ev.at === 'number' ? new Date(ev.at).toLocaleString() : '';
  main.appendChild(t);
  var dur = el('span', 's-duration col-num', typeof ev.durationMs === 'number' ? fmtOpt(ev.durationMs) : '\u2014');
  dur.title = 'Duration (ms)';
  main.appendChild(dur);
  var tokenCells = appendTokenAndSizeCells(main, ev);
  var exp = el('span', 's-expand', '\u25BE');
  exp.setAttribute('aria-hidden', 'true');
  main.appendChild(exp);

  var detail = el('div', 'row-detail');
  detail.hidden = true;

  li.appendChild(main);
  li.appendChild(detail);

  var rs = { li: li, callEv: null, resultEv: ev, status: isErr ? 'fail' : 'ok', expanded: false };
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
    var label = tab.charAt(0).toUpperCase() + tab.slice(1);
    html += '<button type="button" class="rd-tab' + (rs.activeTab === tab ? ' active' : '') + '" data-tab="' + tab + '">' + label + '</button>';
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

// Wire the policy quick-action buttons built by buildPolicySection: the Policy
// section's Hide / Override / New controls. Called by renderRowDetail
// after the detail innerHTML is (re)built, so each fresh DOM has fresh
// listeners. Every button is bound by its data-policy attribute wherever it
// appears in the detail panel. Re-enables a clicked button once the action
// settles so rapid double-clicks do not stack requests.
function bindPolicySection(rs, detailEl) {
  var ev = rs.callEv || rs.resultEv;
  var name = ev && typeof ev.toolName === 'string' ? ev.toolName : '';
  if (!name) return;
  var description = ev && typeof ev.description === 'string' ? ev.description : '';
  detailEl.querySelectorAll('button[data-policy]').forEach(function (btn) {
    var action = btn.getAttribute('data-policy');
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (btn.disabled) return;
      btn.disabled = true;
      var p = handlePolicyAction(action, name, description);
      if (p && typeof p.then === 'function') {
        p.then(function () { btn.disabled = false; }, function () { btn.disabled = false; });
      } else {
        btn.disabled = false;
      }
    });
  });
}

// Build the Arguments tab panel content from callEv.args.
function buildArgsPanel(rs) {
  if (rs.callEv && rs.callEv.args != null) {
    return '<pre class="rd-pre">' + esc(typeof rs.callEv.args === 'string' ? rs.callEv.args : JSON.stringify(rs.callEv.args, null, 2)) + '</pre>';
  }
  return '<div class="muted small">No arguments.</div>';
}

// Build the "Description" section for a row's detail panel: the tool.call
// event's request-provided description (or a '—' placeholder when absent,
// mirroring the stream table's Description column). Text-only — the "Override"
// quick-action now lives in the Policy section's action row (buildPolicySection).
// All text is escaped.
export function buildDescriptionSection(rs) {
  var ev = rs.callEv || rs.resultEv;
  var desc = ev && typeof ev.description === 'string' ? ev.description : '';
  var html = '<div class="rd-section description-section" role="group" aria-label="Description">';
  html += '<div class="rd-label">Description</div>';
  html += '<div class="rd-value">' + (desc !== '' ? esc(desc) : '\u2014') + '</div>';
  html += '</div>';
  return html;
}

// Build the compact "Policy" quick-actions section for a row. Returns an HTML
// string when the row has a non-empty tool name, otherwise '' (name-less orphan
// rows show no policy controls). The three controls map to data-policy:
// hide | addDescription | new. All text is escaped; the arrow is U+2192.
export function buildPolicySection(rs) {
  var ev = rs.callEv || rs.resultEv;
  var name = ev && typeof ev.toolName === 'string' ? ev.toolName : '';
  if (!name) return '';
  var label = 'Policy actions for ' + name;
  return '<div class="rd-section policy-section" role="group" aria-label="' + esc(label) + '">'
    + '<div class="rd-label">Policy</div>'
    + '<div class="policy-actions">'
    + '<button type="button" class="btn btn-primary policy-btn" data-policy="hide" aria-label="Hide tool ' + esc(name) + '">Hide</button>'
    + '<button type="button" class="btn policy-btn policy-add-desc" data-policy="addDescription" aria-label="Override description for tool ' + esc(name) + '">Override</button>'
    + '<button type="button" class="btn policy-btn policy-new" data-policy="new" aria-label="Create new policy rule for tool ' + esc(name) + '">New policy \u2192</button>'
    + '</div>'
    + '</div>';
}
// Dispatch a policy quick-action by `action` ('hide' | 'new' |
// 'addDescription') for the given tool `name` (plus the row's description for
// 'addDescription'). Hide POSTs an enabled rule immediately; 'new' and
// 'addDescription' navigate to the pre-filled editor (synchronous) and return a
// resolved promise.
export function handlePolicyAction(action, name, description) {
  if (action === 'hide') {
    return createPolicyRule(name, {
      enabled: true,
      matcher: { type: 'toolName', toolName: name },
      action: { type: 'hideTool', toolNames: [name] }
    });
  }
  if (action === 'new') {
    prefillNewRule({
      enabled: true,
      matcher: { type: 'toolName', toolName: name },
      action: { type: 'hideTool', toolNames: [name] } // default action; the user changes it in the editor
    });
    return Promise.resolve();
  }
  if (action === 'addDescription') {
    prefillNewRule(name, typeof description === 'string' ? description : '');
    return Promise.resolve();
  }
  return Promise.resolve();
}
// Quick-create an enabled rule for `name` (spec already carries matcher + action).
// Minimal dedupe: if an ENABLED identical rule already exists in the cached
// state.rules, skip the POST and notify instead of stacking duplicates. On success
// re-sync the rules list (and state.rules) then confirm via the global notice.
// createRule has already surfaced a failure notice by the time it throws, so the
// catch only suppresses the success path.
export async function createPolicyRule(name, spec) {
  var actionType = spec.action && spec.action.type;
  var dup = findDuplicatePolicyRule(state.rules, name, actionType);
  if (dup && dup.enabled === true) {
    showNotice(name + ' is already hidden by an existing policy rule');
    return;
  }
  try {
    await createRule(spec);
    await refreshRules(); // re-sync the rendered list + state.rules
    showNotice(name + ' \u2192 policy rule created');
  } catch (e) {
    // createRule already called showNotice('Rule not created: ...')
    console.warn('createPolicyRule failed for ' + name, e);
  }
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
    html += '<div class="rd-section"><div class="rd-label">Result</div>';
    html += '<div class="rd-kv"><span>ok:</span> ' + esc(String(res.ok === true)) + '</div>';
    html += '<div class="rd-kv"><span>chars:</span> ' + (typeof res.chars === 'number' ? formatSize(res.chars) : '\u2014') + '</div>';
    html += '<div class="rd-kv"><span>durationMs:</span> ' + (typeof res.durationMs === 'number' ? String(res.durationMs) : '\u2014') + '</div>';
    html += '</div>';
  }
  // The row's effective turn usage (input / cache-hit input / output / total): the applied
  // turn.usage bound via rs.turnTokens, or a result/carried turn-usage object. The per-tool
  // In/Out columns are separate; this surfaces the REPORTED turn usage breakdown. Omitted
  // when unknown.
  var t = (res && res.tokens && typeof res.tokens.total === 'number') ? res.tokens
       : (rs.turnTokens && typeof rs.turnTokens.total === 'number') ? rs.turnTokens
       : (ev && ev.tokens && typeof ev.tokens.total === 'number') ? ev.tokens
       : null;
  if (t) {
    var parts = [];
    if (typeof t.input === 'number') parts.push('in ' + formatCount(t.input));
    if (typeof t.cacheHitInput === 'number') parts.push('cache ' + formatCount(t.cacheHitInput));
    if (typeof t.output === 'number') parts.push('out ' + formatCount(t.output));
    if (typeof t.total === 'number') parts.push('total ' + formatCount(t.total));
    if (parts.length) html += '<div class="rd-kv"><span>tokens (turn):</span> ' + parts.join(' · ') + '</div>';
  }
  var fullSession = (ev && ev.sessionKey) || '';
  if (fullSession) {
    html += '<div class="rd-section"><div class="rd-label">Session</div><div class="rd-value">' + esc(fullSession) + '</div></div>';
    var ivs = state.interventionsBySession.get(fullSession);
    if (ivs && ivs.length) {
      html += '<div class="rd-section"><div class="rd-label">Intervention</div>';
      ivs.forEach(function (iv) {
        html += '<div class="rd-kv"><span>rule:</span> ' + esc(iv.ruleId || '') + '</div>';
        html += '<div class="rd-kv"><span>action:</span> ' + esc(iv.action || '') + '</div>';
        if (iv.detail) html += '<div class="rd-kv"><span>detail:</span> ' + esc(iv.detail) + '</div>';
      });
      html += '</div>';
    }
  }
  html += buildPolicySection(rs);
  return html || '<div class="muted small">No additional details.</div>';
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
    panelEl.innerHTML = '<div class="muted small">Not available.</div>';
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
  panelEl.innerHTML = '<div class="muted small">Loading\u2026</div>';
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
  if (!r || r.state === 'loading') return '<div class="muted small">Loading\u2026</div>';
  if (r.state === 'notfound') return '<div class="muted small">Not available / not stored.</div>';
  if (r.state === 'error') return '<div class="rd-err">' + esc(r.errMsg || 'Error') + '</div>';
  // state === 'ok'
  var content = r.data.content;
  var chars = r.data.chars;
  if (typeof content !== 'string' || content === '') return '<div class="muted small">Empty.</div>';
  var html;
  try {
    html = '<pre class="rd-pre">' + esc(JSON.stringify(JSON.parse(content), null, 2)) + '</pre>';
  } catch (_e) {
    html = '<pre class="rd-pre">' + esc(content) + '</pre>';
  }
  if (typeof chars === 'number' && content.length < chars) {
    html += '<div class="muted small rd-trunc">\u2026 (' + formatSize(chars) + ' total chars)</div>';
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
    countEl.textContent = anyFilter ? 'showing ' + visible + ' of ' + total : '';
  }

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
// time-window <select> — is wired in ./controls.mjs (onTimeRangeChange). Every
// control funnels through the single applyFilters() re-render above, so live-
// appended rows and manual re-renders both honor the active filters. Each
// binding is guarded so a missing control can never abort app boot.
export function bindFilterEvents() {
  var toolEl = $('filter-tool');
  if (toolEl) toolEl.addEventListener('input', applyFilters);
  var sessionEl = $('filter-session');
  if (sessionEl) sessionEl.addEventListener('input', applyFilters);
  var statusEl = $('filter-status');
  if (statusEl) statusEl.addEventListener('change', applyFilters);
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
  var when = typeof ev.at === 'number' ? new Date(ev.at).toLocaleString() : '';

  var timeEl = childByClass(li, 'iv-time') || el('time', 'iv-time');
  timeEl.textContent = fmtTime(ev.at);
  if (when) timeEl.title = when;

  var ruleEl = childByClass(li, 'iv-rule') || el('span', 'iv-rule muted');
  ruleEl.textContent = ev.ruleId || '';
  if (ev.ruleId) ruleEl.title = 'Rule id: ' + ev.ruleId;

  var actionEl = childByClass(li, 'iv-action') || el('span', 'badge badge-interv iv-action');
  actionEl.textContent = ev.action || 'intervention';

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
