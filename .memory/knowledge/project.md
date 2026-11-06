---
name: project
description: Purpose, stack, commands and verification for the aitoolgate repository (local tool-observability LLM proxy), verified from committed HEAD.
---

# aitoolgate — project overview

- **Type:** single-package TypeScript/Node.js application (`package.json` name `aitoolgate`, v0.1.2, Apache-2.0). Not a monorepo.
- **Purpose:** local proxy for OpenAI-compatible (`/v1/chat/completions`) and Anthropic-compatible (`/v1/messages`) traffic. It records tool calls, results, token usage and latency, and applies live policy rules (`hideTool`, `addDescription`, `rewriteArgs`, `injectMessage`). Evidence: `README.md`, `src/policy/`, `src/telemetry/`.
- **Runtime:** Node.js `>=22.5` (`engines`), relies on built-in `node:sqlite`, `node:http` and a custom RFC 6455 WebSocket. No third-party runtime dependencies. Dev deps: `typescript ^7.0.2`, `@types/node`.
- **Frontend:** vanilla JS dashboard in `dashboard/` (ES modules under `dashboard/js/`, i18n `en`/`tr`), served statically by the server. No framework.

## Commands (from `package.json`)

| Task | Command |
| --- | --- |
| Compile src, config, tests to `dist/` | `npm run build` (`tsc -p tsconfig.build.json`) |
| Run tests | `npm test` (`node --test 'dist/tests/**/*.test.js'`, requires build first) |
| Type-check without emit | `npm run typecheck` |
| Start server | `npm start` (`node dist/src/server/index.js`) |
| Build + start | `npm run dev` |

Default port `8787`, overridable with `PORT`. `GET /health` is the liveness endpoint.

## Verification

- Primary checks: `npm run build`, `npm run typecheck`, `npm test`.
- Tests live in `tests/` (`api`, `dashboard`, `e2e`, `policy`, `protocols`, `providers`, `proxy`, `storage`, `telemetry`) and use `node:test` plus `node:assert/strict`. Integration tests use a mock upstream.
- README states there is no lint, format, or CI/CD configuration. Verified: no `.github/` workflow files are tracked at HEAD.

## Conventions

- Source is `.ts` under `src/`; dashboard uses `.mjs` modules. Test files are named `*.test.ts`.
- Relative imports omit file extensions in TS source (e.g. `'./policy/ruleEngine'`).
- Many modules are headed by JSDoc comments describing the port they satisfy. Keep that style.
- Empty placeholder `.gitkeep` files mark directories in `src/`.
- `.gitignore` excludes `dist/`, `data/`, `node_modules/`, `.serena/`, and `.memory/tmp/`.

## Gaps / notes

- `.serena/project.yml` at HEAD still has `project_name: "mcp-manager"` and Python/Java language servers. Treat it as stale config. It is not authoritative for this project.
- Some tests (e.g. `tests/dashboard/*`) exercise `dashboard/js` through `tests/dom-stub.ts`. There is no browser test runner.

## Related memories

- [development-guide](development-guide.md): read before changing code (investigation, DRY/SOLID, i18n workflow, verification).
