---
name: development-guide
description: Repo-specific workflow for feature work in aitoolgate: codebase-first investigation, module boundaries, DRY/SOLID practice, dashboard i18n steps, and verification commands, verified against HEAD 155db02.
---

# aitoolgate — development guide

Read this before changing code. Background: [project.md](project.md), [architecture.md](architecture.md), [ui/dashboard.md](ui/dashboard.md), [policy-and-telemetry.md](policy-and-telemetry.md).

## 1. Investigate the existing code first

1. Find the feature's entry point and flow with `serena_find_symbol` / `get_symbols_overview`. Start from the module map in [architecture.md](architecture.md).
2. Read the existing implementation and its neighbours in the same folder. Look for an extension point before adding a new one: `PROVIDER_ADAPTERS` (`src/providers/registry.ts`), `CODECS` (`src/proxy/translate.ts`), `ACTION_STRATEGIES` (`src/policy/actions/index.ts`), `matchers/index.ts`.
3. Read the matching tests (see §5) to learn the expected behaviour and fixtures.
4. Check [architecture.md](architecture.md) "Design decisions" before adding a dependency. Runtime deps are zero by design; do not add packages without approval.

## 2. Respect the boundaries

- `src/ports/` holds framework-independent contracts. Adapters implement them. Don't import adapters from ports.
- `src/server/index.ts` is the composition root. Wire new stores or services there, not inside leaf modules.
- Keep the two vocabularies apart: wire `Protocol.id` (`openai-chat`, `anthropic-messages`) versus provider `wireProtocol` (`openai`, `anthropic`).
- Dashboard modules are ES modules under `dashboard/js/`. Feature modules bind to DOM ids that exist only after `layout.mjs` mounts the `html/` fragments.

## 3. DRY and SOLID, proportionately

- Before writing a helper, search for one: `dashboard/js/core/` (`dom.mjs`, `format.mjs`, `time.mjs`, `table.mjs`), `src/telemetry/`, `src/protocols/protocol-common.ts`-style shared code. Reuse it; do not add a near-copy.
- Extend a registry or strategy map (one new entry plus one module) rather than adding `if/else` branches across files.
- Keep a module to one reason to change. Put cross-cutting logic behind the existing port.
- Do not introduce new abstractions for a single call site. Three similar lines beat a premature helper.
- Stay in scope: no drive-by refactors in the same change.

## 4. Dashboard UI strings (i18n)

Every user-visible string must go through the existing i18n mechanism. Do not hardcode text in one language.

Verified API (`dashboard/js/i18n/index.mjs`):
- `t(key, params?)`: looks up a flat dotted key in the active locale, falls back to English, then to the key. `{name}` placeholders are filled from `params`.
- `applyI18n(root = document)`: fills `[data-i18n]` (textContent) and `[data-i18n-attr]` (`attr:key,attr2:key2`) nodes under `root`. Use it for static markup.
- `setLocale(code)`: validates, persists to `localStorage`, re-applies static texts, then notifies listeners.
- `onLocaleChange(fn)`: subscribe; returns an unsubscribe function. Use it to re-render dynamic text (examples: `live/view.mjs`, `rules/rules.mjs`, `settings/settings-providers.mjs` `relocalize`).
- `getLocale()`, `LOCALES`, `initLocaleSelect(selectEl)`.

Catalogs (verified): `dashboard/js/i18n/en.mjs` (default export, flat object) and `dashboard/js/i18n/tr.mjs` (same key set). Both are registered in `DICTIONARIES` in `index.mjs`.

Steps for a new string:
1. Pick a dotted key in the existing namespace style (for example `layout.loadFailed`, `schema.injectMessage.content.label`).
2. Add the key to **both** `en.mjs` and `tr.mjs`.
3. In markup, use `data-i18n` / `data-i18n-attr`, then call `applyI18n` on the fragment root. In JS, call `t(key, params)` and re-run it in an `onLocaleChange` subscriber if the text is rendered dynamically.
4. Adding a language: create `<code>.mjs`, add one `LOCALES` entry and one `DICTIONARIES` entry (both in `index.mjs`).

Known gap (verified): no test in `tests/` references i18n, so key parity between `en.mjs` and `tr.mjs` is not checked automatically. Compare the two key sets by hand.

## 5. Tests and verification

- Build and tests compile to `dist/`. Run `npm run build` before `npm test`; `npm test` runs `node --test 'dist/tests/**/*.test.js'`.
- Type-check: `npm run typecheck`.
- Focused tests: name the matching file in `tests/` (for example `tests/dashboard/*`, `tests/policy/*`, `tests/telemetry/*`, `tests/e2e/*`). Dashboard unit tests use `node:test`, `node:assert/strict` and `tests/dom-stub.ts`. There is no browser runner.
- Lint and formatting: none configured (see [project.md](project.md)). Do not invent a command.
- Never claim a check passed unless you ran it.

## 6. Dashboard caveat

`dashboard/js/data/transport.mjs` and `dashboard/js/data/ingest.mjs` are imported by `app.js` and tests but are **not tracked** at HEAD. `.gitignore` (`data/`) matches them. The committed UI therefore cannot load as-is. Do not assume the dashboard runs, and do not treat this guide as evidence that it is fixed. See [ui/dashboard.md](ui/dashboard.md).

## 7. Invariants to keep

- Management endpoints are unauthenticated and provider detail responses can include raw API keys. Do not widen exposure. Do not log secrets.
- Policy and telemetry must not break proxying: subscriber failures are isolated (`event-bus.ts`).
- Rule changes apply live through the rule getter. Don't cache rules at startup.
- Raw tool-result persistence is off by default (`TOOL_RESULTS_ENABLED=false`). Keep it that way unless the change requires otherwise.
- Changing a dashboard row shape or endpoint path requires updating the tests listed in [ui/dashboard.md](ui/dashboard.md) "Change playbook".

## 8. Workflow

1. Investigate (§1), then state the boundary you will touch (§2).
2. Reuse or extend existing registries and helpers (§3).
3. Add tests beside the existing focused tests (§5).
4. Localize any new UI string (§4).
5. Run `npm run build`, `npm run typecheck`, `npm test`.
6. Update memory only when the change alters documented facts.
