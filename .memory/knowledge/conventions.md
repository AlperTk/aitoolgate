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
- Server precedence: `/health` → `/api/*` → dashboard static (only `/`, `/app.js`, `/styles.css`) → proxy `/v1/*` → 404. One shared `bus`+`collector` feeds proxy telemetry + REST + WS.

## Testing
- `node:test` + `node:assert/strict`; one file per area under `tests/`, compiled to `dist/tests/`. Baseline: ~22 suites / 165 tests green.
- Ephemeral ports: `await server.listen(0)` then read `.port` (or await `'listening'` if the server auto-listens); drive requests via global `fetch` or raw `node:net`; **close servers/sockets in `afterEach`** so the event loop drains.
- WS tests use raw `node:net` (hand-rolled RFC6455 upgrade). See `pitfalls.md` for hang / double-listen traps.

## Dashboard serving
- SPA runs same-origin at `/`; uses relative `/api/*` and `/ws`. Assets resolve relative to the COMPILED location (`dist/src/server`) by walking up ≤4 levels to the first `dashboard/index.html` (explicit `mount.dashboardDir` override wins). Re-verify this if you change the build output layout.
