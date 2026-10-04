# mcp-manager — Pitfalls

Traps likely to cause future mistakes. Each lists Problem / Avoid / Preferred / Evidence.

## Running tests without building
- Problem: `npm run test` runs compiled `dist/tests/**`; running it without building uses stale output and gives misleading pass/fail results.
- Avoid: don't invoke `test` directly after source changes.
- Preferred: always `npm run build` first; gate = `build && typecheck && test`.
- Evidence: `package.json` scripts, `tsconfig.build.json`

## e2e hang from a listen() that never binds
- Problem: a helper that calls `listen()` but never actually invokes `server.listen(0)` leaves every `await` suspended ("event loop resolved", promises pending) → test suite hangs.
- Avoid: don't assume a local `listen` wrapper binds a port.
- Preferred: always call `server.listen(0)` and explicitly await `'listening'` or read `.port`.
- Evidence: `tests/server-integration.test.ts`, `tests/e2e-integration.test.ts`

## Double-listen ERR_SERVER_ALREADY_LISTENING
- Problem: `createServer` may auto-listen internally (relied on by `tests/proxy.test.ts`); calling `listen(0)` again throws `ERR_SERVER_ALREADY_LISTENING`.
- Avoid: don't call `listen(0)` on a server that already auto-listens.
- Preferred: await the `'listening'` event instead of re-listening.
- Evidence: `tests/proxy.test.ts`, `src/server/index.ts`

## Message-stream edits not reaching the wire
- Problem: if the default pipeline stops rehydrating `ctx.raw` from `ctx.messages`/`ctx.toolCalls`, policy message/tool edits never reach the wire (only raw `tools` and in-place request tool-call edits would).
- Avoid: don't bypass `syncRequestMessages`/`syncResponseBody` in `proxy/context.ts`.
- Preferred: keep both sync points; re-verify with e2e tests on the DEFAULT pipeline.
- Evidence: `src/proxy/context.ts`, `tests/e2e-policy.test.ts`, `tests/e2e-integration.test.ts`

## No shared req/res context across pipeline halves
- Problem: `policyStage` resolves the response-phase session key via a per-instance "last request" reference; concurrent multi-client requests can cross-wire session state.
- Avoid: don't rely on it for concurrent multi-client isolation.
- Preferred: treat as sequential single-client for now; thread an explicit request context if concurrency is required.
- Evidence: `src/policy/policyStage.ts`, `src/ports/pipeline.ts`

## Dashboard assets resolve from the COMPILED path
- Problem: dashboard assets resolve relative to `dist/src/server` by walking up ≤4 levels to the first `dashboard/index.html`; a build-layout change silently breaks static serving.
- Avoid: don't restructure dist output without re-checking resolution.
- Preferred: keep `mount.dashboardDir` override authoritative; re-verify the walk-up after any layout change.
- Evidence: `src/server/index.ts` (`DASHBOARD_FILES` resolver)

## Two parallel type/event hierarchies
- Problem: mixing port-level (`Rule`/`Matcher`/`Action`, generic `PolicyEvent`) with policy-level (`PolicyRule`/`PolicyMatcher`/`PolicyAction`, typed `TelemetryEvent`) causes type errors and wrong bus usage.
- Avoid: don't mix the two layers.
- Preferred: use the policy layer for rules/matchers/actions and typed telemetry events; use the port layer only at the boundary. Both buses expose `emit`; `subscribe` returns an unsubscribe fn.
- Evidence: `src/ports/strategy.ts` vs `src/policy/types.ts`; `src/ports/event-bus.ts` vs `src/telemetry/event-bus.ts`

## Relying on the TS-global WebSocket type in tests
- Problem: the global `WebSocket` may be untyped under this tsconfig, so browser-style WS client code fails to compile in tests.
- Avoid: don't use the global `WebSocket` type in test code.
- Preferred: drive WS with raw `node:net` (hand-rolled RFC6455 upgrade).
- Evidence: `tests/ws.test.ts`, `src/api/ws.ts`

## Browser WebSocket silently dead through non-forwarding access paths
- Problem: viewing the dashboard through a tunnel/port-forward/webview that doesn't forward `Upgrade: websocket` leaves the browser WS half-open or failing while plain-HTTP `fetch('api/stats')` still works → the "Live tool calls" stream looks empty with no error.
- Avoid: don't rely on WebSocket alone for the live stream.
- Preferred: dual-source the live stream (WS + `GET /api/events` polling fallback, deduped), add a keepalive that reconnects after ~3 silent windows, and surface live/polling status instead of a silently-empty list.
- Evidence: `dashboard/app.js`, `src/api/ws.ts`, `tests/e2e-integration.test.ts`
