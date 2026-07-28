'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const test = require('node:test');

function createSecretStoreAdapter() {
  const values = new Map();
  return {
    async delete(name) {
      values.delete(name);
    },
    async get(name) {
      return values.get(name) ?? null;
    },
    async set(name, value) {
      values.set(name, value);
    },
  };
}

function modeConfig(mode, storageRoot) {
  return {
    mode,
    storageRoot,
    repositoryRoot: resolve(__dirname, '..', '..', '..'),
    applicationApi: {
      enabled: mode !== 'test',
      host: '127.0.0.1',
      port: mode === 'test' ? 0 : 3210,
    },
    scheduler: { enabled: false },
    lanSync: { enabled: false },
  };
}

function createSmokeAdapters(events) {
  const filePermissions = {
    async restrictDirectory(path) {
      events.push(`permissions:directory:${path}`);
    },
    async restrictFile() {},
  };
  return {
    filePermissions,
    secretStoreAdapter: createSecretStoreAdapter(),
    async openDatabase() {
      events.push('database:open');
      return {
        close() {
          events.push('database:close');
        },
      };
    },
    migrateDatabase() {
      events.push('database:migrate');
      return { currentVersion: 3 };
    },
    async createRouteDependencies({ database, secretStore }) {
      assert.equal(typeof database.close, 'function');
      assert.equal(typeof secretStore.get, 'function');
      events.push('routes:dependencies');
      return Object.freeze({});
    },
    createApplication({ health, routeDependencies }) {
      assert.deepEqual(routeDependencies, {});
      events.push('application:create');
      const app = function smokeApp() {};
      app.locals = { close: () => events.push('application:close') };
      app.health = health;
      return app;
    },
    async createApplicationListener({ host, port }) {
      events.push(`listener:start:${host}:${port}`);
      return {
        address: { address: host, family: 'IPv4', port },
        close() {
          events.push('listener:close');
        },
        drain() {
          events.push('listener:drain');
        },
        stopAccepting() {
          events.push('listener:stop-accepting');
        },
      };
    },
    createSchedulerController({ enabled }) {
      return {
        health: () => ({ status: enabled ? 'ready' : 'disabled' }),
        start: () => events.push(`scheduler:start:${enabled}`),
        stop: () => events.push('scheduler:stop'),
      };
    },
  };
}

for (const mode of ['production', 'standalone', 'test']) {
  test(`${mode} uses the canonical composition and lifecycle`, async t => {
    const storageRoot = mkdtempSync(join(tmpdir(), `easy-rewind-composition-${mode}-`));
    t.after(() => rmSync(storageRoot, { force: true, recursive: true }));
    const events = [];
    const { createBackendComposition } = require('./composition-root');
    const composition = createBackendComposition({
      config: modeConfig(mode, storageRoot),
      adapters: createSmokeAdapters(events),
    });

    assert.equal(composition.config.mode, mode);
    assert.equal(composition.state(), 'created');
    await composition.start();
    assert.equal(composition.state(), 'running');
    assert.equal(composition.health().mode, mode);
    assert.equal(events.includes('routes:dependencies'), true);
    assert.equal(
      events.some(event => event.startsWith('listener:start:')),
      mode !== 'test'
    );
    await composition.stop();
    assert.equal(composition.state(), 'stopped');
  });
}

test('canonical route dependencies construct every authentication service from the same database and secret store', async () => {
  const calls = [];
  const database = { prepare() {}, transaction() {} };
  const secretStore = createSecretStoreAdapter();
  const serviceFactories = {
    async createInstallTokenService(input) {
      calls.push(['install', input]);
      return { authenticate() {} };
    },
    async createBrowserSessionService(input) {
      calls.push(['browser', input]);
      return { authenticate() {}, exchange() {} };
    },
    async createPairingService(input) {
      calls.push(['pairing', input]);
      return { authenticateDevice() {} };
    },
  };
  const { createCanonicalRouteDependencies } = require('./composition-root');
  const dependencies = await createCanonicalRouteDependencies({
    database,
    secretStore,
    serviceFactories,
  });

  assert.deepEqual(Object.keys(dependencies).sort(), [
    'browserSessionService',
    'installTokenService',
    'pairingService',
  ]);
  assert.deepEqual(
    calls.map(([name]) => name),
    ['install', 'browser', 'pairing']
  );
  for (const [, input] of calls) {
    assert.equal(input.db, database);
    assert.equal(input.secretStore, secretStore);
  }
});

test('composition refuses missing protected secret and restrictive permission adapters', () => {
  const storageRoot = mkdtempSync(join(tmpdir(), 'easy-rewind-composition-required-adapters-'));
  try {
    const { createBackendComposition } = require('./composition-root');
    assert.throws(
      () =>
        createBackendComposition({
          config: modeConfig('production', storageRoot),
          adapters: {},
        }),
      /protected secret-store adapter is required/i
    );
    assert.throws(
      () =>
        createBackendComposition({
          config: modeConfig('production', storageRoot),
          adapters: { secretStoreAdapter: createSecretStoreAdapter() },
        }),
      /restrictive file-permission adapter is required/i
    );
  } finally {
    rmSync(storageRoot, { force: true, recursive: true });
  }
});

test('standalone signals stop and dispose the canonical composition exactly once', async () => {
  const signalSource = new EventEmitter();
  signalSource.exitCode = 0;
  const events = [];
  const composition = {
    state: () => (events.includes('stop') ? 'stopped' : 'running'),
    start: async () => {
      events.push('start');
    },
    stop: async () => {
      events.push('stop');
    },
  };
  const { startStandalone } = require('./start-standalone');
  const standalone = await startStandalone({
    composition,
    signalSource,
    logger: { error() {}, info() {} },
  });

  signalSource.emit('SIGINT');
  await standalone.shutdown();
  await standalone.shutdown();
  standalone.disposeSignals();
  assert.deepEqual(events, ['start', 'stop']);
  assert.equal(signalSource.listenerCount('SIGINT'), 0);
  assert.equal(signalSource.listenerCount('SIGTERM'), 0);
});
