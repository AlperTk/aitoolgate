---
name: api-storage
description: The REST/WebSocket API (src/api) and SQLite storage (src/storage): HTTP route table, rule and provider stores (in-memory or SQLite), migrations, and persistence failure isolation. Read when changing REST endpoints, stores, or schema.
---
# Module: api and storage (`src/api/`, `src/storage/`)

Snapshot: 9a2fbb5b684093c9197a81929d7741a91c9718ec. Coverage: partial — REST handler body, WS subscribe, SQLite factory and migrations read; store internals and dashboard API use not read.

## Scope
- API owns: REST handler, WebSocket broadcast, rule and provider CRUD endpoints.
- Storage owns: SQLite factory, migration list and runner, persistent rule/provider stores.

## Critical objects
| Symbol | Path | Responsibility |
|---|---|---|
| `createApiHandler` | src/api/http.ts | Returns `false` for non-`/api` paths; top-level try/catch → 500 |
| `createWsServer` | src/api/ws.ts | Broadcasts each bus event to connected clients |
| `createCrudStore`, `createPersistentStore`, `openDb` | src/api/crudStore.ts | Shared CRUD store for rules and providers |
| `createPersistentRuleStore` | src/api/persistentRuleStore.ts | SQLite-backed rules |
| `createPersistentProviderStore` | src/api/persistentProviderStore.ts | SQLite-backed API providers; calls `applyMigrations` |
| `openPersistentRuleStore`, `openApiProviderStore` | src/server/index.ts | Choose in-memory vs SQLite by config |
| `createSqliteStorage` | src/storage/sqlite.ts | Creates rules/events tables, calls `applyMigrations` |
| `MIGRATIONS`, `applyMigrations` | src/storage/schema.ts | Versioned migrations v1–v5 |
| `createHttpRouter` | src/server/index.ts | Routing order (see architecture.md) — lives in server, not api |

## REST route table (`createApiHandler`, src/api/http.ts)
| Method | Path | Calls |
|---|---|---|
| GET | /api/stats | collector summary |
| POST | /api/stats/reset | collector reset |
| GET | /api/events | collector recent events |
| GET | /api/rules | ruleStore.list |
| POST | /api/rules | ruleStore.add |
| PATCH | /api/rules/:id | applyPatch → ruleStore.update |
| DELETE | /api/rules/:id | ruleStore.remove |
| POST | /api/api-providers/probe | probeSavedProvider / probeProvider |
| POST | /api/api-providers/device-flow/start | deviceAuth.startDeviceFlow |
| POST | /api/api-providers/device-flow/poll | deviceAuth.pollDeviceFlow |
| POST | /api/api-providers/device-flow/confirm | apiProviderStore add/update |
| GET | /api/api-providers | apiProviderStore list/getActive |
| GET | /api/api-providers/:id | apiProviderStore.get |
| POST | /api/api-providers | apiProviderStore.add |
| PATCH | /api/api-providers/:id | apiProviderStore.update |
| DELETE | /api/api-providers/:id | apiProviderStore.remove |
| GET | /api/tool-results/:id | toolResultStore.get, then durable fallback |

## Persistence boundaries
- Rules: in-memory unless `RULES_DB_PATH` set (SQLite).
- Providers: SQLite when `dbPath` set, else in-memory.
- Tool results: optional persister when `TOOL_RESULTS_ENABLED`.
- Events table exists in `createSqliteStorage`; its `recordToolCall` / `recordIntervention` have no non-test callers (see `modules/telemetry.md`).

## Change recipe — add a REST endpoint
1. Add a branch in `createApiHandler` (`src/api/http.ts`) following the existing path/method checks.
2. Use the existing store interface; add store methods in `crudStore.ts` only if needed.
3. Keep the top-level try/catch → 500 behavior.
4. Verify with the matching `tests/` file for the resource (rule and provider tests listed in `modules/policy.md` and `modules/providers.md`) after `npm run build && npm test`.

## Change recipe — add a schema change
1. Append a migration to `MIGRATIONS` in `src/storage/schema.ts`; do not edit applied versions.
2. Verify both `createSqliteStorage` and `createPersistentProviderStore` paths call `applyMigrations`.

## Unknowns
- Store internals (`crudStore.ts` details) not read.
- Whether dashboard uses every listed route — not verified.
- No `src/storage/migrations/` directory; migrations are in `schema.ts`.
