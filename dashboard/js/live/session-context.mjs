/* ==========================================================================
 * aitoolgate dashboard — per-session client context (system prompt + tools).
 *
 * Keeps the latest session.context per session key, plus a bounded history of
 * distinct prompt versions per session, and renders the session-level context
 * block shown in a session group's expanded body. Leaf module: it imports only
 * core/dom.mjs escaping and never imports live/view.mjs.
 * ========================================================================== */
import { esc } from '../core/dom.mjs';

// Latest client context (system prompt + tool definitions) per session key. Only the most recent
// session.context event per session is kept; an older (replayed) event never overwrites a newer one.
const contextBySession = new Map();
const promptHistoryBySession = new Map();

// Distinct prompt versions per session (keyed by version, so replay/WS duplicates collapse to one entry).
// Bounded per session; the newest versions are kept.
var MAX_PROMPT_VERSIONS = 20;

// Store a session.context event as the latest context for its session (no regroup side effects).
export function storeSessionContext(ev) {
  var sk = ev.sessionKey || '';
  if (!sk) return false;
  var version = typeof ev.promptVersion === 'number' ? ev.promptVersion : 0;
  if (version > 0) rememberPromptVersion(sk, version, ev);
  var prev = contextBySession.get(sk);
  if (prev && typeof ev.at === 'number' && typeof prev.at === 'number' && ev.at < prev.at) return false;
  contextBySession.set(sk, { systemPrompt: ev.systemPrompt, tools: ev.tools, at: ev.at, version: version });
  return true;
}

// Live read-only view of the latest context per session key (the stored map itself, not a copy).
export function getSessionContexts() {
  return contextBySession;
}

// Clear all stored session context and prompt-version history.
export function clearSessionContext() {
  contextBySession.clear();
  promptHistoryBySession.clear();
}

function rememberPromptVersion(sk, version, ev) {
  var versions = promptHistoryBySession.get(sk);
  if (!versions) { versions = new Map(); promptHistoryBySession.set(sk, versions); }
  if (!versions.has(version)) versions.set(version, { systemPrompt: ev.systemPrompt || '', at: ev.at });
  while (versions.size > MAX_PROMPT_VERSIONS) versions.delete(versions.keys().next().value);
}

// Render one details <pre> block of text (escaped; never injected as HTML).
function contextPre(text) {
  return '<pre class="rd-value">' + esc(text) + '</pre>';
}

// Session-level context block (system prompt + client tools) for a group's expanded body.
// Returns '' when the session has no context. Text is escaped via contextPre/esc.
export function buildSessionContextHtml(key) {
  var sk = key || '';
  var ctx = contextBySession.get(sk);
  if (!ctx) return '';
  var toolsList = Array.isArray(ctx.tools) ? ctx.tools : [];
  var prompt = ctx.systemPrompt || '';
  var current = ctx.version || 0;
  var html = '<div class="rd-section ctx-section"><details class="ctx-disclosure">';
  html += '<summary class="rd-label">System prompt' + (current ? ' v' + current + ' (current)' : '') + (prompt ? ' (' + prompt.length + ' chars)' : '') + '</summary>';
  html += prompt ? contextPre(prompt) : '<div class="muted small">No system prompt in the latest request</div>';
  html += '</details></div>';
  var versions = promptHistoryBySession.get(sk);
  if (versions && versions.size > 1) {
    var prior = Array.from(versions.keys()).filter(function (v) { return v !== current; }).sort(function (a, b) { return b - a; });
    html += '<div class="rd-section ctx-section"><details class="ctx-disclosure">';
    html += '<summary class="rd-label">Prior prompt versions (' + prior.length + ')</summary>';
    prior.forEach(function (v) {
      var entry = versions.get(v);
      html += '<details class="ctx-disclosure ctx-tool"><summary class="small">v' + v + '</summary>';
      html += entry.systemPrompt ? contextPre(entry.systemPrompt) : '<div class="muted small">Empty system prompt</div>';
      html += '</details>';
    });
    html += '</details></div>';
  }
  html += '<div class="rd-section ctx-section"><details class="ctx-disclosure">';
  html += '<summary class="rd-label">Client tools (' + toolsList.length + ')</summary>';
  if (toolsList.length === 0) {
    html += '<div class="muted small">No tools in the latest request</div>';
  } else {
    toolsList.forEach(function (tool) {
      var json;
      try { json = JSON.stringify(tool, null, 2); } catch (_e) { json = String(tool); }
      var name = (tool && (tool.name || (tool.function && tool.function.name))) || 'tool';
      html += '<details class="ctx-disclosure ctx-tool"><summary class="small">' + esc(String(name)) + '</summary>';
      html += contextPre(json) + '</details>';
    });
  }
  html += '</details></div>';
  return html;
}
