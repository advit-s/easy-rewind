'use strict';

const { createApp: defaultCreateApp } = require('../http/create-app');
const { createSchedulerController: defaultCreateSchedulerController } = require('../scheduler/scheduler-controller');

function assertFunction(value, name) {
  if (typeof value !== 'function') throw new TypeError(`${name} adapter is required`);
  return value;
}

function validateConfig(config) {
  if (
    config === null ||
    typeof config !== 'object' ||
    !['production', 'standalone', 'test'].includes(config.mode) ||
    config.paths === null ||
    typeof config.paths !== 'object' ||
    config.applicationApi === null ||
    typeof config.applicationApi !== 'object' ||
    typeof config.applicationApi.enabled !== 'boolean' ||
    config.scheduler === null ||
    typeof config.scheduler !== 'object' ||
    typeof config.scheduler.enabled !== 'boolean' ||
    config.lanSync === null ||
    typeof config.lanSync !== 'object' ||
    typeof config.lanSync.enabled !== 'boolean'
  ) {
    throw new TypeError('Runtime configuration is invalid');
  }
}

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function safeComponentHealth(controller, fallback) {
  if (controller === null || controller === undefined || typeof controller.health !== 'function') {
    return { status: fallback };
  }
  try {
    const report = controller.health();
    if (
      report !== null &&
      typeof report === 'object' &&
      ['ready', 'degraded', 'unavailable', 'disabled'].includes(report.status)
    ) {
      return { status: report.status };
    }
  } catch {
    // Health reports remain safe and do not expose component failures.
  }
  return { status: 'unavailable' };
}

function defaultLanGateway({ enabled }) {
  let running = false;
  return Object.freeze({
    async start() {
      if (enabled) throw new TypeError('Enabled LAN sync requires an injected gateway');
      running = false;
    },
    async stop() {
      running = false;
    },
    health() {
      return Object.freeze({ status: enabled ? (running ? 'ready' : 'unavailable') : 'disabled' });
    },
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(error => (error ? reject(error) : resolve()));
  });
}

async function createNodeApplicationListener({ app, host, port, drainTimeoutMs = 5_000 }) {
  if (
    typeof app !== 'function' ||
    typeof host !== 'string' ||
    !Number.isInteger(port) ||
    port < 0 ||
    port > 65_535 ||
    !Number.isSafeInteger(drainTimeoutMs) ||
    drainTimeoutMs < 1
  ) {
    throw new TypeError('Application listener configuration is invalid');
  }
  let server;
  await new Promise((resolve, reject) => {
    const onError = error => {
      server?.removeListener('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve();
    };
    try {
      server = app.listen(port, host);
      server.once('error', onError);
      server.once('listening', onListening);
    } catch (error) {
      reject(error);
    }
  });
  const rawAddress = server.address();
  const address =
    rawAddress !== null && typeof rawAddress === 'object'
      ? Object.freeze({
          address: rawAddress.address,
          family: rawAddress.family,
          port: rawAddress.port,
        })
      : Object.freeze({ address: host, family: 'unknown', port });
  let closePromise;

  function stopAccepting() {
    if (closePromise === undefined) closePromise = closeServer(server);
    return closePromise;
  }

  async function drain() {
    const closing = stopAccepting();
    let timeout;
    const timedOut = new Promise(resolve => {
      timeout = setTimeout(() => resolve(true), drainTimeoutMs);
      timeout.unref?.();
    });
    if ((await Promise.race([closing.then(() => false), timedOut])) === true) {
      server.closeIdleConnections?.();
      server.closeAllConnections?.();
      await closing;
    }
    clearTimeout(timeout);
  }

  return Object.freeze({
    address,
    close: stopAccepting,
    drain,
    stopAccepting,
  });
}

function createRuntime(config, adapters = {}) {
  validateConfig(config);
  if (adapters === null || typeof adapters !== 'object') throw new TypeError('Runtime adapters are invalid');
  const openDatabase =
    adapters.openDatabase ??
    (async options => {
      const { openDatabase: openCanonicalDatabase } = require('../database/open-database');
      return openCanonicalDatabase(options);
    });
  const migrateDatabase =
    adapters.migrateDatabase ??
    (database => {
      const { discoverMigrations, runMigrations } = require('../database/migration-runner');
      return runMigrations({ db: database, migrations: discoverMigrations() });
    });
  const createApplication = adapters.createApplication ?? defaultCreateApp;
  const createApplicationListener = adapters.createApplicationListener ?? createNodeApplicationListener;
  const createSchedulerController = adapters.createSchedulerController ?? defaultCreateSchedulerController;
  const createLanGateway = adapters.createLanGateway ?? defaultLanGateway;
  const detectLegacyMigration = adapters.detectLegacyMigration ?? (async () => false);
  for (const [name, adapter] of Object.entries({
    openDatabase,
    migrateDatabase,
    createApplication,
    createApplicationListener,
    createSchedulerController,
    createLanGateway,
    detectLegacyMigration,
  })) {
    assertFunction(adapter, name);
  }
  const version = adapters.version ?? '2.0.0';
  const apiVersion = adapters.apiVersion ?? '1';
  if (
    typeof version !== 'string' ||
    !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(version) ||
    typeof apiVersion !== 'string' ||
    !/^[1-9][0-9]*$/.test(apiVersion)
  ) {
    throw new TypeError('Runtime version configuration is invalid');
  }

  let lifecycleState = 'created';
  let startPromise;
  let stopPromise;
  let database;
  let application;
  let listener;
  let scheduler;
  let lanGateway;
  let schemaVersion = 0;
  let legacyMigrationAvailable = false;

  function health() {
    const databaseStatus = database !== undefined && lifecycleState === 'running' ? 'ready' : 'unavailable';
    const applicationStatus = !config.applicationApi.enabled
      ? 'disabled'
      : listener !== undefined && lifecycleState === 'running'
        ? 'ready'
        : 'unavailable';
    const components = {
      database: { status: databaseStatus },
      applicationApi: { status: applicationStatus },
      scheduler: safeComponentHealth(scheduler, config.scheduler.enabled ? 'unavailable' : 'disabled'),
      lanSync: safeComponentHealth(lanGateway, config.lanSync.enabled ? 'unavailable' : 'disabled'),
    };
    const statuses = Object.values(components).map(component => component.status);
    const requiredUnavailable = databaseStatus === 'unavailable' || applicationStatus === 'unavailable';
    const status = requiredUnavailable
      ? 'unavailable'
      : statuses.includes('unavailable') || statuses.includes('degraded')
        ? 'degraded'
        : 'ok';
    return deepFreeze({
      status,
      version,
      schemaVersion,
      apiVersion,
      mode: config.mode,
      components,
      legacyMigrationAvailable,
    });
  }

  async function cleanupStartup() {
    if (lanGateway !== undefined) {
      try {
        await lanGateway.stop();
      } catch {
        // Preserve the startup failure.
      }
    }
    if (scheduler !== undefined) {
      try {
        await scheduler.stop();
      } catch {
        // Preserve the startup failure.
      }
    }
    if (listener !== undefined) {
      try {
        await listener.close();
      } catch {
        // Preserve the startup failure.
      }
    }
    if (application !== undefined) {
      try {
        await application.locals?.close?.();
      } catch {
        // Preserve the startup failure.
      }
    }
    if (database !== undefined) {
      try {
        await database.close();
      } catch {
        // Preserve the startup failure.
      }
    }
    database = undefined;
    application = undefined;
    listener = undefined;
    scheduler = undefined;
    lanGateway = undefined;
  }

  async function performStart() {
    lifecycleState = 'starting';
    schemaVersion = 0;
    legacyMigrationAvailable = false;
    try {
      database = await openDatabase({
        path: config.paths.database,
        filePermissions: adapters.filePermissions,
      });
      const migration = await migrateDatabase(database);
      if (
        migration === null ||
        typeof migration !== 'object' ||
        !Number.isSafeInteger(migration.currentVersion) ||
        migration.currentVersion < 0
      ) {
        throw new TypeError('Migration result is invalid');
      }
      schemaVersion = migration.currentVersion;
      legacyMigrationAvailable = (await detectLegacyMigration()) === true;
      application = createApplication({ database, health });
      if (typeof application !== 'function') throw new TypeError('Application adapter returned an invalid app');
      if (config.applicationApi.enabled) {
        listener = await createApplicationListener({
          app: application,
          host: config.applicationApi.host,
          port: config.applicationApi.port,
        });
      }
      scheduler = createSchedulerController({
        enabled: config.scheduler.enabled,
        jobs: adapters.schedulerJobs ?? [],
        timers: adapters.timers,
      });
      await scheduler.start();
      lanGateway = createLanGateway({
        config: config.lanSync,
        database,
        enabled: config.lanSync.enabled,
      });
      await lanGateway.start();
      lifecycleState = 'running';
      return runtime;
    } catch (error) {
      await cleanupStartup();
      lifecycleState = 'failed';
      throw error;
    } finally {
      startPromise = undefined;
    }
  }

  function start() {
    if (lifecycleState === 'running') return Promise.resolve(runtime);
    if (startPromise !== undefined) return startPromise;
    if (lifecycleState === 'stopping') return Promise.reject(new Error('Runtime is stopping.'));
    stopPromise = undefined;
    startPromise = performStart();
    return startPromise;
  }

  async function performStop() {
    lifecycleState = 'stopping';
    let firstError;
    const attempt = async operation => {
      try {
        await operation();
      } catch (error) {
        firstError ??= error;
      }
    };
    if (listener !== undefined) {
      await attempt(() => listener.stopAccepting());
      await attempt(() => listener.drain({ timeoutMs: 5_000 }));
    }
    if (scheduler !== undefined) await attempt(() => scheduler.stop());
    if (lanGateway !== undefined) await attempt(() => lanGateway.stop());
    if (listener !== undefined) await attempt(() => listener.close());
    if (application !== undefined) await attempt(() => application.locals?.close?.());
    if (database !== undefined) await attempt(() => database.close());

    database = undefined;
    application = undefined;
    listener = undefined;
    scheduler = undefined;
    lanGateway = undefined;
    lifecycleState = 'stopped';
    startPromise = undefined;
    if (firstError) throw firstError;
  }

  function stop() {
    if (stopPromise !== undefined) return stopPromise;
    if (lifecycleState === 'created' || lifecycleState === 'stopped') return Promise.resolve();
    if (lifecycleState === 'starting' && startPromise !== undefined) {
      stopPromise = startPromise.then(performStop, () => undefined);
    } else if (lifecycleState === 'failed') {
      lifecycleState = 'stopped';
      stopPromise = Promise.resolve();
    } else {
      stopPromise = performStop();
    }
    return stopPromise;
  }

  const runtime = Object.freeze({
    health,
    start,
    state: () => lifecycleState,
    stop,
  });
  return runtime;
}

module.exports = { createNodeApplicationListener, createRuntime };
