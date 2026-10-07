/** Protocol the upstream model provider speaks. */
export type UpstreamProtocol = 'openai' | 'anthropic';

/** Configuration for optional SQLite-backed tool-result persistence. */
export interface ToolResultsConfig {
  /** Enable SQLite persistence of raw tool results (default `false`). */
  enabled: boolean;
  /** Path to the SQLite database file (default `data/tool-results.db`). */
  dbPath: string;
  /** Milliseconds between batched flushes to disk (default `50`). */
  flushIntervalMs: number;
  /** Number of entries that trigger an immediate flush (default `100`). */
  batchSize: number;
  /** Whether each batch flush fsyncs (default `false`; `true` for durability over throughput). */
  fsyncPerBatch: boolean;
}

/** Configuration for optional SQLite-backed rule persistence. */
export interface RulesConfig {
  /** Enable SQLite persistence of user-created rules across restarts (default `true`). */
  enabled: boolean;
  /** Path to the SQLite database file (default `data/rules.db`; mirrors `toolResults.dbPath`). Optional. */
  dbPath?: string;
}

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
  /** Optional SQLite-backed tool-result persistence (defaults: disabled). */
  toolResults: ToolResultsConfig;
  /** Optional SQLite-backed rule persistence (defaults: enabled). */
  rules: RulesConfig;
}

/** Sensible defaults so the server boots with zero configuration. */
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

/**
 * Build a {@link Config} from environment variables, falling back to
 * {@link DEFAULTS} for anything unset.
 *
 * Recognized env vars: `PORT`, `UPSTREAM_BASE_URL`, `UPSTREAM_MODEL`,
 * `UPSTREAM_API_KEY`, `UPSTREAM_PROTOCOL`, `TOOL_RESULTS_ENABLED`,
 * `TOOL_RESULTS_DB`, `TOOL_RESULTS_FLUSH_MS`, `TOOL_RESULTS_BATCH_SIZE`,
 * `TOOL_RESULTS_FSYNC`, `RULES_ENABLED`, `RULES_DB_PATH`.
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

/** Parse a boolean env var: `'true'`/`'1'` → `true`, `'false'`/`'0'` → `false`, else `undefined`. */
function parseBool(value: string | undefined): boolean | undefined {
  if (value === undefined || value === '') return undefined;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  return undefined;
}

/** Parse a positive-integer env var; returns `undefined` for unset/invalid values. */
function parsePositiveInt(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}
