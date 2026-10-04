# mcp-manager — Knowledge Index

> Fast onboarding entry point for AI agents. **Read this first; open only the file(s) you need below.** Working dir: `/sandbox/mcp-manager`.

## Files (one line each)
- **`project.md`** — purpose, tech stack, status, key directories, commands, env vars, core conventions. *Start here for orientation.*
- **`architecture.md`** — design: ports & patterns, layered structure + request/response flow, message-stream shape, session key, the wire-fix.
- **`conventions.md`** — coding/build/test/HTTP/dashboard rules to follow.
- **`decisions.md`** — locked decisions (+ reason + evidence) and deferred / v1.1 scope. *Don't re-litigate locked items without sign-off.*
- **`pitfalls.md`** — traps that cause future mistakes (Problem/Avoid/Preferred/Evidence).
- **`api-reference.md`** — exact contracts: proxy endpoints, REST `/api/*`, WebSocket, RuleSpec, type signatures, config env vars.
- **`tool-metrics.md`** — tool-call metrics (per-call duration ms + tokens): design, key files, business rules, ws large-frame fix, test count.

## "Read this when you need to…"
| Need | File |
|---|---|
| Commands / how to run / env vars | `project.md` (§Commands, §Environment) |
| Where does symbol X live? | `project.md` (§Key directories) + graph |
| Why is it designed this way? | `architecture.md` + `decisions.md` |
| Conventions to follow (imports/tests/HTTP/deps) | `conventions.md` |
| Add a REST / WS / dashboard feature | `api-reference.md` + `architecture.md` + `conventions.md` |
| What's decided vs deferred? | `decisions.md` |
| Avoid a known trap (test hang, wire regression…) | `pitfalls.md` |
| Exact type shapes (PolicyRule, ActionEffect, events, contracts…) | `api-reference.md` |
| Tool-call metrics (duration/tokens), tracker, assumptions | `tool-metrics.md` + `decisions.md` |

## Status snapshot
Complete & green (**151 tests / 0 fail**). Foundation + OpenAI/Anthropic proxy + policy engine + pipeline/wire-fix + telemetry/SQLite + dashboard/REST/WS all wired into `createServer` with one shared bus/collector, plus **tool-call metrics (per-call duration ms + tokens via cross-request pairing)** — see `tool-metrics.md`. See `decisions.md` for deferred v1.1 work.

> Note: `.memory/handoff.md` (at the `.memory` root) is a prior-session handoff snapshot — it is NOT part of this knowledge set and is not maintained here.
