# mcp-manager — Knowledge Index

> Fast onboarding entry point for AI agents. **Read this first; open only the file(s) you need below.** Working dir: `/sandbox/mcp-manager`.

## Files (one line each)
- **`project.md`** — what it is, tech stack, current status, build/test commands, env vars, full file inventory, coding conventions. *Start here for orientation.*
- **`architecture.md`** — how it's designed: ports & design patterns, layered structure (server→proxy→pipeline→policy/session + telemetry/storage), message-stream shape, session key, the wire-fix.
- **`decisions.md`** — locked decisions (+ rationale) and deferred / v1.1 scope. *Don't re-litigate locked items without sign-off.*
- **`api-reference.md`** — exact contracts to code against: proxy endpoints, REST `/api/*`, WebSocket, RuleSpec, key type signatures, config env vars.
- **`testing.md`** — verification gate, test conventions, suite inventory, known pitfalls / gotchas.

## "Read this when you need to…"
| Need | File |
|---|---|
| Commands / how to run / env vars | `project.md` (§Commands, §Environment) |
| Where does symbol X live? | `project.md` (§File inventory) |
| Why is it designed this way? | `architecture.md` |
| Add a REST / WS / dashboard feature | `api-reference.md` + `architecture.md` |
| What's decided vs deferred? | `decisions.md` |
| Write or fix tests, avoid gotchas | `testing.md` |
| Exact type shapes (PolicyRule, ActionEffect, events, contracts…) | `api-reference.md` |

## Status snapshot
~95% of MVP complete & green (127 tests / 0 fail / 20 suites). Tasks 1–7 done, including the dependency-free dashboard + REST/WS API wired into `createServer`. See `decisions.md` for deferred v1.1 work.

> Note: `.memory/handoff.md` (at the `.memory` root) is a prior-session handoff snapshot — it is NOT part of this knowledge set and is not maintained here.
