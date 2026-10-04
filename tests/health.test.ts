import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server/index';

/** GET /health should return 200 on the listening port. */
test('GET /health returns 200', async () => {
  const server = createServer(0); // port 0 -> OS-assigned

  // Wait until the server is actually listening.
  await new Promise<void>((resolve) => {
    if (server.listening) resolve();
    else server.once('listening', () => resolve());
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('server is not listening on a TCP port');
  }
  const port = address.port;

  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(res.status, 200);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
