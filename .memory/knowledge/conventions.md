# mcp-manager — Conventions

Rules to follow; each is supported by multiple examples or explicit project rules.

## Imports & build
- Extensionless relative imports; CJS emit (`import { x } from '../policy/ruleEngine'`). From `src/server/` reach config via `../../config/config`.
- `npm run build` compiles BOTH `src/` and `tests/` to `dist/` (`tsconfig.build.json`); `typecheck` = `tsc --noEmit`.
- **Always `npm run build` before `npm run test`** — tests run from `dist/tests/**`, so skipping build runs stale output.

## Dependency budget
- Zero external runtime dependencies (`dependencies: none`). Use built-ins + global `fetch` + `node:sqlite` only. No `ws` package (WS is hand-rolled over `node:http`/`node:net`); dashboard is vanilla JS (no framework). Do not rely on the TS-global `WebSocket` type in tests.

## HTTP handlers
- Pattern `(req,res)=>Promise<boolean>`: `true`=handled, `false`=fall through (handlers chain). JSON routes set `Content-Type: application/json`.
- Server precedence: `/health` → `/api/*` → dashboard static (any safe dashboard asset: `/`, `/app.js`, `/styles.css`, and `dashboard/js/*.mjs` module files) → proxy `/v1/*` → 404. One shared `bus`+`collector` feeds proxy telemetry + REST + WS.

## Testing
- `node:test` + `node:assert/strict`; one file per area under `tests/`, compiled to `dist/tests/`. Baseline: ~22 suites / 165 tests green.
- Ephemeral ports: `await server.listen(0)` then read `.port` (or await `'listening'` if the server auto-listens); drive requests via global `fetch` or raw `node:net`; **close servers/sockets in `afterEach`** so the event loop drains.
- WS tests use raw `node:net` (hand-rolled RFC6455 upgrade). See `pitfalls.md` for hang / double-listen traps.

## Dashboard serving
- SPA runs same-origin at `/`; uses relative `/api/*` and `/ws`. Assets resolve relative to the COMPILED location (`dist/src/server`) by walking up ≤4 levels to the first `dashboard/index.html` (explicit `mount.dashboardDir` override wins). Re-verify this if you change the build output layout.
- The dashboard is MODULAR vanilla JS served raw (not compiled): `dashboard/app.js` is a thin ES-module entrypoint (`<script type="module" src="app.js">`) that only imports + runs `init()`; real logic lives in `dashboard/js/*.mjs` modules. `src/server/index.ts` serves ANY safe dashboard asset via `resolveDashboardAsset(reqPath, dir)` (replaced the old hardcoded `DASHBOARD_FILES`): rejects traversal (`..`)/absolute/null-byte paths, maps extension→content-type for `.html`/`.css`/`.js`/`.mjs` (all JS as `application/javascript`), and requires the file to exist within the resolved dir. Adding a new `dashboard/js/*.mjs` needs NO further server edit. Module map + DOM structure → `dashboard-ui.md`.
- Do NOT add dependencies or compile the dashboard; keep it framework-free. Use explicit relative ESM imports between modules (keep the import graph acyclic; centralize shared runtime state in `state.mjs`).
