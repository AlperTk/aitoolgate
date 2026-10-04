/* ==========================================================================
 * mcp-manager dashboard — vanilla-JS SPA controller.
 *
 * A classic (non-module) browser script with zero dependencies. It talks to the
 * same-origin REST API (`api/stats`, `api/rules` — relative paths resolve to
 * `/api/...` when the page is served at `/`) and the built-in WebSocket at
 * `/ws`. All DOM access goes through the ids defined in index.html.
 * ========================================================================== */
(function () {
  'use strict';

  /* ---- tunables ------------------------------------------------------ */
  var MAX_LIST_ITEMS = 200;   // cap for the live + intervention lists
  var STATS_POLL_MS = 3000;   // fallback poll interval for /api/stats
  var WS_RECONNECT_MS = 1500; // retry delay after the socket closes
  var EVENTS_POLL_MS = 2500;     // polling interval for the /api/events fallback stream
  var WS_KEEPALIVE_MS = 10000;   // periodic keepalive text frame while the WS is open
  var WS_DEAD_AFTER_MS = WS_KEEPALIVE_MS * 3; // ~3 unanswered keepalive windows => dead
  var MAX_SEEN_EVENTS = 1000;    // cap on the dedup set of already-rendered event keys

  /* ---- tiny DOM helpers ---------------------------------------------- */
  function $(id) { return document.getElementById(id); }
  // Create an element with an optional class and text content.
  function el(tag, className, text) {
    var n = document.createElement(tag);
    if (className) n.className = className;
    if (text !== undefined) n.textContent = text;
    return n;
  }
  // Escape untrusted text before it is interpolated into innerHTML.
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
  // Format an epoch-ms timestamp as local HH:MM:SS; '-' when absent/invalid.
  function fmtTime(ms) {
    if (typeof ms !== 'number' || !isFinite(ms)) return '-';
    var d = new Date(ms);
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }
  // True only for plain objects (records), not arrays or null.
  function isPlainObject(v) {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
  }
  function errMsg(e) { return e && e.message ? e.message : String(e); }
  // Show a short session key (hashes are long); truncate with an ellipsis.
  function shortSession(k) {
    k = String(k || '');
    return k.length > 14 ? k.slice(0, 12) + '…' : k;
  }
  // Format an optional numeric summary field (ms/token totals) as an integer;
  // shows '—' when the field is absent (early in the run) or not finite.
  function fmtOpt(v) {
    return typeof v === 'number' && isFinite(v) ? String(Math.round(v)) : '—';
  }


  // Tooltip shown on a stat value / table cell that is still empty ("—").
  var NO_DATA_TIP = 'No data yet \u2014 appears once tool results arrive.';
  // Set a stat tile's displayed value (via fmtOpt) and attach/remove the
  // "no data yet" tooltip depending on whether the value is present.
  function setStatValue(id, v) {
    var tileEl = $(id);
    var txt = fmtOpt(v);
    tileEl.textContent = txt;
    if (txt === '\u2014') tileEl.title = NO_DATA_TIP; else tileEl.removeAttribute('title');
  }

  /* ---- module state -------------------------------------------------- */
  var ws = null;
  var reconnectTimer = null;
  var localCounts = { calls: 0, results: 0, interventions: 0 };
  var editingId = '';            // set while the form edits an existing rule
  // Defaults chosen so a freshly-emptied form still yields a valid RuleSpec:
  // matcher "loop" (all fields optional) + action "block" (all fields optional).
  var curMatcherType = 'loop';
  var curActionType = 'block';

  /* ---- resilience state for the dual-source live stream -----------
   * The WebSocket is the low-latency primary source. A /api/events poll is the
   * fallback so rows still populate when the browser cannot open a WS (tunnel,
   * port-forward, or a webview that drops the Upgrade header). Both funnel
   * through one deduped ingest path (ingestEvent) so each row renders once.
   */
  var eventsPollTimer = null;      // single-instance interval running pollEvents()
  var keepaliveTimer = null;       // periodic keepalive text frame while the WS is open
  var wsLastInboundAt = 0;         // epoch-ms of the last inbound WS frame (echoes count)
  var seenEventKeys = new Set();   // dedup gate: event keys already rendered (bounded)
  var callRows = new Map();           // callId -> { li, callEv, resultEv, status, expanded }
  var orphanResultEntries = [];       // [{ li, ev }] unmatched tool.result rows
  var interventionsBySession = new Map(); // sessionKey -> [{ ruleId, action, at, detail }]
  // Time-window filter applied client-side over the buffered (retained) events.
  // mode: 'all' | 'preset' | 'custom'; startMs/endMs (epoch ms) bound the window.
  var timeRange = { mode: 'all' };
  // Preset minute values for the quick time-range selector (window ends at selection time).
  var TIME_PRESETS = { '5m': 5, '15m': 15, '1h': 60 };
  // Per-row raw data for intervention log rows (li -> { ruleId, action, at, detail,
  // sessionKey }), used by drill-down and export; kept in sync with the DOM by trimCallData().
  var interventionRowData = new Map();

  /* ---- field schemas -------------------------------------------------
   * Each dynamic form control is described here by `kind`. `readField` and
   * `makeField` interpret `kind`, and `clientValidate` enforces the required
   * fields the server's validateSpec also requires. This keeps the emitted
   * RuleSpec in sync with src/api/ruleSpec.ts without any framework.
   * ------------------------------------------------------------------- */
  var MATCHER_FIELDS = {
    loop: [
      { key: 'window', label: 'Window', kind: 'number', hint: 'Consecutive identical calls to flag (server default 4)' },
      { key: 'requireConsecutive', label: 'Require consecutive', kind: 'bool', def: true, hint: 'The run must sit at the tail of the sequence' },
      { key: 'paramIdentity', label: 'Param identity', kind: 'select', options: ['', 'exact', 'normalized'], hint: 'How repeated args are compared: exact vs normalized. Blank = default (normalized).' },
      { key: 'resultIdentity', label: 'Result identity', kind: 'select', options: ['', 'exact', 'normalized'], hint: 'How results are compared: exact vs normalized. Blank = default (normalized).' }
    ],
    toolName: [
      { key: 'toolName', label: 'Tool name', kind: 'text', hint: 'A single tool to match' },
      { key: 'toolNames', label: 'Tool names', kind: 'list', hint: 'Comma-separated; OR-ed with the single name' }
    ],
    argPattern: [
      { key: 'toolName', label: 'Tool name', kind: 'text', hint: 'Restrict to this tool (omit for all)' },
      { key: 'toolNames', label: 'Tool names', kind: 'list', hint: 'Comma-separated; omit for all' },
      { key: 'pattern', label: 'Argument pattern', kind: 'text', required: true, hint: 'Case-sensitive, matched against serialized args' }
    ]
  };
  var ACTION_FIELDS = {
    block: [
      { key: 'reason', label: 'Reason', kind: 'text', hint: 'Substituted for {reason}' },
      { key: 'message', label: 'Message', kind: 'text', hint: 'Verbatim; overrides template' },
      { key: 'template', label: 'Template', kind: 'text', hint: 'Supports {tool} and {reason}' }
    ],
    hideTool: [
      { key: 'toolNames', label: 'Tools to hide', kind: 'list', required: true, hint: 'Comma-separated tool names' }
    ],
    rewriteArgs: [
      { key: 'toolName', label: 'Tool name', kind: 'text', hint: 'Target by name' },
      { key: 'toolCallId', label: 'Tool call id', kind: 'text', hint: 'Takes precedence over the name' },
      { key: 'arguments', label: 'Arguments (JSON object)', kind: 'json', required: true, hint: 'Full replacement or partial merge' },
      { key: 'mode', label: 'Mode', kind: 'select', options: ['', 'replace', 'merge'], hint: 'replace = swap all arguments; merge = update only listed keys. Blank = default (replace).' }
    ],
    injectMessage: [
      { key: 'role', label: 'Role', kind: 'select', options: ['', 'user', 'system'], hint: 'Which role the injected message appears as. Blank = default (user).' },
      { key: 'content', label: 'Content', kind: 'area', required: true, hint: 'Text injected into the stream' }
    ]
  };

  /* ============================== notices ============================ */
  function showNotice(msg) {
    var n = $('notice');
    if (!msg) return;
    n.textContent = msg;
    n.hidden = false;
  }
  function clearNotice() {
    var n = $('notice');
    n.textContent = '';
    n.hidden = true;
  }
  function showFormError(msg) {
    var n = $('form-error');
    if (msg) { n.textContent = msg; n.hidden = false; }
    else { n.textContent = ''; n.hidden = true; }
  }

  /* ========================= stats / top tools ====================== */
  // Render one duration/token number cell, attaching the "no data yet" tooltip
  // only when the value is still absent (early in the run).
  function statNumCell(v) {
    var t = fmtOpt(v);
    return '<td class="num-col"' + (t === '\u2014' ? ' title="' + NO_DATA_TIP + '"' : '') + '>' + t + '</td>';
  }
  // Render the ranked top-tools table from a CollectorSummary.topTools array.
  // Attaches the "no data yet" tooltip to empty cells and to the Avg/Max column
  // headers whenever any duration value is still absent.
  function renderTopTools(top) {
    var tb = $('top-tools');
    tb.textContent = '';
    var table = tb.closest('table');
    var hasDash = false;
    var html = '';
    if (!top || !top.length) {
      hasDash = true;
      html = '<tr><td colspan="4" class="muted" title="' + NO_DATA_TIP + '">—</td></tr>';
    } else {
      top.forEach(function (t) {
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
  // GET /api/stats and refresh the counts + top-tools panel. Fetched on load
  // and every STATS_POLL_MS so numbers stay current even if the WS drops.
  async function refreshStats() {
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
      setStatValue('total-duration', s.totalDurationMs);
      setStatValue('avg-duration', s.avgDurationMs);
      $('interventions-retained').textContent = String(Array.isArray(s.interventions) ? s.interventions.length : 0);
      clearNotice();
    } catch (e) {
      showNotice('Stats unavailable: ' + errMsg(e));
    }
  }

  /* ========================= live event lists ======================= */
  // Prepend a row to a <ul>, keeping at most `max` children (newest-first).
  function prependTrim(listEl, node, max) {
    listEl.insertBefore(node, listEl.firstChild);
    while (listEl.children.length > max) {
      listEl.removeChild(listEl.lastChild);
    }
  }
  /* ---- unified call-row rendering -----------------------------------
   * One row per logical tool-call, tracked by call id in `callRows`. A
   * matching tool.result pairs back to its call row (by toolCallId or same-
   * session fallback) and updates it in place. Unmatched results are retained
   * as standalone "orphan" rows so no data is lost.
   */
  // Build a single call row, register it in callRows, and prepend it to the list.
  // Append the four numeric cells (In | Out | Total | Size) to a row's .row-main.
  // Each token column renders '\u2014' unless the event carries that field (tokens are only
  // present when the upstream provider reported usage); Size shows the paired result
  // payload size (chars) when known. Driven by tokens.input / tokens.output / tokens.total.
  function appendTokenAndSizeCells(main, ev) {
    var tokens = ev.tokens && typeof ev.tokens === 'object' ? ev.tokens : null;
    var inCell = el('span', 's-tokens-in col-num', tokens && typeof tokens.input === 'number' ? fmtOpt(tokens.input) : '\u2014');
    inCell.title = 'Input tokens (turn)';
    main.appendChild(inCell);
    var outCell = el('span', 's-tokens-out col-num', tokens && typeof tokens.output === 'number' ? fmtOpt(tokens.output) : '\u2014');
    outCell.title = 'Output tokens (turn)';
    main.appendChild(outCell);
    var totCell = el('span', 's-tokens-total col-num', tokens && typeof tokens.total === 'number' ? fmtOpt(tokens.total) : '\u2014');
    totCell.title = 'Turn tokens (in+out) \u2014 the full upstream turn total (dominated by resent history), not a per-tool cost.';
    main.appendChild(totCell);
    var sizeCell = el('span', 's-size col-num', typeof ev.chars === 'number' ? fmtOpt(ev.chars) : '\u2014');
    sizeCell.title = 'Result payload size (characters)';
    main.appendChild(sizeCell);
  }
  // Update a numeric cell's text from an optional value; leave it unchanged ('—') when absent.
  function setNumCellText(cell, v) {
    if (cell && typeof v === 'number' && isFinite(v)) cell.textContent = fmtOpt(v);
  }

  function createCallRow(ev) {
    var callId = ev.id || '';
    var li = el('li', 'stream-row call-row');
    if (callId) li.dataset.callId = callId;
    li.dataset.tool = ev.toolName || '';
    li.dataset.session = ev.sessionKey || '';
    li.dataset.status = 'pending';
    li.dataset.at = ev.at;

    var main = el('div', 'row-main');
    main.appendChild(el('span', 'badge badge-pending', 'pending'));
    main.appendChild(el('span', 's-tool', ev.toolName || ''));
    var sess = el('span', 's-session muted', shortSession(ev.sessionKey));
    sess.title = ev.sessionKey || '';
    main.appendChild(sess);
    var t = el('time', 's-time', fmtTime(ev.at));
    t.title = typeof ev.at === 'number' ? new Date(ev.at).toLocaleString() : '';
    main.appendChild(t);
    var dur = el('span', 's-duration col-num', '\u2014');
    dur.title = 'Duration (ms)';
    main.appendChild(dur);
    appendTokenAndSizeCells(main, ev);
    var exp = el('span', 's-expand', '\u25BE');
    exp.setAttribute('aria-hidden', 'true');
    main.appendChild(exp);

    var detail = el('div', 'row-detail');
    detail.hidden = true;

    li.appendChild(main);
    li.appendChild(detail);

    // Key the row state by the unique event id so each distinct batched same-name
    // call gets its own row (retaining the empty-id fallback for legacy events).
    var rs = { li: li, callEv: ev, resultEv: null, status: 'pending', expanded: false };
    if (callId) callRows.set(callId, rs);
    prependTrim($('stream-list'), li, MAX_LIST_ITEMS);
    $('stream-empty').hidden = true;
    trimCallData();
    bindRowClick(li, rs);
    applyFilters();
    return rs;
  }

  // Update an existing call row in place when its tool.result arrives.
  function updateCallRowWithResult(rs, ev) {
    rs.resultEv = ev;
    rs.status = ev.ok === false ? 'error' : 'ok';
    rs.li.dataset.status = rs.status;
    var badge = rs.li.querySelector('.badge');
    if (badge) {
      badge.className = 'badge ' + (ev.ok === false ? 'badge-err' : 'badge-ok');
      badge.textContent = ev.ok === false ? 'error' : 'ok';
    }
    var dur = rs.li.querySelector('.s-duration');
    if (dur && typeof ev.durationMs === 'number') dur.textContent = fmtOpt(ev.durationMs);
    // Update the numeric columns in place; absent values keep their existing '—'.
    setNumCellText(rs.li.querySelector('.s-tokens-in'), ev.tokens && ev.tokens.input);
    setNumCellText(rs.li.querySelector('.s-tokens-out'), ev.tokens && ev.tokens.output);
    setNumCellText(rs.li.querySelector('.s-tokens-total'), ev.tokens && ev.tokens.total);
    setNumCellText(rs.li.querySelector('.s-size'), ev.chars);
    if (rs.expanded) renderRowDetail(rs);
    applyFilters();
  }

  // Create a standalone row for a tool.result that could not be paired to any call.
  function createOrphanResultRow(ev) {
    var li = el('li', 'stream-row orphan-row');
    li.dataset.tool = ev.toolName || '';
    li.dataset.session = ev.sessionKey || '';
    li.dataset.status = ev.ok === false ? 'error' : 'ok';
    li.dataset.at = ev.at;

    var isErr = ev.ok === false;
    var main = el('div', 'row-main');
    main.appendChild(el('span', 'badge ' + (isErr ? 'badge-err' : 'badge-ok'), isErr ? 'error' : 'ok'));
    main.appendChild(el('span', 's-tool', ev.toolName || ''));
    var sess = el('span', 's-session muted', shortSession(ev.sessionKey));
    sess.title = ev.sessionKey || '';
    main.appendChild(sess);
    var t = el('time', 's-time', fmtTime(ev.at));
    t.title = typeof ev.at === 'number' ? new Date(ev.at).toLocaleString() : '';
    main.appendChild(t);
    var dur = el('span', 's-duration col-num', typeof ev.durationMs === 'number' ? fmtOpt(ev.durationMs) : '\u2014');
    dur.title = 'Duration (ms)';
    main.appendChild(dur);
    appendTokenAndSizeCells(main, ev);
    var exp = el('span', 's-expand', '\u25BE');
    exp.setAttribute('aria-hidden', 'true');
    main.appendChild(exp);

    var detail = el('div', 'row-detail');
    detail.hidden = true;

    li.appendChild(main);
    li.appendChild(detail);

    var rs = { li: li, callEv: null, resultEv: ev, status: isErr ? 'error' : 'ok', expanded: false };
    orphanResultEntries.push({ li: li, ev: ev, rs: rs });
    prependTrim($('stream-list'), li, MAX_LIST_ITEMS);
    $('stream-empty').hidden = true;
    trimCallData();
    bindRowClick(li, rs);
    applyFilters();
  }

  // Find the pending call row that a result event belongs to.
  function findCallForResult(ev) {
    if (ev.toolCallId) {
      var rs = callRows.get(ev.toolCallId);
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
      callRows.forEach(function (rs) {
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
  function matchAndRenderResult(ev) {
    var rs = findCallForResult(ev);
    if (rs) { updateCallRowWithResult(rs, ev); }
    else { createOrphanResultRow(ev); }
  }

  // Store an intervention event for later drill-down lookup by session key.
  function storeInterventionForDrillDown(ev) {
    var sk = ev.sessionKey || '';
    if (!sk) return;
    if (!interventionsBySession.has(sk)) interventionsBySession.set(sk, []);
    interventionsBySession.get(sk).push({ ruleId: ev.ruleId, action: ev.action, at: ev.at, detail: ev.detail });
  }

  // Wire the click-to-drill-down handler on a row.
  function bindRowClick(li, rs) {
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

  // Fill the inline detail block under a row with args / result / session / intervention.
  function renderRowDetail(rs) {
    var detailEl = rs.li.querySelector('.row-detail');
    if (!detailEl) return;
    var ev = rs.callEv || rs.resultEv;
    var res = rs.resultEv;
    var html = '';
    if (rs.callEv && rs.callEv.args != null) {
      html += '<div class="rd-section"><div class="rd-label">Arguments</div>';
      html += '<pre class="rd-pre">' + esc(typeof rs.callEv.args === 'string' ? rs.callEv.args : JSON.stringify(rs.callEv.args, null, 2)) + '</pre></div>';
    }
    if (res) {
      html += '<div class="rd-section"><div class="rd-label">Result</div>';
      html += '<div class="rd-kv"><span>ok:</span> ' + esc(String(res.ok === true)) + '</div>';
      html += '<div class="rd-kv"><span>chars:</span> ' + (typeof res.chars === 'number' ? String(res.chars) : '\u2014') + '</div>';
      html += '<div class="rd-kv"><span>durationMs:</span> ' + (typeof res.durationMs === 'number' ? String(res.durationMs) : '\u2014') + '</div>';
      if (res.tokens && typeof res.tokens.total === 'number') {
        html += '<div class="rd-kv"><span>tokens:</span> ' + fmtOpt(res.tokens.total) + '</div>';
      }
      html += '</div>';
    }
    var fullSession = (ev && ev.sessionKey) || '';
    if (fullSession) {
      html += '<div class="rd-section"><div class="rd-label">Session</div><div class="rd-value">' + esc(fullSession) + '</div></div>';
      var ivs = interventionsBySession.get(fullSession);
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
    if (!html) html = '<div class="muted small">No additional details.</div>';
    detailEl.innerHTML = html;
  }

  // Remove data entries whose DOM rows have been trimmed from the list.
  function trimCallData() {
    var list = $('stream-list');
    var toDelete = [];
    callRows.forEach(function (rs, id) {
      if (rs.li.parentNode !== list) toDelete.push(id);
    });
    toDelete.forEach(function (id) { callRows.delete(id); });
    orphanResultEntries = orphanResultEntries.filter(function (e) { return e.li.parentNode === list; });
    var ivList = $('intervention-list');
    interventionRowData.forEach(function (_d, li) {
      if (li.parentNode !== ivList) interventionRowData.delete(li);
    });
  }

  /* ---- client-side filters ------------------------------------------ */
  // Apply the current filter inputs (tool / status / session) AND the active
  // time-window to show/hide rows in both the stream list and the intervention
  // log; update the stream "showing X of Y" count display. The filters compose:
  // a row is shown only if it passes every active constraint.
  function applyFilters() {
    var toolF = ($('filter-tool').value || '').trim().toLowerCase();
    var statusF = $('filter-status').value;
    var sessionF = ($('filter-session').value || '').trim().toLowerCase();
    var list = $('stream-list');
    var visible = 0, total = 0;

    for (var i = 0; i < list.children.length; i++) {
      var child = list.children[i];
      if (!child.classList.contains('stream-row')) continue;
      total++;
      var show = true;
      if (toolF && (child.dataset.tool || '').toLowerCase().indexOf(toolF) === -1) show = false;
      if (show && statusF) {
        var st = child.dataset.status || '';
        if (statusF === 'unmatched') {
          show = !!child.classList.contains('orphan-row');
        } else if (statusF === 'intervention') {
          var sess2 = child.dataset.session || '';
          var ivs = sess2 ? interventionsBySession.get(sess2) : null;
          show = !!(ivs && ivs.length);
        } else {
          show = (st === statusF);
        }
      }
      if (show && sessionF && (child.dataset.session || '').toLowerCase().indexOf(sessionF) === -1) show = false;
      if (show && !inTimeRange(child.dataset.at)) show = false;
      child.style.display = show ? '' : 'none';
      if (show) visible++;
    }
    var countEl = $('stream-count');
    if (countEl) {
      var anyFilter = !!(toolF || statusF || sessionF || timeRange.mode !== 'all');
      countEl.textContent = anyFilter ? 'showing ' + visible + ' of ' + total : '';
    }

    // The intervention log has no tool/status, so it is constrained only by the
    // session filter (when present) and the shared time-window.
    var ivList = $('intervention-list');
    for (var j = 0; j < ivList.children.length; j++) {
      var ivRow = ivList.children[j];
      if (!ivRow.classList.contains('stream-row')) continue;
      var ivShow = true;
      if (sessionF && (ivRow.dataset.session || '').toLowerCase().indexOf(sessionF) === -1) ivShow = false;
      if (ivShow && !inTimeRange(ivRow.dataset.at)) ivShow = false;
      ivRow.style.display = ivShow ? '' : 'none';
    }
  }

  // Wire up filter input listeners.
  function bindFilterEvents() {
    $('filter-tool').addEventListener('input', applyFilters);
    $('filter-session').addEventListener('input', applyFilters);
    $('filter-status').addEventListener('change', applyFilters);
  }
  // Append a policy.intervention row to the intervention log as distinct cells:
  // Time | Rule id | Action (type badge) | Detail (message). Reuses the
  // InterventionEvent fields (at, ruleId, action, detail?). Built via DOM so
  // untrusted text is escaped automatically.
  function addInterventionRow(ev) {
    var li = el('li', 'stream-row intervention-row');
    li.dataset.at = ev.at;
    li.dataset.session = ev.sessionKey || '';
    var when = typeof ev.at === 'number' ? new Date(ev.at).toLocaleString() : '';

    var timeEl = el('time', 'iv-time', fmtTime(ev.at));
    if (when) timeEl.title = when;
    li.appendChild(timeEl);

    var ruleEl = el('span', 'iv-rule muted', ev.ruleId || '');
    if (ev.ruleId) ruleEl.title = 'Rule id: ' + ev.ruleId;
    li.appendChild(ruleEl);

    li.appendChild(el('span', 'badge badge-interv iv-action', ev.action || 'intervention'));

    var detailEl = el('span', 'iv-detail', ev.detail || '');
    if (ev.detail) detailEl.title = ev.detail;
    li.appendChild(detailEl);

    interventionRowData.set(li, { ruleId: ev.ruleId || '', action: ev.action || '', at: ev.at, detail: ev.detail || '', sessionKey: ev.sessionKey || '' });
    prependTrim($('intervention-list'), li, MAX_LIST_ITEMS);
    $('intervention-empty').hidden = true;
  }
  // Refresh the "this session" per-type counters driven by WS events.
  function updateLiveCounters() {
    $('live-calls').textContent = String(localCounts.calls);
    $('live-results').textContent = String(localCounts.results);
    $('live-interventions').textContent = String(localCounts.interventions);
  }
  /* ---- dual-source ingest: ONE deduped render path for WS + polling --
   * The WS onmessage handler AND the /api/events polling fallback BOTH funnel
   * through ingestEvent(). A module-level Set of already-rendered event keys
   * guarantees each event renders exactly once even when it arrives via both
   * sources (or is replayed), and keeps the per-type "this session" counters
   * from double-counting. The set is bounded to MAX_SEEN_EVENTS most-recent
   * keys so it never grows unbounded.
   */
  // Build a stable identity key for an event so a row renders at most once.
  // The unique event id is included so distinct batched same-name calls (identical
  // type/session/at/toolName) never share a key and collapse into one row. Non-call
  // events carry no id, so an empty trailing segment preserves the prior behavior.
  function eventKey(ev) {
    return ev.type + '|' + (ev.sessionKey || '') + '|' + ev.at + '|' + (ev.toolName || '') + '|' + (ev.id || '');
  }
  // Render one telemetry event only if its key has not been seen, then record it.
  // Accepts an object or a JSON string (the WS onmessage case). Non-telemetry
  // frames (e.g. the server's { echo }) are ignored without side effects.
  function ingestEvent(raw) {
    var ev = raw;
    if (typeof raw === 'string') { try { ev = JSON.parse(raw); } catch (_e) { return; } }
    if (!isPlainObject(ev)) return;
    var key = eventKey(ev);
    if (seenEventKeys.has(key)) return; // already rendered (cross-source or replay)
    seenEventKeys.add(key);
    while (seenEventKeys.size > MAX_SEEN_EVENTS) { // bound the set (drop oldest)
      seenEventKeys.delete(seenEventKeys.keys().next().value);
    }
    switch (ev.type) {
      case 'tool.call':
        localCounts.calls += 1; createCallRow(ev); updateLiveCounters(); break;
      case 'tool.result':
        localCounts.results += 1; matchAndRenderResult(ev); updateLiveCounters(); break;
      case 'policy.intervention':
        localCounts.interventions += 1; addInterventionRow(ev); storeInterventionForDrillDown(ev); updateLiveCounters(); applyFilters(); break;
      default:
        break; // echo / unknown frame — nothing to render
    }
  }
  // Dispatch one inbound WebSocket frame: ANY frame (including the { echo } the
  // server returns for each keepalive we send) counts as liveness activity, then
  // the single deduped ingest path decides whether a row should be rendered.
  function handleWsMessage(raw) {
    wsLastInboundAt = Date.now();
    ingestEvent(raw);
  }

  /* ========================= rules list / CRUD ====================== */
  // Build one <li> for a serialized RuleSpec with an enabled toggle + buttons.
  function renderRuleRow(spec) {
    var li = el('li', 'rule');
    var main = el('div', 'rule-main');
    var toggle = el('label', 'rule-toggle check');
    var cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = spec.enabled === true;
    toggle.appendChild(cb);
    var text = el('div', 'rule-text');
    text.appendChild(el('div', 'rule-desc', spec.description || ('Rule ' + spec.id)));
    text.appendChild(el('div', 'rule-id muted', spec.id || ''));
    main.appendChild(toggle);
    main.appendChild(text);
    var actions = el('div', 'rule-actions');
    var editBtn = el('button', 'btn', 'Edit');
    editBtn.type = 'button';
    var delBtn = el('button', 'btn btn-danger', 'Delete');
    delBtn.type = 'button';
    actions.appendChild(editBtn);
    actions.appendChild(delBtn);
    li.appendChild(main);
    li.appendChild(actions);
    cb.addEventListener('change', function () { toggleEnabled(spec, cb.checked); });
    editBtn.addEventListener('click', function () { loadSpecIntoForm(spec); });
    delBtn.addEventListener('click', function () { deleteRule(spec); });
    return li;
  }
  // Render the whole rule list from a RuleSpec[] and manage the empty state.
  function renderRules(rules) {
    var list = $('rule-list');
    list.textContent = '';
    var arr = Array.isArray(rules) ? rules : [];
    $('rule-empty').hidden = arr.length !== 0;
    arr.forEach(function (spec) { list.appendChild(renderRuleRow(spec)); });
  }
  // GET /api/rules and re-render — called after every mutation so the list is
  // always re-synced to the server (single source of truth).
  async function refreshRules() {
    try {
      var res = await fetch('api/rules');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      renderRules(await res.json());
      clearNotice();
    } catch (e) {
      showNotice('Rules unavailable: ' + errMsg(e));
    }
  }
  // Toggle a rule's enabled flag via PATCH /api/rules/{id} with a partial body.
  async function toggleEnabled(spec, enabled) {
    try {
      var res = await fetch('api/rules/' + encodeURIComponent(spec.id), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: enabled })
      });
      if (!res.ok && res.status !== 404) showNotice('Toggle failed: HTTP ' + res.status);
      refreshRules();
    } catch (e) {
      showNotice('Toggle error: ' + errMsg(e));
    }
  }
  // Delete a rule via DELETE /api/rules/{id}.
  async function deleteRule(spec) {
    var label = spec.description || spec.id;
    if (!window.confirm('Delete rule "' + label + '"?')) return;
    try {
      var res = await fetch('api/rules/' + encodeURIComponent(spec.id), { method: 'DELETE' });
      if (!res.ok && res.status !== 404) showNotice('Delete failed: HTTP ' + res.status);
      refreshRules();
    } catch (e) {
      showNotice('Delete error: ' + errMsg(e));
    }
  }

  /* ========================= dynamic form build ===================== */
  // Create one labelled control for a field definition, pre-filled from `value`.
  function makeField(prefix, def, value) {
    var wrap = el('div', 'field dyn');
    var id = prefix + '-' + def.key;
    var lab = el('label', null, def.label + (def.required ? ' *' : ''));
    lab.htmlFor = id;
    var c = document.createElement('input');
    switch (def.kind) {
      case 'list': c = document.createElement('textarea'); c.rows = 2; break;
      case 'json': c = document.createElement('textarea'); c.rows = 3; break;
      case 'area': c = document.createElement('textarea'); c.rows = 3; break;
      case 'number': c.type = 'number'; c.step = 1; break;
      case 'bool': c.type = 'checkbox'; break;
      case 'select':
        c = document.createElement('select');
        (def.options || ['']).forEach(function (opt) {
          var o = document.createElement('option');
          o.value = opt;
          o.textContent = opt === '' ? '(default)' : opt;
          c.appendChild(o);
        });
        break;
      default: c.type = 'text';
    }
    c.id = id;
    c.dataset.field = def.key;
    setFieldControlValue(c, def, value);
    wrap.appendChild(lab);
    wrap.appendChild(c);
    if (def.hint) wrap.appendChild(el('div', 'hint', def.hint));
    return wrap;
  }
  // Populate a control with a value based on its field `kind`.
  function setFieldControlValue(c, def, value) {
    switch (def.kind) {
      case 'text': case 'area': c.value = value == null ? '' : String(value); break;
      case 'list':
        c.value = Array.isArray(value) ? value.join(', ') : (value == null ? '' : String(value));
        break;
      case 'json': c.value = value == null ? '' : JSON.stringify(value, null, 2); break;
      case 'number': c.value = value == null ? '' : String(value); break;
      case 'bool':
        // No value → use the schema default (requireConsecutive defaults to true).
        c.checked = value == null ? (def.def === undefined ? true : !!def.def) : (value === true);
        break;
      case 'select': c.value = value == null ? '' : String(value); break;
    }
  }
  // Rebuild the matcher-fields container for a type, optionally pre-filled.
  function renderMatcherFields(type, values) {
    var box = $('matcher-fields');
    box.textContent = '';
    (MATCHER_FIELDS[type] || []).forEach(function (def) {
      box.appendChild(makeField('matcher-fields', def, values && values[def.key]));
    });
  }
  // Rebuild the action-fields container for a type, optionally pre-filled.
  function renderActionFields(type, values) {
    var box = $('action-fields');
    box.textContent = '';
    (ACTION_FIELDS[type] || []).forEach(function (def) {
      box.appendChild(makeField('action-fields', def, values && values[def.key]));
    });
  }
  // Read one control's value; returns { skip } or { value } or { err }.
  function readField(container, def) {
    var c = container.querySelector('[data-field="' + def.key + '"]');
    if (!c) return { skip: true };
    var raw = c.value;
    switch (def.kind) {
      case 'text': case 'area': {
        var t = String(raw).trim();
        return t === '' ? { skip: true } : { value: t };
      }
      case 'list': {
        var arr = String(raw).split(',').map(function (s) { return s.trim(); }).filter(function (s) { return s !== ''; });
        return arr.length === 0 ? { skip: true } : { value: arr };
      }
      case 'json': {
        var j = String(raw).trim();
        if (j === '') return { skip: true };
        var parsed;
        try { parsed = JSON.parse(j); } catch (_e) { return { err: '"' + def.key + '" must be valid JSON' }; }
        if (!isPlainObject(parsed)) return { err: '"' + def.key + '" must be a JSON object' };
        return { value: parsed };
      }
      case 'number': {
        var nraw = String(raw).trim();
        if (nraw === '') return { skip: true };
        var num = Number(nraw);
        if (isNaN(num)) return { err: '"' + def.key + '" must be a number' };
        return { value: num };
      }
      case 'bool':
        return { value: c.checked }; // always included (meaningful either way)
      case 'select':
      default:
        return raw === '' ? { skip: true } : { value: raw };
    }
  }
  // Read all fields for one section into `out`; returns an error string or null.
  function readSection(defs, container, out) {
    for (var i = 0; i < defs.length; i++) {
      var r = readField(container, defs[i]);
      if (r.err) return r.err;
      if (r.skip) continue;
      out[defs[i].key] = r.value;
    }
    return null;
  }
  // Client-side mirror of the server's validateSpec required-field checks so we
  // can reject obviously-incomplete rules before they hit the network.
  function clientValidate(spec) {
    if (typeof spec.enabled !== 'boolean') return '"enabled" must be a boolean';
    var m = spec.matcher, a = spec.action;
    if (!isPlainObject(m) || typeof m.type !== 'string') return 'a matcher with a "type" is required';
    if (m.type === 'argPattern' && !(typeof m.pattern === 'string' && m.pattern !== '')) {
      return 'matcher requires a non-empty "pattern"';
    }
    if (m.type === 'loop' && m.window !== undefined && typeof m.window !== 'number') {
      return 'matcher "window" must be a number';
    }
    if (!isPlainObject(a) || typeof a.type !== 'string') return 'an action with a "type" is required';
    if (a.type === 'hideTool' && !(Array.isArray(a.toolNames) && a.toolNames.length > 0)) {
      return 'action requires a non-empty "toolNames" array';
    }
    if (a.type === 'rewriteArgs' && !isPlainObject(a.arguments)) {
      return 'action requires an "arguments" object';
    }
    if (a.type === 'injectMessage' && !(typeof a.content === 'string' && a.content !== '')) {
      return 'action requires a non-empty "content" string';
    }
    return null;
  }
  // Assemble a full RuleSpec from the current form state; { spec } or { error }.
  function collectSpec() {
    var spec = { enabled: $('rule-enabled').checked };
    spec.matcher = { type: curMatcherType };
    var err = readSection(MATCHER_FIELDS[curMatcherType], $('matcher-fields'), spec.matcher);
    if (err) return { error: err };
    spec.action = { type: curActionType };
    err = readSection(ACTION_FIELDS[curActionType], $('action-fields'), spec.action);
    if (err) return { error: err };
    var d = $('rule-description').value.trim();
    if (d) spec.description = d;
    var pr = $('rule-priority').value.trim();
    if (pr !== '') {
      var n = Number(pr);
      if (isNaN(n)) return { error: '"priority" must be a number' };
      spec.priority = n;
    }
    var verr = clientValidate(spec);
    if (verr) return { error: verr };
    return { spec: spec };
  }
  // Load an existing rule's serialized spec into the form for editing.
  function loadSpecIntoForm(spec) {
    editingId = spec.id || '';
    curMatcherType = spec.matcher && spec.matcher.type ? spec.matcher.type : 'loop';
    curActionType = spec.action && spec.action.type ? spec.action.type : 'block';
    $('matcher-type').value = curMatcherType;
    $('action-type').value = curActionType;
    renderMatcherFields(curMatcherType, spec.matcher || {});
    renderActionFields(curActionType, spec.action || {});
    $('rule-enabled').checked = spec.enabled === true;
    $('rule-description').value = spec.description || '';
    $('rule-priority').value = typeof spec.priority === 'number' ? String(spec.priority) : '';
    updateFormMode();
    showFormError('');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  // Reset the form to a clean add-mode state.
  function resetForm() {
    editingId = '';
    curMatcherType = 'loop';
    curActionType = 'block';
    $('matcher-type').value = curMatcherType;
    $('action-type').value = curActionType;
    renderMatcherFields(curMatcherType);
    renderActionFields(curActionType);
    $('rule-enabled').checked = true;
    $('rule-description').value = '';
    $('rule-priority').value = '';
    updateFormMode();
    showFormError('');
  }
  // Reflect edit vs. add mode in the form buttons.
  function updateFormMode() {
    var editing = editingId !== '';
    $('btn-cancel').hidden = !editing;
    $('btn-add').textContent = editing ? 'Save changes' : 'Add rule';
  }
  // Submit the form: POST (add) or PATCH (edit) a RuleSpec, then re-render.
  async function saveRule(spec) {
    try {
      var url, method;
      if (editingId) { url = 'api/rules/' + encodeURIComponent(editingId); method = 'PATCH'; }
      else { url = 'api/rules'; method = 'POST'; }
      var res = await fetch(url, {
        method: method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(spec)
      });
      var data = null;
      try { data = await res.json(); } catch (_e) { /* non-JSON (204 / error text) */ }
      if (!res.ok) {
        showFormError(data && data.error ? data.error : 'Request failed (' + res.status + ')');
        return;
      }
      resetForm();
      refreshRules();
    } catch (e) {
      showFormError('Network error: ' + errMsg(e));
    }
  }
  function submitRule(e) {
    if (e) e.preventDefault();
    var r = collectSpec();
    if (r.error) { showFormError(r.error); return; }
    showFormError('');
    saveRule(r.spec);
  }

  /* ========================= WebSocket lifecycle ====================== */
  // Reflect live/polling connectivity: toggle the header indicator classes, set a
  // short header label, and show/hide the near-list #stream-status banner that
  // explains we're falling back to /api/events polling when no WS is available.
  function setConnected(on) {
    var bannerText = 'Live stream is down — showing recent tool calls via /api/events polling. Upgrades to live automatically once a WebSocket connects.';
    var s = $('conn-status');
    if (s) {
      s.classList.toggle('connected', !!on);
      s.classList.toggle('disconnected', !on);
      s.title = on ? 'Live stream connected' : bannerText;
    }
    var label = $('conn-label');
    if (label) label.textContent = on ? 'live' : 'polling';
    var banner = $('stream-status');
    if (banner) {
      banner.hidden = !!on;
      banner.textContent = on ? '' : bannerText;
    }
  }
  // True when the current socket is actually open (WebSocket.OPEN).
  function wsIsOpen() { return !!(ws && ws.readyState === WebSocket.OPEN); }
  // Reflect true connectivity: open => live, otherwise polling/fallback. Used at
  // startup and on every WS state transition so the header + banner never lag
  // behind reality (e.g. a WS that is created but never reaches open state).
  function syncConnectivity() { setConnected(wsIsOpen()); }
  // True only for a well-formed ws:/wss: URL on the SAME origin as this page
  // (matching host + port). Lets us skip a guaranteed-bad WebSocket open (opaque
  // or file: origins, empty host, etc.) and rely on the /api/events poll instead.
  function isValidSameOriginWsUrl(url) {
    try {
      var u = new URL(url);
      if (u.protocol !== 'ws:' && u.protocol !== 'wss:') return false;
      if (!u.hostname) return false;
      return u.hostname === location.hostname && (u.port || '') === (location.port || '');
    } catch (_e) { return false; }
  }
  // Open (or re-open) the same-origin /ws socket. Only opens a well-formed,
  // same-origin ws:/wss: URL; otherwise skips opening and lets polling be the
  // sole source (no pointless reconnect loop). Wires keepalive + self-heal and
  // reconnects forever on close, so a WS that never connects still self-heals.
  function connectWS() {
    var url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
    if (!isValidSameOriginWsUrl(url)) { setConnected(false); return; } // rely on polling
    try { if (ws && ws.readyState !== WebSocket.CLOSED) ws.close(); } catch (_e) { /* ignore */ }
    var socket;
    try { socket = new WebSocket(url); }
    catch (_e) { setConnected(false); scheduleReconnect(); return; }
    ws = socket;
    ws.onopen = function () { wsLastInboundAt = Date.now(); startKeepalive(); syncConnectivity(); };
    ws.onmessage = function (ev) { handleWsMessage(ev.data); };
    ws.onerror = function () { /* a close follows — handled there */ };
    ws.onclose = function () { stopKeepalive(); syncConnectivity(); scheduleReconnect(); };
  }
  // Schedule a single retry after a short delay (guarded against stacking).
  function scheduleReconnect() {
    if (reconnectTimer != null) return;
    reconnectTimer = setTimeout(function () {
      reconnectTimer = null;
      connectWS();
    }, WS_RECONNECT_MS);
  }

  /* ------------------------ events polling fallback ------------------ */
  // GET /api/events and funnel every returned event through the single deduped
  // ingest path. The server returns events oldest-first (ascending by `at`); we
  // re-sort defensively and render oldest→newest so the newest lands on top via
  // prependTrim, while the dedup set skips anything already shown over the WS.
  // This is what populates the stream when no WebSocket is ever established.
  async function pollEvents() {
    try {
      var res = await fetch('api/events');
      if (!res.ok) return;
      var data = await res.json();
      var arr = data && Array.isArray(data.events) ? data.events.slice() : [];
      arr.sort(function (a, b) {
        var ta = a && typeof a.at === 'number' ? a.at : 0;
        var tb = b && typeof b.at === 'number' ? b.at : 0;
        return ta - tb;
      });
      for (var i = 0; i < arr.length; i++) ingestEvent(arr[i]);
    } catch (_e) { /* offline / unreachable origin — keep polling silently */ }
  }
  // Start (or restart) exactly one polling interval. An immediate first fetch
  // populates the stream without waiting EVENTS_POLL_MS; guarded against stacking.
  function startEventsPolling() {
    stopEventsPolling();
    pollEvents();
    eventsPollTimer = setInterval(pollEvents, EVENTS_POLL_MS);
  }
  // Stop the single polling interval (idempotent).
  function stopEventsPolling() {
    if (eventsPollTimer != null) { clearInterval(eventsPollTimer); eventsPollTimer = null; }
  }

  /* ---------------------- WS keepalive + self-heal ------------------- */
  // While the socket is open, send a periodic text frame; the server echoes each
  // one back (refreshing wsLastInboundAt). If no inbound frame arrives within
  // WS_DEAD_AFTER_MS while still marked open, the link is half-open → close it
  // and force a reconnect (onclose fires → scheduleReconnect → connectWS again),
  // replacing the silent half-open case. Polling keeps the stream alive meanwhile.
  function startKeepalive() {
    stopKeepalive();
    keepaliveTimer = setInterval(function () {
      if (!ws) return;
      try {
        if (ws.readyState !== WebSocket.OPEN) return; // closing/closed; onclose handles it
        ws.send('ping');
        if (Date.now() - wsLastInboundAt > WS_DEAD_AFTER_MS) {
          var dead = ws;
          try { dead.close(); } catch (_e) { /* ignore */ }
          if (ws === dead) { ws = null; syncConnectivity(); scheduleReconnect(); }
        }
      } catch (_e) { /* ignore */ }
    }, WS_KEEPALIVE_MS);
  }
  // Stop the keepalive timer (idempotent); called on close and before a restart.
  function stopKeepalive() {
    if (keepaliveTimer != null) { clearInterval(keepaliveTimer); keepaliveTimer = null; }
  }

  /* ===================== global controls: time / clear / export ==== */
  // True when an event timestamp (epoch ms) falls inside the active time window.
  // 'all' keeps every row; a row with an unknown timestamp is excluded from any
  // specific window (it cannot be proven to fall within it).
  function inTimeRange(at) {
    if (timeRange.mode === 'all') return true;
    var t = (typeof at === 'number' && isFinite(at)) ? at : Number(at);
    if (!isFinite(t)) return false;
    if (timeRange.startMs != null && t < timeRange.startMs) return false;
    if (timeRange.endMs != null && t > timeRange.endMs) return false;
    return true;
  }
  // Parse a <input type="datetime-local"> value (local time) into epoch-ms or null.
  function parseLocalDatetime(v) {
    if (!v) return null;
    var d = new Date(v);
    return isNaN(d.getTime()) ? null : d.getTime();
  }
  // Compact local stamp for export file names, e.g. 20261004-143005.
  function stamp() {
    var d = new Date();
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) +
      '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  }
  // Escape a single CSV field (wrap in quotes and double any embedded quotes).
  function csvCell(v) {
    v = (v == null) ? '' : String(v);
    if (/[",\r\n]/.test(v)) v = '"' + v.replace(/"/g, '""') + '"';
    return v;
  }
  // Trigger a native browser download of text content via Blob + object URL (no deps).
  function downloadFile(filename, text, mime) {
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
  function callRecordFromRs(rs) {
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
  function interventionRecord(d) {
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
  function getVisibleCalls() {
    var out = [];
    var list = $('stream-list');
    for (var i = 0; i < list.children.length; i++) {
      var li = list.children[i];
      if (!li.classList.contains('stream-row')) continue;
      if (li.style.display === 'none') continue; // only rows passing the active filters
      var rec = null;
      if (li.classList.contains('orphan-row')) {
        for (var k = 0; k < orphanResultEntries.length; k++) {
          if (orphanResultEntries[k].li === li) { rec = callRecordFromRs(orphanResultEntries[k].rs); break; }
        }
      } else if (li.dataset.callId) {
        var rs = callRows.get(li.dataset.callId);
        if (rs) rec = callRecordFromRs(rs);
      }
      if (rec) out.push(rec);
    }
    return out;
  }
  // Records for every currently-visible (post-filter) intervention-list row.
  function getVisibleInterventions() {
    var out = [];
    var list = $('intervention-list');
    for (var i = 0; i < list.children.length; i++) {
      var li = list.children[i];
      if (!li.classList.contains('stream-row')) continue;
      if (li.style.display === 'none') continue; // only rows passing the active filters
      var d = interventionRowData.get(li);
      if (d) out.push(interventionRecord(d));
    }
    return out;
  }
  // Serialize visible call records to RFC-4180 CSV text.
  function buildCallsCsv(rows) {
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
  function buildInterventionsCsv(rows) {
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
  function exportJson(records, name) {
    downloadFile('mcp-manager-' + name + '-' + stamp() + '.json', JSON.stringify(records, null, 2), 'application/json');
  }
  // Download pre-built CSV text under a timestamped filename.
  function exportCsv(text, name) {
    downloadFile('mcp-manager-' + name + '-' + stamp() + '.csv', text, 'text/csv;charset=utf-8');
  }
  // Apply the custom from/to inputs to the active time window.
  function applyCustomTimeRange() {
    timeRange = { mode: 'custom' };
    var f = parseLocalDatetime($('filter-time-from').value);
    var t = parseLocalDatetime($('filter-time-to').value);
    if (f != null) timeRange.startMs = f;
    if (t != null) timeRange.endMs = t;
    applyFilters();
  }
  // Handle the time-range preset selector: all / relative presets / custom. A
  // relative preset captures "now" at selection time and applies a fixed window.
  function onTimeRangeChange() {
    var v = $('filter-time').value;
    var showCustom = (v === 'custom');
    $('filter-time-from').hidden = !showCustom;
    $('filter-time-to').hidden = !showCustom;
    if (showCustom) { applyCustomTimeRange(); return; }
    if (v === 'all') { timeRange = { mode: 'all' }; }
    else {
      var mins = TIME_PRESETS[v];
      var now = Date.now();
      timeRange = { mode: 'preset', startMs: now - mins * 60000, endMs: now };
    }
    applyFilters();
  }
  // Clear the client-side buffered events and visible lists only. The dedup set is
  // intentionally KEPT so already-seen events are not re-rendered by polling; new
  // events still stream in. Server aggregates (stats panel) are NOT touched.
  function clearOnScreenHistory() {
    callRows.clear();
    orphanResultEntries.length = 0;
    interventionsBySession.clear();
    interventionRowData.clear();
    localCounts.calls = 0; localCounts.results = 0; localCounts.interventions = 0;
    var sl = $('stream-list'); if (sl) sl.textContent = '';
    var il = $('intervention-list'); if (il) il.textContent = '';
    var se = $('stream-empty'); if (se) se.hidden = false;
    var ie = $('intervention-empty'); if (ie) ie.hidden = false;
    updateLiveCounters();
    applyFilters();
  }
  // Wire the global controls (time range, clear on-screen history, export).
  function bindControlEvents() {
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

  /* ============================== wiring ============================= */
  function bindFormEvents() {
    $('matcher-type').addEventListener('change', function () {
      curMatcherType = this.value;
      renderMatcherFields(curMatcherType);
      updateFormMode();
    });
    $('action-type').addEventListener('change', function () {
      curActionType = this.value;
      renderActionFields(curActionType);
      updateFormMode();
    });
    $('rule-form').addEventListener('submit', submitRule);
    $('btn-cancel').addEventListener('click', resetForm);
  }
  function init() {
    bindFormEvents();
    bindFilterEvents();
    bindControlEvents();
    renderMatcherFields(curMatcherType);
    renderActionFields(curActionType);
    updateFormMode();
    refreshStats();          // initial load: stats + rules in parallel
    refreshRules();
    connectWS();             // low-latency primary source (self-heals on close/dead)
    syncConnectivity();      // honest baseline: polling/fallback until the WS actually opens
    startEventsPolling();    // fallback: keeps the live stream alive without a WS
    setInterval(refreshStats, STATS_POLL_MS); // stats fallback poll
  }
  // The script is loaded at the end of <body> so the DOM is ready; guard just in case.
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
