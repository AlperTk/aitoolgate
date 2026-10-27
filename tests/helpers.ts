/**
 * Shared per-file test boilerplate for tests/*.ts.
 *
 * These helpers were re-declared VERBATIM across multiple test files; they now live here.
 * Domain-specific fakes (e.g. `createFakeModel`, `FakeWebSocket`) and per-file fixtures are
 * intentionally left local to each test file.
 */
import http from 'node:http';
import { createServer, type AtgServer } from '../src/server/index';
import { createProxyHandler, type ProxyOptions } from '../src/proxy/index';
import type { FetchLike } from '../src/proxy/upstream';

type ServerOpts = Parameters<typeof createServer>[1];
type MountOpts = Parameters<typeof createServer>[2];

/** Boot a full MCP server on an ephemeral port; resolves with the port, server, and atg test handle. */
export async function startAtgServer(
  opts: ServerOpts,
  mount?: MountOpts,
): Promise<{ port: number; srv: AtgServer; atg: NonNullable<AtgServer['atg']> }> {
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
  const atg = srv.atg;
  if (atg === undefined) throw new Error('server.atg test handle is missing');
  return { port: addr.port, srv, atg };
}

/** Idempotent, error-tolerant close for an MCP server. */
export async function closeAtgServer(srv: AtgServer): Promise<void> {
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

/** Bind a server to an ephemeral TCP port (port 0); resolves once listening. */
function listenEphemeral(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    if (server.listening) {
      resolve();
      return;
    }
    server.once('listening', () => resolve());
    server.listen(0);
  });
}

function portOfServer(server: http.Server): number {
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('server is not listening on a TCP port');
  return address.port;
}

/** A canned upstream model: records each parsed JSON request body and replies with the current canned body. */
export interface FakeModel {
  server: http.Server;
  port: number;
  requests: unknown[];
  setCanned(canned: unknown): void;
  close(): Promise<void>;
}

/** Start a canned upstream on an ephemeral port. Non-JSON bodies are not recorded. */
export async function createFakeModel(initialCanned: unknown): Promise<FakeModel> {
  const requests: unknown[] = [];
  let current = initialCanned;
  const server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (chunk: Buffer) => {
      data += chunk;
    });
    req.on('end', () => {
      if (data !== '') {
        try {
          requests.push(JSON.parse(data));
        } catch {
          /* non-JSON body: nothing to record */
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(current));
    });
  });
  await listenEphemeral(server);
  return {
    server,
    port: portOfServer(server),
    requests,
    setCanned: (canned: unknown) => {
      current = canned;
    },
    close: () => closeHttpServer(server),
  };
}

/** Start a proxy HTTP server on an ephemeral port. Unhandled requests get 404; handler errors get a generic 500. */
export async function startProxy(options: ProxyOptions): Promise<{ server: http.Server; port: number }> {
  const handler = createProxyHandler(options);
  const server = http.createServer((req, res) => {
    void handler(req, res).then(
      (handled) => {
        if (!handled) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'not_found' }));
        }
      },
      () => {
        if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
        // Never expose err.message to clients; mirrors src/server/index.ts.
        res.end(JSON.stringify({ error: 'internal_error' }));
      },
    );
  });
  await listenEphemeral(server);
  return { server, port: portOfServer(server) };
}
