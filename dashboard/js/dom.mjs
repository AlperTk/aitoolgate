/* ==========================================================================
 * mcp-manager dashboard — DOM / format / notice helpers.
 *
 * Pure, framework-free helpers: by-id DOM access, element construction,
 * untrusted-text escaping, time/number formatting, and notice + form-error
 * banner updates. The only cross-module dependency is the shared "no data
 * yet" tooltip constant, imported from ./constants.mjs.
 * ========================================================================== */
import { NO_DATA_TIP } from './constants.mjs';

/* ---- tiny DOM helpers ---------------------------------------------- */
export function $(id) { return document.getElementById(id); }
// Create an element with an optional class and text content.
export function el(tag, className, text) {
  var n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
}
// Escape untrusted text before it is interpolated into innerHTML.
export function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
// Format an epoch-ms timestamp as local HH:MM:SS; '-' when absent/invalid.
export function fmtTime(ms) {
  if (typeof ms !== 'number' || !isFinite(ms)) return '-';
  var d = new Date(ms);
  function p(n) { return (n < 10 ? '0' : '') + n; }
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}
// True only for plain objects (records), not arrays or null.
export function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
export function errMsg(e) { return e && e.message ? e.message : String(e); }
// Show a short session key (hashes are long); truncate with an ellipsis.
export function shortSession(k) {
  k = String(k || '');
  return k.length > 14 ? k.slice(0, 12) + '…' : k;
}
// Format an optional numeric summary field (ms/token totals) as an integer;
// shows '—' when the field is absent (early in the run) or not finite.
export function fmtOpt(v) {
  return typeof v === 'number' && isFinite(v) ? String(Math.round(v)) : '—';
}

// Set a stat tile's displayed value (via fmtOpt) and attach/remove the
// "no data yet" tooltip depending on whether the value is present.
export function setStatValue(id, v) {
  var tileEl = $(id);
  var txt = fmtOpt(v);
  tileEl.textContent = txt;
  if (txt === '\u2014') tileEl.title = NO_DATA_TIP; else tileEl.removeAttribute('title');
}

/* ============================== notices ============================ */
export function showNotice(msg) {
  var n = $('notice');
  if (!msg) return;
  n.textContent = msg;
  n.hidden = false;
}
export function clearNotice() {
  var n = $('notice');
  n.textContent = '';
  n.hidden = true;
}
export function showFormError(msg) {
  var n = $('form-error');
  if (msg) { n.textContent = msg; n.hidden = false; }
  else { n.textContent = ''; n.hidden = true; }
}
