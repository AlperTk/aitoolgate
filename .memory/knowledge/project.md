# Project

## Purpose
Local, LiteLLM-style model proxy that sits in the agentic loop as a man-in-the-middle over the LLM request/response stream. Its core is a programmable tool-monitoring/interception layer: declarative **policy pipelines** inspect and (optionally) rewrite the message stream while transparently forwarding traffic to one configured upstream model. It exposes OpenAI- and Anthropic-compatible HTTP endpoints and drives a local real-time web dashboard.

## Primary Responsibilities
- Forward LLM chat traffic to a single configured upstream model (OpenAI- or Anthropic-compatible).
- Apply declarative policy rules to the stream: block tool calls, detect tool-call loops, hide tools from the model, inject corrective feedback messages, rewrite tool arguments.
- Bidirectional protocol translation between OpenAI and Anthropic wire formats (request and response, including SSE streams).
- REST API for rule CRUD plus a live WebSocket feed for the dashboard.
- Persist rules, telemetry events, and per-tool metrics to SQLite (opt-in).
- Serve the static local dashboard (real-time view of sessions, tool calls, and interventions).

## Domain Concepts
- **Rule** (`Rule`, `PolicyRule`): a declarative policy — matcher + action(s) + scope/severity — evaluated against a `PolicyContext` into a `RuleEvaluationResult`.
- **Matcher**: predicate deciding whether a rule fires on a context (e.g., `loopDetector`, `argPattern`, `toolName`).
- **Action**: what happens when a rule fires — `block`, `hideTool`, `injectMessage`, `rewriteArgs`; produces an `ActionEffect`.
- **Pipeline / Stage**: ordered chain of request/response handlers through which each proxied call passes; the policy engine is mounted as one stage.
- **RequestContext / ResponseContext**: normalized inbound-request / outbound-response views flowing through stages.
- **SessionKey**: identity derived from headers/messages used to scope per-session state (feedback store, session token).
- **TelemetryEvent / ToolCallEvent / InterventionEvent**: events emitted for requests, tool calls, and policy interventions; consumed by the collector, tool-metrics tracker, and dashboard.
- **FeedbackMessage**: injected corrective message stored per session for dashboard drill-down.

## External Systems
- **Upstream model API** — the single configured target (OpenAI/Anthropic endpoint) that all LLM traffic forwards to.
- **SQLite** — local persistence for rules/events/tool metrics (opt-in via config).
- **Dashboard browser client** — consumes REST + WebSocket to render real-time session/tool/intervention views.

## Notes
- Current knowledge for this project lives under `.memory/knowledge/`. A legacy memory set exists at `.memory2/` (root-level files + `modules/`) — treat it as candidate notes; prefer current source plus this knowledge when they conflict.
