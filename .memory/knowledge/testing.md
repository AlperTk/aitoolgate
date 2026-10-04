# mcp-manager — Testing & Pitfalls

## Verification gate
From `/sandbox/mcp-manager`: `npm run build && npm run typecheck && npm run test`, all green. Current baseline: **127 tests passing / 0 fail across 20 suites.**

**CRITICAL:** tests are compiled into `dist/` by the build — **ALWAYS `npm run build` before `npm run test`** (running test directly uses stale output).

## Conventions
- `node:test` + `node:assert/strict`, one file per area under `tests/`, compiled to `dist/tests` by the build.
- HTTP tests: ephemeral port — `await server.listen(0)` then read `server.address().port` (or `await` the `'listening'` event if the server auto-listens); drive requests via global `fetch` or raw `node:net` sockets; **close servers/sockets in `afterEach`** so the event loop drains.
- WS tests: raw `node:net` (perform the RFC6455 upgrade by hand). Do NOT rely on the TS-global `WebSocket` type (may be untyped under this tsconfig).
- Extensionless relative imports match the repo.

## Suite inventory (20)
health · proxy · translate · session · normalize · policy-matchers · rule-engine · rule-store · feedback-store · policy-stage · policy-stage-events · e2e-policy · telemetry · telemetry-collector · storage-schema · storage · proxy-telemetry · http-api · ws · server-integration

## Known pitfalls
- **Empty/aborted runner results:** the task-runner intermittently returns empty or aborts on large/open-ended tasks. Countermeasures: keep tasks small + concrete (≤3 files, prescriptive spec); **glob target dirs after every runner call** before trusting completion; retry with a smaller slice rather than repeating the prompt; start a FRESH runner each time (don't resume).
- **e2e hang:** a local `listen()` helper that never calls `server.listen(0)` leaves every `await` suspended ("event loop resolved", promises pending). Always listen/await explicitly.
- **Double-listen:** `createServer` may auto-listen internally (relied on by `tests/proxy.test.ts`); calling `listen(0)` again throws `ERR_SERVER_ALREADY_LISTENING`. `await` the `'listening'` event instead (as `tests/server-integration.test.ts` does).
- **Production-gap regression risk:** the default pipeline must rehydrate `ctx.raw` from `ctx.messages`/`ctx.toolCalls` (`proxy/context.ts` `syncRequestMessages`/`syncResponseBody`) or message-stream edits don't reach the wire. Re-validated by `tests/e2e-policy.test.ts` on the DEFAULT pipeline.
- **No shared req/res context across pipeline halves:** `policyStage` resolves the response-phase session key via a per-instance "last request" reference (sequential single-client only).
- **Dashboard dir resolution:** assets resolve relative to the COMPILED location (`dist/src/server`) by walking up ≤4 levels to the first `dashboard/index.html`; an explicit `mount.dashboardDir` override wins. If you change the build output layout, re-verify this.
