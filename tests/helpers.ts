/**
 * Shared per-file test boilerplate for tests/*.ts.
 *
 * These helpers were re-declared VERBATIM across multiple test files; they now live here.
 * Domain-specific fakes (e.g. `createFakeModel`, `FakeWebSocket`) and per-file fixtures are
 * intentionally left local to each test file.
 */
import type http from 'node:http';
import { createServer, type McmServer } from '../src/server/index';
import type { FetchLike } from '../src/proxy/upstream';

type ServerOpts = Parameters<typeof createServer>[1];
type MountOpts = Parameters<typeof createServer>[2];

/** Boot a full MCP server on an ephemeral port; resolves with the port, server, and mcm test handle. */
export async function startMcmServer(
  opts: ServerOpts,
  mount?: MountOpts,
): Promise<{ port: number; srv: McmServer; mcm: NonNullable<McmServer['mcm']> }> {
  const srv = createServer(0, opts, mount); // auto-listens on an ephemeral port
  await new Promise<void>((resolve, reject) => {
    if (srv.listening) resolve();
    else {
      srv.once('listening', () => resolve());
      srv.once('error', reject);
    }
  });
  const addr = srv.address();
  if (addr === null || typeof addr !== 'object') throw new Error('server did not bind a TCP port');
  const mcm = srv.mcm;
  if (mcm === undefined) throw new Error('server.mcm test handle is missing');
  return { port: addr.port, srv, mcm };
}

/** Idempotent, error-tolerant close for an MCP server. */
export async function closeMcmServer(srv: McmServer): Promise<void> {
  try {
    srv.closeAllConnections();
  } catch {
    /* ignore */
  }
  await new Promise<void>((resolve) => {
    srv.close(() => resolve());
  });
}

/** Close a raw http.Server, forcing any open connections shut. */
export async function closeHttpServer(server: http.Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

/** Build a mock upstream (fetch) that always returns a canned OpenAI response. */
export function makeMockFetch(canned: unknown): FetchLike {
  return async () =>
    new Response(JSON.stringify(canned), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
}

/** The canonical non-streaming OpenAI completion, parameterized by its `id`. */
export function oaiCanned(id: string) {
  return {
    id,
    object: 'chat.completion',
    created: 1700000000,
    model: 'gpt-4o-mini',
    choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}
