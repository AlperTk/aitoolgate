---
name: commands
description: Defined build, test, typecheck, run commands; toolchain prerequisites; and all environment variables read by config. Read before running verification or changing configuration.
---
# Commands and configuration

Source: `package.json` scripts (defined, not executed during bootstrap).

## Scripts
| Name | Exact script | Prerequisite |
|---|---|---|
| build | `tsc -p tsconfig.build.json` | none |
| test | `node --test 'dist/tests/**/*.test.js'` | `npm run build` first |
| typecheck | `tsc --noEmit` | none |
| dev | `npm run build && node dist/src/server/index.js` | none (builds itself) |
| start | `node dist/src/server/index.js` | `dist/` must exist |

No lint, format, or CI scripts are defined.

## Toolchain
- Node `>=22.5` (`engines.node`); `node:sqlite` and `node:test` are used.
- TypeScript (devDependency). `tsconfig.json` includes `src`, `config`, `tests`; excludes `dashboard`, `dist`. `tsconfig.build.json` extends it (node16, `outDir: dist`).
- Zero runtime dependencies.

## Verification recipe
1. `npm run typecheck`
2. `npm run build`
3. `npm test` (or a single file: `node --test dist/tests/<name>.test.js`)

## Environment variables (`config/config.ts::loadConfig`, defaults in `DEFAULTS`)
| Variable | Default | Notes |
|---|---|---|
| PORT | 8787 | invalid or outside 0–65535 throws |
| TOOL_RESULTS_ENABLED | false | bool |
| TOOL_RESULTS_DB | `<DEFAULT_DB_DIR>/tool-results.db` | README: `data/tool-results.db` |
| TOOL_RESULTS_FLUSH_MS | 50 | positive int |
| TOOL_RESULTS_BATCH_SIZE | 100 | positive int |
| TOOL_RESULTS_FSYNC | false | bool |
| RULES_ENABLED | true | bool |
| RULES_DB_PATH | `<DEFAULT_DB_DIR>/rules.db` | README: `data/rules.db`; set enables SQLite rule/provider stores |
| TOOL_ERROR_PATTERNS | [] | string list; not in README table |
| COPILOT_DEVICE_CLIENT_ID | built-in client id | empty string falls back to default; not in README table |

Config shape: `config/config.ts::Config` (port, toolResults, rules, toolErrorPatterns, copilotDeviceClientId).
