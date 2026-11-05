// Light/dark palette: resolve, apply, persist, and bind the header toggle.
// The head script in index.html applies the same logic before first paint.
import { t, onLocaleChange } from '../i18n/index.mjs';

const KEY = 'aitoolgate.theme';
const TOGGLE_ID = 'theme-toggle';

function readStored() {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : null;
  } catch {
    return null;
  }
}

function writeStored(theme) {
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    /* storage unavailable (private mode / disabled): theme still applies for this page */
  }
}

function systemTheme() {
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function currentTheme() {
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}

function syncToggle(theme) {
  const btn = document.getElementById(TOGGLE_ID);
  if (!btn) return;
  const light = theme === 'light';
  btn.setAttribute('aria-pressed', String(light));
  const action = t(light ? 'theme.toDark' : 'theme.toLight');
  btn.title = action;
  btn.setAttribute('aria-label', action);
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  syncToggle(theme);
}

let toggleBound = false; // idempotent: one delegated listener no matter how often initTheme runs

export function initTheme() {
  applyTheme(readStored() || systemTheme());
  if (toggleBound) return;
  toggleBound = true;
  // applyI18n resets the toggle's data-i18n-attr labels to the light-mode text; re-apply the current state.
  onLocaleChange(() => syncToggle(currentTheme()));
  // Capture phase on document: runs before any bubbling handler in the page can
  // stopPropagation(), so a real pointer click on #theme-toggle always flips the theme.
  document.addEventListener('click', (e) => {
    const target = e.target instanceof Element ? e.target.closest('#' + TOGGLE_ID) : null;
    if (!target) return;
    const next = currentTheme() === 'light' ? 'dark' : 'light';
    writeStored(next);
    applyTheme(next);
  }, true);
}
