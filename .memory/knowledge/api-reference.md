# mcp-manager — API Reference (contracts to code against)

> Exact shapes/endpoints. Conceptual design → `architecture.md`. Rationale → `decisions.md`.

## Proxy endpoints (same-protocol = verbatim passthrough)
- **`GET /v1/models`** → `{ object:'list', data:[{ id:<upstream model>, object:'model', created, owned_by:'mcp-manager' }] }` (single entry from `config.upstream.model` / `UPSTREAM_MODEL`).
- **`POST /v1/chat/completions`** → OpenAI pass-through. The upstream model is taken from the **REQUEST BODY `model` field** (not config); the body (incl. `messages` and `tools`) is forwarded verbatim and the response returned verbatim (OpenAI-shaped). **No auth required** (`Authorization: Bearer …` / `x-api-key` are read only as client identity, default `'anonymous'`, not enforced). Configure the real backend via env: `UPSTREAM_BASE_URL`, `UPSTREAM_API_KEY`, `UPSTREAM_PROTOCOL`.
- **`POST /v1/messages`** → Anthropic pass-through. Cross-protocol pairs are translated by `proxy/translate.ts` only when client protocol ≠ upstream protocol.
- Unmatched paths → 404. Optional session header `x-session-id` (case-insensitive) feeds loop detection.

**To connect an OpenAI SDK client:** `base_url=http://localhost:8787/v1`, `api_key=anything` (e.g. `'mcp-manager'`), send your real upstream model in `model`.

## REST (`src/api/http.ts` — `createApiHandler({ruleStore, collector, specs?}) → (req,res)=>Promise<boolean>`)
Prefix `/api`; JSON `Content-Type`; non-`/api` returns `false` (chains before the proxy handler).
- `GET /api/stats` → `CollectorSummary { totalCalls, totalResults, topTools:[{toolName,count}], interventions:[InterventionEvent] }`.
- `GET /api/rules` → `RuleSpec[]` (prefers the originally-submitted spec stored server-side, else best-effort `describeRule`).
- `POST /api/rules` → body `RuleSpec` → `201 { id, ...spec }` (assigns id if missing); invalid → `400 { error }`.
- `PATCH /api/rules/{id}` → partial update (e.g. `{enabled}`; or new matcher/action) → `200` serialized rule; unknown → `404 { error:'not_found' }`.
- `DELETE /api/rules/{id}` → `204`; unknown → `404`.

## WebSocket (`src/api/ws.ts` — `createWsServer(server, {bus?}) → { close(); get size }`)
- Attach via HTTP `Upgrade`; `Sec-WebSocket-Accept = base64(sha1(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'))`; raw `HTTP/1.1 101`; frames over Node sockets (no `ws` package).
- Connect: `ws(s)://<host>/ws`. Inbound broadcast frames are verbatim `TelemetryEvent` JSON; each client text frame is echoed as `{ echo: <parsedJson|rawString> }`.

## Dashboard statics (served same-origin)
`GET /` → `index.html`; `GET /app.js`; `GET /styles.css`. The SPA polls `/api/stats` (~3s) and subscribes to WS for live events.

## Key type contracts
- `PolicyRule { id; enabled; priority?; description?; matcher:PolicyMatcher; action:PolicyAction }` (**NO `name` field**). `PolicyMatcher.matches(ctx): Match|null`; `Match { matched; reason; details? }`. `PolicyAction.apply(ctx): ActionEffect|null`.
- `createRuleEngine(rules: PolicyRule[] | (()=>PolicyRule[])): RuleEngine { evaluate(ctx): RuleEvaluationResult }`; `RuleEvaluationResult { effects; matches:[{ruleId,match}]; applied:[{ruleId,effect}] }`.
- `ActionEffect = {type:'block'; toolCallIds?; message} | {type:'hideTool'; toolNames:string[]} | {type:'rewriteArgs'; toolCallId; newArguments} | {type:'injectMessage'; role:'user'|'system'; content:string}`.
- **Factory option shapes (verbatim):** loop `{ window?; requireConsecutive?; paramIdentity?:'exact'|'normalized'; resultIdentity? }`; toolName `{ toolName?; toolNames? }`; argPattern `{ toolName?; toolNames?; pattern: string|RegExp }`; block `{ reason?; message?; template? }`; hideTool `{ toolNames:string[] }`; rewriteArgs `{ toolName?; toolCallId?; arguments:Record<string,unknown>; mode? }`; injectMessage `{ role?:'user'|'system'; content:string }`. Matcher factories return `PolicyMatcher`; action factories return a port `Action`.
- `RuleSpec` (`src/api/ruleSpec.ts`) = `{ id?; enabled; priority?; description?; matcher:MatcherSpec; action:ActionSpec }`; `buildRuleFromSpec(spec): PolicyRule`; `describeRule(rule): RuleSpec`; `validateSpec(value): string|null`.
- **Telemetry events** (`at:number`): `ToolCallEvent{type:'tool.call';sessionKey;clientId?;toolName;args?;at}`; `ToolResultEvent{type:'tool.result';…;ok?;at}`; `InterventionEvent{type:'policy.intervention';sessionKey;ruleId;action:InterventionAction;detail?;at}`; `InterventionAction = ActionEffect['type']`; `TelemetryEvent` = union.
- **Collector** (`createCollector({bus?, maxInterventions?=500})`): `getTopTools(n?): TopTool[]`; `getInterventions(limit?): InterventionEvent[]`; `summary(): CollectorSummary`; plus readonly `perTool`/`perSession` maps, `reset()`, `dispose()`.
- **RuleStore** (`createRuleStore({initial?})`): `list():PolicyRule[](copy); get(id); add(rule)(auto randomUUID id if missing):PolicyRule; update(id,patch):PolicyRule|undefined; remove(id):boolean; reset():void; size():number`. Defensive copies.
- `createProxyHandler(options): (req,res)=>Promise<boolean>` with non-enumerable `.telemetry = { bus; collector; storage? }`. `ProxyOptions{ upstream:UpstreamClient; pipeline?; policy?{ rules; feedback?; sessionIdHeader?='x-session-id' }; telemetry? }`.
- `createServer(port?, options?:ProxyOptions, mount?:MountOptions): McmServer`; `MountOptions{ ruleStore?; initialRules?:PolicyRule[]; dashboardDir?; ws?:boolean }`; `McmServer = http.Server & { readonly mcm?: McmServerHandle }`; `McmServerHandle{ bus; collector; storage?; ruleStore; apiHandler; ws }` (non-enumerable). Dashboard dir resolved by walking up from `__dirname` (≤4 levels) to the first containing `dashboard/index.html` (or `mount.dashboardDir`).

## Config env vars
`PORT` (8787), `UPSTREAM_BASE_URL` (`http://localhost:4000/v1`), `UPSTREAM_MODEL` (`gpt-4o-mini`), `UPSTREAM_API_KEY`, `UPSTREAM_PROTOCOL` (`openai`|`anthropic`).
