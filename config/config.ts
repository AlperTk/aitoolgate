export type UpstreamProtocol = 'openai' | 'anthropic';

export interface ToolResultsConfig {
  enabled: boolean;
  dbPath: string;
  flushIntervalMs: number;
  batchSize: number;
  fsyncPerBatch: boolean;
}

export interface RulesConfig {
  enabled: boolean;
  dbPath?: string;
}

export interface Config {
  port: number;
  upstream: {
    baseUrl: string;
    model: string;
    apiKey?: string;
    protocol: UpstreamProtocol;
  };
  toolResults: ToolResultsConfig;
  rules: RulesConfig;
}

const DEFAULTS: Config = {
  port: 8787,
  upstream: {
    baseUrl: 'http://127.0.0.1:9005/v1',
    model: 'gpt-4o-mini',
    protocol: 'openai',
  },
  toolResults: {
    enabled: false,
    dbPath: 'data/tool-results.db',
    flushIntervalMs: 50,
    batchSize: 100,
    fsyncPerBatch: false,
  },
  rules: {
    enabled: true,
    dbPath: 'data/rules.db',
  },
};

/** Build a Config from environment variables, falling back to DEFAULTS for anything unset. */
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
    toolResults: {
      enabled: parseBool(env.TOOL_RESULTS_ENABLED) ?? DEFAULTS.toolResults.enabled,
      dbPath: env.TOOL_RESULTS_DB ?? DEFAULTS.toolResults.dbPath,
      flushIntervalMs: parsePositiveInt(env.TOOL_RESULTS_FLUSH_MS) ?? DEFAULTS.toolResults.flushIntervalMs,
      batchSize: parsePositiveInt(env.TOOL_RESULTS_BATCH_SIZE) ?? DEFAULTS.toolResults.batchSize,
      fsyncPerBatch: parseBool(env.TOOL_RESULTS_FSYNC) ?? DEFAULTS.toolResults.fsyncPerBatch,
    },
    rules: {
      enabled: parseBool(env.RULES_ENABLED) ?? DEFAULTS.rules.enabled,
      dbPath: env.RULES_DB_PATH ?? DEFAULTS.rules.dbPath,
    },
  };
}

/** Interpret the `UPSTREAM_PROTOCOL` env var; anything but `anthropic` defaults to `openai`. */
function parseProtocol(value: string | undefined): UpstreamProtocol {
  return value === 'anthropic' ? 'anthropic' : 'openai';
}

function parseBool(value: string | undefined): boolean | undefined {
  if (value === undefined || value === '') return undefined;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  return undefined;
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}
