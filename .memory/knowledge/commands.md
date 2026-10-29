---
name: commands
description: Build, run, test, and typecheck commands plus environment variables and local-service requirements for aitoolgate. Read when you need to build, run, test, or configure the project.
---

# Commands

## Toolchain
Node (with built-in `node:sqlite`) + TypeScript. **Zero runtime dependencies**; dev deps are `typescript@^7.0.2` and `@types/node@^26.6.4` only.

## Setup
```
npm install          # installs dev deps only (typescript, @types/node)
npm i -g aitoolgate  # published CLI (bin `aitoolgate`); same entry as `npm start`
```

## Build / run / test
| Task | Command | Notes |
|---|---|---|
| Build | `npm run build` | `tsc -p tsconfig.build.json` → emits `dist/` (node16 CJS). |
| Run | `npm start` | `node dist/src/server/index.js`; listens on `PORT` (default 8787); dashboard at `http://localhost:8787/`. |
| Dev | `npm run dev` | build then start. |
| Test | `npm test` | `node --test 'dist/tests/**/*.test.js'` — **MUST `npm run build` first** (tests run compiled `dist/`). Build does NOT delete stale `dist/` artefacts: a `dist/tests/*.test.js` whose source was removed or never tracked keeps running and can fail the suite. Delete such a stale file under `dist/` only (never tracked source). Baseline after the protocol-layer work: 647 tests, all passing. |
| Typecheck | `npm run typecheck` | `tsc --noEmit` against the dev tsconfig. |

There is **no lint or format script** in `package.json` (none observed). `main` and `bin` (`aitoolgate`) both point at `dist/src/server/index.js`; published `files` = `["dist/src","dist/config","dashboard","README.md","LICENSE"]` (tarball verified self-sufficient via `npm pack` + extracted smoke test); `engines` `node >=22.5` (required for `node:sqlite`); `publishConfig.access=public`.

## Database & migrations
- No migration CLI — migrations **auto-apply when storage opens** (`SCHEMA_VERSION=5`, idempotent, tracked in a `migrations` table).
- Two DB files (defaults under the OS user home `~/.aitoolgate/`, cwd-independent):
  - `~/.aitoolgate/rules.db` — `rules`, `events`, `tool_calls`, `interventions`, `api_providers` (provider configs; enabled by default via `RULES_ENABLED=true`).
  - `~/.aitoolgate/tool-results.db` — heavy `tool_results` payloads (only when `TOOL_RESULTS_ENABLED=true`, default off).
- Delete a DB file to reset; it is regenerated at startup.

## Required env vars / local services
There is **no env-based upstream config**: the upstream target comes only from a **provider config** (dashboard **Settings** or `POST /api/api-providers`); with no active provider the LLM routes answer **503 JSON** instead of forwarding. For local tests, the e2e suite uses a canned mock (no real service required).

| Var | Default | Meaning |
|---|---|---|
| `PORT` | `8787` | HTTP/WS/dashboard port (validated 0–65535). |
| `RULES_ENABLED` | `true` | Persist rules + events to `RULES_DB_PATH`. |
| `RULES_DB_PATH` | `~/.aitoolgate/rules.db` | Path of the rules/events DB. |
| `TOOL_RESULTS_ENABLED` | `false` | Persist raw tool-result values to `TOOL_RESULTS_DB`. |
| `TOOL_RESULTS_DB` | `~/.aitoolgate/tool-results.db` | Path of the tool-results DB. |
| `TOOL_RESULTS_FLUSH_MS` | `50` | SQLite drain flush interval. |
| `TOOL_RESULTS_BATCH_SIZE` | `100` | SQLite drain batch size. |
| `TOOL_RESULTS_FSYNC` | `false` | `wal_checkpoint(TRUNCATE)` per batch. |
| `TOOL_ERROR_PATTERNS` | *(none)* | Comma-separated case-insensitive regex patterns; a tool result whose content matches is flagged as an error (additive to the built-in content heuristic). |
| `COPILOT_DEVICE_CLIENT_ID` | built-in GitHub OAuth app id | Client id for Copilot device login (used when the device-flow request omits `clientId`). |

## Debugging / dev shortcuts
- `GET /health` → `{status:"ok"}` liveness check.
- `GET /api/stats`, `/api/events`, `/api/rules` → current telemetry/rule state as JSON.
- `WS /ws` (conventionally) → live `TelemetryEvent` stream; client text frames are echoed back (`{"echo": ...}`) as a liveness probe.
- The dashboard is the primary live-debug surface (stream + metrics + intervention log). No logging framework — console output from Node stdlib only.

## CI/CD
**No CI/CD pipeline configuration was observed in the repo** (no `.github/`, workflow files, Makefile, or Dockerfile at exploration time). If one exists it is not captured here — verify before assuming.
