---
name: constraints
description: MUST / MUST NOT rules, architectural restrictions, infrastructure limits, and external-system constraints that constrain future work in mcp-manager. Read before making cross-cutting changes or adding dependencies.
---

# Constraints

## MUST
- **Keep zero runtime dependencies.** Node stdlib only (`node:http`, `node:sqlite`, hand-written WebSocket). Do not add npm runtime packages; dev deps are `typescript` + `@types/node` only.
- **Wrap all telemetry emission in `safeEmit`** (or equivalent try/catch) so a telemetry failure never fails an LLM request; bus handlers are isolated.
- **Route OpenAI↔Anthropic conversion through `src/proxy/translate.ts`** (request + response rehydration). Don't scatter translation.
- **Keep domain/proxy ops non-throwing** — return `null`/`undefined` for not-found/no-match. Only `readJSONBody` throws (invalid API input).
- **Build before test** — tests run against compiled `dist/`; `npm run build` must precede `npm test`.
- **Store large tool-result values out-of-band** (in-memory keyed by id + optional async SQLite), never inline in `TelemetryEvent`/WS frames.
- **Keep per-session state in the policy STAGE** (`SessionFeedbackStore`); rules are stateless (the flagship rule is deliberately stateless).
- **Centralize tool-CALL emission** in `context.ts` (`emitResponseTelemetry`) — not in the policy stage.
- **Keep `RuleSpec` ↔ engine factories consistent with `dashboard/js/rule-schema.mjs`** (form schemas are synced to `src/api/ruleSpec.ts`).
- **Gate opt-in features via config/options:** storage via server options (`options.telemetry.storage`); tool-result persistence via `config.toolResults.enabled` (default off).
- **Keep provider persistence best-effort** — a failing open/read/write logs a warning and leaves the in-memory provider store untouched; the server still boots (in-memory fallback if the DB can't open).
- **Validate provider input strictly:** `POST /api/api-providers` requires non-empty `name` and `baseUrl`; `protocol` must be exactly `openai` or `anthropic`; `apiKey` must be string-or-null; unknown extra fields are ignored.

## MUST NOT
- **Persist the built-in `flagship-loop-rule`** to the database.
- **Inline heavy payloads into every WS broadcast** (unbounded memory).
- **Assume multiple *concurrently-active* upstreams** — at most ONE provider is active at a time (single-active invariant); the active upstream is runtime-switchable but never load-balanced.
- **Leak a provider's raw `apiKey`** in list responses — expose only `apiKeySet`; only the detail `GET /api/api-providers/:id` may return the raw key.

## Architectural restrictions
- Framework-agnostic contracts live in `src/ports/`; impls depend on ports, not each other. Put new abstractions in `ports/`; impls consume them.
- **Single composition root:** `server/index.ts` builds and injects all subsystems; the proxy depends on injected port interfaces (`src/ports/telemetry.ts`), never on concrete factories (DIP). See architecture.md.
- Two tsconfigs: `tsconfig.json` (dev, `noEmit`, Bundler resolution) and `tsconfig.build.json` (build → `dist/`, node16). Don't emit from the dev tsconfig.
- Dashboard CSS is **token-first** (`css/tokens.css`); don't hardcode values. `styles.css` `@import` order matters — later sheets win at equal specificity.

## Infrastructure limits
- `PORT` is validated as an integer 0–65535 (throws otherwise); default **8787**.
- Upstream fetch has **no timeout** (`streamToEndpoint` = no-timeout fetch).
- Collector caps: `maxInterventions=500`, `maxRecent=200`, `maxTokenTurns=10000`. Tool-metrics pending TTL default 300 000 ms; `maxPending` 1 000. In-memory tool-result store bounded at 1 000 entries.
- SQLite persister runs in **WAL mode**; flush interval default 50 ms, batch size default 100, `fsyncPerBatch` default false.
- Static dashboard serving **rejects path traversal / absolute paths / null bytes** and serves only `.html/.css/.js/.mjs` inside the dashboard dir; `resolveDashboardDir` walks up ≤4 levels for `dashboard/index.html`.

## External-system restrictions
- `UPSTREAM_PROTOCOL` switches only on the value `anthropic` (anything else = `openai`) — it's effectively binary.
- Single *active* upstream target via `UPSTREAM_BASE_URL` / `UPSTREAM_MODEL` / `UPSTREAM_API_KEY`; multiple persisted provider configs are allowed but only one is active at a time (no concurrent routing).
- Persistence is Node built-in `node:sqlite` — no external DB server, no migration CLI (migrations auto-apply on open, `SCHEMA_VERSION=3`).

## Rules whose violation causes a production incident
- Unwrapped telemetry emission → a request can 500 / traffic lost.
- Skipping `npm run build` before tests → stale `dist/` makes tests fail or misrun.
- Inlining heavy payloads into events/broadcasts → unbounded memory + slow WS.
- Path-traversal gap in static serving → arbitrary local file read.
- Exposing a raw provider `apiKey` in a list response → credential leak.
