import http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadConfig } from '../../config/config';
import { createProxyHandler, type ProxyOptions, type ProxyHandler } from '../proxy/index';
import { defaultProxyDefaults } from '../composition';
import { createApiHandler, type RequestHandler } from '../api/http';
import { createWsServer, type WsServer } from '../api/ws';
import { createRuleStore, type RuleStore } from '../api/ruleStore';
import { createPersistentRuleStore } from '../api/persistentRuleStore';
import { createApiProviderStore, type ApiProviderStore } from '../api/providerStore';
import { createPersistentProviderStore } from '../api/persistentProviderStore';
import type { ApiProvider } from '../api/providerSpec';
import type { RuleSpec } from '../api/ruleSpec';
import type { UpstreamClient } from '../proxy/upstream';
import { createToolResultStore, type ToolResultStore } from '../telemetry/toolResultStore';
import { createSqliteToolResultPersister, type SqliteToolResultPersister } from '../telemetry/sqliteToolResultPersister';
import { createEventBus, type TelemetryEventBus } from '../telemetry/event-bus';
import { createCollector, type Collector } from '../telemetry/collector';
import { createToolMetricsTracker, type ToolMetricsTracker } from '../telemetry/toolMetrics';
import { createSqliteStorage, type SqliteStorage } from '../storage/sqlite';
import { flagshipLoopRule, type PolicyRule } from '../policy/ruleEngine';

/**
 * Optional configuration for mounting the REST API, WebSocket server, and
 * dashboard static files onto the proxy HTTP server. Every field is optional;
 * defaults: a fresh empty rule store, no initial rules, WebSocket enabled, and
 * the dashboard resolved from disk (see {@link resolveDashboardDir}).
 */
export interface MountOptions {
  /** Live rule registry backing the `/api/rules` CRUD routes (default: fresh empty store). */
  ruleStore?: RuleStore;
  /** Live raw-tool-result store backing `/api/tool-results/:id` (default: fresh empty store). */
  toolResultStore?: ToolResultStore;
  /** Rules to seed the rule store with (default: none). */
  initialRules?: PolicyRule[];
  /** Explicit directory containing the dashboard assets; overrides the on-disk resolver. */
  dashboardDir?: string;
  /** Attach the built-in WebSocket server (default: `true`; set `false` to disable). */
  ws?: boolean;
}

/** Test-facing handle describing what {@link createServer} wired together. */
export interface AtgServerHandle {
  /** The single shared telemetry event bus (feeds the proxy AND read by the API/WS). */
  bus: TelemetryEventBus;
  /** Live aggregation view subscribed to the shared bus (backs `/api/stats`). */
  collector: Collector;
  /** Live tool-call latency tracker pairing issued calls with their later results (always present). */
  tracker: ToolMetricsTracker;
  /** SQLite-backed persistence, present only when a storage was configured. */
  storage?: SqliteStorage;
  /** In-memory rule registry backing the rule CRUD routes. */
  ruleStore: RuleStore;
  /** Live raw-tool-result store backing the `/api/tool-results/:id` route (always present). */
  toolResultStore: ToolResultStore;
  /** SQLite-backed tool-result persister, present only when `toolResults` is enabled in config. */
  toolResultPersister?: SqliteToolResultPersister;
  /** Mounted REST API request handler (`true` = handled, `false` = fall through). */
  apiHandler: RequestHandler;
  /** Built-in WebSocket server attached to the HTTP server (broadcasts the shared bus). */
  ws: WsServer;
}

/** An HTTP server carrying an optional non-enumerable `.atg` test-facing handle. */
export type AtgServer = http.Server & { readonly atg?: AtgServerHandle };

/**
 * Content types for the dashboard asset extensions the server is allowed to serve.
 * Serving is now general: any GET path whose final segment has one of these
 * extensions — that stays inside the dashboard dir, contains no traversal, and
 * actually exists on disk — is served. Adding new module files (e.g. `/js/*.mjs`)
 * therefore needs no further change here.
 */
const DASHBOARD_CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
};

/**
 * Resolve a GET request path to a safe dashboard asset ({ file, contentType }) or
 * null when the path is unsafe or not an allowed static-asset type. Rejects
 * traversal (`..`), absolute paths, null bytes, and any resolved path that escapes
 * `dir`; only serves `.html` / `.css` / `.js` / `.mjs` files; and verifies the
 * resolved file actually exists inside `dir`. The bare web root maps to `index.html`.
 */
function resolveDashboardAsset(
  reqPath: string,
  dir: string | undefined,
): { file: string; contentType: string } | null {
  if (dir === undefined) return null;
  // Reject null bytes outright (guards against NUL truncation / raw-byte abuse).
  if (reqPath.includes('\u0000')) return null;
  // Decode URL-escaped sequences (%2e -> '.', etc.); malformed input is treated as unsafe.
  let decoded: string;
  try {
    decoded = decodeURIComponent(reqPath);
  } catch {
    return null;
  }
  if (decoded.includes('\u0000')) return null;

  // The bare web root serves the directory index.
  const rel = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const segments = rel.split('/');
  for (const seg of segments) {
    if (seg === '') continue; // extra slashes / trailing slash are harmless
    if (seg === '..') return null; // traversal attempt
  }

  // Only known-safe static asset extensions are served.
  const last = segments[segments.length - 1];
  const contentType = DASHBOARD_CONTENT_TYPES[path.extname(last).toLowerCase()];
  if (contentType === undefined) return null;

  // Rebuild the candidate relative path from the surviving segments, then verify it
  // stays within `dir` and actually exists before serving it.
  const file = segments.filter((seg) => seg !== '' && seg !== '.').join(path.sep);
  const resolved = path.resolve(dir, file);
  if (resolved !== dir && !resolved.startsWith(dir + path.sep)) return null;
  if (!fs.existsSync(resolved)) return null;
  return { file, contentType };
}

/**
 * Resolve the dashboard directory. Uses an explicit override if provided;
 * otherwise walks up from this module's directory (at most ~4 levels) and picks
 * the first parent that contains `dashboard/index.html`. This works both from
 * the compiled layout (`dist/src/server`) and from an in-source run. Returns
 * `undefined` when no candidate is found.
 */
function resolveDashboardDir(override?: string): string | undefined {
  if (override !== undefined) return override;
  let dir = __dirname;
  for (let i = 0; i <= 4; i += 1) {
    if (fs.existsSync(path.join(dir, 'dashboard', 'index.html'))) {
      return path.join(dir, 'dashboard');
    }
    const parent = path.dirname(dir);
    if (parent === dir) break; // reached the filesystem root
    dir = parent;
  }
  return undefined;
}

/** Serve one known dashboard file; respond 404 when the dir/file is missing. */
function serveStaticFile(
  res: http.ServerResponse,
  entry: { file: string; contentType: string },
  dir: string | undefined,
): void {
  if (dir === undefined) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
    return;
  }
  let body: Buffer;
  try {
    body = fs.readFileSync(path.join(dir, entry.file));
  } catch {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
    return;
  }
  res.writeHead(200, { 'Content-Type': entry.contentType });
  res.end(body);
}

/**
 * Ensure the parent directory of the resolved rules DB file exists before it is
 * opened, so a fresh checkout with no `data/` directory still persists rules.
 * A bare filename (dirname `'.'` or empty) is skipped because its directory already
 * resolves; a throwing mkdir is caught by the caller and falls back to memory-only.
 */
function ensureRulesDbParentDir(dbFile: string | undefined): void {
  if (typeof dbFile !== 'string' || dbFile.length === 0) return;
  const dir = path.dirname(dbFile);
  if (dir === '' || dir === '.') return;
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * Build a write-through persistent {@link RuleStore} backed by SQLite when rule
 * persistence is enabled, or an in-memory store as a fallback. Opens the existing
 * `rules` table via the shared {@link createSqliteStorage} (no new tables or
 * migrations), seeds the base store from any persisted rules, and mirrors every
 * mutation back to disk. If opening the database fails, log a warning and return a
 * non-persistent in-memory store so the server still boots.
 */
function openPersistentRuleStore(
  dbPath: string | undefined,
  initial: PolicyRule[] | undefined,
  specs: Map<string, RuleSpec>,
): RuleStore {
  const baseOptions = initial ? { initial } : {};
  try {
    ensureRulesDbParentDir(dbPath);
    const storage = createSqliteStorage({ file: dbPath });
    const base = createRuleStore(baseOptions);
    return createPersistentRuleStore({ base, storage, dbFile: dbPath ?? ':memory:', specs });
  } catch (err) {
    console.warn('aitoolgate: rule persistence disabled (could not open the rules database):', err);
    return createRuleStore(baseOptions);
  }
}

/**
 * Build a write-through persistent {@link ApiProviderStore} backed by SQLite when rule
 * persistence is enabled, else an in-memory store as a fallback. Reuses the shared rules DB
 * file path + parent-directory helper; if opening fails we fall back to a non-persistent
 * in-memory store so the server still boots. Seeding of the env-derived default row is
 * applied BY THE CALLER (see {@link createServer}) so it happens identically whether or not
 * persistence is available.
 */
function openApiProviderStore(dbFile: string | undefined): ApiProviderStore {
  try {
    ensureRulesDbParentDir(dbFile);
    return createPersistentProviderStore({ dbFile: dbFile ?? ':memory:' });
  } catch (err) {
    console.warn('aitoolgate: API-provider persistence disabled (could not open the provider database):', err);
    return createApiProviderStore();
  }
}

/**
 * Create the aitoolgate HTTP server, mounting the model-proxy routes alongside
 * a REST API (`/api/*`), a built-in WebSocket server (the `/ws` upgrade), and
 * the dashboard static files. A single shared telemetry bus + collector feeds
 * BOTH the proxy handler and the API/WS layers so every consumer observes the
 * same event stream.
 *
 * @param port Optional port override; defaults to the configured port.
 * @param options Optional proxy options (upstream client + pipeline + policy).
 * Defaults to the configured upstream using the global `fetch`.
 * @param mount Optional configuration for the API/WS/dashboard mount (defaults:
 * fresh empty rule store, no initial rules, WebSocket enabled, dashboard auto-resolved).
 * @returns the listening HTTP server, carrying a non-enumerable `.atg` handle.
 */
export function createServer(port?: number, options?: ProxyOptions, mount?: MountOptions): AtgServer {
  const config = loadConfig();
  const listenPort = port ?? config.port;

  // Single shared telemetry source: BOTH the proxy handler AND the API/WS read it.
  const bus = options?.telemetry?.bus ?? createEventBus();
  const collector = options?.telemetry?.collector ?? createCollector({ bus });
  const tracker = options?.telemetry?.tracker ?? createToolMetricsTracker();
  const storage = options?.telemetry?.storage;

  // Shared raw-tool-result store: the proxy WRITES each resolved result's RAW content here and the
  // REST API READS it back over `/api/tool-results/:id`. When tool-result persistence is enabled
  // via config, a SQLite-backed persister mirrors every put() fire-and-forget; the API route
  // falls back to it on an in-memory cache miss.
  let toolResultPersister: SqliteToolResultPersister | undefined;
  if (config.toolResults.enabled) {
    toolResultPersister = createSqliteToolResultPersister({
      dbPath: config.toolResults.dbPath,
      flushIntervalMs: config.toolResults.flushIntervalMs,
      batchSize: config.toolResults.batchSize,
      fsyncPerBatch: config.toolResults.fsyncPerBatch,
    });
  }
  const toolResultStore: ToolResultStore =
    mount?.toolResultStore ??
    createToolResultStore(toolResultPersister !== undefined ? { persister: toolResultPersister } : {});

  // Shared spec registry: the REST API stores each submitted/merged {@link RuleSpec}
  // here keyed by rule id; the persistent rule store reads it so a write-through mirrors
  // the exact spec to SQLite losslessly (a PolicyRule's matcher/action are closures and
  // would be dropped by JSON.stringify).
  const ruleSpecs = new Map<string, RuleSpec>();

  // Live rule registry backing the REST API's rule CRUD routes AND the proxy policy
  // stage (read live via ruleStore.list()). Created BEFORE the proxy handler below so
  // the engine can read it LIVE via a getter — letting rules POSTed at runtime (via
  // /api/rules) reach the engine without a restart. When config.rules.enabled and no
  // caller-supplied store is given, wrap the base store so user-created rules persist
  // across restarts; opening the DB failing falls back to a memory-only store (the
  // server still boots).
  let ruleStore: RuleStore;
  if (mount?.ruleStore !== undefined) {
    ruleStore = mount.ruleStore;
  } else if (config.rules.enabled) {
    ruleStore = openPersistentRuleStore(config.rules.dbPath, mount?.initialRules, ruleSpecs);
  } else {
    ruleStore = createRuleStore(mount?.initialRules ? { initial: mount.initialRules } : {});
  }

  // The policy stage evaluates against the LIVE rule collection: the always-on built-in
  // flagship loop rule PLUS any statically supplied rules PLUS whatever the REST rule
  // store holds at evaluation time. A caller that already wires its own `rules` source
  // (array or getter, per the full-stack convention) is honored as-is. An empty
  // store-backed collection (beyond the built-in) is a clean no-op, so request
  // passthrough is never altered.
  //
  // The flagship rule is spliced in here at WIRING time — it is NEVER added to the rule
  // store, so `ruleStore.list()` stays clean, it is never persisted, and it is re-added
  // on restart without a DB seed (the persistent store's seed/persist skip it by id).
  // Evaluated first via its stable low priority (see FLAGSHIP_RULE_PRIORITY in ruleEngine).
  const callerRules = options?.policy?.rules;
  const flagshipRule = flagshipLoopRule();
  const policyRules: PolicyRule[] | (() => PolicyRule[]) =
    typeof callerRules === 'function'
      ? callerRules
      : () => [
          flagshipRule,
          ...(Array.isArray(callerRules) ? callerRules : []),
          ...ruleStore.list(),
        ];
  // Single STABLE mutable upstream reference consumed per-request by the proxy (context.ts reads
  // its fields off this object each request). Mutating its fields hot-applies the active
  // API-provider WITHOUT rebuilding any handler/closure. Initialized from the effective upstream
  // snapshot — a caller-supplied `options.upstream` when given, else the env/config-derived
  // default (exactly what used to be constructed inline here).
  const resolvedUpstream: UpstreamClient =
    options?.upstream ?? {
      baseUrl: config.upstream.baseUrl,
      model: config.upstream.model,
      protocol: config.upstream.protocol,
      ...(config.upstream.apiKey ? { apiKey: config.upstream.apiKey } : {}),
    };
  // Immutable baseline (seed source AND reset-to-defaults target) captured before any live-apply,
  // flattened into concrete consts so the closure never touches optional properties at runtime.
  const initialUpstream: UpstreamClient = { ...resolvedUpstream };
  const upstreamRef: UpstreamClient = { ...resolvedUpstream };
  const baselineBaseUrl = initialUpstream.baseUrl;
  const baselineModel = initialUpstream.model;
  const baselineProtocol = initialUpstream.protocol;
  const baselineApiKey: string | undefined =
    typeof initialUpstream.apiKey === 'string' && initialUpstream.apiKey.length > 0
      ? initialUpstream.apiKey
      : undefined;

  // Live API-provider registry backing `/api/api-providers/*`. Persisted + seeded against the
  // shared rules DB ONLY for real env-based deployments (no caller-injected upstream) when rule
  // persistence is enabled. Caller-injected/mock upstreams (the common test case) stay strictly
  // in-memory so they neither pollute the shared DB across runs nor have their routing flipped by
  // another process's seeded row — keeping pre-existing test behavior bit-for-bit unchanged.
  const providersPersistent = config.rules.enabled && options?.upstream === undefined;
  let apiProviderStore: ApiProviderStore;
  if (providersPersistent) {
    apiProviderStore = openApiProviderStore(config.rules.dbPath);
  } else {
    apiProviderStore = createApiProviderStore();
  }

  // Startup SEEDING: if no provider rows exist yet, auto-create exactly one from the current
  // effective upstream snapshot, marked active — so pre-existing env-based deployments keep
  // working unchanged without user action. add() into an empty store activates the first row.
  if (apiProviderStore.size() === 0) {
    apiProviderStore.add({
      name: 'default',
      baseUrl: baselineBaseUrl,
      model: baselineModel,
      apiKey: baselineApiKey !== undefined ? baselineApiKey.trim() : null,
      protocol: baselineProtocol,
      isActive: true,
      createdAt: Date.now(),
    });
  }

  // LIVE APPLY: overwrite the shared stable ref's fields with the active provider's values so the
  // proxy forwards there immediately. With no active provider, reset back to the baseline default.
  function applyActiveProvider(active?: ApiProvider): void {
    upstreamRef.baseUrl = active ? active.baseUrl : baselineBaseUrl;
    upstreamRef.model = active ? active.model : baselineModel;
    upstreamRef.protocol = active ? active.protocol : baselineProtocol;
    upstreamRef.apiKey = active && active.apiKey !== null ? active.apiKey : (active ? undefined : baselineApiKey);
  }
  applyActiveProvider(apiProviderStore.getActive()); // initialize consistent state once after seeding

  // The server is the SINGLE composition root: it builds the policy stage from the
  // LIVE rules getter (re-resolved on every evaluation) + the shared bus and injects
  // it, so the proxy itself never imports a concrete policy factory. A caller that
  // already supplied a pre-built stage (or a custom feedback store) is honored as-is.
  const callerPolicy = options?.policy;
  const policyStage =
    callerPolicy?.stage ??
    defaultProxyDefaults.makePolicyStage(policyRules, callerPolicy?.feedback, bus);
  const proxyOptions: ProxyOptions = {
    ...(options ?? {}),
    // Pass the SAME mutable reference captured above so per-request field reads observe live changes.
    upstream: upstreamRef,
    // Reuse any caller-provided bus/collector; otherwise default to fresh instances
    // that share the configured bus so the live view always sees the stage's events.
    telemetry: { bus, collector, tracker, ...(storage !== undefined ? { storage } : {}) },
    toolResultStore,
    // Explicitly inject the concrete defaults bundle (the SSE extractor factory + timing/
    // estimation helpers) so the server stays the single composition root for ALL telemetry
    // wiring; the proxy sources `makeSseExtractor` / `usage` from this injected port.
    defaults: defaultProxyDefaults,
    policy: {
      ...(callerPolicy ?? {}),
      rules: policyRules,
      stage: policyStage,
    },
  };
  const handleProxyRequest: ProxyHandler = createProxyHandler(proxyOptions);

  // Shared REST API, backed by the same rule store + collector/bus above AND wired to hot-apply
  // the active provider on every successful `/api/api-providers/*` mutation (and at boot).
  const api: RequestHandler = createApiHandler({
    ruleStore,
    collector,
    toolResultStore,
    specs: ruleSpecs,
    apiProviderStore,
    applyActiveProvider,
  });
  const dashboardDir = resolveDashboardDir(mount?.dashboardDir);

  const server = http.createServer((req, res) => {
    const url = (req.url ?? '/').split('?')[0] ?? '/';

    void (async () => {
      try {
        // 1. Health check (regression guard; highest precedence).
        if (req.method === 'GET' && url === '/health') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok' }));
          return;
        }
        // 2. REST API layer (/api/*) — `true` = handled, `false` = fall through.
        if (await api(req, res)) return;
        // 3. Dashboard static files (any safe, allowed-asset GET path; no traversal).
        if (req.method === 'GET') {
          const entry = resolveDashboardAsset(url, dashboardDir);
          if (entry !== null) {
            serveStaticFile(res, entry, dashboardDir);
            return;
          }
        }
        // 4. Model-proxy routes (OpenAI/Anthropic pass-through).
        if (await handleProxyRequest(req, res)) return;
        // 5. Nothing matched this request.
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not_found' }));
      } catch (err) {
        console.error('aitoolgate request error:', err);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
        }
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'internal_error' }));
      }
    })();
  });

  // Attach the built-in WebSocket server (broadcasts the shared bus to clients),
  // unless explicitly disabled. Clean teardown: when the HTTP server closes, tear
  // down the WS layer so tests drain the event loop (removes the upgrade listener
  // and bus subscription, closes open clients).
  const ws: WsServer | undefined = mount?.ws === false ? undefined : createWsServer(server, { bus });
  if (ws !== undefined) {
    server.once('close', () => ws.close());
  }

  // Graceful shutdown: flush any buffered tool results and close the SQLite DB.
  // Only wired when a persister was configured; best-effort (never throws).
  if (toolResultPersister !== undefined) {
    server.once('close', () => {
      void toolResultPersister.close();
    });
  }

  // Expose a test-facing handle as a NON-enumerable property without changing how
  // the server is invoked (existing callers/tests keep working unchanged).
  Object.defineProperty(server, 'atg', {
    value: {
      bus,
      collector,
      tracker,
      ...(storage !== undefined ? { storage } : {}),
      ruleStore,
      toolResultStore,
      ...(toolResultPersister !== undefined ? { toolResultPersister } : {}),
      apiHandler: api,
      ws: ws as WsServer,
    },
    enumerable: false,
    configurable: true,
    writable: false,
  });

  server.listen(listenPort, () => {
    const addr = server.address();
    const actualPort = typeof addr === 'object' && addr !== null ? addr.port : listenPort;
    console.log(`aitoolgate listening on http://localhost:${actualPort}`);
  });

  return server;
}

// Auto-start only when run directly (not when imported, e.g. by tests).
if (require.main === module) {
  createServer();
}
