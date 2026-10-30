---
name: conventions
description: Shared implementation patterns: factory-based DI, port-first contracts, registries, telemetry isolation, test layout. Read before adding a provider, action, matcher, protocol, event, or test.
---
# Conventions

Snapshot: 9a2fbb5b684093c9197a81929d7741a91c9718ec. Each pattern lists its evidence. Do not generalize beyond the listed anchors.

## 1. Factory functions + port interfaces (observed across modules)
- Components are `create*` factories returning an object typed by a port (e.g. `createEventBus` → `TelemetryEventBus`, `createPolicyStage` → `PipelineStage`, `createGenericAdapter` → `ProviderAdapter`).
- Dependencies are passed as options objects; defaults come from `src/composition.ts` (`defaultProxyDefaults`), not from imports inside the proxy.
- Anchors: `src/server/index.ts::createServer`, `src/composition.ts::defaultProxyDefaults`.

## 2. Registries as typed maps
- Providers: `src/providers/registry.ts::PROVIDER_ADAPTERS` keyed by adapter id; lookup via `lookupProviderAdapter` (own-property check, returns null when absent); `wireProtocolFor` defaults unknown ids to `openai`.
- Policy actions: `src/policy/actions/index.ts::ACTION_STRATEGIES` is a `Record` keyed by `ActionEffectKind`; a missing entry is a compile error.
- Protocol codecs: `src/proxy/translate.ts::CODECS` (`openai-chat`, `anthropic-messages`); protocol registration in `src/protocols/registry.ts`.
- Matchers have no registry map; they are attached to rule objects (see `modules/policy.md`).

## 3. Telemetry isolation
- Telemetry must not break the client path. Anchors: `createEventBus` per-handler try/catch and `.catch`; `src/proxy/index.ts::createProxyHandler` storage writes in try/catch; `streamSameProtocolRequest` extractor factory in try/catch; `src/policy/policyStage.ts` emit with `.catch(() => {})`.
- Test anchor: `tests/cross-protocol-route-stream.test.ts` (telemetry transform failure does not break the client stream).

## 4. Error responses
- Client-facing errors are built via protocol-aware helpers: `src/proxy/upstream.ts::clientErrorResponse`, `src/protocols/registry.ts::clientErrorBody`.
- Status mapping observed: 503 unconfigured upstream (`unconfiguredUpstreamResponse`), 504 `upstream_timeout`, 502 upstream error or no content.
- Router-level: 404 `not_found`, 500 `internal_error`.

## 5. Tests
- Runner: `node:test` + `node:assert/strict`. Flat `tests/` directory; `*.test.ts` and `*.e2e.test.ts`; compiled to `dist/tests/`.
- Shared helpers: `tests/helpers.ts` (`createFakeModel`, `makeMockFetch`, `oaiCanned`, `startProxy`, `startAtgServer`, `closeAtgServer`, `listenEphemeral`, `closeHttpServer`, `portOfServer`); DOM stub `tests/dom-stub.ts` (`createDomStub`, `FakeEl`).
- Integration tests use a mock upstream; no real provider is needed.

## 6. Dashboard
- Vanilla JS ES modules; entry `dashboard/app.js` imports `dashboard/js/*.mjs`. Not compiled by TypeScript (excluded in both tsconfig files). Served as static files by the router (`resolveDashboardDir`, `resolveDashboardAsset`, `serveStaticFile`).
- Module boundaries: `constants.mjs`, `state.mjs`, `dom.mjs`/`format.mjs`/`time.mjs` (helpers), `transport.mjs` (WebSocket connect, reconnect, events polling), `ingest.mjs` (event ingestion), `live-view.mjs`/`table.mjs`/`stats.mjs` (views), `rules.mjs`/`rule-schema.mjs` (rule editor), `settings.mjs`/`settings-providers.mjs` (provider settings), `controls.mjs`/`views.mjs`/`layout.mjs` (controls, view switching, mounting).
- Main exports: `ingestEvent`, `handleWsMessage` (ingest.mjs); `connectWS`, `startEventsPolling` (transport.mjs); `renderRules`, `saveRule` (rules.mjs); `createProvidersPane`, `initSettings` (settings); `mountLayout` (layout.mjs); `initViews` (views.mjs).
- Not verified in this bootstrap: whether adding a provider type requires dashboard list updates (`listProviderTypes`, `PROVIDER_TYPE_LABELS`).

## Where new code goes (by existing mechanism)
| Change | Put it in | Wire via |
|---|---|---|
| New upstream provider | `src/providers/<name>/` | `PROVIDER_ADAPTERS` in `src/providers/registry.ts` |
| New policy action | `src/policy/actions/<name>.ts` | `ACTION_STRATEGIES` + `ActionEffectKind` in `src/policy/types.ts` |
| New matcher | `src/policy/matchers/<name>.ts` | re-export in `src/policy/matchers/index.ts` |
| New telemetry event | `src/telemetry/events.ts` union | emit at producer; collector handles in `src/telemetry/collector.ts` |
| New dependency for proxy | `src/ports/telemetry.ts::ProxyDefaults` | default in `src/composition.ts` |

Unverified steps are listed in `modules/providers.md` and `modules/policy.md` under Unknowns.
