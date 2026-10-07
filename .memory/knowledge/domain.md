---
name: domain
description: Domain vocabulary, core entities and their relationships, business rules that are easy to violate, invariants/state, and end-to-end workflows in mcp-manager. Read before changing policy, session, or telemetry behavior.
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
- **TelemetryEvent** — `ToolCallEvent | ToolResultEvent | InterventionEvent` broadcast on the bus.
- **tool-result value** — a tool call's raw returned output, captured out-of-band and fetched lazily by id.
- **flagship-loop-rule** — the built-in always-on loop-detection rule (see below).

## Core entities & relationships
```
Rule{enabled, priority, matcher, action}
   ├──matcher──▶ Matcher ──matches?──▶ PolicyContext
   └──action───▶ Action  ──apply───▶ ActionEffect   (mutates ctx and/or emits InterventionEvent)

RuleStore (live getter) ─▶ Rule[] ─▶ createRuleEngine ─▶ PolicyStage ─.use()─▶ Pipeline
SessionKey{fingerprint[,token]} ─scopes─▶ SessionFeedbackStore ─▶ FeedbackMessage queue
TelemetryEvent = ToolCall | ToolResult | Intervention ─▶ bus ─▶ {Collector, ToolMetricsTracker, WS}
```
Context carriers: `RequestContext{client, model, sessionKey, messages, raw}`, `ResponseContext{client, model, sessionKey, toolCalls, content, raw}`, `ResultContext{sessionKey, results, raw}`. Other domain types: `ToolCall{id,name,arguments}`, `ToolResult{toolCallId,name,isError,content}`, `ClientConfig{apiKey,name,model}`, `ModelConfig{id,baseUrl,model,apiKey?}`, `PolicyEvent{id,at,type,sessionKey?,ruleId?,payload}`.

## Business rules (easy to violate)
- **Rule selection is ALL-match, not first-match.** Only `enabled` rules fire, evaluated in ascending `priority` (missing = last; ties by array index). Multiple rules can apply in one pass.
- Matchers return `Match | null`; only `always` never returns `null`. The others may legitimately produce `null` (no match).
- The **flagship loop rule is STATELESS**; per-session cooldown is laddered in the **policy stage** (which owns per-session feedback state). Don't put per-session state into a rule.
- `hideTool` strips tools from `raw.tools` **and** removes references from messages. `block` on a response drops the tool calls **and** queues user feedback for the next request — it is never silent.
- `injectMessage` on a response is **queued for the next request**, not spliced into the current response.
- `describeRule` is **not lossless** (closures); the HTTP layer stores the original specs for exact round-trip.
- **Tool-call emission is centralized** in `context.ts` (`emitResponseTelemetry`), NOT in the policy stage — the stage emits only interventions. Avoid double-counting.
- **SessionKey derivation:** an explicit token (header, default `x-session-id`) wins → `sha256(token-domain)+token`; otherwise `sha256` of the canonical stable prefix (system messages + first user message).

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
- **Collector caps:** `maxInterventions=500`, `maxRecent=200`, `maxTokenTurns=10000`; token dedup per `(sessionKey␟at)`; aggregates skip excluded tools (default `['task']`, case-insensitive).
- **In-memory tool-result store** bounded at 1 000 entries; optional SQLite persister drains in batches (WAL mode).

## End-to-end workflows
- **Request:** client → route → `buildRequestContext` (derive SessionKey) → pipeline [session-token stage drains+splices feedback; policy stage evaluates+applies effects+emits Intervention] → translate → forward upstream → response stages → rehydrate → emit tool-call/result telemetry (centralized) → send.
- **Add a rule at runtime:** `POST /api/rules` → `validateSpec` → `buildRuleFromSpec` (assigns `id` if absent) → `RuleStore.add` + write-through `saveRule` → the policy stage's live getter sees it on the next evaluate (**no restart**). The built-in flagship rule is skipped from persistence.
- **Drill into a tool result:** `resolveAndEmitToolResults` captures the raw value into the in-memory store (key = tool-call id) → dashboard calls `GET /api/tool-results/:id` (memory-first, then DB fallback); optional async SQLite drain when enabled.
