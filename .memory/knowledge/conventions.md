---
name: conventions
description: Coding patterns, naming, where new code goes, error-handling and testing conventions, and config/observability guidelines for aitoolgate. Read before adding or modifying code.
---

# Conventions

> Mostly observed from source; where a pattern is strongly evidenced but not explicitly documented, treat it as the norm to follow.

## Dependency injection & structure
- Composition over constructor DI: build objects via **`createXxx(...)` factory functions** that receive injected deps/options (`createServer`, `createProxyHandler(deps)`, `createRuleEngine`, `createPolicyStage`, `createCollector`, …). The server entry point is the **single composition root**.
- **Ports & adapters (hexagonal):** contracts live in `src/ports/`; impl modules depend on ports, not on each other. Keep new abstractions in `ports/`.
- **Shared store base:** `src/api/crudStore.ts` provides `createCrudStore<T>` (in-memory) and `createPersistentStore<T>` (write-through SQLite). The rule and provider stores are thin domain-specific wrappers over these bases; domain logic (validation, invariants, skip-flagship) stays in the caller, not the base.
- **Shared protocol helpers:** `src/telemetry/protocol-common.ts` provides `parseArgs`, `stableCallId`, `normalizeUsage`, `toolDescriptionMap`, and the `NormalizedUsage` type; reused by the proxy (`context.ts`, `translate.ts`, `openai.ts`, `anthropic.ts`) and telemetry (`stream-extract.ts`). Don't duplicate these. `toolDescriptionMap(raw)` maps a request's `tools` array to a tool-name→description map, understanding BOTH provider wire shapes by value (OpenAI `tools[i].function.{name,description}` and Anthropic `tools[i].{name,description}`), non-throwing and skipping tools with no name/description — it lets the emitted `tool.call` event carry the request-provided description (see domain.md).

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
- **Shared test helpers:** `tests/helpers.ts` provides `startAtgServer`, `closeAtgServer`, `closeHttpServer`, `makeMockFetch`, `oaiCanned`. Domain-specific fakes (e.g. `FakeWebSocket`, `createFakeModel`) stay local per file. `tests/dom-stub.ts` (`FakeEl`, `createDomStub()`/`DomStub`) is the sole shared module for loading dashboard `.mjs` under Node. Dashboard unit/DOM tests use an injected `fetchImpl` + microtask-flush (no timers/sleeps), one process per file, and a non-literal dynamic import to cache the module graph.

## Naming
- camelCase for functions/factories, PascalCase for types/classes, `createXxx()` prefix for constructors. Two tsconfigs (dev `noEmit` vs build → `dist/`).

## Dashboard CSS
- **Token-first:** sizes/colors/weights live in `css/tokens.css`; component files consume tokens (avoid hardcoded values). Aggregation order in `styles.css`: tokens→base→layout→components→rules→controls→table→responsive. Import order matters at equal specificity — a modifier declared **before** its base rule loses. Scrollbar styling is scoped to named scroll surfaces (`scrollbar-width:thin` + `::-webkit-scrollbar` with `--scroll-thumb*`).
- Component sheets load in a fixed order; `css/settings.css` is linked **last** in `index.html` so its equal-specificity rules win over the aggregated `styles.css` (same aggregation-order rule as above).

## Dashboard modules
- `dashboard/js/*.mjs` are framework-free ES modules using **relative base paths** (no leading slash, e.g. `api/api-providers`). The Settings overlay is built from a single-run `initSettings` + a `SETTINGS_SECTIONS` registry; add a new settings section by appending to that registry.
- **Cross-module reuse:** a dashboard view module reuses shared operations by importing exported helpers from another dashboard module rather than duplicating fetch/routing/navigation logic — e.g. `live-view.mjs` imports `createRule`/`prefillNewRule`/`findDuplicatePolicyRule` from `rules.mjs` to quick-create a toolName rule from the tool-call detail panel. To pre-fill the rule editor from a non-form view, call `prefillNewRule(spec)` (a full RuleSpec) or `prefillNewRule(toolName, description)` (builds an `addDescription` spec in one call — the tool-detail "Override" button): it stores a one-shot pending spec consumed exactly once by `openNewRuleForm()`, which drives the `#/rules/new` router (or opens the form directly when already there).
- **Stream-column pattern (live tool-call stream):** the live tool-call stream's columns are canonicalized by `live-view.mjs` (`STREAM_HEAD_CELLS` + `normalizeStreamHead()`), which self-heals the header regardless of the served HTML. The grid is **10 tracks**: `Status | Tool | Session | Time | Dur (ms) | In (est) | Out (est) | Context Size | Size | (expand)`. `In (est)` = the row's per-call request-side estimate (`ev.callTokens`); `Out (est)` = the paired result's estimated `tokens` (filled in place by `updateCallRowWithResult`; `—` until the result arrives; an orphan row shows its own value); `Context Size` (renamed from `Total`) is turn-level — rendered ONCE per turn on the last tool-call row via `applyTurnUsageToRows` (wired from `ingest.mjs` on `turn.usage`), `—` elsewhere, and it is NOT the sum of In and Out. The Description column was removed from the table (the description now appears in the row detail panel via `buildDescriptionSection`). The four numeric cells are created together by `appendTokenAndSizeCells(main, ev)`, which returns the cell refs so callers update them in place. Desktop `grid-template-columns` is `4.5rem minmax(4.375rem, 1fr) minmax(14.5rem, auto) 4.5rem 3.5rem 3.4rem 3.4rem 3.4rem 4.65rem 1.2rem` — only **Tool** is flexible; **Session** is content-hugging (`minmax(14.5rem, auto)`; the `.s-session` cell uses a 12.5px font so the full 30-char ID fits the 232px track; header and rows share one template so the label and ID column resolve to the identical track); **Size** is the widest numeric track (4.65rem) while In/Out/Context stay 3.4rem; every other track is fixed. Session cells render the **full session ID** (no client-side 12-char slice). The mobile grid is unchanged: `minmax(0, 4.6rem) minmax(0, 1fr) minmax(0, 1fr) minmax(0, 4.4rem) 1.2rem`. To add a column: add an `appendXxxCell(main, value)` helper (or extend `appendTokenAndSizeCells`) and call it from BOTH `createCallRow(ev)` and `createOrphanResultRow(ev)` (orphan rows render a `—` placeholder), extend the shared `grid-template-columns` on `.stream-head`/`.row-main` in `css/components.css` (and the mobile `responsive.css` override), and mirror the new `<th>` in both `dashboard/index.html` and `dashboard/html/dashboard-view.html` so header cells, row cells, and CSS tracks stay in lock-step.

## Where new code goes
| Add | Put it in | Also touch |
|---|---|---|
| New matcher | `src/policy/matchers/<name>.ts` + `matchers/index.ts` | `ruleSpec.ts` (`buildMatcher`+`validateSpec`), `dashboard/js/rule-schema.mjs` |
| New action | `src/policy/actions/<name>.ts` (contributing an `ActionStrategy`) + one entry in `actions/index.ts` `ACTION_STRATEGIES` | `dashboard/js/rule-schema.mjs` (ruleSpec is registry-driven; no per-kind switch to edit) |
| New pipeline stage | `src/policy/` or `src/proxy/` | mount via `.use()` in the composition root |
| New port/contract | `src/ports/<name>.ts` | impl consumes it; no cross-impl imports |
| New REST route | `src/api/http.ts` (+ wiring via API options) | dashboard consumer if UI-visible |
| New provider concept (mirrors rules) | `src/api/providerSpec.ts` (pure shape+validation) + `providerStore.ts` (in-memory) + `persistentProviderStore.ts` (SQLite write-through) | mirror the rule files (`ruleSpec`/`ruleStore`/`persistentRuleStore`); keep the pure validator separate from the store (store never parses input); register a dashboard section under `dashboard/js/settings.mjs` |
| New provider adapter (e.g. another vendor) | `src/providers/<id>/adapter.ts` (`ProviderAdapter` from `src/ports/provider.ts`) + one entry in `src/providers/registry.ts` `PROVIDER_ADAPTERS` | reuse `src/providers/auth/` strategies (`ApiKeyAuth`, `DeviceOAuthAuth`); add tests under `tests/<id>-adapter.test.ts`; dashboard adapter option in `settings-providers.mjs`; no proxy/upstream edits |
| New DB table | `src/storage/schema.ts` (append a migration) | bump `SCHEMA_VERSION` |
| Token estimation / payload→token sizing | `src/telemetry/tokenEstimate.ts` (dependency-free, ~4 chars/token) | reuse its helpers rather than ad-hoc `÷4`; accounting/dedup rules in domain.md |

## Checklist — add a rule type end-to-end
1. Implement the matcher/action factory in `src/policy/{matchers,actions}/`.
2. For actions: contribute an `ActionStrategy` in the action file + add one entry to `ACTION_STRATEGIES` in `actions/index.ts` (the policy stage and ruleSpec dispatch by `effect.type` via the registry — no per-kind switch to edit). For matchers: register in `ruleSpec.ts` (`buildMatcher` + `validateSpec` known-type + required fields).
3. Sync the dashboard form schema in `dashboard/js/rule-schema.mjs`.
4. Add a unit test + an `e2e-*` test; run `npm run build && npm test`.

## Repo hygiene
- Browser verification screenshots are taken at repo root during UI checks and deleted before committing; `.playwright-mcp/` is gitignored.
