# Tech Stack

## Runtime
- Node.js — version NOT pinned (no `engines` field); effectively requires a modern runtime because it imports `node:sqlite`. Marked **inferred**, not verified.
- TypeScript ^7.0.2, `strict` mode.
- Two tsconfigs: `tsconfig.json` (dev, noEmit) and `tsconfig.build.json` (build → `dist/`).

## Frameworks
- None. **Zero third-party runtime dependencies** (`dependencies` empty) — the entire server is built on the Node standard library only.

## Persistence
- SQLite via the Node built-in `node:sqlite` module (`DatabaseSync`), wrapped by `src/storage/sqlite.ts` + `schema.ts`. Storage is opt-in (server forwards `options.telemetry.storage`); default path not verified.

## Transport
- HTTP server via `node:http`.
- Built-in WebSocket handling in `src/api/ws.ts`.
- Server-Sent Events (SSE) streaming for LLM responses piped from the upstream.

## Build
- `tsc` (TypeScript compiler) → `dist/`. No bundler.

## Testing
- Node built-in test runner (`node:test`, `node --test`). Tests run against **compiled JS in `dist/`** (must `build` first).

## Deployment
- None (no Dockerfile, docker-compose, Makefile, or CI config present). Run locally via `npm start` / `npm run dev`.

## Developer tools
- `@types/node ^26.6.4` (devDependency). Serena MCP for symbol-aware navigation. Graphify maintains a code graph under `.graphify-out/`.
