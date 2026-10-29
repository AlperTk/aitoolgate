/** JSON REST API layer over the telemetry Collector and rule/provider stores; non-`/api` paths return false without writing a response so it can chain before the proxy. */
import type * as http from 'node:http';
import { randomUUID } from 'node:crypto';
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
import type { ApiProvider, ProviderAuthType } from './providerSpec';
import { validateProviderSpec, isNonEmptyString, normalizeApiKey } from './providerSpec';
import { parseProbeBody, probeProvider, probeSavedProvider } from './providerProbe';
import type { ProbeResult } from './providerProbe';
import { lookupProviderAdapter } from '../providers/registry';
import type { ApiProviderStore, ProviderPatch } from './providerStore';
import { createDeviceOAuthAuth, checkCopilotEntitlement, serializeAuthState } from '../providers/auth/deviceOAuth';
import type { DeviceOAuthOptions } from '../providers/auth/deviceOAuth';
import { COPILOT_ADAPTER_ID, COPILOT_DEVICE_CLIENT_ID } from '../providers/copilot/adapter';
import { createDeviceFlowRegistry } from './deviceFlowRegistry';
import type { DeviceFlowRegistry } from './deviceFlowRegistry';

/** The request-handler convention: `true` = handled this route, `false` = fall through. */
export type RequestHandler = (req: http.IncomingMessage, res: http.ServerResponse) => Promise<boolean>;

export interface ApiOptions {
  ruleStore: RuleStore;
  collector: Collector;
  /** Optional raw-tool-result store for `GET /api/tool-results/:id`; when omitted that route returns 404. */
  toolResultStore?: ToolResultStore;
  /** Optional API-provider registry for `/api/api-providers/*`; falls through when omitted and never leaks the raw API key in list form. */
  apiProviderStore?: ApiProviderStore;
  /** Invoked once after each provider mutation and at boot to hot-apply the active provider without a restart; no-op when omitted. */
  applyActiveProvider?: (active: ApiProvider | undefined) => void;
  /** Copilot device-login options (GitHub domain, client id, fetch) plus an optional pending-flow registry; defaults to github.com. */
  deviceFlow?: DeviceOAuthOptions & { registry?: DeviceFlowRegistry };
}

type PatchResult =
  | { kind: 'updated'; rule: PolicyRule }
  | { kind: 'not_found' }
  | { kind: 'invalid'; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

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

/** Create the JSON REST API handler. */
export function createApiHandler(options: ApiOptions): RequestHandler {
  const { ruleStore, collector, toolResultStore, apiProviderStore, deviceFlow } = options;
  const deviceAuth = createDeviceOAuthAuth({ ...deviceFlow, clientId: deviceFlow?.clientId ?? COPILOT_DEVICE_CLIENT_ID });
  const deviceFlows: DeviceFlowRegistry = deviceFlow?.registry ?? createDeviceFlowRegistry();
  // Hot-apply hook (optional): tracks the active provider without a restart; no-op for legacy callers.
  const liveApply: (active: ApiProvider | undefined) => void = options.applyActiveProvider ?? (() => {});
  // Authorized-but-unsaved Copilot logins keyed by opaque pendingId; tokens never leave the server.
  const PENDING_LOGIN_TTL_MS = 10 * 60_000;
  const pendingLogins = new Map<string, { state: Parameters<typeof serializeAuthState>[0]; expiresAt: number }>();

  /** Serialize a rule: prefer its stored spec (re-keyed to the live id) for fidelity, else a best-effort descriptor. */
  const serialize = (rule: PolicyRule): RuleSpec => {
    const spec = ruleStore.entry(rule.id)?.spec as RuleSpec | undefined;
    return spec !== undefined ? { ...spec, id: rule.id } : describeRule(rule);
  };

  function applyPatch(id: string, patch: Record<string, unknown>): PatchResult {
    const existing = ruleStore.entry(id);
    if (existing === undefined) return { kind: 'not_found' };
    try {
      if (existing.spec !== undefined) {
        const merged = { ...(existing.spec as RuleSpec), ...(patch as Partial<RuleSpec>) };
        const validationError = validateSpec(merged);
        if (validationError !== null) return { kind: 'invalid', error: validationError };
        const built = buildRuleFromSpec(merged);
        const updated = ruleStore.update(
          id,
          {
            enabled: built.enabled,
            priority: built.priority,
            description: built.description,
            matcher: built.matcher,
            action: built.action,
          },
          { ...merged, id: built.id },
        );
        return updated === undefined ? { kind: 'not_found' } : { kind: 'updated', rule: updated };
      }
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

      // Serialize a provider without its raw API key (only an `apiKeySet` flag) so the list route never leaks secrets.
      // `authState` is opaque adapter credential state and is never returned by any provider route.
      // deviceOAuth rows never expose any credential: authState is dropped and apiKey is forced to null.
      const withoutAuthState = (provider: ApiProvider): Omit<ApiProvider, 'authState'> => {
        const { authState: _authState, ...rest } = provider;
        return rest.authType === 'deviceOAuth' ? { ...rest, apiKey: null } : rest;
      };
      const serializePublic = (provider: ApiProvider): Record<string, unknown> => {
        const { apiKey, ...rest } = withoutAuthState(provider);
        return { ...rest, apiKeySet: apiKey !== null };
      };
      // Fire the hot-apply hook once against the current active provider (no-op if not wired).
      const fireLiveApply = (): void => {
        liveApply(apiProviderStore?.getActive());
      };

      if (path === '/api/stats' && method === 'GET') {
        sendJson(res, 200, collector.summary());
        return true;
      }

      if (path === '/api/stats/reset' && method === 'POST') {
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
        const stored = ruleStore.add(built, { ...spec, id: built.id });
        sendJson(res, 201, serialize(stored));
        return true;
      }

      const match = /^\/api\/rules\/([^/]+)$/.exec(path);
      if (match) {
        const id = decodeURIComponent(match[1]);

        if (method === 'DELETE') {
          const removed = ruleStore.remove(id);
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

      // Probe an upstream's model-list endpoint; a stored key is used server-side when `id` is given without `apiKey`.
      if (path === '/api/api-providers/probe' && method === 'POST') {
        const parsed = await readJsonBody(req);
        if (parsed instanceof Error) {
          sendJson(res, 400, { error: parsed.message });
          return true;
        }
        // Authorized-but-unsaved Copilot login: lists models with the pending token; nothing is persisted or consumed.
        if (isRecord(parsed) && 'pendingId' in parsed) {
          const pendingId = parsed.pendingId;
          if (typeof pendingId !== 'string' || pendingId.length === 0) {
            sendJson(res, 400, { error: '"pendingId" is required and must be a non-empty string' });
            return true;
          }
          const pending = pendingLogins.get(pendingId);
          if (pending === undefined) {
            sendJson(res, 404, { error: 'not_found' });
            return true;
          }
          if (pending.expiresAt <= Date.now()) {
            pendingLogins.delete(pendingId);
            sendJson(res, 410, { error: 'pending_expired' });
            return true;
          }
          const copilot = lookupProviderAdapter(COPILOT_ADAPTER_ID);
          const listed: ProbeResult =
            copilot === null
              ? { ok: false, latencyMs: 0, models: [], error: 'unknown provider type' }
              : await probeSavedProvider(
                  copilot,
                  { baseUrl: 'https://github.com', protocol: 'openai', apiKey: null },
                  serializeAuthState(pending.state),
                );
          if (!listed.ok) {
            sendJson(res, listed.status ?? 502, { error: listed.error ?? 'model list failed' });
            return true;
          }
          sendJson(res, 200, { models: listed.models });
          return true;
        }
        const probeBody = parseProbeBody(parsed);
        if (!probeBody.ok) {
          sendJson(res, 400, { error: probeBody.error });
          return true;
        }
        if (!('protocol' in probeBody)) {
          // Saved provider: config and credentials are resolved here; the token never leaves the server.
          const saved = apiProviderStore?.get(probeBody.id);
          if (saved === undefined) {
            sendJson(res, 404, { error: 'not_found' });
            return true;
          }
          const adapter = lookupProviderAdapter(saved.adapterId);
          const savedResult =
            adapter === null
              ? { ok: false, latencyMs: 0, models: [], error: 'unknown provider type' }
              : await probeSavedProvider(
                  adapter,
                  {
                    baseUrl: saved.baseUrl,
                    protocol: saved.protocol,
                    apiKey: saved.authType === 'deviceOAuth' ? null : saved.apiKey,
                  },
                  saved.authState,
                );
          sendJson(res, 200, savedResult);
          return true;
        }
        const stored = probeBody.id !== undefined ? apiProviderStore?.get(probeBody.id) : undefined;
        const result = await probeProvider({
          protocol: probeBody.protocol,
          baseUrl: probeBody.baseUrl,
          apiKey: probeBody.apiKey ?? stored?.apiKey ?? null,
        });
        sendJson(res, 200, result);
        return true;
      }

      // API-provider registry (/api/api-providers/*); only reached when a live store is wired.
      if (apiProviderStore !== undefined) {
        // Copilot device login: the device_code stays server-side, referenced by an opaque flowId.
        if (method === 'POST' && path === '/api/api-providers/device-flow/start') {
          const started = await deviceAuth.startDeviceFlow();
          if (!started.ok) {
            sendJson(res, started.error.code === 'invalid_domain' ? 400 : 502, { error: started.error.message });
            return true;
          }
          const flow = started.flow;
          const flowId = deviceFlows.start(flow);
          sendJson(res, 200, {
            flowId,
            userCode: flow.userCode,
            verificationUri: flow.verificationUri,
            interval: flow.interval,
            expiresIn: flow.expiresIn,
          });
          return true;
        }

        if (method === 'POST' && path === '/api/api-providers/device-flow/poll') {
          const parsed = await readJsonBody(req);
          if (parsed instanceof Error) {
            sendJson(res, 400, { error: parsed.message });
            return true;
          }
          const flowId = isRecord(parsed) ? parsed.flowId : undefined;
          if (typeof flowId !== 'string' || flowId.length === 0) {
            sendJson(res, 400, { error: '"flowId" is required and must be a non-empty string' });
            return true;
          }
          const flow = deviceFlows.get(flowId);
          if (flow === undefined) {
            sendJson(res, 404, { error: 'not_found' });
            return true;
          }
          const result = await deviceAuth.pollDeviceFlow(flow);
          switch (result.status) {
            case 'pending':
              sendJson(res, 200, { status: 'pending', interval: result.interval });
              return true;
            case 'slow_down':
              deviceFlows.setInterval(flowId, result.interval);
              sendJson(res, 200, { status: 'slow_down', interval: result.interval });
              return true;
            case 'expired':
            case 'denied':
              deviceFlows.delete(flowId);
              sendJson(res, 200, { status: result.status });
              return true;
            case 'error':
              sendJson(res, 502, { error: result.error.message });
              return true;
            case 'done':
              break;
          }
          // Entitlement gates activation; a blocked account never gets a provider row.
          const entitlement = await checkCopilotEntitlement(result.state.accessToken, deviceFlow);
          deviceFlows.delete(flowId);
          if (entitlement.status === 'blocked') {
            sendJson(res, 403, { error: entitlement.message });
            return true;
          }
          // Authorized but unsaved: credentials stay server-side under an opaque pendingId until confirmed.
          const now = Date.now();
          for (const [id, entry] of pendingLogins) {
            if (entry.expiresAt <= now) pendingLogins.delete(id);
          }
          const pendingId = randomUUID();
          pendingLogins.set(pendingId, { state: result.state, expiresAt: now + PENDING_LOGIN_TTL_MS });
          sendJson(res, 200, { status: 'done', pendingId, expiresIn: PENDING_LOGIN_TTL_MS / 1000 });
          return true;
        }

        // Persists an authorized pending Copilot login with the model the user chose; fires live-apply once.
        if (method === 'POST' && path === '/api/api-providers/device-flow/confirm') {
          const parsed = await readJsonBody(req);
          if (parsed instanceof Error) {
            sendJson(res, 400, { error: parsed.message });
            return true;
          }
          if (!isRecord(parsed)) {
            sendJson(res, 400, { error: 'body must be a JSON object' });
            return true;
          }
          const pendingId = parsed.pendingId;
          if (typeof pendingId !== 'string' || pendingId.length === 0) {
            sendJson(res, 400, { error: '"pendingId" is required and must be a non-empty string' });
            return true;
          }
          if ('apiKey' in parsed && parsed.apiKey !== null) {
            sendJson(res, 400, { error: '"apiKey" cannot be set on a deviceOAuth provider' });
            return true;
          }
          const specError = validateProviderSpec({ model: parsed.model ?? null });
          if (specError !== null) {
            sendJson(res, 400, { error: specError });
            return true;
          }
          if ('name' in parsed && typeof parsed.name !== 'string') {
            sendJson(res, 400, { error: '"name" must be a string when provided' });
            return true;
          }
          if ('providerId' in parsed && (typeof parsed.providerId !== 'string' || parsed.providerId.length === 0)) {
            sendJson(res, 400, { error: '"providerId" must be a non-empty string when provided' });
            return true;
          }
          const customName = typeof parsed.name === 'string' && parsed.name.trim().length > 0 ? parsed.name.trim() : undefined;
          const model = typeof parsed.model === 'string' ? parsed.model : null;
          const pending = pendingLogins.get(pendingId);
          if (pending === undefined) {
            sendJson(res, 404, { error: 'not_found' });
            return true;
          }
          // Explicit providerId = re-login on that saved deviceOAuth row; absent = always add a new provider.
          const targetId = typeof parsed.providerId === 'string' ? parsed.providerId : undefined;
          const target = targetId === undefined ? undefined : apiProviderStore.get(targetId);
          if (targetId !== undefined && (target === undefined || target.authType !== 'deviceOAuth')) {
            sendJson(res, 404, { error: 'not_found' });
            return true;
          }
          pendingLogins.delete(pendingId);
          if (pending.expiresAt <= Date.now()) {
            sendJson(res, 410, { error: 'pending_expired' });
            return true;
          }
          const authState = serializeAuthState(pending.state);
          const row =
            target === undefined
              ? apiProviderStore.add({
                  name: customName ?? 'GitHub Copilot',
                  baseUrl: 'https://github.com',
                  model,
                  adapterId: COPILOT_ADAPTER_ID,
                  authType: 'deviceOAuth',
                  authState,
                  isActive: true,
                })
              : apiProviderStore.update(target.id, {
                  model,
                  authType: 'deviceOAuth',
                  authState,
                  isActive: true,
                  ...(customName !== undefined ? { name: customName } : {}),
                });
          if (row === undefined) {
            sendJson(res, 404, { error: 'not_found' });
            return true;
          }
          fireLiveApply();
          sendJson(res, 200, { status: 'done', provider: serializePublic(row) });
          return true;
        }

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
            sendJson(res, 200, withoutAuthState(found));
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
            const isCopilot = body.adapterId === COPILOT_ADAPTER_ID;
            for (const field of ['name', 'baseUrl'] as const) {
              if (!isNonEmptyString(body[field])) {
                sendJson(res, 400, { error: `"${field}" is required and must be a non-empty string` });
                return true;
              }
            }
            const created = apiProviderStore.add({
              name: String(body.name),
              baseUrl: String(body.baseUrl),
              model: typeof body.model === 'string' ? body.model : null,
              apiKey: normalizeApiKey(body.apiKey),
              adapterId: typeof body.adapterId === 'string' ? body.adapterId : undefined,
              authType: isCopilot
                ? 'deviceOAuth'
                : typeof body.authType === 'string' ? (body.authType as ProviderAuthType) : undefined,
            });
            fireLiveApply();
            sendJson(res, 201, withoutAuthState(created));
            return true;
          }

          // PATCH update known fields only (requires an id). Enforces single-active.
          if (method === 'PATCH' && segment !== undefined) {
            const existing = apiProviderStore.get(segment);
            if (existing === undefined) {
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
            const specError = validateProviderSpec(parsed, { adapterId: existing.adapterId, authType: existing.authType });
            if (specError !== null) {
              sendJson(res, 400, { error: specError });
              return true;
            }
            const patchBody = parsed as Record<string, unknown>;
            if ('apiKey' in patchBody && existing.authType === 'deviceOAuth') {
              sendJson(res, 400, { error: '"apiKey" cannot be set on a deviceOAuth provider' });
              return true;
            }
            const patch: ProviderPatch = {};
            if ('name' in patchBody) patch.name = String(patchBody.name);
            if ('baseUrl' in patchBody) patch.baseUrl = String(patchBody.baseUrl);
            if ('model' in patchBody) patch.model = patchBody.model === null ? null : String(patchBody.model);
            if ('apiKey' in patchBody) patch.apiKey = normalizeApiKey(patchBody.apiKey);
            if ('adapterId' in patchBody) patch.adapterId = String(patchBody.adapterId);
            if ('authType' in patchBody) patch.authType = patchBody.authType as ProviderAuthType;
            if ('isActive' in patchBody) patch.isActive = Boolean(patchBody.isActive);
            const updated = apiProviderStore.update(segment, patch);
            if (updated === undefined) {
              sendJson(res, 404, { error: 'not_found' });
              return true;
            }
            fireLiveApply();
            sendJson(res, 200, withoutAuthState(updated));
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
