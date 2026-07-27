const assert = require('node:assert/strict');
const express = require('express');
const test = require('node:test');

const { startTestServer } = require('./test-server');

test('startTestServer binds an ephemeral IPv4 loopback listener only when invoked', async () => {
  const app = express();
  app.get('/health', (_request, response) => response.json({ status: 'ok' }));

  assert.equal(process.getActiveResourcesInfo().includes('TCPSERVERWRAP'), false);
  const testServer = await startTestServer(app);

  try {
    const url = new URL(testServer.origin);
    assert.equal(url.hostname, '127.0.0.1');
    assert.ok(Number(url.port) > 0);
    assert.equal(Number(url.port), testServer.server.address().port);
    assert.equal(testServer.server.address().address, '127.0.0.1');
    assert.equal(testServer.server.address().family, 'IPv4');

    const response = await fetch(`${testServer.origin}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'ok' });
  } finally {
    await testServer.close();
    await testServer.close();
  }

  assert.equal(testServer.server.listening, false);
});

test('startTestServer rejects fixed-port runtime options', async () => {
  const app = express();

  await assert.rejects(startTestServer({ app, host: '0.0.0.0', port: 41_234 }), /127\.0\.0\.1.*port 0/i);
});
