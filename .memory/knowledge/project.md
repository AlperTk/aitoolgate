---
name: project
description: Purpose, scope, and principal use cases of aitoolgate. Read first when onboarding or when a change affects what the product does.
---
# aitoolgate — project overview

Snapshot: 9a2fbb5b684093c9197a81929d7741a91c9718ec (bootstrap).

## Purpose
Single-process TypeScript HTTP proxy that sits between AI clients and upstream LLM providers. It accepts OpenAI Chat Completions and Anthropic Messages requests, forwards them to a configured upstream (translating protocol when client and upstream differ), and applies a policy engine to tool calls and messages. It also collects telemetry and serves a live dashboard.

## Principal use cases
- Route `POST /v1/chat/completions` and Anthropic messages requests to the active upstream provider (streaming and non-streaming).
- Apply user-defined or built-in policy rules to tool definitions, tool-call arguments, and messages (request and response phases).
- Record telemetry events (tool calls, tool results, token usage, policy interventions) and expose stats, recent events, and a live WebSocket stream.
- Manage rules and upstream providers via REST (`/api/*`) and a browser dashboard.
- Optionally persist rules, providers, and tool results in SQLite.

## Scope and packaging
- Package `aitoolgate` 0.1.1, Apache-2.0, `engines.node >=22.5`, zero runtime dependencies.
- Binary entry: `dist/src/server/index.js`.
- Dashboard is static assets served by the same HTTP server.

## Related
- Structure and cross-module flows: `knowledge/architecture.md`.
- Commands and env vars: `knowledge/commands.md`.
