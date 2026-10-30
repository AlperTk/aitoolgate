---
name: providers
description: The providers module (src/providers): provider adapter registry, generic API-key adapter, Copilot adapter with device OAuth, and upstream URL/header resolution. Read when adding or changing an upstream provider or its auth.
---
# Module: providers (`src/providers/`)

Snapshot: 9a2fbb5b684093c9197a81929d7741a91c9718ec. Coverage: partial — registry, generic adapter, Copilot adapter, session-independent auth read; `createDeviceOAuthAuth` body not read.

## Scope
- Owns: adapter registry, provider-specific endpoint resolution, auth strategies, provider-specific headers.
- Consumed by: server wiring (`applyActiveProvider` in `src/server/index.ts`) and proxy forwarding.

## Critical objects
| Symbol | Path | Responsibility |
|---|---|---|
| `PROVIDER_ADAPTERS` | src/providers/registry.ts | Map: `GENERIC_OPENAI`, `GENERIC_ANTHROPIC`, `COPILOT` → adapter |
| `lookupProviderAdapter` | src/providers/registry.ts | Own-property lookup; null when absent |
| `wireProtocolFor` | src/providers/registry.ts | Adapter → wire protocol; unknown → `openai` |
| `createGenericAdapter` | src/providers/generic/adapter.ts | id `generic-<protocol>`, API-key auth, endpoint = `config.baseUrl` unchanged |
| `createApiKeyAuth` | src/providers/generic/apiKeyAuth.ts | Emits `Authorization: Bearer <key>` and `x-api-key` |
| `createCopilotAdapter` | src/providers/copilot/adapter.ts | Device OAuth, `decorateHeaders`, `listModels` |
| `resolveCopilotBaseUrl` | src/providers/copilot/adapter.ts | Normalizes default host and `copilot-api.*` prefix |
| `createDeviceOAuthAuth` | src/providers/auth/deviceOAuth.ts | Device OAuth strategy (body not read) |

Copilot `decorateHeaders` adds `User-Agent`, `Openai-Intent`, `X-GitHub-Api-Version`, `x-initiator` (via `initiatorFor`), and `Copilot-Vision-Request` when image content is present.

## Flow
Active provider chosen in server (`applyActiveProvider`) → adapter via `lookupProviderAdapter` → `resolveEndpoint` / `decorateHeaders` / auth applied per upstream call in the proxy.

## Change recipe — add a provider
1. Create `src/providers/<name>/` implementing `ProviderAdapter` (id, wireProtocol, auth, endpoint resolution, optional `decorateHeaders`, optional `listModels`), modeled on `generic/adapter.ts`.
2. Add an id constant and an entry in `PROVIDER_ADAPTERS` (`src/providers/registry.ts`).
3. Verify: `tests/provider-adapter-registry.test.ts`, `tests/provider-types.test.ts`, `tests/provider-schema-v4.test.ts`, `tests/provider-active-patch.test.ts`; for Copilot-style auth also `tests/copilot-adapter.test.ts`, `tests/copilot-wiring.test.ts`.

## Invariants / pitfalls (observed)
- An unknown adapter id silently maps to wire protocol `openai` (`wireProtocolFor`), which can hide misconfiguration.

## Unknowns
- Whether the dashboard provider-type list (`listProviderTypes`, `PROVIDER_TYPE_LABELS`) must also be updated for a new provider — not verified.
- Caller path from `applyActiveProvider` through `lookupProviderAdapter` not traced.

## Device OAuth (resolved)
- `createDeviceOAuthAuth` returns `startDeviceFlow`, `pollDeviceFlow`, `resolveAuthStateHeaders` (`resolveHeaders` exists as an inner child but is not on the interface).
- Auth state is `JSON.stringify({ v: AUTH_STATE_VERSION, accessToken })` (`serializeAuthState`); no separate OAuth `state` parameter.
- Host is user-supplied and validated (`invalid_domain`); token endpoint `https://<host>/login/oauth/access_token`. See `constraints.md`.
