# aitoolgate

A local, LiteLLM-style model proxy that sits in the agentic loop as the single
man-in-the-middle over the LLM request/response stream. Its core is a
programmable tool-monitoring and interception layer: declarative policy
pipelines inspect and rewrite the message stream (block tool calls, detect
loops, hide tools, inject corrective messages) while forwarding to a single
configured upstream model. It exposes both OpenAI- and Anthropic-compatible
endpoints, persists rules and events in SQLite, and drives a local real-time
web dashboard.
