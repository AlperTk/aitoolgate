/**
 * Dependency-free JSON REST API layer over the existing telemetry {@link Collector}
 * and in-memory {@link RuleStore}.
 *
 * Routes (all under `/api`, all JSON):
 * - `GET    /api/stats`        → `200` `collector.summary()`
 * - `POST   /api/stats/reset`  → `200` post-reset `collector.summary()` (same shape as GET)
 * - `GET    /api/events`       → `200` `{ events }` (recent raw telemetry events, ascending)
 * - `GET    /api/rules`        → `200` `RuleSpec[]` (stored spec if present, else best-effort `describeRule`)
 * - `POST   /api/rules`        → `201` serialized rule; `400 { error }` on an invalid spec/body
 * - `PATCH  /api/rules/{id}`   → `200` serialized rule; `404 { error:'not_found' }` unknown; `400` bad body
 * - `DELETE /api/rules/{id}`   → `204`; `404 { error:'not_found' }` unknown
 * - `GET    /api/tool-results/{id}` → `200 { ok, content, chars }`; `404 { error:'not_found' }` unknown
 *
 * Non-`/api` requests return `false` WITHOUT writing a response, so the server
 * can chain this handler before the proxy handler (true = handled, false =
 * fall through). Uses only Node built-ins (`node:http`, `node:crypto`).
 */
import type * as http from 'node:http';
import type { Collector } from '../telemetry/collector';
import type { ToolResultStore } from '../telemetry/toolResultStore';
import type { RuleStore, RulePatch } from './ruleStore';
import type { PolicyRule } from '../policy/ruleEngine';
import type { RuleSpec, MatcherSpec, ActionSpec } from './ruleSpec';
import {
  buildRuleFromSpec,
  buildMatcher,
  buildAction,
  describeRule,
  validateSpec,
} from './ruleSpec';
import type { ApiProvider } from './providerSpec';
import { validateProviderSpec, isNonEmptyString, normalizeApiKey } from './providerSpec';
import type { ApiProviderStore, ProviderPatch } from './providerStore';

/** The request-handler convention: `true` = handled this route, `false` = fall through. */
export type RequestHandler = (req: http.IncomingMessage, res: http.ServerResponse) => Promise<boolean>;

/** Options for {@link createApiHandler}. */
export interface ApiOptions {
  /** The live in-memory rule registry backing rule CRUD. */
  ruleStore: RuleStore;
  /** The telemetry collector backing stats. */
  collector: Collector;
  /**
   * Originally-submitted specs keyed by rule id, used to serialize rules with
   * full fidelity (a closure can't be re-described losslessly). Created fresh
   * when omitted.
   */
  specs?: Map<string, RuleSpec>;
  /**
   * Optional raw-tool-result store backing `GET /api/tool-results/:id`. When omitted,
   * that route responds `404 { error:'not_found' }` (no results available).
   */
  toolResultStore?: ToolResultStore;
  /**
   * Optional live API-provider registry backing the `/api/api-providers/*` routes. When
   * omitted, those paths are not handled (fall through to the proxy), so existing callers
   * are unaffected. Never returns a raw API key in list form (only an `apiKeySet` flag).
   */
  apiProviderStore?: ApiProviderStore;
  /**
   * Invoked exactly once after every successful provider mutation AND at boot, passing the
   * currently-active provider (or `undefined`) so the live upstream reference can be hot-
   * applied without a server restart. Omitted → no-op (callers not wiring providers).
   */
  applyActiveProvider?: (active: ApiProvider | undefined) => void;
}

/** Result of a PATCH attempt, so callers can map each case to an HTTP status. */
type PatchResult =
  | { kind: 'updated'; rule: PolicyRule }
  | { kind: 'not_found' }
  | { kind: 'invalid'; error: string };

/** Type guard: a non-null, non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Send a JSON response with `Content-Type: application/json`. */
function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** Accumulate the raw request-body stream as a string. */
function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk: Buffer) => {
      data += chunk.toString();
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

/** Parse a JSON body; an empty body is `{}` and a parse failure yields an `Error`. */
async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const data = await readBody(req);
  if (data.length === 0) return {};
  try {
    return JSON.parse(data);
  } catch {
    return new Error('invalid JSON body');
  }
}

/**
 * Create a JSON REST API handler backed by `options.ruleStore` + `options.collector`.
 * Initializes `options.specs` to a fresh map when not provided. Returns a handler
 * consistent with the codebase `(req, res) => Promise<boolean>` convention
 * (true = handled, false = fall through to the proxy handler).
 */
export function createApiHandler(options: ApiOptions): RequestHandler {
  const specs = (options.specs ??= new Map<string, RuleSpec>());
  const { ruleStore, collector, toolResultStore, apiProviderStore } = options;
  // Hot-apply hook (optional): invoked once after each successful provider mutation and at
  // boot so the shared mutable upstream reference tracks the active provider with no restart.
  // Defaults to a no-op for legacy callers that don't wire an API-provider feature.
  const liveApply: (active: ApiProvider | undefined) => void = options.applyActiveProvider ?? (() => {});

  /** Serialize a rule: prefer its stored spec for fidelity, else a best-effort descriptor. */
  const serialize = (rule: PolicyRule): RuleSpec => specs.get(rule.id) ?? describeRule(rule);

  /** Apply a partial PATCH to a rule, handling both stored-spec and spec-less rules. */
  function applyPatch(id: string, patch: Record<string, unknown>): PatchResult {
    if (ruleStore.get(id) === undefined) return { kind: 'not_found' };
    try {
      if (specs.has(id)) {
        // Merge the patch into the stored spec, then rebuild the full rule from it.
        const merged = { ...(specs.get(id) as RuleSpec), ...(patch as Partial<RuleSpec>) };
        const validationError = validateSpec(merged);
        if (validationError !== null) return { kind: 'invalid', error: validationError };
        const built = buildRuleFromSpec(merged);
        specs.set(built.id, { ...merged, id: built.id });
        const updated = ruleStore.update(id, {
          enabled: built.enabled,
          priority: built.priority,
          description: built.description,
          matcher: built.matcher,
          action: built.action,
        });
        return updated === undefined ? { kind: 'not_found' } : { kind: 'updated', rule: updated };
      }
      // No stored spec: apply only the provided fields directly to the live rule.
      const rulePatch: RulePatch = {};
      if ('enabled' in patch) rulePatch.enabled = patch.enabled as boolean;
      if ('priority' in patch) rulePatch.priority = patch.priority as number;
      if ('description' in patch) rulePatch.description = patch.description as string;
      if ('matcher' in patch) {
        if (!isRecord(patch.matcher)) return { kind: 'invalid', error: '"matcher" must be an object' };
        rulePatch.matcher = buildMatcher(patch.matcher as MatcherSpec);
      }
      if ('action' in patch) {
        if (!isRecord(patch.action)) return { kind: 'invalid', error: '"action" must be an object' };
        rulePatch.action = buildAction(patch.action as ActionSpec);
      }
      const updated = ruleStore.update(id, rulePatch);
      return updated === undefined ? { kind: 'not_found' } : { kind: 'updated', rule: updated };
    } catch (error) {
      return { kind: 'invalid', error: error instanceof Error ? error.message : String(error) };
    }
  }

  return async (req, res): Promise<boolean> => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    // Not an API route → fall through without writing anything (chains before the proxy).
    if (!path.startsWith('/api/')) return false;

    try {
      const method = req.method ?? 'GET';

      // Serialize a provider WITHOUT its raw API key, exposing only an `apiKeySet` flag —
      // the list route never leaks secrets even though get() returns them by design.
      const serializePublic = (provider: ApiProvider): Record<string, unknown> => {
        const { apiKey, ...rest } = provider;
        return { ...rest, apiKeySet: apiKey !== null };
      };
      // Fire the hot-apply hook exactly once against the current active provider (a no-op when
      // the caller didn't wire one, or when no store / no active row exists).
      const fireLiveApply = (): void => {
        liveApply(apiProviderStore?.getActive());
      };

      if (path === '/api/stats' && method === 'GET') {
        sendJson(res, 200, collector.summary());
        return true;
      }

      if (path === '/api/stats/reset' && method === 'POST') {
        // Clear all aggregates, then return the post-reset summary (same shape as GET /api/stats).
        collector.reset();
        sendJson(res, 200, collector.summary());
        return true;
      }

      if (path === '/api/events' && method === 'GET') {
        sendJson(res, 200, { events: collector.getRecentEvents() });
        return true;
      }

      if (path === '/api/rules' && method === 'GET') {
        sendJson(res, 200, ruleStore.list().map(serialize));
        return true;
      }

      if (path === '/api/rules' && method === 'POST') {
        const parsed = await readJsonBody(req);
        if (parsed instanceof Error) {
          sendJson(res, 400, { error: parsed.message });
          return true;
        }
        const validationError = validateSpec(parsed);
        if (validationError !== null) {
          sendJson(res, 400, { error: validationError });
          return true;
        }
        const spec = parsed as RuleSpec;
        const built = buildRuleFromSpec(spec);
        const stored = ruleStore.add(built);
        specs.set(stored.id, { ...spec, id: stored.id });
        sendJson(res, 201, serialize(stored));
        return true;
      }

      const match = /^\/api\/rules\/([^/]+)$/.exec(path);
      if (match) {
        const id = decodeURIComponent(match[1]);

        if (method === 'DELETE') {
          const removed = ruleStore.remove(id);
          specs.delete(id);
          if (!removed) {
            sendJson(res, 404, { error: 'not_found' });
            return true;
          }
          res.writeHead(204);
          res.end();
          return true;
        }

        if (method === 'PATCH') {
          const patch = await readJsonBody(req);
          if (patch instanceof Error) {
            sendJson(res, 400, { error: patch.message });
            return true;
          }
          if (!isRecord(patch)) {
            sendJson(res, 400, { error: 'body must be a JSON object' });
            return true;
          }
          const result = applyPatch(id, patch);
          if (result.kind === 'not_found') {
            sendJson(res, 404, { error: 'not_found' });
            return true;
          }
          if (result.kind === 'invalid') {
            sendJson(res, 400, { error: result.error });
            return true;
          }
          sendJson(res, 200, serialize(result.rule));
          return true;
        }
      }

      // --- API-provider registry (/api/api-providers/*) — optional feature. ----
      // Only reached when the caller wired a live store; absent callers keep prior behavior.
      if (apiProviderStore !== undefined) {
        const providerPath = /^\/api\/api-providers(?:\/([^/]+))?$/.exec(path);
        if (providerPath) {
          const segment = providerPath[1] === undefined ? undefined : decodeURIComponent(providerPath[1]);

          // GET list (masked, +activeId) OR single record (full incl apiKey), by presence of id.
          if (method === 'GET') {
            if (segment === undefined) {
              sendJson(res, 200, {
                providers: apiProviderStore.list().map(serializePublic),
                activeId: apiProviderStore.getActive()?.id ?? null,
              });
              return true;
            }
            const found = apiProviderStore.get(segment);
            if (found === undefined) {
              sendJson(res, 404, { error: 'not_found' });
              return true;
            }
            sendJson(res, 200, found);
            return true;
          }

          // POST create (no id present). Auto-activates the first-ever row via the store.
          if (method === 'POST' && segment === undefined) {
            const parsed = await readJsonBody(req);
            if (parsed instanceof Error) {
              sendJson(res, 400, { error: parsed.message });
              return true;
            }
            if (!isRecord(parsed)) {
              sendJson(res, 400, { error: 'body must be a JSON object' });
              return true;
            }
            const specError = validateProviderSpec(parsed);
            if (specError !== null) {
              sendJson(res, 400, { error: specError });
              return true;
            }
            const body = parsed as Record<string, unknown>;
            for (const field of ['name', 'baseUrl'] as const) {
              if (!isNonEmptyString(body[field])) {
                sendJson(res, 400, { error: `"${field}" is required and must be a non-empty string` });
                return true;
              }
            }
            const created = apiProviderStore.add({
              name: String(body.name),
              baseUrl: String(body.baseUrl),
              model: typeof body.model === 'string' ? body.model : '',
              protocol: typeof body.protocol === 'string' ? (body.protocol as ApiProvider['protocol']) : 'openai',
              apiKey: normalizeApiKey(body.apiKey),
            });
            fireLiveApply();
            sendJson(res, 201, created);
            return true;
          }

          // PATCH update known fields only (requires an id). Enforces single-active.
          if (method === 'PATCH' && segment !== undefined) {
            if (apiProviderStore.get(segment) === undefined) {
              sendJson(res, 404, { error: 'not_found' });
              return true;
            }
            const parsed = await readJsonBody(req);
            if (parsed instanceof Error) {
              sendJson(res, 400, { error: parsed.message });
              return true;
            }
            if (!isRecord(parsed)) {
              sendJson(res, 400, { error: 'body must be a JSON object' });
              return true;
            }
            const specError = validateProviderSpec(parsed);
            if (specError !== null) {
              sendJson(res, 400, { error: specError });
              return true;
            }
            const patchBody = parsed as Record<string, unknown>;
            const patch: ProviderPatch = {};
            if ('name' in patchBody) patch.name = String(patchBody.name);
            if ('baseUrl' in patchBody) patch.baseUrl = String(patchBody.baseUrl);
            if ('model' in patchBody) patch.model = String(patchBody.model);
            if ('apiKey' in patchBody) patch.apiKey = normalizeApiKey(patchBody.apiKey);
            if ('protocol' in patchBody) patch.protocol = patchBody.protocol as ApiProvider['protocol'];
            if ('isActive' in patchBody) patch.isActive = Boolean(patchBody.isActive);
            const updated = apiProviderStore.update(segment, patch);
            if (updated === undefined) {
              sendJson(res, 404, { error: 'not_found' });
              return true;
            }
            fireLiveApply();
            sendJson(res, 200, updated);
            return true;
          }

          // DELETE remove the row (promotes lowest-id remaining / none via the store).
          if (method === 'DELETE' && segment !== undefined) {
            const removed = apiProviderStore.remove(segment);
            if (!removed) {
              sendJson(res, 404, { error: 'not_found' });
              return true;
            }
            fireLiveApply();
            sendJson(res, 200, { deleted: true });
            return true;
          }

          // A provider path with no matching handler (e.g. POST carrying an id segment).
          sendJson(res, 404, { error: 'not_found' });
          return true;
        }
      }

      const resultMatch = /^\/api\/tool-results\/([^/]+)$/.exec(path);
      if (resultMatch && method === 'GET') {
        const id = decodeURIComponent(resultMatch[1]);
        // Memory hit is the fast path; fall back to the durable store on a miss.
        const memHit = toolResultStore?.get(id);
        let entry = memHit;
        if (entry === undefined && toolResultStore?.resolve !== undefined) {
          entry = (await toolResultStore.resolve(id)) ?? undefined;
        }
        if (entry === undefined) {
          sendJson(res, 404, { error: 'not_found' });
          return true;
        }
        sendJson(res, 200, {
          content: entry.content,
          chars: entry.chars,
          ...(entry.ok !== undefined ? { ok: entry.ok } : {}),
        });
        return true;
      }

      // Unknown API route.
      sendJson(res, 404, { error: 'not_found' });
      return true;
    } catch (error) {
      if (!res.headersSent) {
        sendJson(res, 500, { error: error instanceof Error ? error.message : 'internal_error' });
      }
      return true;
    }
  };
}
