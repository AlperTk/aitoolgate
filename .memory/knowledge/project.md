# mcp-manager — Project Overview

## Purpose
A local, LiteLLM-style model proxy that is the single man-in-the-middle in the agentic loop. The agent's model client points at it (custom `base_url`); it forwards to the real upstream and returns the response. Core value: a **programmable tool-monitoring & interception layer** over the LLM request/response stream. Tool execution stays with the agent; control is exercised by editing the message stream (hide a tool, block/rewrite a call, inject a corrective message). Use cases: block/allowlist tool calls, detect loops → inject corrective message, telemetry (counts / top tools), hide tools / modify prompts.

## Tech stack
- TypeScript (`typescript` devDep, CJS emit) + modern Node (uses global `fetch` + `node:sqlite` `DatabaseSync`; no pinned `engines`). tsc → `dist/src/**` + `dist/tests/**`.
- **Zero external runtime dependencies** (`dependencies: none`). Built-ins + global fetch + node:sqlite only. WS via `node:http`/`node:net` (no `ws` package); dashboard is dependency-free vanilla JS (no framework).
- Default port **8787**.

## Status
Complete & green: **151 tests / 0 fail** (gate: `build && typecheck && test`). Covers foundation, OpenAI+Anthropic proxy, policy engine (matchers + actions + flagship loop rule + session key), pipeline wiring + wire-fix, telemetry + SQLite storage + **tool-call metrics (per-call duration ms + tokens)**, dashboard + REST/WS API all wired into `createServer` with one shared bus/collector/tracker. See `tool-metrics.md` and `decisions.md`.

## Key directories
- `src/server/` — HTTP server entry (`createServer`): routing + shared bus/collector + auto-start.
- `src/proxy/` — proxy core: `openai.ts`/`anthropic.ts` routes, `upstream.ts` forwarding, `translate.ts` cross-protocol, `context.ts` pipeline driver + **wire-fix**.
- `src/pipeline/` — ordered stages (Chain-of-Responsibility).
- `src/policy/` — rule engine + `matchers/` + `actions/` + feedbackStore + policyStage.
- `src/session/` — stateless session key derivation.
- `src/telemetry/` — typed events + event bus + collector + `toolMetrics.ts` (bounded cross-request duration/token pairing tracker; see `tool-metrics.md`).
- `src/storage/` — schema + SQLite repository.
- `src/api/` — rule store + rule specs + REST `/api/*` + WebSocket server.
- `src/ports/` — core interfaces (domain, pipeline, strategy, event-bus, storage) + barrel.
- `config/config.ts` — `loadConfig`. `dashboard/` — vanilla-JS SPA. `tests/` — 21 suites.

## Commands (from `/sandbox/mcp-manager`)
| Command | Does |
|---|---|
| `npm run build` | `tsc -p tsconfig.build.json` → compiles **both** `src/` and `tests/` to `dist/` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run test` | `node --test 'dist/tests/**/*.test.js'` |
| `npm start` | `node dist/src/server/index.js` (HTTP server on 8787) |
| `npm run dev` | `npm run build && node dist/src/server/index.js` |

**GOTCHA:** tests are compiled to `dist/` first — **always `npm run build` before `npm run test`** (see `conventions.md`, `pitfalls.md`). Gate = `build && typecheck && test`, all green. No lint script; nothing to install.

## Environment / config (`config/config.ts`, `loadConfig`)
Env vars (default → field): `PORT` (8787 → `port`; validated integer 0–65535 else throws), `UPSTREAM_BASE_URL` (`http://127.0.0.1:9005/v1` → `upstream.baseUrl`), `UPSTREAM_MODEL` (`gpt-4o-mini` → `upstream.model`), `UPSTREAM_API_KEY` (unset → `upstream.apiKey`), `UPSTREAM_PROTOCOL` (`openai`; only value `anthropic` selects Anthropic, anything else → openai). The client request-body `model` passes through verbatim; these env vars set the real upstream target. Config supplies no rules by default.

## Core conventions
- Extensionless relative imports; CJS emit (`import { x } from '../policy/ruleEngine'`). From `src/server/` reach config via `../../config/config`.
- HTTP handler pattern `(req,res)=>Promise<boolean>` (true=handled, false=fall through); JSON routes set `Content-Type: application/json`.
- Dependency budget: zero external runtime deps (WS via `node:http`/`node:net`, no `ws`; dashboard vanilla JS; don't rely on the TS-global `WebSocket` type in tests). Full list: see `conventions.md`.
