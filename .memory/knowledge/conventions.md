---
name: conventions
description: Coding patterns, naming, where new code goes, error-handling and testing conventions, and config/observability guidelines for mcp-manager. Read before adding or modifying code.
---

# Conventions

> Mostly observed from source; where a pattern is strongly evidenced but not explicitly documented, treat it as the norm to follow.

## Dependency injection & structure
- Composition over constructor DI: build objects via **`createXxx(...)` factory functions** that receive injected deps/options (`createServer`, `createProxyHandler(deps)`, `createRuleEngine`, `createPolicyStage`, `createCollector`, …). The server entry point is the **single composition root**.
- **Ports & adapters (hexagonal):** contracts live in `src/ports/`; impl modules depend on ports, not on each other. Keep new abstractions in `ports/`.
- **Shared store base:** `src/api/crudStore.ts` provides `createCrudStore<T>` (in-memory) and `createPersistentStore<T>` (write-through SQLite). The rule and provider stores are thin domain-specific wrappers over these bases; domain logic (validation, invariants, skip-flagship) stays in the caller, not the base.
- **Shared protocol helpers:** `src/telemetry/protocol-common.ts` provides `parseArgs`, `stableCallId`, `normalizeUsage`, and the `NormalizedUsage` type; reused by the proxy (`context.ts`, `translate.ts`) and telemetry (`stream-extract.ts`). Don't duplicate these.

## Error handling
- Domain/proxy ops are **non-throwing** (return `null`/`undefined` for not-found/no-match). Only `readJSONBody` throws on invalid API input. REST errors are JSON `{ error: string }` with the right HTTP status.

## Observability
- All telemetry goes through **`safeEmit`** (try/catch guarded) — a telemetry failure must never fail an LLM request. Bus handlers are isolated. No logging framework; rely on the dashboard as the primary observability surface.

## Config
- `loadConfig()` reads env vars + defaults. Shape: top-level `port`, nested `upstream.*`, nested `toolResults.*` (gates optional tool-result-value persistence, default off). Base storage path is opt-in via server options, not a config field.

## Heavy payloads
- Store large tool-result/output values **out-of-band** (in-memory keyed by stable id + optional async SQLite behind a port), exposed via a REST getter and loaded lazily in the UI (fetch once, cache). Never inline them in events/WS frames.

## Testing
- Node built-in **`node:test`** + `node:assert/strict`; tests run against **compiled `dist/`** — you MUST `npm run build` before `npm test`.
- Naming: unit/integration = `*.test.ts` (integration often `*-integration.test.ts`); end-to-end = `e2e-*.test.ts`; a backend/API e2e suite may use the `.e2e.test.ts` suffix (e.g. `api-providers-live-apply.e2e.test.ts`). Use `describe`/`it`.
- E2E drives **real client→server round-trips** but the upstream is **canned** (mock `fetch` / inline mock upstream, incl. canned SSE strings) — never a real provider. Servers start on **ephemeral port 0** (read back via `address().port`).
- **Shared test helpers:** `tests/helpers.ts` provides `startMcmServer`, `closeMcmServer`, `closeHttpServer`, `makeMockFetch`, `oaiCanned`. Domain-specific fakes (e.g. `FakeWebSocket`, `createFakeModel`) stay local per file. `tests/dom-stub.ts` (`FakeEl`, `createDomStub()`/`DomStub`) is the sole shared module for loading dashboard `.mjs` under Node. Dashboard unit/DOM tests use an injected `fetchImpl` + microtask-flush (no timers/sleeps), one process per file, and a non-literal dynamic import to cache the module graph.

## Naming
- camelCase for functions/factories, PascalCase for types/classes, `createXxx()` prefix for constructors. Two tsconfigs (dev `noEmit` vs build → `dist/`).

## Dashboard CSS
- **Token-first:** sizes/colors/weights live in `css/tokens.css`; component files consume tokens (avoid hardcoded values). Aggregation order in `styles.css`: tokens→base→layout→components→rules→controls→table→responsive. Import order matters at equal specificity — a modifier declared **before** its base rule loses. Scrollbar styling is scoped to named scroll surfaces (`scrollbar-width:thin` + `::-webkit-scrollbar` with `--scroll-thumb*`).
- Component sheets load in a fixed order; `css/settings.css` is linked **last** in `index.html` so its equal-specificity rules win over the aggregated `styles.css` (same aggregation-order rule as above).

## Dashboard modules
- `dashboard/js/*.mjs` are framework-free ES modules using **relative base paths** (no leading slash, e.g. `api/api-providers`). The Settings overlay is built from a single-run `initSettings` + a `SETTINGS_SECTIONS` registry; add a new settings section by appending to that registry.

## Where new code goes
| Add | Put it in | Also touch |
|---|---|---|
| New matcher | `src/policy/matchers/<name>.ts` + `matchers/index.ts` | `ruleSpec.ts` (`buildMatcher`+`validateSpec`), `dashboard/js/rule-schema.mjs` |
| New action | `src/policy/actions/<name>.ts` (contributing an `ActionStrategy`) + one entry in `actions/index.ts` `ACTION_STRATEGIES` | `dashboard/js/rule-schema.mjs` (ruleSpec is registry-driven; no per-kind switch to edit) |
| New pipeline stage | `src/policy/` or `src/proxy/` | mount via `.use()` in the composition root |
| New port/contract | `src/ports/<name>.ts` | impl consumes it; no cross-impl imports |
| New REST route | `src/api/http.ts` (+ wiring via API options) | dashboard consumer if UI-visible |
| New provider concept (mirrors rules) | `src/api/providerSpec.ts` (pure shape+validation) + `providerStore.ts` (in-memory) + `persistentProviderStore.ts` (SQLite write-through) | mirror the rule files (`ruleSpec`/`ruleStore`/`persistentRuleStore`); keep the pure validator separate from the store (store never parses input); register a dashboard section under `dashboard/js/settings.mjs` |
| New DB table | `src/storage/schema.ts` (append a migration) | bump `SCHEMA_VERSION` |
| Token estimation / payload→token sizing | `src/telemetry/tokenEstimate.ts` (dependency-free, ~4 chars/token) | reuse its helpers rather than ad-hoc `÷4`; accounting/dedup rules in domain.md |

## Checklist — add a rule type end-to-end
1. Implement the matcher/action factory in `src/policy/{matchers,actions}/`.
2. For actions: contribute an `ActionStrategy` in the action file + add one entry to `ACTION_STRATEGIES` in `actions/index.ts` (the policy stage and ruleSpec dispatch by `effect.type` via the registry — no per-kind switch to edit). For matchers: register in `ruleSpec.ts` (`buildMatcher` + `validateSpec` known-type + required fields).
3. Sync the dashboard form schema in `dashboard/js/rule-schema.mjs`.
4. Add a unit test + an `e2e-*` test; run `npm run build && npm test`.

## Repo hygiene
- Browser verification screenshots are taken at repo root during UI checks and deleted before committing; `.playwright-mcp/` is gitignored.
