# mcp-manager — Decisions

## Locked decisions (do not re-litigate without explicit sign-off)
- **Interception surface = the model proxy** (NOT the tool executor). MVP = model-proxy-only. Rationale: a single choke point over the message stream, framework-agnostic.
- **Protocols (v1)** = BOTH OpenAI-compatible (`/v1/chat/completions`, `/v1/models`) AND Anthropic-compatible (`/v1/messages`), pass-through to one configured upstream.
- **Model layer (v1)** = single configured model, pass-through (LiteLLM-lite). Multi-model + per-client routing + fallback is the extensible target (v1.1), not v1.
- **Client identity** = per-client API key (LiteLLM-style) for routing/attribution; **read but NOT enforced** in the default passthrough. No UI login (local, trusted, single-node).
- **Policy engine** = declarative ordered rule pipeline (matcher + action), UI-editable and editable live via REST. Scripting escape-hatch (v1.1) + LLM-as-policy matcher (v1.1). Open/Closed.
- **Flagship loop rule** = last 4 consecutive identical (tool+params+result) calls → intervene. Feedback ladder: short-circuit + inject "you're looping/stuck, change approach" → warn+block → require-human/halt, with a cooldown. Knobs: window, require-consecutive, param/result-identity strictness (exact → normalized → LLM-judged).
- **Block behavior** = drop the offending call + return a message to the LLM ("blocked by rule X, reason…") — never silently dropped.
- **Session / loop detection** = stateless per-request history scan (client resends full history each turn; no standard conversation-id on the wire). Session key = content-fingerprint of stable prefix + optional client token (`X-Session-Id`).
- **Tool side** = MVP does NOT front tools. Extensible via a `ToolProvider` port so MCP + skills can be injected later as plugins (no core rework).
- **Storage** = Repository pattern; SQLite default; swappable (Postgres later).
- **UI** = local web dashboard, no login, real-time (live tool-call stream + intervention log + counts/top tools) + rule authoring.
- **Dashboard tech** = dependency-free (this session's decision): vanilla-JS SPA + built-in RFC6455 WebSocket + Node `http` REST, served by the same process. NO React/Vite/Tailwind/shadcn, NO `ws` package. *(Supersedes the earlier "React/Vite+Tailwind+shadcn" draft.)*

## Deferred scope
- **v1.1:** multi-model + per-client routing + fallback (full LiteLLM-lite); scripting hooks; LLM-as-policy matcher; streaming; Postgres option.
- **Later:** MCP tool gateway; skills (injected via `ToolProvider` port).
