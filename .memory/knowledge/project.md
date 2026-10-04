# mcp-manager — Project Overview

## What it is
A local, LiteLLM-style model proxy that sits as the single man-in-the-middle in the agentic loop. The agent's model client points at it (custom `base_url`); it forwards to the real upstream model. Core value = a **programmable tool-monitoring & interception layer** over the LLM request/response stream. **Tool execution stays with the agent; control is exercised by editing the message stream.** Use cases: block specific tool calls / allowlists; detect loops → inject a corrective message; telemetry (counts, top tools); hide tools / modify prompts.
→ Design: see `architecture.md`. Locked choices: see `decisions.md`. Exact APIs: see `api-reference.md`.

## Tech stack
- TypeScript + Node **v24.18.1** (Bun unavailable). **Zero external runtime deps** — Node built-ins + global `fetch` + `node:sqlite` (`DatabaseSync`).
- tsc → CJS dist (`node16`); output layout `dist/src/**` and `dist/tests/**`.
- Default port **8787**.

## Current status
~**95% of MVP complete and green: 127 tests / 0 fail across 20 suites.** Tasks 1–7 done: foundation; OpenAI+Anthropic proxy; policy engine (matchers + actions + flagship loop rule + session key); pipeline wiring + production-gap fix; telemetry + SQLite storage; dashboard + REST/WS API all wired into `createServer` with one shared bus/collector.
Optional remaining: a single all-in-one end-to-end test (agent→proxy→policy→telemetry→WebSocket→dashboard) — each link is already covered separately. Deferred v1.1 scope: see `decisions.md`.

## Commands (run from `/sandbox/mcp-manager`)
| Command | Does |
|---|---|
| `npm run build` | `tsc -p tsconfig.build.json` → compiles `src/` **and `tests/`** to `dist/` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run test` | `node --test 'dist/tests/**/*.test.js'` |
| `npm run dev` / `npm start` | `dev`=build+run; `start`=`node dist/src/server/index.js` → HTTP server on port 8787 |

**GOTCHA:** tests are compiled into `dist/` first — **ALWAYS `npm run build` before `npm run test`.** Verification gate = build && typecheck && test, all green. No lint script; no deps to install.

## Environment / config (`config/config.ts`, `loadConfig`)
Env vars: `PORT` (8787), `UPSTREAM_BASE_URL` (default `http://localhost:4000/v1`), `UPSTREAM_MODEL` (default `gpt-4o-mini`), `UPSTREAM_API_KEY`, `UPSTREAM_PROTOCOL` (`openai`|`anthropic`, default `openai`). The client's request-body `model` passes through verbatim; these env vars set the real upstream target. Config supplies **no rules** by default.

## File inventory (one line each)
**`src/` (~42 source files):**
- `server/index.ts` — `createServer(port?, options?: ProxyOptions, mount?: MountOptions): McmServer`. Precedence: `/health` → `/api/*` → dashboard static (`/`, `/app.js`, `/styles.css`) → proxy `/v1/*` → 404; try/catch→500. One shared `bus`+`collector` feeds proxy telemetry + REST + WS; non-enumerable `.mcm` handle; auto-starts when `require.main===module`.
- `ports/{domain,pipeline,strategy,event-bus,storage,index}.ts` — core interfaces: domain types; Pipeline/context shapes; Matcher/Action/ToolProvider/ModelRouter; EventBus; Storage (Repository); barrel.
- `proxy/{types,upstream,translate,context,openai,anthropic,index}.ts` — proxy core: UpstreamClient; cross-protocol translation; `runThroughPipeline` + `syncRequestMessages`/`syncResponseBody` (wire-fix); OpenAI/Anthropic routes; `createProxyHandler` + `.telemetry`.
- `pipeline/index.ts` — `createPipeline` (ordered stages; threads NO shared object between request/response halves).
- `policy/{types,normalize,ruleEngine,feedbackStore,policyStage}.ts` + `matchers/{loopDetector,toolName,argPattern,index}.ts` + `actions/{block,hideTool,rewriteArgs,injectMessage,index}.ts` — rule engine (array|getter), matchers, actions, request/response edits, per-session feedback.
- `session/session.ts` — `deriveSessionKey({messages, token?}) → {fingerprint, token?}`; provider-agnostic `Message`.
- `telemetry/{events,event-bus,collector}.ts` — typed domain events; `createEventBus`; `createCollector` (counts/top tools/interventions).
- `storage/{schema,sqlite}.ts` — schema/migrations; `createSqliteStorage` (node:sqlite).
- `api/{ruleStore,ruleSpec,http,ws}.ts` — in-memory RuleStore; RuleSpec builders; REST `/api/*`; dependency-free RFC6455 WebSocket server.

**`config/config.ts`** — `loadConfig`. **`dashboard/{index.html,app.js,styles.css}`** — vanilla-JS SPA served at `/` (live stream, intervention log, counts/top tools, rule authoring UI). **`tests/`** — 20 suites, 127 tests: health, proxy, translate, session, normalize, policy-matchers, rule-engine, rule-store, feedback-store, policy-stage, policy-stage-events, e2e-policy, telemetry, telemetry-collector, storage-schema, storage, proxy-telemetry, http-api, ws, server-integration.

## Conventions
- **Imports:** extensionless relative, CJS emit (`import { x } from '../policy/ruleEngine';`). From `src/server/` reach config via `../../config/config`.
- **Tests:** `node:test` + `node:assert/strict`, one file per area, compiled to `dist/tests`. Ephemeral ports; drive via global `fetch` or raw `node:net`; close servers/sockets in `afterEach`. See `testing.md`.
- **HTTP handler pattern:** `(req,res)=>Promise<boolean>` (true=handled, false=fall through). JSON routes set `Content-Type: application/json`.
- **Dependency budget:** zero external runtime deps (built-ins + fetch + node:sqlite). WS via `node:http`/`node:net` (no `ws`); dashboard is vanilla JS (no framework); don't rely on the TS-global `WebSocket` type in tests.
- **Dashboard serving:** SPA runs same-origin at `/`; uses relative `/api/*` and `/ws`. Server precedence: `/health` → `/api/*` → static (only `/`, `/app.js`, `/styles.css`) → proxy `/v1/*` → 404.
