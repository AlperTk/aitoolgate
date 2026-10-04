# Architecture Decisions

## Zero runtime dependencies
Decision: Build the entire server on the Node standard library only (`node:http`, `node:sqlite`, built-in WebSocket handling, SSE). `dependencies` in package.json is empty.
Reason: Keeps the proxy self-contained/portable with nothing to install beyond TypeScript; minimizes supply-chain surface for a local dev tool.
Impact: New features should prefer the Node stdlib over adding third-party packages. Adding a runtime dependency is a deliberate decision.
Evidence: `package.json`.

## Hexagonal / ports-and-adapters layout
Decision: All framework-agnostic contracts live in `src/ports/`; implementation modules depend on those ports and are wired by composition factories (`createXxx`) in `src/server/index.ts`.
Reason: Decouples domain/policy/telemetry from transport and storage, enabling isolated testing (many suites test policy/telemetry/storage in isolation without a live server).
Impact: Keep new abstractions in `ports/`; do not let impl modules import each other directly when a port exists.
Evidence: `src/ports/*`, `src/server/index.ts`.

## Tests run against compiled output
Decision: `npm test` runs `node --test 'dist/tests/**/*.test.js'` — compiled JS, not source. You must `npm run build` first.
Reason: A single TS→JS compile step is shared by runtime and tests; avoids a separate test-transpile toolchain.
Impact: You cannot run tests without building. Do not introduce a TS-native test runner.
Evidence: `package.json` scripts, two tsconfigs.

## Policy-as-pipeline-stage design
Decision: The rule engine is mounted into the request/response path as a pipeline **stage** (`createPolicyStage` over the `Pipeline` port), rather than called imperatively at a fixed point.
Reason: Uniform interception model — session tokening, policy evaluation, and future stages all share the same `handleRequest`/`handleResponse` contract.
Impact: New cross-cutting interceptors should be added as pipeline stages, not hardcoded into proxy handlers.
Evidence: `src/ports/pipeline.ts`, `src/policy/policyStage.ts`, `src/proxy/context.ts` (`runThroughPipeline`).

## Storage is opt-in
Observed constraint: The server does not auto-create a SQLite database; persistence is enabled only by forwarding `options.telemetry.storage` from config. The default file path is not verified in current source.
Reason: Unknown (kept light-weight; memory-only operation by default).
Impact: Do not assume a durable DB exists by default; guard storage-dependent paths.
Evidence: `src/server/index.ts`, `src/storage/sqlite.ts`.

## Node version (inferred)
Observed constraint: Requires a recent Node runtime because it imports `node:sqlite`. No `engines` field pins a minimum; the modern-runtime requirement is inferred from usage, not declared.
Reason: Unknown.
Impact: Verify `node:sqlite` availability before relying on new built-in modules; consider declaring `engines`.

## Dashboard: viewport-fit fixed-height layout (≥961px)
Decision: At ≥961px the dashboard fits exactly one screen: `.dash-grid { max-height: calc(100dvh - 160px); grid-template-rows: minmax(0,1fr) auto }`; panels get `min-height:0`; the stream list fills its panel via `flex:1` (internal scroll, sticky `#stream-head`); the stats panel keeps its count tiles fixed and scrolls ONLY the Top Tools table via a `.tools-scroll` wrapper (`flex:1; min-height:0; overflow:auto`) with a sticky `<thead>`. Below 960px: natural page flow, no capping.
Reason: Unbounded row growth made the page grow without limit; capping the grid CONTAINER alone is insufficient — grid tracks must be deterministic (`minmax(0,1fr)` rows) for inner scrolling to work instead of items visually overflowing the capped box.
Impact: New long content in a dashboard panel should scroll inside its own container; never stretch the grid row.
Evidence: `dashboard/css/responsive.css`, `dashboard/index.html` (`.tools-scroll` wrapper around `#top-tools`).

## Stream status badges: tonal dot-pill design
Decision: Stream-row status pills (call/orphan/intervention) are soft-toned badges: background ≈14% alpha of the status tone, border ≈30%, text plus an 8px leading dot both at full tone via `currentColor`, padding `.2rem .4rem`, `width:max-content` left-aligned in the column. Tones are tokenized as `--c-st-{ok,pending,error,amber}`. The status column itself is content-aware: first track = `minmax(max-content,6rem)` in the shared `.stream-head,.row-main` grid rule (Tool column floor lowered to 9rem accordingly).
Reason: Solid fills were too loud for the dark theme; a fixed 3.6rem status track clipped the longest label ("pending" pill ≈84px).
Impact: Keep per-status colors in tokens; badge layout lives in the single stream-scoped `.call-row/.orphan-row/.intervention-row .badge` rule in components.css.
Evidence: `dashboard/css/components.css`, `dashboard/css/tokens.css`.
