# mcp-manager — Architecture

> Design & internal structure. Exact shapes/signatures → `api-reference.md`. Rationale → `decisions.md`. Traps → `pitfalls.md`.

## Core concept
Man-in-the-middle model proxy. The agent's LLM client points at it (custom `base_url`); every request is forwarded to the configured upstream and returned. Tool execution stays with the agent — control is exercised by **editing the message stream** (hide a tool, inject a message, block/rewrite a tool call). OpenAI + Anthropic pass through verbatim when same-protocol; cross-protocol pairs are translated (`proxy/translate.ts`).

## Ports & patterns
- **Pipeline = Chain-of-Responsibility:** ordered composable stages (request-in → LLM → response-out → result-in). `PipelineStage` has `onRequest`/`onResponse`/`onResult`; `createPipeline` builds the chain (passthrough default).
- **Matcher / Action / ToolProvider / ModelRouter = Strategy** (pluggable).
- **Storage = Repository** (SQLite default, swappable to Postgres).
- **EventBus = Observer** (domain events → telemetry → powers the UI). The dashboard live stream is DUAL-SOURCE: WebSocket primary + a ~2.5s `GET /api/events` polling fallback (deduped by event key; a WS keepalive self-heals half-open sockets and a live/polling status banner is shown) so records appear even when the access path can't carry WebSockets.
- Ports live in `src/ports/` (barrel `src/ports/index.ts`).
- **Two parallel type hierarchies (don't mix):** port level (`Rule`/`Matcher.matches(ctx):boolean`/`Action.apply(ctx):void`) vs policy level (`PolicyRule`/`PolicyMatcher.matches(ctx):Match|null`/`PolicyAction.apply(ctx):ActionEffect|null`). Similarly two event buses: port `EventBus`/`PolicyEvent` (generic payload bag) vs telemetry `TelemetryEventBus`/`TelemetryEvent` (typed, `at:number`). Both expose `emit`; `subscribe` returns an unsubscribe fn.

## Layering & flow
```
server/index.ts        # createServer: HTTP routing + ONE shared bus/collector + auto-start
└─ proxy/             # openai.ts / anthropic.ts route by path; context.ts runs the pipeline
   │                  #   and rehydrates raw; upstream.ts forwards; translate.ts cross-protocol
   └─ pipeline/       # ordered stages
      ├─ policy/      # ruleEngine evaluates ordered rules; matchers detect; actions produce effects;
      │  │            # policyStage applies effects at request-in/response-out; feedbackStore queues per-session msgs
      │  └─ session/  # stateless session key per request
      ├─ telemetry/   # events → bus → collector aggregates (+ bounded recent ring buffer → REST /api/events)
      └─ storage/     # SQLite repository
└─ api/              # ruleStore (in-memory) + ruleSpec (builders) + http (REST /api/*) + ws (WS server)
```

### Request/response data flow
```
HTTP req → /health | /api/* | dashboard static | /v1/* (proxy) | 404
proxy: buildRequestContext → runThroughPipeline(onRequest stages)
     → syncRequestMessages (raw.messages = ctx.messages)    [wire-fix, request→upstream]
     → forward to upstream (upstream.ts)
     → summarize response → pipeline onResponse stages
     → syncResponseBody (rehydrate ctx.toolCalls/content → raw)  [wire-fix, response→client]
     → optional telemetry emit (safeEmit) → return to client
```

## Message-stream shape
- Assistant messages carry `tool_calls: [{ id, function:{ name, arguments } }]` (`arguments` = JSON string OR parsed object). Tool results are `role:'tool'` messages paired by `tool_call_id` (else order).
- The client resends the **FULL history each turn** → detection is stateless per-request.

## Session key / loop detection
`deriveSessionKey({messages, token?}): SessionKey`. Stable prefix = all system message(s) + first user message (later turns excluded); canonical per msg `${role}\u0000${text}` joined by `\u0001`; SHA-256 hex. Token precedence: non-empty `token` → fingerprint=hash(`session-key/token/v1\u0000${token}`) and key.token set; else fallback hash(`session-key/fingerprint/v1\u0000${canonical}`), no token field. Header binding lives in `context.ts` (`sessionKeyFromHeaders`, reads `x-session-id`; case-insensitive since Node lowercases header names); **token beats fingerprint**. Feedback: `FeedbackMessage { role, content }` queued per fingerprint for next-request injection. Flagship loop rule: last N consecutive identical (tool+params+result) calls → intervene with a corrective message (see `decisions.md`).
Note: the default pipeline threads NO shared object between request/response halves — `policyStage` resolves the response-phase session key via a per-instance "last request" reference (fine for sequential single-client; known limitation for concurrent multi-client — see `pitfalls.md`).

## Wire fix (do not regress)
The default pipeline originally forwarded/returned `ctx.raw` while the policy stage edited provider-agnostic `ctx.messages`/`ctx.toolCalls`, so message-stream edits did NOT reach the wire. **Fixed in `proxy/context.ts`:** `syncRequestMessages` (`raw.messages = ctx.messages`) on the request→upstream path and protocol-aware `syncResponseBody` (OpenAI `choices[].message.tool_calls` via `rehydrateOpenAIResponse` / Anthropic `content[]` tool_use via `rehydrateAnthropicResponse`; protocol detected by `detectResponseProtocol`) on the response→client path; both idempotent when unchanged (`toolCallsEqual`). Re-validated by `tests/e2e-policy.test.ts` and `tests/e2e-integration.test.ts` on the DEFAULT pipeline.
