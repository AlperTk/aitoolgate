---
name: _sync
description: Last validated Git snapshot, unfinished memory inspection, and coverage gaps. Read before generating or updating project knowledge.
---
# Sync state

schema_version: 2
status: complete
last_synced_commit: "9a2fbb5b684093c9197a81929d7741a91c9718ec"
last_synced_at: "2026-10-30T16:19:36Z"
pending_target: null
completed_scopes:
  - composition root, ports, DI wiring (architecture.md)
  - proxy request/stream flow (modules/proxy.md, partial)
  - protocols factories/registry (modules/protocols.md, partial)
  - providers, session, policy (modules/providers.md, modules/policy.md, partial)
  - telemetry, api, storage (modules/telemetry.md, modules/api-storage.md, partial)
  - commands, env vars, test conventions, dashboard boundaries (commands.md, conventions.md)
  - constraints (constraints.md)
  - domain model (domain.md)
  - gap closure: Anthropic route, session token, policy drain order, tracker wiring, device OAuth, dashboard exports (module docs "Resolved" sections)
pending_scopes:
  - none (protocol decode/encode bodies remain unread by design; listed as unknown in modules/protocols.md)
Unresolved questions (carried forward):
  - Whether the rule API rejects writes to flagship-loop-rule (domain.md, Unknowns)
  - Whether a request-body size limit exists outside src/api/http.ts (constraints.md, Unknowns)
  - Whether adding a provider type requires dashboard list updates (conventions.md, modules/providers.md)
  - Enclosing symbols of 504/502 sites in src/proxy/upstream.ts (modules/proxy.md)
