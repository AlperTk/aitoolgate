/* ==========================================================================
 * aitoolgate dashboard — i18n core.
 *
 * Flat dotted keys ("header.title") resolved against per-locale dictionaries
 * (./en.mjs, ./tr.mjs). Missing key: active locale -> English -> the key itself.
 * To add a language: create ./<code>.mjs (default-export a flat dictionary) and
 * add one entry to LOCALES plus one to DICTIONARIES below.
 * ==================================================================== */
import en from './en.mjs';
import tr from './tr.mjs';

export const LOCALES = [
  { code: 'en', label: 'English' },
  { code: 'tr', label: 'Türkçe' }
];

const DICTIONARIES = { en, tr };
const DEFAULT_LOCALE = 'en';
const STORAGE_KEY = 'dashboard.locale';

const listeners = new Set();
const boundSelects = new WeakSet();

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function isValidLocale(code) {
  return LOCALES.some((l) => l.code === code);
}

function readSavedLocale() {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch (e) {
    return null;
  }
}

function writeSavedLocale(code) {
  try {
    localStorage.setItem(STORAGE_KEY, code);
  } catch (e) {
    // storage unavailable (private mode / quota): keep the in-memory choice only
  }
}

let current = isValidLocale(readSavedLocale()) ? readSavedLocale() : DEFAULT_LOCALE;

export function getLocale() {
  return current;
}

// Translate a flat key; {name} placeholders are replaced from params.
export function t(key, params) {
  let text = hasOwn(DICTIONARIES[current], key) ? DICTIONARIES[current][key] : undefined;
  if (text === undefined) text = hasOwn(en, key) ? en[key] : key;
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (match, name) =>
    hasOwn(params, name) ? String(params[name]) : match
  );
}

// Translate every [data-i18n] node (textContent) and [data-i18n-attr] node
// ("attr:key,attr2:key2") under root. Including root itself if it matches.
export function applyI18n(root = document) {
  if (root === document) document.documentElement.lang = current;
  const collect = (selector) => {
    const nodes = Array.from(root.querySelectorAll(selector));
    if (typeof root.matches === 'function' && root.matches(selector)) nodes.unshift(root);
    return nodes;
  };
  for (const el of collect('[data-i18n]')) {
    el.textContent = t(el.getAttribute('data-i18n'));
  }
  for (const el of collect('[data-i18n-attr]')) {
    for (const pair of el.getAttribute('data-i18n-attr').split(',')) {
      const idx = pair.indexOf(':');
      if (idx < 1) continue;
      const attr = pair.slice(0, idx).trim();
      const key = pair.slice(idx + 1).trim();
      if (attr && key) el.setAttribute(attr, t(key));
    }
  }
}

// Subscribe to locale changes (fn receives the new code). Returns unsubscribe.
export function onLocaleChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// Switch locale: validates, persists, re-applies static texts, notifies subscribers.
// Returns false (and changes nothing) for an unknown code.
export function setLocale(code) {
  if (!isValidLocale(code)) return false;
  current = code;
  writeSavedLocale(code);
  applyI18n(document);
  for (const fn of listeners) {
    try {
      fn(code);
    } catch (e) {
      console.error('[i18n] locale listener failed: ' + (e && e.message ? e.message : String(e)));
    }
  }
  return true;
}

// Populate a <select> from LOCALES, reflect the active locale, and wire change -> setLocale.
export function initLocaleSelect(selectEl) {
  if (!selectEl) return;
  selectEl.replaceChildren(
    ...LOCALES.map(({ code, label }) => {
      const opt = document.createElement('option');
      opt.value = code;
      opt.textContent = label;
      return opt;
    })
  );
  selectEl.value = current;
  if (boundSelects.has(selectEl)) return;
  boundSelects.add(selectEl);
  selectEl.addEventListener('change', () => setLocale(selectEl.value));
  onLocaleChange((code) => {
    selectEl.value = code;
  });
}
