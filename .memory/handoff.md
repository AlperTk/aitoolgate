---
name: handoff
description: Session handoff: internal model rename, bypass removal, telemetry event-tap plan
---
# Agent Handoff Document

**Outgoing Agent / Role:** Architect/orchestrator (delegates to task-runner; never edits code directly)

---

## 1. Goal & Objective
- **Main Goal:** Provider-neutral internal format for all traffic. Every request/response/stream is decoded to the internal model and encoded to the client protocol. NO same-protocol bypass. Telemetry runs on the internal layer. Goal: adding a new provider/format later should be cheap.
- **Scope in:** `src/ports/llm.ts`, `src/protocols/*`, `src/proxy/{upstream,translate,context,openai,anthropic}.ts`, telemetry consumers, related tests, `.memory/knowledge/*` (only with user approval).
- **Out of scope:** commits (need explicit user approval), `tmp/` (external opencode copy, never touch), dashboard.

## 2. Session Summary
- **Renames (done):** `LLMEvent`→`InternalLLMEvent`, `CommonRequest`→`InternalRequest`, `CommonResponse`→`InternalResponse` (89 refs, 11 files). Shared "Internal" prefix = our common format.
- **Model ext (done, additive):** `Usage.cacheWriteInput?` (Anthropic `cache_creation_input_tokens`; OpenAI leaves undefined). Tool-call variant of `InternalLLMEvent`: `rawArgs?`, `index?`. `InternalRequest.streamOptions?` (OpenAI stream_options).
- **Bypass removal, response side (done):** `translate.ts::syncResponseBody` change-gate removed (param dropped; `toolCallsEqual`/`deepEqual` deleted). `upstream.ts`: non-2xx → `upstreamErrorResponse` (keeps status, client error envelope; raw error bytes no longer passed). `conformResult` applies metadata-only 502 to non-stream JSON too. `registry.ts::upstreamErrorMessage` added.
- **Bypass removal, request side (done):** identity translators removed from `upstream.ts` (`streamOpenAIRequest`, `streamAnthropicRequest`, `forwardOpenAIRequest`, `forwardAnthropicRequest`). `translate.ts`: `reencodeOpenAIRequest`, `reencodeAnthropicRequest`, `withModelOverride`. `openai.ts`: `ensureStreamUsage` removed (moved into OpenAI encode).
- **Encoder fix (done):** Anthropic `encodeStream`: signed thinking text is joined with its following signature event (`pendingThinking`). Unsigned thinking is still never emitted (documented rule).
- **Tests:** full suite 715/715 green at last run. Pinned bypass tests updated (not deleted): cross-protocol-stream "same-protocol stream is re-encoded from LLMEvents" (+2 subtests, one non-2xx subtest → 429 error envelope), cross-protocol-route-stream "same-protocol JSON-200 ... re-encoded as an OpenAI SSE stream", protocols-sync-body (5 call sites, arg removed), e2e-actions rewriteArgs (JSON string args), protocols-openai-chat (tool msg `name`), proxy.test.ts capturingFetch mock now has one choice with content.

## 3. Trials, Errors & Failed Approaches
- ❌ **Telemetry as-is reads upstream raw SSE bytes** (`stream-extract.ts`, `sseTextChunks` tap). Loses raw args/index and cannot see JSON-200 tool calls.
  - Reason: decided to move to event tap (user decision). Not implemented yet.
- ❌ **Adding `rawArgs`/`index`/`cacheWriteInput` broke deepEqual expectations** in stream-parity and cross-protocol-stream. Fixed in tests (expectations only).
- ❌ **Removing change-gate broke `protocols-sync-body.test.ts`** (signature change). Fixed call sites.
- ❌ **Assumed "unsigned thinking" for regression test** — fixture was actually signed. Real bug was decoder/encoder pairing of signature event. Fixed in encoder.
- 💡 **Decision:** mock returning `choices: []` must stay 502 (approved metadata-only rule). Fixed by giving the mock a content choice, NOT by weakening the rule.

## 4. Key Findings & Technical Notes
- 🔒 **Telemetry must never break a request:** all emission via `safeEmit`; bus handlers isolated; tee/tap errors swallowed.
- 🔍 **Request-side field loss (OPEN, critical):** round-trip now drops fields not in `InternalRequest`. OpenAI: `max_completion_tokens`, `response_format`, `seed`, `stop`, `n`, `user`, `parallel_tool_calls`, `reasoning_effort`, `tools[].function.strict`, legacy `functions`/`function_call`, `presence/frequency_penalty`, `logit_bias`, `logprobs`, `store`, `metadata`, `service_tier`, `modalities`, `audio`, `prediction`. Anthropic: `stop_sequences`, `top_k`, `metadata`, request-level `thinking`, `cache_control`, image blocks, `tool_result.is_error`. Also `stream:false` omitted (equivalent default). Undecodable request messages → `messages: []`.
  - Proposed fix (awaiting user approval): opaque `extra` on `InternalRequest`, carried through decode and re-encoded for the same protocol.
- 🔍 **Telemetry coverage (analysis done, read-only):**
  - OK from internal models: tool-call id/name/parsed args; tool-result id/name/chars; turn usage input/output/cacheHitInput; request tool descriptions.
  - Gaps: `tool.result.ok` heuristic lives in telemetry (`isError` native only); `sessionKey`, `clientId`, `durationMs`, timestamps are outside models (stay in context/tracker, fine).
  - `cacheHitInput` non-optional → "not reported" vs 0 indistinguishable (planned step 3).
  - OpenAI per-frame usage defaults cache to 0.
- 🔍 **Bugs noticed, NOT fixed:** non-2xx / 502 JSON error bodies are sent with `Content-Type: text/event-stream` (`pipeUpstreamStream` always sets it). Wrong for JSON clients.
- ⚙️ **Technical decisions (user-approved):**
  - No same-protocol bypass on any path (stream, JSON, request, error).
  - Telemetry should run on the internal event stream (event tap, tee after `decodeStream` in `bridgeStream`). Byte tap only for undecodable passthrough.
  - Provider-specific usage (cache-write) is an optional field; absent when provider does not report.
  - Tool-call raw args + index are optional fields on the tool-call event.
- 🔒 **Constraints:**
  - Do NOT edit `.memory/knowledge/*` without user approval (constraints.md and domain.md still describe the old byte-tap telemetry and old names `LLMEvent`/`CommonRequest` — doc drift).
  - Do NOT commit without explicit user approval.
  - Never touch `tmp/`.
  - Protocol parity: encoded client output must not change due to new optional fields (encoders ignore them).
  - Metadata-only JSON 2xx (choices empty/no content) → 502 (user-approved; `cross-protocol-json200-error` pins it).
  - Unsigned Anthropic thinking is never emitted (documented rule).

## 5. Current State & Progress
- **Completion Status:** ~55%. Renames + model ext + bypass removal (response & request) done. Telemetry event tap, request-field-loss decision, docs, cacheHitInput not done.
- **Last Action Taken:** Full-suite green (715/715) after same-protocol request re-encoding. Runner report listed dropped request fields; awaiting user decision on `extra`.
- **Operational Status:** `npm run build` exit 0; `npm test` 715 pass, 0 fail (at last run). Test count 715 vs baseline 647 in commands memory — likely stale `dist/` artefacts, NOT investigated.
- **Git:** nothing committed. `git status` shows staged changes NOT made by us (README.md, src/ports/protocol.ts, src/proxy/translate.ts, src/proxy/upstream.ts, several tests). Review before any commit.

## 6. Next Steps (Action Plan)
1. [ ] **Step 0 (user decision):** approve `extra` passthrough on `InternalRequest` for dropped request fields (or accept loss explicitly).
2. [ ] **Step 1:** Record "no bypass" rule in `.memory/knowledge/constraints.md` (replace open bypass item). Needs user approval for memory edit.
3. [ ] **Step 2:** Telemetry event tap: tee internal event stream in `upstream.ts::bridgeStream` after `decodeStream`; stream telemetry from events (requires `rawArgs`/`index` already present); JSON telemetry via `eventsOfBody`/`responseEvents`; keep byte tap only for undecodable passthrough; all wrapped in try/catch (`safeEmit`). Verify parity tests and stream-extract consumers (`tool.call` emission at stream end; batched turns omit per-call tokens).
4. [ ] **Step 3:** `Usage.cacheHitInput` → optional (presence semantics); adjust `collector.ts` and `tokenEstimate.ts`.
5. [ ] **Step 4:** Fix non-2xx JSON error `Content-Type` (`pipeUpstreamStream`) — check with user first.
6. [ ] **Step 5:** Doc sync (`domain.md`, `architecture.md`, `constraints.md`): names, telemetry source, bypass state. Use `memory-update` skill or user-approved brief.
7. [ ] **Step 6:** Investigate test count 715 vs 647 (stale `dist/`?).
8. [ ] **Step 7:** Delete `.memory/tmp/model-ext-handoff.md` (temp handoff from earlier chain) once no longer needed.

Verification command: `npm run build && npm test` (see `.memory/knowledge/commands.md`).

## 7. Modified & Relevant Files (Touchpoints)
- `src/ports/llm.ts` - renamed types; `Usage.cacheWriteInput?`; tool-call `rawArgs?`/`index?`; `InternalRequest.streamOptions?`.
- `src/protocols/openai-chat/protocol.ts` - decodeStream/flushCalls (rawArgs, index); decodeRequest/encodeRequest (streamOptions, stream_options usage, tool msg name, object-form args); decodeOpenAIMessages/encodeMessages.
- `src/protocols/anthropic-messages/protocol.ts` - decodeUsage (cacheWriteInput); emitToolCall(block, index); decodeRequest; encodeStream pendingThinking (signed thinking fix).
- `src/protocols/registry.ts` - `upstreamErrorMessage` (new).
- `src/proxy/translate.ts` - change-gate removed; `reencodeOpenAIRequest`, `reencodeAnthropicRequest`, `withModelOverride`; deleted `toolCallsEqual`/`deepEqual`.
- `src/proxy/upstream.ts` - identity translators removed; `upstreamErrorResponse`, `clientErrorResponse`, `conformResult` added; bridgeStream non-2xx path.
- `src/proxy/openai.ts` - `streamSameProtocol`; `ensureStreamUsage` removed.
- `src/proxy/context.ts` - `runThroughPipeline` calls `syncResponseBody(processedResponse)`.
- Tests updated: `tests/cross-protocol-stream.test.ts`, `tests/cross-protocol-route-stream.test.ts`, `tests/stream-parity.test.ts`, `tests/protocols-sync-body.test.ts`, `tests/e2e-actions.test.ts`, `tests/protocols-openai-chat.test.ts`, `tests/protocols-anthropic-messages.test.ts`, `tests/proxy.test.ts`.
- Temp: `.memory/tmp/model-ext-handoff.md` (delete when done).
