---
name: domain
description: Domain vocabulary, core entities and their relationships, business rules that are easy to violate, invariants/state, and end-to-end workflows in aitoolgate. Read before changing policy, session, or telemetry behavior.
---

# Domain

## Terminology (project-specific)
- **Rule / PolicyRule** — a declarative policy: `{id, enabled, priority?, description?, matcher, action}`, evaluated against a `PolicyContext`.
- **RuleSpec** — the JSON wire form of a rule sent over REST / shown in the dashboard: `{id?, enabled, priority?, description?, matcher, action}`. `buildRuleFromSpec` → engine `PolicyRule`; `validateSpec` guards it.
- **Matcher** — predicate deciding whether a rule fires on a context. Returns `Match{matched, reason, details?} | null`.
- **Action** — what happens when a rule fires; returns an `ActionEffect` (a discriminated union) or `null`.
- **Pipeline / Stage** — ordered chain of request/response/result handlers each proxied call passes through; the policy engine is mounted as one stage via `.use()`.
- **PolicyContext** — the union of `RequestContext | ResponseContext | ResultContext` that matchers/actions operate on.
- **SessionKey** — per-session identity `{fingerprint, token?}` used to scope state (the feedback store).
- **FeedbackMessage** — a corrective message queued per session and spliced into the next request.
- **TelemetryEvent** — `ToolCallEvent | ToolResultEvent | InterventionEvent | TurnUsageEvent` broadcast on the bus.
- **`turn.usage` / `TurnUsageEvent`** — whole-turn token-mass event covering ALL message content of a turn (not only tool calls/results): upstream-reported usage when present, else a char-based estimate (~4 chars/token). Carries `{input, cacheHitInput, output, total}` under one shared turn-level `at`, with `total = input + cacheHitInput + output` (`input` = base input not served from cache; `cacheHitInput` = input tokens served from the provider cache, `0` on the estimate path). `tool.call` `tokens` also carry an optional `cacheHitInput`.
- **tool-result value** — a tool call's raw returned output, captured out-of-band and fetched lazily by id.
- **flagship-loop-rule** — the built-in always-on loop-detection rule (see below).
- **Provider / ApiProvider** — an LLM upstream config: `{id, name, baseUrl, model, apiKey (string|null), protocol ('openai'|'anthropic'), isActive, createdAt}`. The proxy forwards to the single **active** provider (at most one at a time; env `config.upstream` seeds a "default" one). A **provider spec** is the validatable client-sent subset (`KNOWN_FIELDS`: `name, baseUrl, model, apiKey, protocol, isActive`).

## Core entities & relationships
```
Rule{enabled, priority, matcher, action}
   ├──matcher──▶ Matcher ──matches?──▶ PolicyContext
   └──action───▶ Action  ──apply───▶ ActionEffect   (mutates ctx and/or emits InterventionEvent)

RuleStore (live getter) ─▶ Rule[] ─▶ createRuleEngine ─▶ PolicyStage ─.use()─▶ Pipeline
Provider{baseUrl, model, protocol, apiKey, isActive}   (≤1 active)  ─▶ ApiProviderStore ─▶ proxy upstreamRef (hot-applied, no restart)
SessionKey{fingerprint[,token]} ─scopes─▶ SessionFeedbackStore ─▶ FeedbackMessage queue
TelemetryEvent = ToolCall | ToolResult | Intervention | TurnUsage ─▶ bus ─▶ {Collector, ToolMetricsTracker, WS}
```
Context carriers: `RequestContext{client, model, sessionKey, messages, raw}`, `ResponseContext{client, model, sessionKey, toolCalls, content, raw}`, `ResultContext{sessionKey, results, raw}`. Other domain types: `ToolCall{id,name,arguments}`, `ToolResult{toolCallId,name,isError,content}`, `ClientConfig{apiKey,name,model}`, `ModelConfig{id,baseUrl,model,apiKey?}`, `PolicyEvent{id,at,type,sessionKey?,ruleId?,payload}`. `ApiProvider` (see **Provider** above) is the runtime-switchable generalization of the single upstream `ModelConfig`.

## Business rules (easy to violate)
- **Rule selection is ALL-match, not first-match.** Only `enabled` rules fire, evaluated in ascending `priority` (missing = last; ties by array index). Multiple rules can apply in one pass.
- Matchers return `Match | null`; only `always` never returns `null`. The others may legitimately produce `null` (no match).
- The **flagship loop rule is ACTIVE by default**: it is wired into the default rule set at composition time (priority 0, evaluated first), is **never persisted** (the rule store stays clean), and is re-added on restart without a DB seed. It is STATELESS; per-session cooldown is laddered in the **policy stage** (which owns per-session feedback state). Don't put per-session state into a rule.
- `hideTool` strips tools from `raw.tools` **and** removes references from messages. `block` on a response drops the tool calls **and** queues user feedback for the next request — it is never silent.
- `injectMessage` on a response is **queued for the next request**, not spliced into the current response.
- `describeRule` is **not lossless** (closures); the HTTP layer stores the original specs for exact round-trip.
- **Tool-call emission is centralized** in `context.ts` (`emitResponseTelemetry`), NOT in the policy stage — the stage emits only interventions. Avoid double-counting. It also emits ONE whole-turn `turn.usage` per turn that HAS a token source (upstream-reported usage OR issued tool calls): reported usage when present, else an ESTIMATE over all request messages + response content/tool calls; a usage-less, call-free final-answer turn emits NOTHING (omit, don't fabricate). The SSE path mirrors this at stream end (`stream-extract.ts`).
- **Cache-hit input accounting:** the turn's input is split into base `input` (not served from cache) + `cacheHitInput` (input tokens served from the provider cache), with `total = input + cacheHitInput + output`. Per-provider mapping (detected from which usage fields are present): OpenAI `prompt_tokens` INCLUDES the cached subset → `input = prompt_tokens − prompt_tokens_details.cached_tokens`, `cacheHitInput = cached_tokens`; Anthropic `input_tokens` EXCLUDES cache tokens → `input = input_tokens + cache_creation_input_tokens`, `cacheHitInput = cache_read_input_tokens` (cache-creation folds into base input — writing the cache is not a hit). Base input and `cacheHitInput` are clamped ≥ 0; the estimate path sets `cacheHitInput = 0`. Cross-protocol translation carries the cache fields without over-counting (OpenAI `cache_write_tokens` is a separate write metric, never folded into cache-creation).
- **Streamed usage merge is FIELD-AWARE last-reported-value-wins:** each numeric field (`input`, `output`, `total`, `cacheHitInput`) independently takes the value from the most recent frame that reports it — a later Anthropic `message_delta` (final `output_tokens`, cumulative `cache_read_input_tokens`) wins over the preliminary `message_start` values, while `input_tokens` (only on `message_start`) survives; once both input and output are known, `total` is recomputed as `input + cacheHitInput + output` so the emitted total always reconciles with the final field values.
- **SessionKey derivation:** an explicit token (header, default `x-session-id`) wins → `sha256(token-domain)+token`; otherwise `sha256` of the canonical stable prefix (system messages + first user message).
- **Single-active provider:** at most ONE `isActive` provider at a time (zero allowed). The store re-enforces on add/update/setActive; deleting the active row promotes the **lexicographically-lowest-id** remaining row (or none if the store is empty). The dashboard mirrors this client-side with a single native radio group.
- **Provider key-masking:** list responses (`GET /api/api-providers`) expose only `apiKeySet: true|false`; only the detail `GET /api/api-providers/:id` returns the raw `apiKey` verbatim. Never leak the raw key in a list.
- **Auto-first activation:** adding a provider to an **empty** store (or sending explicit `isActive:true`) makes it active; seeding the env-derived "default" provider marks it active so env-based deployments keep working unchanged.

## Matchers (return `Match | null`)
| Type | Fields | Behavior |
|---|---|---|
| `toolName` | `toolName?`, `toolNames?` | name equality on any call. |
| `argPattern` | `pattern: string\|RegExp`, `toolName?`, `toolNames?` | **case-sensitive** regex vs serialized args (optional name restriction). |
| `loop` (loopDetector) | `window?=4`, `requireConsecutive?=true`, `paramIdentity/resultIdentity='normalized'\|'exact'` | builds `(call→result)` pairs; signature = `name␟paramsKey␟resultKey` (normalized = key-order/whitespace-insensitive); flags `window` consecutive identical signatures. |
| `always` | brand flag | fires unconditionally; never `null`. |

## Actions (`ActionEffect` union)
| Type | Effect |
|---|---|
| `block` `{toolCallIds?, message}` | drops matched calls (request) / drops + queues user feedback (response); supports `{tool}`/`{reason}` templating. |
| `hideTool` `{toolNames[]}` | removes those tools from `raw.tools` and from message references. |
| `rewriteArgs` `{toolCallId, newArguments, mode:'replace'\|'merge'}` | mutates a tool call's arguments. |
| `injectMessage` `{role, content}` | splices into the request; if on a response, queued for the next request. |

## Invariants & state
- **Session feedback queue:** FIFO, keyed by `fingerprint`; drained and spliced at the injection index (after the system prefix, before the trailing user turn).
- **Tool-metrics pairing:** issued→result matched by stable id (same-session bucket first, then any-session fallback); `durationMs = max(0, result.at - issued.at)`; pending entries swept by lazy TTL (default 300 000 ms) and `maxPending` (1 000).
- **Collector caps:** `maxInterventions=500`, `maxRecent=200`, `maxTokenTurns=10000`; token dedup per `(sessionKey␟at)`; aggregates skip excluded tools (default `['task']`, case-insensitive). Whole-turn token totals are summed from BOTH `tool.call.tokens` AND `turn.usage`, deduped per `(sessionKey␟at)` with first-seen winning (a turn carrying both sources counts once). Per-tool adds `totalTokens` (sum of distinct turns' `tokens.total` invoking that tool, deduped per `(turn␟tool)`) and `totalResponseTokens` + `resolvedCount` (estimated response-payload tokens `round(chars/4)` across resolved results reporting `chars`). A `totalCacheHitInputTokens` aggregate (global on `CollectorSummary` + per-tool on `TopTool`) sums `tokens.cacheHitInput` with the same dedup semantics and is auto-exposed via `GET /api/stats`; it is OMITTED (not 0) when no reported tokens carried a cache-hit value.
- **In-memory tool-result store** bounded at 1 000 entries; optional SQLite persister drains in batches (WAL mode).
- **Provider persistence:** providers persist in the shared `data/rules.db` `api_providers` table (schema v3) via a write-through store; persistence is **best-effort** (a failing open/read/write logs a warning and leaves the in-memory store intact) and applies only to real env-based deployments — caller/mock upstreams stay in-memory so pre-existing test behavior is unchanged.

## End-to-end workflows
- **Request:** client → route → `buildRequestContext` (derive SessionKey) → pipeline [session-token stage drains+splices feedback; policy stage evaluates+applies effects+emits Intervention] → translate → forward upstream → response stages → rehydrate → emit tool-call/result telemetry (centralized) → send.
- **Add a rule at runtime:** `POST /api/rules` → `validateSpec` → `buildRuleFromSpec` (assigns `id` if absent) → `RuleStore.add` + write-through `saveRule` → the policy stage's live getter sees it on the next evaluate (**no restart**). The built-in flagship rule is wired in at composition time (never added to the store), so it is never persisted and is re-added on restart.
- **Drill into a tool result:** `resolveAndEmitToolResults` captures the raw value into the in-memory store (key = tool-call id) → dashboard calls `GET /api/tool-results/:id` (memory-first, then DB fallback); optional async SQLite drain when enabled.
