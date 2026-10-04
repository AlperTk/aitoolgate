import http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadConfig } from '../../config/config';
import { createProxyHandler, type ProxyOptions, type ProxyHandler } from '../proxy/index';
import { createApiHandler, type RequestHandler } from '../api/http';
import { createWsServer, type WsServer } from '../api/ws';
import { createRuleStore, type RuleStore } from '../api/ruleStore';
import { createEventBus, type TelemetryEventBus } from '../telemetry/event-bus';
import { createCollector, type Collector } from '../telemetry/collector';
import { createToolMetricsTracker, type ToolMetricsTracker } from '../telemetry/toolMetrics';
import type { SqliteStorage } from '../storage/sqlite';
import type { PolicyRule } from '../policy/ruleEngine';

/**
 * Optional configuration for mounting the REST API, WebSocket server, and
 * dashboard static files onto the proxy HTTP server. Every field is optional;
 * defaults: a fresh empty rule store, no initial rules, WebSocket enabled, and
 * the dashboard resolved from disk (see {@link resolveDashboardDir}).
 */
export interface MountOptions {
  /** Live rule registry backing the `/api/rules` CRUD routes (default: fresh empty store). */
  ruleStore?: RuleStore;
  /** Rules to seed the rule store with (default: none). */
  initialRules?: PolicyRule[];
  /** Explicit directory containing the dashboard assets; overrides the on-disk resolver. */
  dashboardDir?: string;
  /** Attach the built-in WebSocket server (default: `true`; set `false` to disable). */
  ws?: boolean;
}

/** Test-facing handle describing what {@link createServer} wired together. */
export interface McmServerHandle {
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
  /** Mounted REST API request handler (`true` = handled, `false` = fall through). */
  apiHandler: RequestHandler;
  /** Built-in WebSocket server attached to the HTTP server (broadcasts the shared bus). */
  ws: WsServer;
}

/** An HTTP server carrying an optional non-enumerable `.mcm` test-facing handle. */
export type McmServer = http.Server & { readonly mcm?: McmServerHandle };

/**
 * Known dashboard files served over the web root. Only these exact paths are
 * mapped to concrete file names, so arbitrary/relative path traversal is
 * impossible (unknown paths fall through to the proxy handler / 404).
 */
const DASHBOARD_FILES: Record<string, { file: string; contentType: string }> = {
  '/': { file: 'index.html', contentType: 'text/html' },
  '/app.js': { file: 'app.js', contentType: 'application/javascript' },
  '/styles.css': { file: 'styles.css', contentType: 'text/css' },
};

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
 * Create the mcp-manager HTTP server, mounting the model-proxy routes alongside
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
 * @returns the listening HTTP server, carrying a non-enumerable `.mcm` handle.
 */
export function createServer(port?: number, options?: ProxyOptions, mount?: MountOptions): McmServer {
  const config = loadConfig();
  const listenPort = port ?? config.port;

  // Single shared telemetry source: BOTH the proxy handler AND the API/WS read it.
  const bus = options?.telemetry?.bus ?? createEventBus();
  const collector = options?.telemetry?.collector ?? createCollector({ bus });
  const tracker = options?.telemetry?.tracker ?? createToolMetricsTracker();
  const storage = options?.telemetry?.storage;

  const proxyOptions: ProxyOptions = {
    ...(options ?? {}),
    upstream:
      options?.upstream ?? {
        baseUrl: config.upstream.baseUrl,
        model: config.upstream.model,
        protocol: config.upstream.protocol,
        ...(config.upstream.apiKey ? { apiKey: config.upstream.apiKey } : {}),
      },
    // Reuse any caller-provided bus/collector; otherwise default to fresh instances
    // that share the configured bus so the live view always sees the stage's events.
    telemetry: { bus, collector, tracker, ...(storage !== undefined ? { storage } : {}) },
  };
  const handleProxyRequest: ProxyHandler = createProxyHandler(proxyOptions);

  // Shared rule registry + REST API, both backed by the same collector/bus above.
  const ruleStore: RuleStore =
    mount?.ruleStore ?? createRuleStore(mount?.initialRules ? { initial: mount.initialRules } : {});
  const api: RequestHandler = createApiHandler({ ruleStore, collector });
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
        // 3. Dashboard static files (known mapped GET paths only, no traversal).
        if (req.method === 'GET') {
          const entry = DASHBOARD_FILES[url];
          if (entry !== undefined) {
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
        console.error('mcp-manager request error:', err);
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

  // Expose a test-facing handle as a NON-enumerable property without changing how
  // the server is invoked (existing callers/tests keep working unchanged).
  Object.defineProperty(server, 'mcm', {
    value: {
      bus,
      collector,
      tracker,
      ...(storage !== undefined ? { storage } : {}),
      ruleStore,
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
    console.log(`mcp-manager listening on http://localhost:${actualPort}`);
  });

  return server;
}

// Auto-start only when run directly (not when imported, e.g. by tests).
if (require.main === module) {
  createServer();
}
