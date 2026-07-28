'use strict';

const { dirname } = require('node:path');
const { createBrowserSessionService } = require('../auth/browser-session-service');
const { createInstallTokenService } = require('../auth/install-token-service');
const { createPairingService } = require('../auth/pairing-service');
const { createConfig } = require('../config/create-config');
const { createApp } = require('../http/create-app');
const { createSecretStore } = require('../platform/secret-store');
const { createRuntime } = require('./create-runtime');

function requireAdapter(value, methods, message) {
  if (value === null || typeof value !== 'object' || methods.some(method => typeof value[method] !== 'function')) {
    throw new TypeError(message);
  }
  return value;
}

async function createCanonicalRouteDependencies({ database, secretStore, serviceFactories = {} } = {}) {
  requireAdapter(database, ['prepare', 'transaction'], 'A canonical database is required');
  requireAdapter(secretStore, ['get', 'set', 'delete'], 'A protected secret store is required');
  const installFactory = serviceFactories.createInstallTokenService ?? createInstallTokenService;
  const browserFactory = serviceFactories.createBrowserSessionService ?? createBrowserSessionService;
  const pairingFactory = serviceFactories.createPairingService ?? createPairingService;
  for (const factory of [installFactory, browserFactory, pairingFactory]) {
    if (typeof factory !== 'function') throw new TypeError('Authentication service factories are invalid');
  }

  const installTokenService = await installFactory({ db: database, secretStore });
  const browserSessionService = await browserFactory({ db: database, secretStore });
  const pairingService = await pairingFactory({ db: database, secretStore });
  return Object.freeze({
    browserSessionService,
    installTokenService,
    pairingService,
  });
}

function storageDirectories(config) {
  return [
    config.storageRoot,
    dirname(config.paths.database),
    dirname(config.paths.settings),
    dirname(config.paths.runtimeState),
    config.paths.logs,
    config.paths.exports,
    config.paths.backups,
    config.paths.migrationWork,
  ].filter((path, index, paths) => paths.indexOf(path) === index);
}

async function prepareCanonicalStorage(config, filePermissions) {
  const { mkdir } = require('node:fs/promises');
  for (const directory of storageDirectories(config)) {
    await mkdir(directory, { recursive: true });
    await filePermissions.restrictDirectory(directory);
  }
}

function defaultMigrateDatabase(database) {
  const { discoverMigrations, runMigrations } = require('../database/migration-runner');
  return runMigrations({ db: database, migrations: discoverMigrations() });
}

function createBackendComposition({ config: configInput, adapters = {} } = {}) {
  if (adapters === null || typeof adapters !== 'object' || Array.isArray(adapters)) {
    throw new TypeError('Composition adapters are invalid');
  }
  const secretStoreAdapter = requireAdapter(
    adapters.secretStoreAdapter,
    ['get', 'set', 'delete'],
    'A protected secret-store adapter is required'
  );
  const filePermissions = requireAdapter(
    adapters.filePermissions,
    ['restrictDirectory', 'restrictFile'],
    'A restrictive file-permission adapter is required'
  );
  const config = createConfig(configInput);
  const secretStore = createSecretStore(secretStoreAdapter);
  const migrateDatabase = adapters.migrateDatabase ?? defaultMigrateDatabase;
  const createRouteDependencies =
    adapters.createRouteDependencies ??
    (options =>
      createCanonicalRouteDependencies({
        ...options,
        serviceFactories: adapters.serviceFactories,
      }));
  const applicationFactory = adapters.createApplication ?? createApp;
  const prepareStorage = adapters.prepareStorage ?? prepareCanonicalStorage;
  for (const operation of [migrateDatabase, createRouteDependencies, applicationFactory, prepareStorage]) {
    if (typeof operation !== 'function') throw new TypeError('Composition factory adapters are invalid');
  }

  let routeDependencies;
  const runtime = createRuntime(config, {
    ...adapters,
    filePermissions,
    async migrateDatabase(database) {
      const migration = await migrateDatabase(database);
      routeDependencies = await createRouteDependencies({ database, secretStore });
      if (routeDependencies === null || typeof routeDependencies !== 'object') {
        throw new TypeError('Route dependencies are invalid');
      }
      return migration;
    },
    createApplication({ database, health }) {
      if (routeDependencies === undefined) {
        throw new TypeError('Route dependencies must be constructed before the application');
      }
      return applicationFactory({
        database,
        health,
        routeDependencies,
      });
    },
  });

  let lifecycleState = 'created';
  let startPromise;
  let stopPromise;

  const composition = Object.freeze({
    config,
    health: runtime.health,
    start() {
      if (lifecycleState === 'running') return Promise.resolve(composition);
      if (startPromise !== undefined) return startPromise;
      if (lifecycleState === 'stopping') {
        return Promise.reject(new Error('Backend composition is stopping.'));
      }
      stopPromise = undefined;
      lifecycleState = 'starting';
      startPromise = Promise.resolve()
        .then(() => prepareStorage(config, filePermissions))
        .then(() => runtime.start())
        .then(() => {
          lifecycleState = 'running';
          return composition;
        })
        .catch(error => {
          lifecycleState = 'failed';
          throw error;
        })
        .finally(() => {
          startPromise = undefined;
        });
      return startPromise;
    },
    state() {
      return lifecycleState;
    },
    stop() {
      if (stopPromise !== undefined) return stopPromise;
      if (lifecycleState === 'created' || lifecycleState === 'stopped') return Promise.resolve();
      lifecycleState = 'stopping';
      const waitForStart = startPromise?.catch(() => undefined) ?? Promise.resolve();
      stopPromise = waitForStart
        .then(() => runtime.stop())
        .finally(() => {
          lifecycleState = 'stopped';
          startPromise = undefined;
        });
      return stopPromise;
    },
  });
  return composition;
}

module.exports = {
  createBackendComposition,
  createCanonicalRouteDependencies,
  prepareCanonicalStorage,
};
