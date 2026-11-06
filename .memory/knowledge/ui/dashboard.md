---
name: dashboard
description: Dashboard UI scope, source map, live/settings data flows, change playbook, UI tests and the verified missing-import caveat for aitoolgate's static vanilla-JS dashboard at HEAD.
---

# aitoolgate — dashboard UI

Cross-cutting system context (server mounting, API surface) lives in [../architecture.md](../architecture.md).

## Scope and source map (evidence: committed `dashboard/` and `tests/dashboard/` at HEAD)

Static vanilla-JS UI. No framework, no bundler, no browser test runner. Served by `src/server/index.ts` (`resolveDashboardDir`, static handler). `index.html` loads `dashboard/app.js` as `type="module"`.

| Path | Owns |
| --- | --- |
| `app.js` | Entry. `boot()` is idempotent. Awaits `mountLayout()`, then `init()` |
| `js/ui/layout.mjs` | Fetches `html/header.html` and `html/rules-view.html` into shell slots |
| `js/core/state.mjs` | Shared `state` object (open WebSocket, live rows, cleared-before marker in localStorage) |
| `js/core/constants.mjs` | Poll intervals (`STATS_POLL_MS` 3000, `EVENTS_POLL_MS` 2500) |
| `js/core/dom.mjs`, `format.mjs`, `time.mjs`, `table.mjs` | DOM helpers (`$`, `el`), formatting, time, table utilities |
| `js/i18n/` | `en`/`tr` string tables, `t()`, `applyI18n`, `onLocaleChange` |
| `js/ui/` | Layout mount, views/tabs, stats panel, controls, theme |
| `js/data/transport.mjs`, `js/data/ingest.mjs` | Event transport and ingest. **Not in HEAD** (see caveat) |
| `js/live/view.mjs` | Live tool-call stream: rows, filters, session/batch grouping, detail panel, tool-result fetch |
| `js/live/policy-actions.mjs`, `session-context.mjs` | Policy-intervention rows and session context helpers |
| `js/rules/` | Rule form (`rules.mjs`), schema (`rule-schema.mjs`), summary (`rule-summary.mjs`) |
| `js/settings/settings.mjs` | Settings modal, sections (`SETTINGS_SECTIONS`), `initSettings` |
| `js/settings/settings-providers.mjs` | Provider pane: API-backed CRUD, probe, device-OAuth flow (`PROVIDERS_BASE = 'api/api-providers'`) |
| `css/*.css`, `styles.css` | Styles (`tokens.css` first, then base/layout/components/table/controls/rules/settings/responsive) |

## Observed structure and data flows

**Navigation.** View/tab switching lives in `js/ui/views.mjs` (`initViews`; mechanism not traced). Header and rules markup come from `html/` fragments, not from `index.html`. Feature modules bind to DOM ids that exist only after mount.

**Stats.** `js/ui/stats.mjs` fetches `api/stats` on load and every `STATS_POLL_MS`. Reset is `POST api/stats/reset`.

**Live events.** `js/data/transport.mjs` opens `/ws` as the primary source. If no same-origin WebSocket is available, it falls back to polling `api/events` every `EVENTS_POLL_MS`. Overrides: `?ws=` or `window.ATG_WS_URL`.

**Settings and provider flow.** `settings-providers.mjs` calls `POST api/api-providers/probe` (`{protocol, baseUrl, apiKey?, id?}`) and `POST api/api-providers/device-flow/start|poll|confirm` (poll returns `pending|slow_down|expired|denied|done`; confirm persists once). Provider CRUD uses the same `api/api-providers` base. Only endpoints verified in UI source are listed. Route handlers live in `src/api/http.ts`.

**UI endpoints (HEAD grep).** `api/events`, `api/stats`, `api/stats/reset`, `api/rules`, `api/rule`, `api/api-providers`, `api/tool-results/:id`. All paths are relative (`api/...`), so the UI must be served under the same prefix.

## Caveat (verified): missing gitignored data modules

`js/data/` is **not tracked in HEAD**. `.gitignore` line 3 (`data/`) matches `dashboard/js/data/`. `dashboard/app.js` (line 8) and tests import `js/data/transport.mjs` and `js/data/ingest.mjs`. The committed snapshot therefore cannot load its entry module as-is. Do not assume the committed UI runs. Fix options (tracking `js/data/` or scoping the rule to `/data/`) are not applied here.

## Change playbook

- Changing a row shape in `live/view.mjs` requires checking the `dashboard-session-grouping`, `dashboard-batch-turn-tokens`, and `dashboard-intervention-*` tests.
- Changing an endpoint path requires matching the `src/api/http.ts` route and the `tests/e2e/api-providers-*` tests.
- Changing `state.mjs` cleared-before semantics requires the `dashboard-clear-on-screen` test.
- New UI strings go in both `en.mjs` and `tr.mjs`.

## Tests and verification

- **UI unit tests:** `tests/dashboard/` (22 files, `node:test` + `tests/dom-stub.ts`). Covers stream/batch/session grouping and filters, clear-on-screen, intervention dedup, parallel dedup, WS URL derivation (`dashboard-ws-url`), settings modal, provider type and Copilot save, device flow, rule wizard, description prefill, export blob, format, session context, and tool-result status. They import modules directly and do not render a real page.
- **E2E:** `tests/e2e/*` covers server, policy, and provider flows through HTTP. No browser.
- **Command:** `npm run build && npm test`. Dashboard tests compile to `dist/tests/dashboard/*.test.js` per the `npm test` glob.
- No manual browser check is recorded in the repo. `js/ui/views.mjs` internals were not read in depth.

## Related memories

- [../architecture.md](../architecture.md): module map, server mounting, API surface, design decisions.
- [../policy-and-telemetry.md](../policy-and-telemetry.md): intervention and event sources consumed by the live view.
