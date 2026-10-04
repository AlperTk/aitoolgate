/* ==========================================================================
 * mcp-manager dashboard — WebSocket lifecycle + polling fallback.
 *
 * The WebSocket is the low-latency primary source of live tool-call events; a
 * GET /api/events poll is the fallback so rows still populate when the browser
 * cannot open a WS (tunnel, port-forward, or a webview that drops the Upgrade
 * header). Both funnel through the single deduped ingest path so each row
 * renders once. A same-origin guard skips a guaranteed-bad WS open; a periodic
 * keepalive text frame self-heals a half-open (silently dead) socket by forcing
 * a reconnect. Timers live on `state` (reconnectTimer / eventsPollTimer /
 * keepaliveTimer / ws) so the lifecycle stays observable across modules.
 * ========================================================================== */
import { $ } from './dom.mjs';
import { state } from './state.mjs';
import { WS_RECONNECT_MS, EVENTS_POLL_MS, WS_KEEPALIVE_MS, WS_DEAD_AFTER_MS } from './constants.mjs';
import { handleWsMessage, ingestEvent } from './ingest.mjs';

// Reflect live/polling connectivity: toggle the header indicator classes, set a
// short header label, and show/hide the near-list #stream-status banner that
// explains we're falling back to /api/events polling when no WS is available.
export function setConnected(on) {
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
export function wsIsOpen() { return !!(state.ws && state.ws.readyState === WebSocket.OPEN); }

// Reflect true connectivity: open => live, otherwise polling/fallback. Used at
// startup and on every WS state transition so the header + banner never lag
// behind reality (e.g. a WS that is created but never reaches open state).
export function syncConnectivity() { setConnected(wsIsOpen()); }

// True only for a well-formed ws:/wss: URL on the SAME origin as this page
// (matching host + port). Lets us skip a guaranteed-bad WebSocket open (opaque
// or file: origins, empty host, etc.) and rely on the /api/events poll instead.
export function isValidSameOriginWsUrl(url) {
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
export function connectWS() {
  var url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
  if (!isValidSameOriginWsUrl(url)) { setConnected(false); return; } // rely on polling
  try { if (state.ws && state.ws.readyState !== WebSocket.CLOSED) state.ws.close(); } catch (_e) { /* ignore */ }
  var socket;
  try { socket = new WebSocket(url); }
  catch (_e) { setConnected(false); scheduleReconnect(); return; }
  state.ws = socket;
  state.ws.onopen = function () { state.wsLastInboundAt = Date.now(); startKeepalive(); syncConnectivity(); };
  state.ws.onmessage = function (ev) { handleWsMessage(ev.data); };
  state.ws.onerror = function () { /* a close follows — handled there */ };
  state.ws.onclose = function () { stopKeepalive(); syncConnectivity(); scheduleReconnect(); };
}

// Schedule a single retry after a short delay (guarded against stacking).
export function scheduleReconnect() {
  if (state.reconnectTimer != null) return;
  state.reconnectTimer = setTimeout(function () {
    state.reconnectTimer = null;
    connectWS();
  }, WS_RECONNECT_MS);
}

// GET /api/events and funnel every returned event through the single deduped
// ingest path. The server returns events oldest-first (ascending by `at`); we
// re-sort defensively and render oldest→newest so the newest lands on top via
// prependTrim, while the dedup set skips anything already shown over the WS.
// This is what populates the stream when no WebSocket is ever established.
export async function pollEvents() {
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
export function startEventsPolling() {
  stopEventsPolling();
  pollEvents();
  state.eventsPollTimer = setInterval(pollEvents, EVENTS_POLL_MS);
}

// Stop the single polling interval (idempotent).
export function stopEventsPolling() {
  if (state.eventsPollTimer != null) { clearInterval(state.eventsPollTimer); state.eventsPollTimer = null; }
}

// While the socket is open, send a periodic text frame; the server echoes each
// one back (refreshing state.wsLastInboundAt). If no inbound frame arrives within
// WS_DEAD_AFTER_MS while still marked open, the link is half-open → close it
// and force a reconnect (onclose fires → scheduleReconnect → connectWS again),
// replacing the silent half-open case. Polling keeps the stream alive meanwhile.
export function startKeepalive() {
  stopKeepalive();
  state.keepaliveTimer = setInterval(function () {
    if (!state.ws) return;
    try {
      if (state.ws.readyState !== WebSocket.OPEN) return; // closing/closed; onclose handles it
      state.ws.send('ping');
      if (Date.now() - state.wsLastInboundAt > WS_DEAD_AFTER_MS) {
        var dead = state.ws;
        try { dead.close(); } catch (_e) { /* ignore */ }
        if (state.ws === dead) { state.ws = null; syncConnectivity(); scheduleReconnect(); }
      }
    } catch (_e) { /* ignore */ }
  }, WS_KEEPALIVE_MS);
}

// Stop the keepalive timer (idempotent); called on close and before a restart.
export function stopKeepalive() {
  if (state.keepaliveTimer != null) { clearInterval(state.keepaliveTimer); state.keepaliveTimer = null; }
}
