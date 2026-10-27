/* ==========================================================================
 * aitoolgate dashboard — Settings popup/modal (master–detail).
 *
 * A full-viewport overlay opened from the header's gear icon (#open-settings,
 * see html/header.html). LEFT rail = vertical category menu built from the
 * exported SETTINGS_SECTIONS registry (extensible: unknown future ids render a
 * neutral "coming soon" stub); RIGHT panel = content for the selected section.
 * The only implemented section today is "API Providers" (see
 * settings-providers.mjs). Framework-free DOM + global fetch (injectable for
 * unit tests); all failures surface as inline messages — never crashes the page.
 *
 * Import graph: this -> dom.mjs, settings-providers.mjs. Wired once from app.js
 * init() AFTER mountLayout() has mounted the header fragment that hosts the trigger.
 * ==================================================================== */
import { $, el } from './dom.mjs';
import { createProvidersPane } from './settings-providers.mjs';

export { validateClientSide, formatProviderRow } from './settings-providers.mjs';

/* ---- extensible settings-section registry ---------------------------- */
/* Adding a future category = append one entry here; its left-rail item and
   right-panel stub (or real pane) are generated automatically below. */
export const SETTINGS_SECTIONS = [
  { id: 'apiProviders', label: 'API Providers' }
];

const DEFAULT_SECTION = SETTINGS_SECTIONS[0].id; // first registered section wins on open

let initialized = false; // single-instance guard: initSettings() runs exactly once even if called twice

export function initSettings(options) {
  var opts = options || {};
  if (initialized) return;
  initialized = true;

  var f = typeof opts.fetchImpl === 'function' ? opts.fetchImpl : globalThis.fetch;
  // Bind fetch to its global so it works whether injected or default.
  var doFetch = f && f.bind ? f.bind(typeof window !== 'undefined' ? window : globalThis) : f;
  var providers = createProvidersPane({ doFetch: doFetch });

  /* ---- module-local state ------------------------------------------- */
  var backdrop, dialogEl, railEl, panelEl, triggerEl;
  var currentSection = DEFAULT_SECTION;
  var openFlag = false;

  /* ============================== overlay markup ======================== */
  const BACKDROP_HTML =
    '<div class="settings-backdrop" hidden>' +
      '<div class="settings-card card" role="dialog" aria-modal="true" aria-labelledby="settings-title" tabindex="-1">' +
        '<div class="settings-head">' +
          '<h2 id="settings-title">Settings</h2>' +
          '<button type="button" class="btn icon-btn" id="settings-close" aria-label="Close settings">&#215;</button>' +
        '</div>' +
        '<div class="settings-body">' +
          '<nav class="settings-rail-nav" aria-label="Settings sections">' +
            '<ul id="settings-rail" class="settings-rail"></ul>' +
          '</nav>' +
          '<main id="settings-panel" class="settings-panel"></main>' +
        '</div>' +
      '</div>' +
    '</div>';

  function buildModal() {
    var tpl = document.createElement('template');
    tpl.innerHTML = BACKDROP_HTML.trim();
    backdrop = tpl.content.firstElementChild;
    dialogEl = $('settings-dialog') || backdrop.firstElementChild;
    document.body.appendChild(tpl.content);
  }

  /* ======================== master–detail panes ======================= */
  function placeholderPane(section) {
    var pane = el('section', 'settings-subpane settings-placeholder');
    pane.setAttribute('data-pane', section.id);
    var h3 = el('h3', 'section-title', section.label);
    var p = el('p', 'small muted', 'Coming soon.');
    pane.appendChild(h3); pane.appendChild(p);
    return pane;
  }

  function ensurePanesBuilt() {
    SETTINGS_SECTIONS.forEach(function (section) {
      var existing = panelEl.querySelector('.settings-subpane[data-pane="' + section.id + '"]');
      if (!existing) {
        panelEl.appendChild(section.id === 'apiProviders' ? providers.buildPane() : placeholderPane(section));
      }
    });
  }

  function renderRail() {
    railEl.textContent = '';
    SETTINGS_SECTIONS.forEach(function (section) {
      var li = el('li');
      var btn = el('button', 'rail-item' + (section.id === currentSection ? ' is-active' : ''), section.label);
      btn.type = 'button';
      btn.setAttribute('data-section-id', section.id);
      if (section.id === currentSection) btn.setAttribute('aria-current', 'true'); else btn.removeAttribute('aria-current');
      btn.addEventListener('click', function () { selectSection(section.id); });
      li.appendChild(btn);
      railEl.appendChild(li);
    });
  }

  function selectSection(id) {
    var known = SETTINGS_SECTIONS.some(function (s) { return s.id === id; });
    if (!known) return;                       // unknown ids are ignored by design
    currentSection = id;
    renderRail();
    Array.prototype.forEach.call(panelEl.children, function (pane) {
      pane.hidden = pane.getAttribute('data-pane') !== id;
    });
    if (id === 'apiProviders') providers.onShow(); // fresh data on every show (hot-apply aware)
  }

  function openSettings() {
    if (openFlag) return;
    openFlag = true;
    selectSection(currentSection);           // refreshes the visible pane's data
    backdrop.hidden = false;
    backdrop.classList.add('is-open');
    dialogEl.focus();                       // focus moved into the dialog on open
  }

  function closeSettings() {
    if (!openFlag) return;
    openFlag = false;
    backdrop.classList.remove('is-open');
    backdrop.hidden = true;
    try { triggerEl && triggerEl.focus(); } catch (_e) { /* trigger may be detached */ }
  }

  function bindOverlayEvents() {
    $('settings-close').addEventListener('click', closeSettings);
    backdrop.addEventListener('click', function (ev) {   // backdrop click closes; card clicks bubble with target≠backdrop
      if (ev.target === backdrop) closeSettings();
    });
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && openFlag) closeSettings();
    });
  }

  buildModal();
  railEl = $('settings-rail');
  panelEl = $('settings-panel');
  ensurePanesBuilt();
  renderRail();
  Array.prototype.forEach.call(panelEl.children, function (pane) { pane.hidden = pane.getAttribute('data-pane') !== currentSection; });
  bindOverlayEvents();

  triggerEl = $('open-settings');
  if (triggerEl) triggerEl.addEventListener('click', openSettings);
  else console.warn('[settings] Missing #open-settings trigger in header — settings modal not wired.');
}
