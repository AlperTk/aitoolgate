import type { DecorateContext, ModelListRequest, ProviderAdapter, ProviderConfig } from '../../ports/provider';
import { createDeviceOAuthAuth, parseAuthState } from '../auth/deviceOAuth';

/** Registry id of the Copilot adapter (GitHub Copilot chat, OpenAI chat-completions wire protocol). */
export const COPILOT_ADAPTER_ID = 'copilot';

const DEFAULT_COPILOT_BASE_URL = 'https://api.githubcopilot.com';
const DEFAULT_GITHUB_HOST = 'github.com';
const COPILOT_USER_AGENT = 'aitoolgate/1.0';
const COPILOT_OPENAI_INTENT = 'conversation-edits';
const COPILOT_API_VERSION = '2026-08-01';

type ChatMessage = { role: string; content?: unknown };

/** Host of a stored endpoint value (bare host or URL); null when it cannot be parsed. */
function hostOf(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    return new URL(withScheme).host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Maps the stored base URL to the Copilot API origin: github.com/default host → api.githubcopilot.com,
 * any other host is an enterprise domain → copilot-api.<domain>. Never throws; unparseable input → default.
 */
export function resolveCopilotBaseUrl(baseUrl: string): string {
  const host = hostOf(baseUrl ?? '');
  if (host === null || host === DEFAULT_GITHUB_HOST || host === 'api.githubcopilot.com') {
    return DEFAULT_COPILOT_BASE_URL;
  }
  if (host.startsWith('copilot-api.')) return `https://${host}`;
  return `https://copilot-api.${host}`;
}

/** x-initiator: `user` when the last message is a user turn (or there are no messages), otherwise `agent`. */
function initiatorFor(messages: ReadonlyArray<ChatMessage> | undefined): 'user' | 'agent' {
  if (!messages || messages.length === 0) return 'user';
  return messages[messages.length - 1].role === 'user' ? 'user' : 'agent';
}

/** True when any message content part is an image (OpenAI `image_url` or `image` part). */
function hasImageContent(messages: ReadonlyArray<ChatMessage> | undefined): boolean {
  if (!messages) return false;
  for (const message of messages) {
    const content = message.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (typeof part === 'object' && part !== null) {
        const type = (part as { type?: unknown }).type;
        if (type === 'image_url' || type === 'image') return true;
      }
    }
  }
  return false;
}

/** Copilot adapter: device-OAuth token from authState, Copilot headers, metadata-driven endpoint. */
export function createCopilotAdapter(): ProviderAdapter {
  const auth = createDeviceOAuthAuth();
  const decorateHeaders = (ctx: DecorateContext): Record<string, string> => {
    const headers = auth.resolveAuthStateHeaders(ctx.authState);
    headers['User-Agent'] = COPILOT_USER_AGENT;
    headers['Openai-Intent'] = COPILOT_OPENAI_INTENT;
    headers['X-GitHub-Api-Version'] = COPILOT_API_VERSION;
    headers['x-initiator'] = initiatorFor(ctx.messages);
    if (hasImageContent(ctx.messages)) headers['Copilot-Vision-Request'] = 'true';
    return headers;
  };
  return {
    id: COPILOT_ADAPTER_ID,
    wireProtocol: 'openai',
    auth,
    resolveEndpoint(config: ProviderConfig) {
      return { baseUrl: resolveCopilotBaseUrl(config.baseUrl), protocol: 'openai' };
    },
    decorateHeaders,
    listModels(config: ProviderConfig, authState: string | null | undefined): ModelListRequest | null {
      const token = parseAuthState(authState)?.accessToken;
      if (token === undefined) return null;
      const headers = decorateHeaders({ headers: {}, protocol: 'openai', authState, messages: [] });
      return { url: `${resolveCopilotBaseUrl(config.baseUrl)}/models`, headers, secrets: [token] };
    },
  };
}
