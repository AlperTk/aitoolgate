---
name: proxy
description: The proxy module (src/proxy): OpenAI and Anthropic route handlers, non-stream and SSE stream pipelines, upstream forwarding, and upstream/client error mapping. Read when changing request handling, streaming, pipeline stages, or proxy errors.
---
# Module: proxy (`src/proxy/`)

Snapshot: 9a2fbb5b684093c9197a81929d7741a91c9718ec. Coverage: partial — OpenAI route body and runner-listed stages read; Anthropic route, `buildRequestContext`, `readJSONBody`, `postJSON`, `streamToEndpoint`, `bridgeStream`, `pipeUpstreamStream`, `conformResult`, `reencodeRequest`, `convertResponse` not read.

## Scope
- Owns: HTTP-level request handling for `/v1/chat/completions` and Anthropic messages, pipeline execution, streaming bridge, upstream calls, error mapping.
- Does not own: protocol encode/decode bodies (`src/protocols/`), provider selection/auth (`src/providers/`), rule evaluation (`src/policy/`).
- Depends on ports: `Pipeline`, `PipelineStage`, `ProxyDefaults`, `TelemetryEventBus`.

## Critical objects
| Symbol | Path | Responsibility |
|---|---|---|
| `createProxyHandler` | src/proxy/index.ts | Builds pipeline, bus, tracker, token pipeline; returns inner `handleProxyRequest` (not exported) |
| `SessionTokenPipeline` | src/proxy/index.ts | Wraps base pipeline: `handleRequest`, `handleResponse`, `handleResult`, `use`, `setSessionToken` |
| `handleOpenAIRoute` | src/proxy/openai.ts | GET `/v1/models`; POST `/v1/chat/completions`: read body, stream or buffer |
| `handleAnthropicRoute` | src/proxy/anthropic.ts | Same shape as OpenAI route |
| `runThroughPipeline` | src/proxy/context.ts | Non-stream pipeline sequence |
| `streamSameProtocolRequest` | src/proxy/context.ts | Stream path, SSE tap |
| `forwardRequest`, `streamForClient`, `upstreamErrorResponse`, `clientErrorResponse`, `unconfiguredUpstreamResponse` | src/proxy/upstream.ts | Upstream call and error shaping |
| `CODECS` | src/proxy/translate.ts | Protocol codec table |

## Flow A — non-stream request (OpenAI)
1. `createProxyHandler` → `handleProxyRequest` sets session token on the pipeline.
2. `handleOpenAIRoute` (openai.ts) matches route, reads JSON body (`readJSONBody`), detects stream (`isStreamRequest`).
3. `buildRequestContext` (context.ts) builds the internal request.
4. `runThroughPipeline`: `SessionTokenPipeline.handleRequest` → `syncRequestMessages` → `resolveAndEmitToolResults` → `forwardRequest`.
5. `forwardRequest` (upstream.ts): unconfigured upstream → 503; `reencodeRequest` to upstream protocol; `postJSON`; `conformResult`; `convertResponse` when protocols differ.
6. `runThroughPipeline` continues: `summarizeResponse` → `handleResponse` → `syncResponseBody` → `emitResponseTelemetry` → `sendJSON`.

## Flow B — streaming request (same protocol)
1. `streamSameProtocol` (openai.ts) → `streamSameProtocolRequest` (context.ts): `handleRequest`, `resolveAndEmitToolResults`, SSE extractor built in try/catch (a factory failure disables only the tap).
2. `streamForClient` (upstream.ts): `reencodeRequest` → `streamToEndpoint` → `bridgeStream` with optional tap.
3. `pipeUpstreamStream` writes SSE frames to the client response.

## Failure paths
- No active upstream → 503 (`unconfiguredUpstreamResponse`).
- Upstream timeout → 504 `upstream_timeout` (`upstream.ts`, enclosing symbol unverified).
- Upstream error body → `upstreamErrorResponse` → `clientErrorResponse` in the client's protocol.
- Empty upstream content → 502 with `NO_CONTENT_MESSAGE` (`upstream.ts`, enclosing symbol unverified).
- Telemetry/storage failures are caught and do not affect the response.

## Invariants (observed)
- Policy stage runs in both request and response phases through the same pipeline.
- Telemetry failures are isolated; the client stream must not depend on them.
- Session token is set before route handling (`handleProxyRequest`).

## Tests (names)
`tests/proxy.test.ts`, `proxy-telemetry.test.ts`, `stream-parity.test.ts`, `cross-protocol-stream.test.ts`, `cross-protocol-route-stream.test.ts`, `cross-protocol-json200-error.test.ts`, `unconfigured-upstream-503.test.ts`, `upstream-content-type.test.ts`.

## Change recipe — new route or request field
- Start at `handleOpenAIRoute` / `handleAnthropicRoute`. Protocol-level decode/encode belongs to `src/protocols/`. Verify with the proxy and cross-protocol tests above plus `npm test` after `npm run build`.

## Anthropic route (verified)
`handleAnthropicRoute` (`src/proxy/anthropic.ts`) mirrors `handleOpenAIRoute`: route `/v1/messages` (no `/v1/models`), protocol `anthropic-messages`, decode via `readJSONBody`, encode via `sendJSON`.

## Session token and SessionKey (verified)
- `src/proxy/index.ts::createProxyHandler` sets the token from the request header via `tokenPipeline.setSessionToken(readStringHeader(...))`.
- `src/proxy/context.ts::sessionKeyFromHeaders` builds the SessionKey, called from `buildRequestContext`.

## Unknowns
- Enclosing symbols of the 504 and 502 sites in `upstream.ts` — not verified.
- Callers of `upstreamErrorResponse` beyond the forward paths — not verified.
- Request-body size limits outside `http.ts` — not verified (see `constraints.md`).
