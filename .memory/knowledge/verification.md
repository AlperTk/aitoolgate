# Verification

## Build
```bash
npm run build          # tsc -p tsconfig.build.json → dist/
npm run typecheck      # tsc --noEmit
```

## Tests
```bash
npm run build          # REQUIRED FIRST — tests run against compiled JS
npm test               # node --test 'dist/tests/**/*.test.js'
```
> Tests target compiled output in `dist/`; running `npm test` without a fresh build tests stale/missing artifacts.

## Run locally
```bash
npm run dev            # build + node dist/src/server/index.js
npm start              # node dist/src/server/index.js
```

## Health check
```
GET /health → { "status": "ok" }
```

## Integration / e2e
- Named `*-integration.test.ts` and `e2e-*.test.ts` (e.g., `server-integration.test.ts`, `e2e-integration.test.ts`, `e2e-policy.test.ts`). They spin up the real server via the `.mcm` handle exposed by `createServer()`.
- No CI pipeline, Docker, or Makefile exists; verification is local `build` + `typecheck` + `test`.

## Recommended pre-merge gate
1. `npm run typecheck`
2. `npm run build`
3. `npm test`
4. Spot-check `GET /health` after `npm start`.

## Browser verification (dashboard UI changes)
- The dev server HTTP-caches static assets; a plain reload of a long-lived tab can render stale CSS/JS. Verify UI changes in a **fresh browser context** (clean cache), not just a page reload.
- WS sanity check: element `.conn` text reads "live" when connected; console/pageerrors must be empty.
- Current test baseline: 242 tests passing (`npm run build && npm test`) as of 2026-10-06 (after the on-demand tool-result value feature). Representative suites for it: `tool-result-store.test.ts`, `tool-result-store-e2e.test.ts`, `sqlite-tool-result-persister.test.ts`.
