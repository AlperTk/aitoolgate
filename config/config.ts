import * as os from 'node:os';
import * as path from 'node:path';

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
  toolResults: ToolResultsConfig;
  rules: RulesConfig;
  /** Optional case-insensitive regex patterns (`TOOL_ERROR_PATTERNS`) that mark a tool result as a failure; additive to the built-in heuristic. */
  toolErrorPatterns: string[];
}

/** Default DB files live under the OS user home (cwd-independent). */
const DEFAULT_DB_DIR = path.join(os.homedir(), '.aitoolgate');

const DEFAULTS: Config = {
  port: 8787,
  toolResults: {
    enabled: false,
    dbPath: path.join(DEFAULT_DB_DIR, 'tool-results.db'),
    flushIntervalMs: 50,
    batchSize: 100,
    fsyncPerBatch: false,
  },
  rules: {
    enabled: true,
    dbPath: path.join(DEFAULT_DB_DIR, 'rules.db'),
  },
  toolErrorPatterns: [],
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
    toolErrorPatterns: parseStringList(env.TOOL_ERROR_PATTERNS),
  };
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

/** Parse a comma-separated env value into a trimmed, non-empty string list (`[]` when unset/blank). */
function parseStringList(value: string | undefined): string[] {
  if (value === undefined || value.trim() === '') return [];
  return value.split(',').map((entry) => entry.trim()).filter((entry) => entry !== '');
}
