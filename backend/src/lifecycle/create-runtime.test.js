'use strict';

const assert = require('node:assert/strict');
const { once } = require('node:events');
const { EventEmitter } = require('node:events');
const net = require('node:net');
const { resolve } = require('node:path');
const test = require('node:test');

function config(overrides = {}) {
  return Object.freeze({
    mode: 'test',
    paths: Object.freeze({ database: 'injected-test-database' }),
    applicationApi: Object.freeze({
      enabled: false,
      host: '127.0.0.1',
      port: 0,
      ...(overrides.applicationApi ?? {}),
    }),
    scheduler: Object.freeze({ enabled: false, ...(overrides.scheduler ?? {}) }),
    lanSync: Object.freeze({ enabled: false, ...(overrides.lanSync ?? {}) }),
  });
}

function createRecordedAdapters({ failAt = null, drainPromise = null } = {}) {
  const events = [];
  let databaseNumber = 0;
  const maybeFail = name => {
    if (failAt === name) throw Object.assign(new Error(`fixture ${name}`), { code: `FIXTURE_${name}` });
  };
  return {
    events,
    adapters: {
      version: '2.0.0',
      apiVersion: '1',
      async openDatabase() {
        events.push('database:open');
        maybeFail('database');
        databaseNumber += 1;
        const instance = databaseNumber;
        return {
          instance,
          close() {
            events.push(`database:${instance}:close`);
          },
        };
      },
      migrateDatabase() {
        events.push('database:migrate');
        maybeFail('migration');
        return { currentVersion: 3 };
      },
      createApplication({ health }) {
        events.push('application:create');
        maybeFail('application');
        const app = function fixtureApplication() {};
        app.health = health;
        app.locals = {
          close() {
            events.push('application:close');
          },
        };
        return app;
      },
      async createApplicationListener() {
        events.push('listener:start');
        maybeFail('listener');
        return {
          stopAccepting() {
            events.push('listener:stop-accepting');
          },
          async drain() {
            events.push('listener:drain');
            await drainPromise;
          },
          close() {
            events.push('listener:close');
          },
          address: Object.freeze({ address: '127.0.0.1', family: 'IPv4', port: 43210 }),
        };
      },
      createSchedulerController({ enabled }) {
        return {
          start() {
            events.push(`scheduler:start:${enabled}`);
            maybeFail('scheduler');
          },
          stop() {
            events.push('scheduler:stop');
          },
          health() {
            return { status: enabled ? 'ready' : 'disabled' };
          },
        };
      },
      createLanGateway({ enabled }) {
        return {
          start() {
            events.push(`lan:start:${enabled}`);
            maybeFail('lan');
          },
          stop() {
            events.push('lan:stop');
          },
          health() {
            return { status: enabled ? 'ready' : 'disabled' };
          },
        };
      },
      async detectLegacyMigration() {
        events.push('legacy:detect');
        return false;
      },
    },
  };
}

test('listener-disabled test runtime starts, reports sanitized health, stops, and starts again', async () => {
  const { createRuntime } = require('./create-runtime');
  const recorded = createRecordedAdapters();
  const runtime = createRuntime(config(), recorded.adapters);

  assert.equal(runtime.state(), 'created');
  await runtime.start();
  assert.equal(runtime.state(), 'running');
  const firstHealth = await runtime.health();
  assert.deepEqual(firstHealth, {
    status: 'ok',
    version: '2.0.0',
    schemaVersion: 3,
    apiVersion: '1',
    mode: 'test',
    components: {
      database: { status: 'ready' },
      applicationApi: { status: 'disabled' },
      scheduler: { status: 'disabled' },
      lanSync: { status: 'disabled' },
    },
    legacyMigrationAvailable: false,
  });
  assert.equal(JSON.stringify(firstHealth).includes('injected-test-database'), false);

  await runtime.stop();
  assert.equal(runtime.state(), 'stopped');
  await runtime.start();
  assert.equal(runtime.state(), 'running');
  await runtime.stop();
  assert.deepEqual(
    recorded.events.filter(event => event === 'database:open'),
    ['database:open', 'database:open']
  );
});

test('concurrent stop calls share one drain and close resources in the required order', async () => {
  const { createRuntime } = require('./create-runtime');
  let releaseDrain;
  const drainPromise = new Promise(resolve => {
    releaseDrain = resolve;
  });
  const recorded = createRecordedAdapters({ drainPromise });
  const runtime = createRuntime(
    config({
      applicationApi: { enabled: true, port: 3210 },
      scheduler: { enabled: true },
      lanSync: { enabled: true },
    }),
    recorded.adapters
  );
  await runtime.start();

  const firstStop = runtime.stop();
  const secondStop = runtime.stop();
  assert.equal(firstStop, secondStop);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(recorded.events.filter(event => event === 'listener:drain').length, 1);
  releaseDrain();
  await firstStop;

  assert.deepEqual(recorded.events.slice(-7), [
    'listener:stop-accepting',
    'listener:drain',
    'scheduler:stop',
    'lan:stop',
    'listener:close',
    'application:close',
    'database:1:close',
  ]);
});

test('partial startup failure rolls back started resources in reverse order and preserves the cause', async () => {
  const { createRuntime } = require('./create-runtime');
  const recorded = createRecordedAdapters({ failAt: 'lan' });
  const runtime = createRuntime(
    config({
      applicationApi: { enabled: true, port: 3210 },
      scheduler: { enabled: true },
      lanSync: { enabled: true },
    }),
    recorded.adapters
  );

  await assert.rejects(runtime.start(), error => error.code === 'FIXTURE_lan');
  assert.equal(runtime.state(), 'failed');
  assert.deepEqual(recorded.events.slice(-6), [
    'lan:start:true',
    'lan:stop',
    'scheduler:stop',
    'listener:close',
    'application:close',
    'database:1:close',
  ]);
});

test('database startup failure does not create later components', async () => {
  const { createRuntime } = require('./create-runtime');
  const recorded = createRecordedAdapters({ failAt: 'database' });
  const runtime = createRuntime(config(), recorded.adapters);

  await assert.rejects(runtime.start(), error => error.code === 'FIXTURE_database');
  assert.deepEqual(recorded.events, ['database:open']);
  assert.equal((await runtime.health()).status, 'unavailable');
});

test('health reports degraded optional components and legacy migration availability without details', async () => {
  const { createRuntime } = require('./create-runtime');
  const recorded = createRecordedAdapters();
  recorded.adapters.detectLegacyMigration = async () => true;
  recorded.adapters.createSchedulerController = () => ({
    async start() {},
    async stop() {},
    health() {
      return { status: 'degraded', privateError: 'must-not-escape' };
    },
  });
  const runtime = createRuntime(config({ scheduler: { enabled: true } }), recorded.adapters);
  await runtime.start();
  const report = await runtime.health();
  assert.equal(report.status, 'degraded');
  assert.equal(report.legacyMigrationAvailable, true);
  assert.deepEqual(report.components.scheduler, { status: 'degraded' });
  assert.equal(JSON.stringify(report).includes('must-not-escape'), false);
  await runtime.stop();
});

test('default application listener reports address conflicts and runtime closes its database', async t => {
  const blocker = net.createServer();
  blocker.listen(0, '127.0.0.1');
  await once(blocker, 'listening');
  t.after(
    () =>
      new Promise(resolve => {
        blocker.close(() => resolve());
      })
  );
  const occupiedPort = blocker.address().port;
  const events = [];
  const { createRuntime } = require('./create-runtime');
  const runtime = createRuntime(config({ applicationApi: { enabled: true, port: occupiedPort } }), {
    version: '2.0.0',
    apiVersion: '1',
    async openDatabase() {
      return {
        close() {
          events.push('database:close');
        },
      };
    },
    migrateDatabase() {
      return { currentVersion: 3 };
    },
  });

  await assert.rejects(runtime.start(), error => error.code === 'EADDRINUSE');
  assert.deepEqual(events, ['database:close']);
});

test('createApp exposes contract-valid health without opening a listener', async () => {
  const { createApp } = require('../http/create-app');
  const request = require('supertest');
  const health = Object.freeze({
    status: 'ok',
    version: '2.0.0',
    schemaVersion: 3,
    apiVersion: '1',
    mode: 'test',
    components: {
      database: { status: 'ready' },
      applicationApi: { status: 'disabled' },
      scheduler: { status: 'disabled' },
      lanSync: { status: 'disabled' },
    },
  });
  const app = createApp({ health: async () => health, generateRequestId: () => 'request-test' });

  const response = await request(app).get('/v1/health').expect(200);
  assert.deepEqual(response.body, health);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  const { validateHealthResponse } = await import('../../../packages/contracts/src/health.js');
  assert.equal(validateHealthResponse(response.body).valid, true);
  app.locals.close();
});

test('scheduler controller creates no timer while disabled and rolls back partial starts', async () => {
  const { createSchedulerController } = require('../scheduler/scheduler-controller');
  const events = [];
  const disabled = createSchedulerController({
    enabled: false,
    jobs: [],
    timers: {
      setInterval() {
        throw new Error('disabled scheduler must not allocate a timer');
      },
      clearInterval() {},
    },
  });
  await disabled.start();
  assert.deepEqual(disabled.health(), { status: 'disabled' });
  await disabled.stop();

  let allocations = 0;
  const enabled = createSchedulerController({
    enabled: true,
    jobs: [
      { name: 'first', intervalMs: 1_000, run() {} },
      { name: 'second', intervalMs: 1_000, run() {} },
    ],
    timers: {
      setInterval() {
        allocations += 1;
        if (allocations === 2) throw new Error('fixture timer failure');
        return { id: allocations };
      },
      clearInterval(timer) {
        events.push(`clear:${timer.id}`);
      },
    },
  });
  await assert.rejects(enabled.start(), /fixture timer failure/);
  assert.deepEqual(events, ['clear:1']);
});

test('standalone lifecycle owns signal handlers and routes shutdown through the shared runtime', async () => {
  const { startStandalone } = require('./start-standalone');
  const { createRuntime } = require('./create-runtime');
  const signalSource = new EventEmitter();
  signalSource.exitCode = 0;
  const messages = [];
  const recorded = createRecordedAdapters();
  const composition = createRuntime(config(), recorded.adapters);
  const standalone = await startStandalone({
    composition,
    signalSource,
    logger: {
      info(message) {
        messages.push(message);
      },
      error(message) {
        messages.push(message);
      },
    },
  });
  assert.equal(standalone.runtime.state(), 'running');
  assert.equal(signalSource.listenerCount('SIGINT'), 1);
  assert.equal(signalSource.listenerCount('SIGTERM'), 1);

  signalSource.emit('SIGTERM');
  await standalone.shutdown();
  assert.equal(standalone.runtime.state(), 'stopped');
  standalone.disposeSignals();
  assert.equal(signalSource.listenerCount('SIGINT'), 0);
  assert.equal(signalSource.listenerCount('SIGTERM'), 0);
  assert.deepEqual(messages, ['Easy Rewind backend is ready.']);
});

test('standalone lifecycle passes dashboard configuration separately into composition', async () => {
  const { startStandalone } = require('./start-standalone');
  const signalSource = new EventEmitter();
  signalSource.exitCode = 0;
  const dashboardDirectory = resolve(__dirname, '..', '..', '..', 'frontend');
  const standaloneConfig = { mode: 'standalone' };
  const platformAdapters = { marker: 'exact-adapter-object' };
  const calls = [];
  const runtime = {
    async start() {
      calls.push('start');
    },
    async stop() {
      calls.push('stop');
    },
  };

  const standalone = await startStandalone({
    adapters: platformAdapters,
    config: standaloneConfig,
    dashboardDirectory,
    createComposition(options) {
      calls.push(options);
      return runtime;
    },
    signalSource,
    logger: { error: assert.fail, info() {} },
  });

  assert.equal(calls[0].adapters, platformAdapters);
  assert.equal(calls[0].config, standaloneConfig);
  assert.equal(calls[0].dashboardDirectory, dashboardDirectory);
  assert.deepEqual(calls.slice(1), ['start']);
  await standalone.shutdown();
  standalone.disposeSignals();
  assert.deepEqual(calls.slice(1), ['start', 'stop']);
});
