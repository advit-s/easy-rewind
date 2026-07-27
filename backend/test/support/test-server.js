const assert = require('node:assert/strict');

async function startTestServer(appOrRuntime) {
  const runtime = typeof appOrRuntime === 'function' ? { app: appOrRuntime } : appOrRuntime;
  assert.equal(typeof runtime?.app, 'function', 'startTestServer requires an Express app or runtime with an app');
  assert.equal(
    runtime.host === undefined || runtime.host === '127.0.0.1',
    true,
    'test servers must bind only 127.0.0.1 with port 0'
  );
  assert.equal(
    runtime.port === undefined || runtime.port === 0,
    true,
    'test servers must bind only 127.0.0.1 with port 0'
  );

  const server = await new Promise((resolve, reject) => {
    const listener = runtime.app.listen(0, '127.0.0.1', () => resolve(listener));
    listener.once('error', reject);
  });
  const address = server.address();
  assert.equal(typeof address, 'object');
  assert.equal(address.address, '127.0.0.1');
  assert.equal(address.family, 'IPv4');
  let closePromise;

  return {
    server,
    origin: `http://127.0.0.1:${address.port}`,
    close() {
      if (!closePromise) {
        closePromise = server.listening
          ? new Promise((resolve, reject) => {
              server.close(error => (error ? reject(error) : resolve()));
            })
          : Promise.resolve();
      }
      return closePromise;
    },
  };
}

module.exports = { startTestServer };
