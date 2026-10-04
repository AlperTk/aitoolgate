# mcp-manager — Architecture

> Design & internal structure. Exact shapes/signatures: see `api-reference.md`. Rationale: see `decisions.md`.

## Core concept
A man-in-the-middle model proxy. The agent's LLM client points at it (custom `base_url`); every request is forwarded to the configured upstream and the response returned. Tool execution stays with the agent — control is exercised by **editing the message stream** (hide a tool, inject a message, block/rewrite a tool call). OpenAI + Anthropic pass through verbatim when same-protocol; cross-protocol pairs are translated (`proxy/translate.ts`).

## Ports & design patterns
- **Pipeline = Chain-of-Responsibility:** ordered, composable stages (request-in → LLM → response-out → result-in). `PipelineStage` has `onRequest`/`onResponse`/`onResult`; `createPipeline` builds an ordered chain (passthrough).
- **Matcher / Action / ToolProvider / ModelRouter = Strategy** (pluggable).
- **Storage = Repository** (SQLite default, swappable to Postgres).
- **EventBus = Observer** (domain events → telemetry → powers the UI).
- Ports live in `src/ports/` (barrel `src/ports/index.ts`).
- **Two parallel type hierarchies (don't mix):** port level `Rule`/`Matcher.matches(ctx):boolean`/`Action.apply(ctx):void` vs policy level `PolicyRule`/`PolicyMatcher.matches(ctx):Match|null`/`PolicyAction.apply(ctx):ActionEffect|null`. Similarly two event shapes/buses: port `EventBus`/`PolicyEvent` (generic payload bag, `at:string`) vs telemetry `TelemetryEventBus`/`TelemetryEvent` (typed, `at:number`). Both buses' dispatch method is `emit`; `subscribe` returns an unsubscribe fn.

## Layered structure
```
server/index.ts          # HTTP routing: /health + /api/* + dashboard static + /v1/* ; builds ONE shared bus/collector
└─ proxy/                # openai.ts / anthropic.ts route by path; context.ts runThroughPipeline drives the pipeline
│   │                    #   and rehydrates raw; upstream.ts forwards to the real backend; translate.ts cross-protocol
│   └─ pipeline/         # ordered stages (Chain-of-Responsibility)
│       ├─ policy/       # ruleEngine evaluates ordered rules; matchers detect; actions produce effects;
│       │   │            # policyStage applies effects at request-in/response-out; feedbackStore queues per-session msgs
│       │   └─ session/  # stateless session key per request
│       ├─ telemetry/    # events → bus → collector aggregates
│       └─ storage/      # SQLite repository
└─ api/                  # ruleStore (in-memory) + ruleSpec (builders) + http (REST /api/*) + ws (WS server)
```

## Message-stream shape
- Assistant messages carry `tool_calls: [{ id, function: { name, arguments } }]` (`arguments` = JSON string OR parsed object). Tool results are `role:'tool'` messages paired by `tool_call_id` (else order).
- The client resends the **FULL history each turn** → detection is stateless per-request.

## Session key / loop detection
`deriveSessionKey` = SHA-256 of the stable prefix (system msg(s) + FIRST user msg), or token-derived when `X-Session-Id` present (token wins; header name configurable via `PolicyOptions.sessionIdHeader`, default `x-session-id`, case-insensitive). `FeedbackMessage = { role, content }` queued per fingerprint for next-request injection.
Note: `DefaultPipeline` threads NO shared object between request/response halves — `policyStage` resolves the response-phase session key via a per-instance "last request" reference (fine for sequential single-client; a known limitation for concurrent multi-client).

## Production-gap wire fix (don't regress)
The default pipeline originally forwarded/returned `ctx.raw` while the policy stage edited provider-agnostic `ctx.messages`/`ctx.toolCalls`, so message-stream edits did NOT reach the wire (only raw `tools` edits and in-place request tool-call edits did). **Fixed in `proxy/context.ts`:** `syncRequestMessages` (`raw.messages = ctx.messages`) + protocol-aware `syncResponseBody` rehydrate (OpenAI `choices[].message.tool_calls` / Anthropic `content[]` tool_use) from `ctx.toolCalls`, idempotent when unchanged. Re-validated by `tests/e2e-policy.test.ts` on the DEFAULT pipeline.
