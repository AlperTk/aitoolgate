---
name: constraints
description: Cross-cutting security, operational, architectural, compatibility, and external-system constraints of aitoolgate, each with its anchor. Read before touching auth, the management API, config parsing, timeouts/limits, provider URLs, or compatibility targets.
---
# Constraints

Snapshot: 9a2fbb5b684093c9197a81929d7741a91c9718ec. Basis key: doc = README, code = source symbol, test = test name.

## Security
| Constraint | Anchor | Basis |
|---|---|---|
| Management API is not an authentication boundary; run only for trusted users | README "Security and limitations"; README "API reference" | doc |
| Provider-detail API can return raw API keys; restrict access | README "Security and limitations" (Provider credentials) | doc |
| Prompts, tool arguments, and tool results may contain secrets; review retention | README "Security and limitations" (Sensitive content) | doc |
| `authState` is never returned by any provider route | `src/api/http.ts::createApiHandler` (`withoutAuthState`); test "list responses never include authState" in `tests/provider-schema-v4.test.ts` | code, test |
| Device-OAuth rows: `apiKey` forced null; PATCH with `apiKey` rejected 400 | `src/api/http.ts::createApiHandler`; `tests/provider-probe-copilot.test.ts` | code, test |
| Copilot token is kept server-side behind an opaque `pendingId` | `src/api/http.ts::createApiHandler` | code |
| Only a `Bearer` token is extracted from the client `Authorization` header | `src/proxy/context.ts` (header parsing) | code |
| Path traversal is not served outside the dashboard directory | test "security: path-traversal…" in `tests/server-integration.test.ts` | test |
| No request-body size limit: `readBody` and `readJsonBody` concatenate chunks unbounded | `src/api/http.ts::readBody`, `::readJsonBody` | code (absence) |
| No authentication, Origin, or CORS check in the management API (only 403 for Copilot entitlement) | `src/api/http.ts` | code (absence) |
| Server listens without an explicit host argument (Node default: all interfaces) — README describes localhost | `src/server/index.ts::createServer` (`server.listen`) | code; bind behavior not verified at runtime |

## Operational
| Constraint | Anchor | Basis |
|---|---|---|
| `PORT` must be an integer 0–65535; otherwise startup throws | `config/config.ts::loadConfig` | code |
| Boolean env vars accept only `true/1/false/0`; invalid values silently fall back to default | `config/config.ts::parseBool` | code |
| Positive-integer env vars: non-integer or ≤0 silently falls back to default | `config/config.ts::parsePositiveInt` | code |
| Upstream request timeout 300 s → 504 `upstream_timeout` | `src/proxy/upstream.ts::REQUEST_TIMEOUT_MS` | code |
| Streaming responses have no short timeout | `src/proxy/upstream.ts` (comment on stream path) | code |
| Model-list probe timeout 10 s; probe errors are redacted of secrets | `src/api/providerProbe.ts::PROBE_TIMEOUT_MS`, `::probeModelList`; `tests/api-providers-probe.test.ts` | code, test |
| Tool-result content truncated at 16384 characters | `src/proxy/context.ts::MAX_TOOL_RESULT_CONTENT_CHARS` | code |
| Telemetry in-memory caps: interventions 500, recent events 200, token turns 10000, pending calls 1000, tool results 1000 | `src/telemetry/collector.ts`, `src/telemetry/toolMetrics.ts`, `src/telemetry/toolResultStore.ts` | code |
| Server starts without an upstream; model requests return 503 until one is configured | README "Configure an upstream"; `tests/unconfigured-upstream-503.test.ts` | doc, test |
| Raw tool-result persistence disabled by default (`TOOL_RESULTS_ENABLED=false`) | README "Configuration" | doc |
| Live policy rule changes need no restart | README "Policy engine" | doc |

## Architectural
| Constraint | Anchor | Basis |
|---|---|---|
| Hexagonal layout; `src/server/index.ts` is the sole composition root | README "Architecture"; `src/server/index.ts::createServer` | doc, code |
| Telemetry failures must not break the proxied request | README "How it works"; `createEventBus` try/catch | doc, code |
| Exactly one active upstream provider at a time; no load balancing | README "Security and limitations"; `src/api/providerStore.ts` (`markActive`, `reconcileSingleActive`) | doc, code |
| Streaming always goes decode → internal event → encode; no same-protocol bypass | README "Streaming and reasoning" | doc |
| Built-in `flagship-loop-rule` is never persisted | `src/api/persistentRuleStore.ts` (`FLAGSHIP_RULE_ID`, `persistId`, `seedFromDb`); README "Policy engine" | code, doc |
| Dashboard is vanilla JS with no CDN or framework | README "Dashboard" | doc |
| Rule store returns defensive copies | `src/api/ruleStore.ts` (doc comment; list/get/add/update return copies) | code |

## Compatibility
| Constraint | Anchor | Basis |
|---|---|---|
| Node.js ≥ 22.5 required (`node:sqlite`) | README "Quick start"; `package.json` `engines` | doc |
| Zero third-party runtime dependencies; Node stdlib only | README "Technical choices"; `package.json` (no `dependencies`) | doc |
| Anthropic unsigned thinking blocks are dropped (open decision, not settled) | README "Streaming and reasoning" | doc |
| Non-SSE JSON response with no content → 502 | README "Non-SSE JSON responses"; `src/proxy/upstream.ts` (`NO_CONTENT_MESSAGE`) | doc, code |

## External systems
| Constraint | Anchor | Basis |
|---|---|---|
| Copilot base URL: default GitHub host → `api.githubcopilot.com`; any other host → `https://copilot-api.<host>`; no allowlist | `src/providers/copilot/adapter.ts::resolveCopilotBaseUrl` | code |
| GitHub device-OAuth host is user-supplied; invalid domains rejected (`invalid_domain`) | `src/providers/auth/deviceOAuth.ts::createDeviceOAuthAuth`; test in `tests/device-oauth-auth.test.ts` | code, test |
| Device-OAuth token endpoint is `https://<host>/login/oauth/access_token` | `src/providers/auth/deviceOAuth.ts` | code |

## Unknowns
- Whether a request-body limit exists outside `http.ts` (e.g. in `createHttpRouter`) — not read.
- Whether the API rejects writes to `flagship-loop-rule` — `ruleSpec.ts::describeRule` special-cases it but no rejection was found.
- Actual bind host at runtime — inferred from Node defaults.
