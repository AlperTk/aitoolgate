# aitoolgate

**Observe, debug, and optimize AI agent tool usage — locally.**

[![Version](https://img.shields.io/badge/version-0.1.0-blue)](#)
[![TypeScript](https://img.shields.io/badge/TypeScript-7.0.2-blue)](#)
[![Runtime dependencies](https://img.shields.io/badge/runtime_dependencies-0-brightgreen)](#)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
[![Npm Version](https://img.shields.io/npm/v/aitoolgate.svg)](https://www.npmjs.com/package/aitoolgate)

`aitoolgate` is a **local tool observability and optimization proxy** for AI agents and developers building or tuning tools. Route your agent's model traffic through it to see **which tools are offered and called, their inputs and outputs, execution times, token usage, and cache-hit behavior** in one real-time dashboard.

Go beyond monitoring: **hide tools, change tool descriptions, rewrite arguments, and inject messages** using live policy rules — without changing your agent's source code. This makes it easier to investigate inefficient tool usage, refine tool definitions, and compare behavior while developing tools.

The underlying proxy supports OpenAI- and Anthropic-format APIs, including streaming and protocol translation. It forwards to **one active upstream model provider at a time**, which you can switch without restarting.

## Why aitoolgate?

When developing AI-agent tools, the model's final answer rarely explains *why* it selected a tool, what arguments it sent, how much context the interaction consumed, or whether the returned data was useful. `aitoolgate` makes those interactions visible and gives you a way to adjust what the model sees.

| What you want to do | How aitoolgate helps |
| --- | --- |
| **Inspect tool execution** | See tool names, sessions, call status, arguments, returned content, and timing. |
| **Find expensive tools** | Compare per-tool attributed token totals, average token usage, response-token estimates, and durations. |
| **Understand context usage** | Track total, input, output, and cache-hit input tokens at the turn level. |
| **Improve tool definitions** | Modify tool descriptions or hide selected tools using live rules. |
| **Debug agent behavior** | Investigate repeated calls, match argument patterns, and review policy interventions. |
| **Work locally** | Use the bundled dashboard and optional SQLite storage without third-party runtime packages. |

### What you can measure

- **Overall usage:** total tokens, base input tokens, cache-hit input tokens, and output tokens.
- **Per-tool usage:** attributed token totals, cache-hit input tokens where reported, average usage derived from aggregates, and estimated returned-content tokens.
- **Tool activity:** invocation and result counts, execution durations, and per-session history.
- **Tool details:** inspect arguments and captured outputs to diagnose overly verbose results or unnecessary calls.

> **How token metrics work:** Whole-turn token counts use upstream-reported usage when available, with an approximate character-based fallback otherwise. Per-tool token totals attribute a turn's usage to tools invoked in that turn; they are **not isolated token costs for individual tool executions**. Returned-content token counts are estimated from response size. Cache-hit input is reported separately when the provider supplies it; missing cache metrics do not imply zero cache usage.

## Key capabilities

**Tool observability:** live dashboard with tool-call stream, session/status/tool filters, input/output inspection, result drill-down, timing, aggregate metrics, and JSON/CSV export.

**Tool control:** policy rules can `hideTool`, `addDescription`, `rewriteArgs`, or `injectMessage`. Match by tool name, argument pattern, repeated-call loop, or an unconditional rule. Changes take effect without a restart.

**Proxy compatibility:** OpenAI chat completions and Anthropic messages, JSON/SSE responses, protocol translation, and runtime switching between saved upstream configurations.

**Local-first architecture:** Node.js and TypeScript, zero third-party runtime dependencies, built-in dashboard and WebSocket telemetry, and optional SQLite persistence.

## How it works

```text
 AI client (OpenAI / Anthropic API format)
                 |
                 v
        +-------------------+
        |    aitoolgate     |
        |                   |
        |  Request context  |
        |        |          |
        |  Policy pipeline  |<---- Live rules (dashboard)
        |        |          |
        | Protocol adapter  |
        |        |          |
        |  Upstream proxy   |----> Active model provider
        |        |          |<---- JSON / SSE response
        | Response handling |
        |        |          |
        |   Telemetry bus   |----> Metrics / events
        +-------------------+            |
                 |                       +--> Dashboard (WebSocket)
                 v                       +--> REST API
          AI client response             +--> Optional SQLite storage
```

Requests pass through a policy pipeline, are translated if necessary, and are forwarded to the currently active provider. Responses are returned in the client's protocol. Tool activity and interventions are published to a shared telemetry bus. Telemetry failures are isolated from proxied requests.

## Quick start

### 1. Install and run

**Prerequisite:** Node.js >= 22.5 (for the built-in `node:sqlite` module), plus npm.

**From npm** (published as `aitoolgate`):

```bash
npm i -g aitoolgate
aitoolgate
```

**From source:**

```bash
npm install
npm run build
npm start
```

For development, use `npm run dev` (build then start). The repository uses TypeScript 7.0.2 for development.

Whichever way you start it, open **http://localhost:8787** for the dashboard (the server listens on port `8787` by default; override with `PORT`). The server also exposes `GET /health`.

### 2. Configure an upstream

Open **Settings** in the dashboard, add your upstream provider (name, base URL, model, protocol, and API key if required), and activate it.

The first provider is activated automatically. Later, you can switch the active provider from Settings without restarting the server.

**Important:** The server starts without an upstream. Model requests return `503` (a JSON error) until a provider is configured and active. Configure the upstream via the dashboard Settings overlay or `POST /api/api-providers` (fields: `name`, `baseUrl`, `model`, `protocol`, `apiKey`).

### 3. Send a request through the proxy

Point an OpenAI-compatible client at `http://localhost:8787/v1`, or test directly:

```bash
curl http://localhost:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "gpt-4o-mini",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

The proxy also accepts Anthropic-format requests at `POST /v1/messages`. Responses are translated when the client's protocol differs from the active provider's protocol.

### 4. Inspect activity and configure rules

Use the dashboard to watch tool calls and results, inspect tool inputs and outputs, compare per-tool token and timing metrics, filter by tool/session/status/time, inspect interventions, and create rules through the matcher/action editor. Rules created through the dashboard take effect without a restart.

## Policy engine

Rules have the following general structure:

```json
{
  "enabled": true,
  "priority": 10,
  "matcher": {},
  "action": {}
}
```

The `matcher` and `action` objects must follow the corresponding rule schemas. Create and update rules using the dashboard wizard.

| Matchers | Purpose |
| --- | --- |
| `toolName` | Match a tool by name. |
| `argPattern` | Match tool arguments by pattern. |
| `loop` | Detect repeated tool-call behavior. |
| `always` | Match unconditionally. |

| Actions | Purpose |
| --- | --- |
| `hideTool` | Hide a tool from the applicable model-facing context. |
| `rewriteArgs` | Rewrite matched tool arguments. |
| `injectMessage` | Insert a message into the applicable context. |
| `addDescription` | Add descriptive information to a tool. |

A built-in `flagship-loop-rule` is registered at startup and is not persisted as a user rule. Custom rules are evaluated by the policy pipeline and can be updated live. Actions are implemented through an extensible `ActionStrategy` registry.

## Dashboard and observability

The bundled dashboard uses vanilla JavaScript and a local WebSocket feed—no frontend framework, CDN, or separate dashboard service is required.

- **Live tool activity:** tool name, status, description, session, timing, tokens, and size.
- **Filters and exports:** narrow the visible stream and export calls/interventions to JSON or CSV.
- **Statistics:** total/input/output/cache-hit input tokens, per-tool attributed token totals and averages, response-token estimates, durations, calls, results, and top tools.
- **Intervention history:** see when policy rules affect requests or responses.
- **Tool input/output inspection:** inspect tool-call arguments and retrieve captured raw result content by ID.
- **Settings:** add, edit, and switch the active upstream provider.

Token accounting uses provider-reported usage when present; otherwise it falls back to a character-based estimate. Per-tool attribution and estimated response tokens are diagnostic metrics, not exact per-tool billing costs.

## Configuration

All environment variables are optional.

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `8787` | HTTP, WebSocket, and dashboard port. |
| `RULES_ENABLED` | `true` | Enable SQLite persistence for rules and events. |
| `RULES_DB_PATH` | `data/rules.db` | Rules/events database path. |
| `TOOL_RESULTS_ENABLED` | `false` | Enable persistence of raw tool results. |
| `TOOL_RESULTS_DB` | `data/tool-results.db` | Tool-result database path. |
| `TOOL_RESULTS_FLUSH_MS` | `50` | Tool-result batch flush interval, in milliseconds. |
| `TOOL_RESULTS_BATCH_SIZE` | `100` | Tool-result persistence batch size. |
| `TOOL_RESULTS_FSYNC` | `false` | Run `wal_checkpoint(TRUNCATE)` per batch. |

The two databases separate lightweight rules/events/provider configuration from potentially large tool-result payloads. Raw tool-result persistence is disabled by default.

## API reference

### Model-facing endpoints

| Method | Endpoint | Description |
| --- | --- | --- |
| `GET` | `/v1/models` | Model list for the active upstream. |
| `POST` | `/v1/chat/completions` | OpenAI-compatible chat completions. |
| `POST` | `/v1/messages` | Anthropic-compatible messages. |

### Health check

`GET /health` returns the server's liveness status. Tool activity, metrics, policy rules, and provider settings are managed through the built-in dashboard.

> **Security:** The local management endpoints are not an authentication boundary and can expose sensitive tool data or provider credentials. Keep the server accessible only to trusted users.

## Architecture

`aitoolgate` is a **hexagonal, single-process TypeScript application**. Ports define subsystem contracts, adapters implement them, and `src/server/index.ts` wires everything together as the composition root.

| Location | Responsibility |
| --- | --- |
| `src/server/index.ts` | Server setup and composition root. |
| `src/proxy/` | OpenAI/Anthropic routing, protocol translation, upstream forwarding, SSE handling. |
| `src/policy/` | Rule evaluation, matchers, action strategies, feedback handling. |
| `src/telemetry/` | Event bus, collection, token estimates, tool metrics, result storage. |
| `src/api/` | REST API, WebSocket server, rule/provider stores and validation. |
| `src/ports/` | Framework-independent domain and pipeline contracts. |
| `src/pipeline/` | Default pipeline implementation. |
| `src/session/` | Session-key derivation and session state. |
| `src/storage/` | SQLite storage and schema migrations. |
| `src/composition.ts` | Default dependency-injection components. |
| `config/` | Environment-based configuration. |
| `dashboard/` | Static dashboard assets. |
| `tests/` | Unit, integration, and end-to-end tests. |

### Technical choices

- **Node standard library at runtime:** `node:http`, `node:sqlite`, and a custom RFC 6455 WebSocket implementation.
- **No third-party runtime packages:** TypeScript and Node type definitions are development dependencies.
- **Centralized protocol translation:** request, response, and streaming conversion share the same translation layer.
- **Hot-swappable provider:** requests read the current upstream reference; only one provider can be active at a time.
- **Isolated telemetry:** event failures should not interrupt the model request path.
- **Out-of-band tool results:** large result bodies are stored separately from lightweight event frames, with optional batched SQLite writes.

## Development

```bash
npm run build       # Compile source and tests into dist/
npm test            # Run compiled tests (build first)
npm run typecheck   # TypeScript validation without emitting files
npm run dev         # Build and start
```

Tests use Node's built-in `node:test` and `node:assert/strict`. Integration tests use a mock upstream, so a real model provider is not required. The repository does not currently define lint, format, or CI/CD scripts.

## Security and limitations

- **Local-first, not an auth gateway:** keep the dashboard and management endpoints on a trusted interface or behind appropriate access controls.
- **Sensitive content:** prompts, tool arguments/results, and telemetry may contain secrets or personal data. Review retention and persistence settings before use.
- **Provider credentials:** the provider-detail API can return raw keys; restrict access accordingly.
- **Single active upstream:** provider switching is supported, but concurrent multi-provider routing, load balancing, and distributed coordination are not part of the current design.
- **Usage estimates:** fallback token estimates are approximate.

## License

Licensed under the **Apache License 2.0**. See [LICENSE](LICENSE).

Copyright © 2026 AlperTk.