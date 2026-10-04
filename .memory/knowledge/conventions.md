# Development Conventions

> Mostly observed from source; "Observed convention:" marks evidence that is strong but not explicitly documented.

## Dependency injection
Composition over constructor DI: build objects via `createXxx(...)` factory functions that receive injected deps/options (e.g., `createServer()`, `createProxyHandler(deps)`, `createRuleEngine()`, `createPolicyStage()`, `createCollector()`). The server entry point is the single composition root. Observed convention (strongly evidenced across proxy/policy/telemetry/api).

## Ports & adapters (hexagonal)
Framework-agnostic contracts live in `src/ports/` (`domain`, `pipeline`, `strategy`, `storage`). Implementation modules depend on ports, not directly on each other. Keep new abstractions/contracts in `ports/`; impls consume them.

## Non-throwing domain operations
Domain and proxy operations return `null`/`undefined` rather than throwing on "not found"/"no match". Only `readJSONBody` (API layer) throws for invalid input. Follow this when adding handlers.

## Telemetry must never break the request flow
All telemetry emission goes through `safeEmit()` (try/catch guarded). New instrumentation must be wrapped the same way — a telemetry failure must not fail an LLM request.

## Centralized protocol translation
Do not scatter OpenAI↔Anthropic conversion. Add conversions in `src/proxy/translate.ts` (request + response rehydration).

## Config shape
`loadConfig()` reads env vars + defaults. Structure: top-level `port`, nested `upstream.*`. Storage path is opt-in via server options (`options.telemetry.storage`), not a config field.

## API / error shape
REST endpoints return JSON; errors are `{ error: string }` with appropriate HTTP status codes.

## Testing
Use Node's built-in `node:test` runner (`describe`/`it`). Tests run against **compiled JS in `dist/`** — you must `npm run build` before `npm test`. Prefer focused unit tests per module; integration/e2e tests use `*-integration.test.ts` / `e2e-*.test.ts` naming.

## Naming
camelCase for functions/factories, PascalCase for types/classes, `createXxx()` prefix for constructors. Two tsconfigs: `tsconfig.json` (dev, noEmit) and `tsconfig.build.json` (build → `dist/`).

## Dashboard CSS
Token-first: sizes/colors/weights live in `css/tokens.css`; component files consume them (avoid hardcoded values). Aggregation order in `styles.css`: tokens→base→layout→components→rules→controls→table→responsive. Cascade order matters at equal specificity — a modifier declared BEFORE its base rule loses (this bit `.badge-pending` vs the base `.badge` transparent-border rule). Scrollbar styling is scoped to named scroll surfaces (not document-wide) using `scrollbar-width:thin` + `::-webkit-scrollbar` with the `--scroll-thumb*` tokens.

## Repo hygiene
Browser verification screenshots are taken at repo root during UI checks and deleted before committing. `.playwright-mcp/` (browser session artifacts) is gitignored; `.chromium-test/` remains untracked on disk.
