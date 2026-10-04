# mcp-manager — Decisions

Locked decisions (do not re-litigate without explicit sign-off). Each lists Decision / Reason / Evidence.

## Interception surface = the model proxy
- Decision: MVP intercepts at the model proxy, NOT the tool executor; model-proxy-only.
- Reason: a single choke point over the message stream, framework-agnostic.
- Evidence: `src/proxy/`, `src/ports/domain.ts`

## Protocols (v1) = OpenAI-compatible AND Anthropic-compatible
- Decision: both `/v1/chat/completions` + `/v1/models` (OpenAI) and `/v1/messages` (Anthropic), pass-through to one configured upstream.
- Reason: cover both major client SDKs from one upstream target.
- Evidence: `src/proxy/openai.ts`, `src/proxy/anthropic.ts`, `src/proxy/translate.ts`

## Model layer (v1) = single configured model, pass-through
- Decision: pass through one configured upstream model (LiteLLM-lite). Multi-model + per-client routing + fallback is v1.1.
- Reason: keep v1 minimal; extensible via ports.
- Evidence: `config/config.ts`, `src/ports/strategy.ts` (ModelRouter)

## Client identity read but NOT enforced
- Decision: per-client API key (LiteLLM-style) for routing/attribution; read but not enforced in default passthrough; no UI login (local, trusted, single-node).
- Reason: local tool — auth adds friction without value.
- Evidence: `src/proxy/upstream.ts` (FetchLike/auth), `src/proxy/context.ts` (`toClientId`)

## Policy engine = declarative ordered rule pipeline, live-editable
- Decision: ordered matcher+action rules, UI- and REST-editable. Scripting escape-hatch + LLM-as-policy matcher deferred to v1.1. Open/Closed.
- Reason: deterministic + inspectable rules first; scripting/LLM matchers add power later without core rework.
- Evidence: `src/policy/ruleEngine.ts`, `src/api/ruleSpec.ts`, `src/api/http.ts`

## Flagship loop rule
- Decision: last N consecutive identical (tool+params+result) calls → intervene. Feedback ladder: short-circuit + inject "you're looping/stuck, change approach" → warn+block → require-human/halt, with a cooldown. Knobs: window, require-consecutive, param/result-identity strictness (exact → normalized → LLM-judged).
- Reason: loops are the highest-value agent failure mode; graduated response avoids harsh over-punishment.
- Evidence: `src/policy/matchers/loopDetector.ts`, `src/policy/actions/*`, `src/policy/feedbackStore.ts`

## Block behavior = never silent
- Decision: block = drop the offending call AND return a message to the LLM ("blocked by rule X, reason…").
- Reason: the model must see why it was stopped to change behavior.
- Evidence: `src/policy/actions/block.ts`

## Session / loop detection = stateless per-request
- Decision: scan full per-request history (client resends all turns each request; no standard conversation-id on the wire). Session key = content-fingerprint of stable prefix + optional client token (`X-Session-Id`).
- Reason: statelessness means no server-side session store needed; survives restarts.
- Evidence: `src/session/session.ts`, `src/policy/matchers/loopDetector.ts`

## Tools NOT fronted in MVP
- Decision: MVP does not front tools; extensible via a `ToolProvider` port so MCP + skills can be injected as plugins later.
- Reason: keep core proxy-agnostic; tool gating can be added without rework.
- Evidence: `src/ports/strategy.ts` (ToolProvider)

## Storage = Repository, SQLite default, swappable
- Decision: Repository pattern with SQLite default; swappable to Postgres later.
- Reason: zero-dep local persistence now, portable storage interface later.
- Evidence: `src/storage/schema.ts`, `src/storage/sqlite.ts`, `src/ports/storage.ts`

## Dashboard = dependency-free, real-time, same process
- Decision: local web dashboard, no login, real-time (live tool-call stream + intervention log + counts/top tools) + rule authoring; built as dependency-free vanilla-JS SPA + built-in RFC6455 WebSocket + Node `http` REST, served by the same process. NO React/Vite/Tailwind/shadcn, NO `ws` package.
- Reason: keeps the whole system zero-dependency and single-process; supersedes an earlier React/Vite+Tailwind+shadcn draft.
- Evidence: `dashboard/`, `src/api/ws.ts`, `src/server/index.ts` (`DASHBOARD_FILES`)

## Live tool-call stream = dual-source (WS primary + /api/events polling)
- Decision: the dashboard populates its live stream from TWO sources — WebSocket as low-latency primary plus a ~2.5s `GET /api/events` polling fallback (deduped by event key), with a WS keepalive that reconnects after ~3 silent windows and a visible live/polling status banner.
- Reason: real access paths (tunnels/port-forwards/webviews) may not forward the `Upgrade: websocket` header, leaving a half-open socket that shows nothing while plain-HTTP fetch still works; polling guarantees records appear regardless of WS support.
- Evidence: `dashboard/app.js` (polling + dedup + keepalive), `src/api/http.ts` (`/api/events`), `src/telemetry/collector.ts` (`getRecentEvents`), `tests/e2e-integration.test.ts`

## Deferred scope
- **v1.1:** multi-model + per-client routing + fallback (full LiteLLM-lite); scripting hooks; LLM-as-policy matcher; streaming; Postgres option.
- **Later:** MCP tool gateway; skills (injected via `ToolProvider` port).
