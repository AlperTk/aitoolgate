---
name: constraints
description: MUST / MUST NOT rules, architectural restrictions, infrastructure limits, and external-system constraints that constrain future work in aitoolgate. Read before making cross-cutting changes or adding dependencies.
---

# Constraints

## MUST
- **Runtime dependencies allowed when justified.** Provider SDKs / npm runtime packages may be added (user decision, 2026-10-29). Prefer Node stdlib (`node:http`, `node:sqlite`, global `fetch`) first; add a package only when it clearly pays off.
- **Wrap all telemetry emission in `safeEmit`** (or equivalent try/catch) so a telemetry failure never fails an LLM request; bus handlers are isolated.
- **Route OpenAI↔Anthropic conversion through `src/proxy/translate.ts`** (entry point for request + response conversion). Don't scatter translation. Conversion logic itself belongs in `src/protocols/<id>/` behind `src/ports/protocol.ts`; `translate.ts` delegates to it (tool-call rewrite via `Protocol.applyToolCalls`; the change-gate stays in `translate.ts`).
- **`translate.ts` output is stable** unless there is an explicit behavior decision. Exception (user-approved): malformed upstream responses no longer use the HEAD fallback mappers; protocols keep id/model/usage, and `translate.ts` uses an `EMPTY_RESPONSE` default.
- **Protocol parity is the contract:** `tests/protocols-parity.test.ts` and the pinned malformed-response tests define expected output; change them only with an explicit behavior decision (the approved HEAD-fallback removal is such a decision).
- **Error bodies come from the protocol registry** (`ProtocolRegistration.errorBody` / `clientErrorBody` in `src/protocols/registry.ts`); `upstream.ts` must not import protocol modules.
- **All streaming goes through `InternalLLMEvent`:** every upstream SSE stream, same-protocol or cross-protocol, is decoded (`decodeStream`) to `InternalLLMEvent` and re-encoded (`encodeStream`) for the client via `streamForClient`/`bridgeStream`. **No same-protocol bypass on any path:** never forward upstream SSE bytes unchanged to the client.
- **Opaque passthrough is same-protocol only:** unmodeled request fields (`InternalRequest.extra`, incl. `OpaquePart` blocks) are re-emitted only when the target protocol equals the source protocol; never carry them across protocols.
- **Error Content-Type:** JSON error bodies are sent as `application/json`; `text/event-stream` only for actual SSE streams.
- **Metadata-only JSON-200 (2xx, no message content) → client-protocol HTTP 502** `upstream returned a non-streaming response without content` (user-approved). Content-bearing JSON-200 → synthetic SSE; undecodable JSON → raw passthrough.
- **Keep domain/proxy/protocol ops non-throwing** — return `null`/`undefined` for not-found/no-match. Only `readJSONBody` throws (invalid API input).
- **Build before test** — tests run against compiled `dist/`; `npm run build` must precede `npm test`.
- **Store large tool-result values out-of-band** (in-memory keyed by id + optional async SQLite), never inline in `TelemetryEvent`/WS frames.
- **Keep per-session state in the policy STAGE** (`SessionFeedbackStore`); rules are stateless (the flagship rule is deliberately stateless).
- **Centralize tool-CALL emission** in `context.ts` (`emitResponseTelemetry`) — not in the policy stage.
- **Keep `RuleSpec` ↔ engine factories consistent with `dashboard/js/rule-schema.mjs`** (form schemas are synced to `src/api/ruleSpec.ts`).
- **Gate opt-in features via config/options:** storage via server options (`options.telemetry.storage`); tool-result persistence via `config.toolResults.enabled` (default off).
- **Keep provider persistence best-effort** — a failing open/read/write logs a warning and leaves the in-memory provider store untouched; the server still boots (in-memory fallback if the DB can't open).
- **Validate provider input strictly:** `POST /api/api-providers` requires non-empty `name` and `baseUrl`; `adapterId` must be a catalog type (`generic-openai`, `generic-anthropic`, `copilot`); the wire `protocol` is derived from the type and ignored if sent by the client; `apiKey` must be string-or-null (forbidden for `copilot`, whose `authType` is forced to `deviceOAuth`); unknown extra fields are ignored.

## MUST NOT
- **Mutate protocol inputs** — protocol ops (e.g. `Protocol.applyToolCalls`) MUST NOT mutate their input; they return a copy.
- **Persist the built-in `flagship-loop-rule`** to the database.
- **Inline heavy payloads into every WS broadcast** (unbounded memory).
- **Assume multiple *concurrently-active* upstreams** — at most ONE provider is active at a time (single-active invariant); the active upstream is runtime-switchable but never load-balanced.
- **Leak a provider's raw `apiKey`** in list responses — expose only `apiKeySet`; only the detail `GET /api/api-providers/:id` may return the raw key; `deviceOAuth` rows always return `apiKey: null`.
- **Leak `authState` (OAuth tokens, `auth_state` column)** in any list, detail, or device-flow response; it is written only by the server-side device-flow path and is never client-writable. Device-code `device_code` values stay server-side (flow registry), never sent to the client.
- **Echo a raw `apiKey` or raw upstream error body from `POST /api/api-providers/probe`** — probe errors are key-redacted and upstream bodies are discarded.

## Architectural restrictions
- Framework-agnostic contracts live in `src/ports/`; impls depend on ports, not each other. Put new abstractions in `ports/`; impls consume them.
- **Single composition root:** `server/index.ts` builds and injects all subsystems; the proxy depends on injected port interfaces (`src/ports/telemetry.ts`), never on concrete factories (DIP). See architecture.md.
- Two tsconfigs: `tsconfig.json` (dev, `noEmit`, Bundler resolution) and `tsconfig.build.json` (build → `dist/`, node16). Don't emit from the dev tsconfig.
- Dashboard CSS is **token-first** (`css/tokens.css`); don't hardcode values. `styles.css` `@import` order matters — later sheets win at equal specificity.

## Infrastructure limits
- Provider probe timeout 10 000 ms (`PROBE_TIMEOUT_MS`); proxy upstream fetch remains unbounded.
- `PORT` is validated as an integer 0–65535 (throws otherwise); default **8787**.
- Upstream fetch has **no timeout** (`streamToEndpoint` = no-timeout fetch).
- Collector caps: `maxInterventions=500`, `maxRecent=200`, `maxTokenTurns=10000`. Tool-metrics pending TTL default 300 000 ms; `maxPending` 1 000. In-memory tool-result store bounded at 1 000 entries.
- SQLite persister runs in **WAL mode**; flush interval default 50 ms, batch size default 100, `fsyncPerBatch` default false.
- Static dashboard serving **rejects path traversal / absolute paths / null bytes** and serves only `.html/.css/.js/.mjs` inside the dashboard dir; `resolveDashboardDir` walks up ≤4 levels for `dashboard/index.html`.

## External-system restrictions
- **No env-based upstream config:** upstream target comes only from the provider store or programmatic `options.upstream`; an unconfigured proxy answers LLM routes with **503 JSON** (`UNCONFIGURED_UPSTREAM`) before any fetch — configure via dashboard Settings or `POST /api/api-providers`.
- Single *active* upstream target (provider store or programmatic `options.upstream`); multiple persisted provider configs are allowed but only one is active at a time (no concurrent routing).
- Persistence is Node built-in `node:sqlite` — no external DB server, no migration CLI (migrations auto-apply on open, `SCHEMA_VERSION=5`).

## Rules whose violation causes a production incident
- Unwrapped telemetry emission → a request can 500 / traffic lost.
- Skipping `npm run build` before tests → stale `dist/` makes tests fail or misrun.
- Inlining heavy payloads into events/broadcasts → unbounded memory + slow WS.
- Path-traversal gap in static serving → arbitrary local file read.
- Exposing a raw provider `apiKey` in a list response → credential leak.
