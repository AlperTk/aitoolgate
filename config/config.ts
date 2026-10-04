/** Protocol the upstream model provider speaks. */
export type UpstreamProtocol = 'openai' | 'anthropic';

/** Minimal, framework-agnostic runtime configuration. */
export interface Config {
  /** Port the HTTP server listens on. */
  port: number;
  /** The upstream model to forward requests to. */
  upstream: {
    /** Base URL of the upstream model provider, e.g. http://127.0.0.1:9005/v1 */
    baseUrl: string;
    /** Model name passed to the upstream provider. */
    model: string;
    /** Optional provider API key. */
    apiKey?: string;
    /** Protocol the upstream speaks: `openai` (default) or `anthropic`. */
    protocol: UpstreamProtocol;
  };
}

/** Sensible defaults so the server boots with zero configuration. */
const DEFAULTS: Config = {
  port: 8787,
  upstream: {
    baseUrl: 'http://127.0.0.1:9005/v1',
    model: 'gpt-4o-mini',
    protocol: 'openai',
  },
};

/**
 * Build a {@link Config} from environment variables, falling back to
 * {@link DEFAULTS} for anything unset.
 *
 * Recognized env vars: `PORT`, `UPSTREAM_BASE_URL`, `UPSTREAM_MODEL`,
 * `UPSTREAM_API_KEY`, `UPSTREAM_PROTOCOL`.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port =
    env.PORT !== undefined && env.PORT !== '' ? Number(env.PORT) : DEFAULTS.port;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid PORT: ${env.PORT}`);
  }

  return {
    port,
    upstream: {
      baseUrl: env.UPSTREAM_BASE_URL ?? DEFAULTS.upstream.baseUrl,
      model: env.UPSTREAM_MODEL ?? DEFAULTS.upstream.model,
      protocol: parseProtocol(env.UPSTREAM_PROTOCOL),
      ...(env.UPSTREAM_API_KEY ? { apiKey: env.UPSTREAM_API_KEY } : {}),
    },
  };
}

/** Interpret the `UPSTREAM_PROTOCOL` env var; anything but `anthropic` defaults to `openai`. */
function parseProtocol(value: string | undefined): UpstreamProtocol {
  return value === 'anthropic' ? 'anthropic' : 'openai';
}
