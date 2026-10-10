---
name: project
description: What mcp-manager is, who it serves, its scope, core use cases, and technology stack. Read first to orient on the project before diving into architecture or domain.
---

# Project

## Purpose
`mcp-manager` is a **local, zero-runtime-dependency TypeScript model proxy** on Node that sits in the agentic loop as a **man-in-the-middle over the LLM request/response stream** (LiteLLM-style). Its core value is a **programmable tool-monitoring / interception layer**: declarative *policy pipelines* inspect and optionally rewrite the message stream while transparently forwarding traffic to one configured upstream model.

## Scope
- **In:** proxying LLM chat traffic; policy-based inspection & rewriting of tool calls; OpenAI↔Anthropic protocol translation (request, response, and SSE streams); rule CRUD REST API; real-time WebSocket telemetry feed; opt-in SQLite persistence; local dashboard.
- **Out:** it proxies to exactly ONE *active* upstream at a time (no concurrent multi-model routing/load-balancing) — though that active upstream is **runtime-switchable** among multiple persisted provider configs (see `domain.md`/`architecture.md`); it is not an auth gateway, and makes no cloud/distributed-system assumptions. Single-host only.

## Core use cases
1. Point an AI client at the proxy's OpenAI (`/v1/chat/completions`, `/v1/models`) or Anthropic (`/v1/messages`) endpoint instead of the provider directly.
2. Author **policy rules** (matcher + action) to block tool calls, detect tool-call loops, hide tools, inject corrective feedback, or rewrite tool arguments — live, without restarting.
3. Watch sessions in real time via the dashboard: live tool-call stream, per-tool metrics/tokens, intervention log.
4. Drill into any tool call's actual returned value (`GET /api/tool-results/:id`).
5. Optionally persist rules, telemetry events, and tool-result values to local SQLite.
6. Add/edit and **switch the active LLM upstream** among multiple persisted provider configs (name, base URL, model, protocol, key) via the dashboard **Settings** UI or the `api-providers` REST API — hot-applied to the proxy **without a restart** (at most one provider is active at a time).

## Main consumers
- AI clients/agents configured with the proxy as their model base URL (OpenAI- or Anthropic-wire format).
- A local browser dashboard (real-time ops view).
- Operators adding/removing rules or providers via the REST API or the dashboard UI.

## Technology stack (version-pinned)
| Layer | Choice | Notes |
|---|---|---|
| Language/runtime | TypeScript on Node | dev-only deps: `typescript@^7.0.2`, `@types/node@^26.6.4`. **Zero runtime dependencies.** |
| HTTP | `node:http` | no framework. |
| WebSocket | hand-written RFC6455 server (`src/api/ws.ts`) | no `ws` package. |
| Streaming | native SSE parsing (`src/telemetry/stream-extract.ts`) | protocol-aware. |
| Persistence | `node:sqlite` (`DatabaseSync`) | Node built-in; two DB files. |
| Dashboard | vanilla JS ES modules (`.mjs`) | no framework/bundler/fonts/CDNs. |
| Tests | Node `node:test` + `node:assert/strict` | run against compiled `dist/`. |
| Build | `tsc` → `dist/` (node16 CJS) | source authored as ESNext modules. |

## High-level overview
```
AI client ──▶ mcp-manager (proxy + policy engine + telemetry) ──▶ one *active* upstream LLM (provider-switchable)
   │               node:http  (OpenAI + Anthropic endpoints)
   │               REST  /api/{rules,stats,events,tool-results,api-providers}
   │               WS    /ws  (live TelemetryEvent feed)
   │               static  dashboard/ (vanilla JS + Settings gear)
   ▼
   SQLite: data/rules.db (+ optional data/tool-results.db)
```
