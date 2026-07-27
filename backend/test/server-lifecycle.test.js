const assert = require('node:assert/strict');
const { once } = require('node:events');
const net = require('node:net');
const test = require('node:test');

const { closeDb, getDb, resetGenAI } = require('../routes/helpers');
const { createApp, startServer } = require('../server');
const { createTestEnvironment } = require('./support/test-environment');

const runtimeEnvironmentKeys = [
  'DATABASE_PATH',
  'SETTINGS_PATH',
  'LOG_PATH',
  'EXPORT_PATH',
  'EASY_REWIND_PROFILE_USER_ID',
  'EASY_REWIND_SCHEDULERS_ENABLED',
  'GEMINI_API_KEY',
];

function captureEnvironment() {
  return Object.fromEntries(runtimeEnvironmentKeys.map(key => [key, process.env[key]]));
}

function applyEnvironment(environment) {
  Object.assign(process.env, environment.env, { GEMINI_API_KEY: '' });
}

function restoreEnvironment(previousEnvironment) {
  for (const key of runtimeEnvironmentKeys) {
    if (previousEnvironment[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnvironment[key];
  }
}

function createRateLimitedAppWithIntervals() {
  const intervals = [];
  const originalSetInterval = global.setInterval;
  global.setInterval = function (...args) {
    const interval = originalSetInterval(...args);
    intervals.push(interval);
    return interval;
  };
  try {
    return {
      app: createApp({ requestLogging: false }),
      intervals,
    };
  } finally {
    global.setInterval = originalSetInterval;
  }
}

async function closeServer(server) {
  if (!server?.listening) return;
  await new Promise((resolve, reject) => {
    server.close(error => (error ? reject(error) : resolve()));
  });
}

test('failed listen closes rate-limit intervals, app resources, and the database', async () => {
  const environment = await createTestEnvironment();
  const previousEnvironment = captureEnvironment();
  const blocker = net.createServer();
  let app;

  try {
    applyEnvironment(environment);
    blocker.listen(0, '127.0.0.1');
    await once(blocker, 'listening');
    const occupiedPort = blocker.address().port;
    const captured = createRateLimitedAppWithIntervals();
    app = captured.app;
    assert.equal(captured.intervals.length, 2);
    const originalAppClose = app.locals.close;
    let appCloseCalls = 0;
    app.locals.close = () => {
      appCloseCalls += 1;
      originalAppClose();
    };
    const originalListen = app.listen.bind(app);
    let database;
    let listenerCloseCalls = 0;
    app.listen = (...args) => {
      database = getDb();
      const listener = originalListen(...args);
      const originalClose = listener.close.bind(listener);
      listener.close = (...closeArgs) => {
        listenerCloseCalls += 1;
        return originalClose(...closeArgs);
      };
      return listener;
    };

    await assert.rejects(
      startServer({
        app,
        host: '127.0.0.1',
        port: occupiedPort,
        schedulersEnabled: false,
      }),
      error => error?.code === 'EADDRINUSE'
    );

    assert.equal(appCloseCalls, 1);
    assert.equal(listenerCloseCalls, 1);
    assert.notEqual(database, undefined);
    assert.equal(database.open, false);
    assert.equal(
      captured.intervals.every(interval => interval._destroyed === true),
      true
    );
  } finally {
    app?.locals.close?.();
    closeDb();
    resetGenAI();
    await closeServer(blocker);
    restoreEnvironment(previousEnvironment);
    await environment.cleanup();
  }
});

test('successful startup removes its temporary error listener', async () => {
  const environment = await createTestEnvironment();
  const previousEnvironment = captureEnvironment();
  let runtime;

  try {
    applyEnvironment(environment);
    runtime = await startServer({
      app: createApp({ rateLimitsEnabled: false, requestLogging: false }),
      host: '127.0.0.1',
      port: 0,
      schedulersEnabled: false,
    });

    assert.equal(runtime.server.listenerCount('error'), 0);
  } finally {
    await runtime?.close();
    closeDb();
    resetGenAI();
    restoreEnvironment(previousEnvironment);
    await environment.cleanup();
  }
});

test('runtime close cleans app and database once even when server close rejects', async () => {
  const environment = await createTestEnvironment();
  const previousEnvironment = captureEnvironment();
  let runtime;
  let closeListeningServer;
  let app;

  try {
    applyEnvironment(environment);
    app = createApp({ rateLimitsEnabled: false, requestLogging: false });
    const originalAppClose = app.locals.close;
    let appCloseCalls = 0;
    app.locals.close = () => {
      appCloseCalls += 1;
      originalAppClose();
    };
    runtime = await startServer({
      app,
      host: '127.0.0.1',
      port: 0,
      schedulersEnabled: false,
    });
    const database = getDb();
    const closeError = new Error('fixture close failure');
    closeListeningServer = runtime.server.close.bind(runtime.server);
    runtime.server.close = callback => {
      queueMicrotask(() => callback(closeError));
      return runtime.server;
    };

    await assert.rejects(runtime.close(), error => error === closeError);
    await assert.rejects(runtime.close(), error => error === closeError);

    assert.equal(appCloseCalls, 1);
    assert.equal(database.open, false);
  } finally {
    if (runtime?.server && closeListeningServer) {
      runtime.server.close = closeListeningServer;
      await closeServer(runtime.server);
    }
    app?.locals.close?.();
    closeDb();
    resetGenAI();
    restoreEnvironment(previousEnvironment);
    await environment.cleanup();
  }
});
