'use strict';

const { join, resolve } = require('node:path');
const { resolveDesktopResourcePaths } = require('./resource-paths');

class DesktopPlatformAdapterError extends Error {
  constructor() {
    super('Windows protected secret and restrictive ACL adapters are required.');
    this.name = 'DesktopPlatformAdapterError';
    this.code = 'WINDOWS_PROTECTED_ADAPTERS_REQUIRED';
  }
}

class DesktopBackendHealthError extends Error {
  constructor() {
    super('Embedded backend health is unavailable.');
    this.name = 'DesktopBackendHealthError';
    this.code = 'EMBEDDED_BACKEND_HEALTH_UNAVAILABLE';
  }
}

function hasMethods(value, methods) {
  return value !== null && typeof value === 'object' && methods.every(method => typeof value[method] === 'function');
}

function validHealth(health) {
  return (
    health !== null &&
    typeof health === 'object' &&
    ['ok', 'degraded'].includes(health.status) &&
    health.components !== null &&
    typeof health.components === 'object' &&
    health.components.applicationApi !== null &&
    typeof health.components.applicationApi === 'object' &&
    health.components.applicationApi.status === 'ready'
  );
}

function createEmbeddedBackendLifecycle({
  electronApp,
  processLike = process,
  desktopDirectory = __dirname,
  fileSystem,
  platformAdapters,
  createPlatformAdapters,
  createComposition,
  resolveResourcePaths = resolveDesktopResourcePaths,
} = {}) {
  if (
    electronApp === null ||
    typeof electronApp !== 'object' ||
    typeof electronApp.getPath !== 'function' ||
    typeof electronApp.isPackaged !== 'boolean' ||
    processLike === null ||
    typeof processLike !== 'object' ||
    (createPlatformAdapters !== undefined && typeof createPlatformAdapters !== 'function') ||
    (createComposition !== undefined && typeof createComposition !== 'function') ||
    typeof resolveResourcePaths !== 'function'
  ) {
    throw new TypeError('Electron backend lifecycle dependencies are invalid');
  }

  let composition;
  let compositionStopPromise;
  let resourcePaths;
  let resolvedPlatformAdapters;
  let lifecycleState = 'created';
  let startPromise;
  let stopPromise;

  function stopCompositionOnce() {
    if (compositionStopPromise === undefined) {
      compositionStopPromise =
        composition === undefined ? Promise.resolve() : Promise.resolve().then(() => composition.stop());
    }
    return compositionStopPromise;
  }

  function assertProtectedAdapters() {
    if (
      !hasMethods(resolvedPlatformAdapters?.secretStoreAdapter, ['get', 'set', 'delete']) ||
      !hasMethods(resolvedPlatformAdapters?.filePermissions, ['restrictDirectory', 'restrictFile']) ||
      !hasMethods(resolvedPlatformAdapters?.artifactFilePermissions, ['restrictFile']) ||
      (resolvedPlatformAdapters?.reminderNotifier !== undefined &&
        !hasMethods(resolvedPlatformAdapters.reminderNotifier, ['deliver'])) ||
      typeof resolvedPlatformAdapters?.storageRoot !== 'string' ||
      resolve(resolvedPlatformAdapters.storageRoot) !== resolvedPlatformAdapters.storageRoot
    ) {
      throw new DesktopPlatformAdapterError();
    }
  }

  function createResolvedComposition() {
    const compositionFactory =
      createComposition ??
      (options => {
        const backendComposition = require(
          join(resourcePaths.backendModuleRoot, 'src', 'lifecycle', 'composition-root')
        ).createBackendComposition;
        if (typeof backendComposition !== 'function') {
          throw new TypeError('Electron backend composition is invalid');
        }
        return backendComposition(options);
      });
    const adapters = {
      artifactFilePermissions: resolvedPlatformAdapters.artifactFilePermissions,
      filePermissions: resolvedPlatformAdapters.filePermissions,
      secretStoreAdapter: resolvedPlatformAdapters.secretStoreAdapter,
    };
    if (resolvedPlatformAdapters.reminderNotifier !== undefined) {
      adapters.reminderNotifier = resolvedPlatformAdapters.reminderNotifier;
    }
    return compositionFactory({
      config: {
        mode: 'production',
        storageRoot: resolvedPlatformAdapters.storageRoot,
        applicationApi: {
          enabled: true,
          host: '127.0.0.1',
          port: 3210,
        },
        scheduler: { enabled: true },
        lanSync: { enabled: false },
      },
      adapters,
      dashboardDirectory: resourcePaths.dashboardDirectory,
    });
  }

  const lifecycle = Object.freeze({
    start() {
      if (lifecycleState === 'running') return Promise.resolve(composition);
      if (startPromise !== undefined) return startPromise;
      if (lifecycleState === 'stopping') {
        return Promise.reject(new Error('Embedded backend is stopping.'));
      }
      stopPromise = undefined;
      compositionStopPromise = undefined;
      lifecycleState = 'starting';
      startPromise = Promise.resolve()
        .then(() => {
          resourcePaths = resolveResourcePaths({
            desktopDirectory,
            electronApp,
            fileSystem,
            processLike,
          });
          resolvedPlatformAdapters = platformAdapters ?? createPlatformAdapters?.();
          assertProtectedAdapters();
          composition = createResolvedComposition();
          if (
            composition === null ||
            typeof composition !== 'object' ||
            typeof composition.start !== 'function' ||
            typeof composition.stop !== 'function' ||
            typeof composition.health !== 'function' ||
            typeof composition.getInstallAuthorization !== 'function'
          ) {
            throw new TypeError('Electron backend composition is invalid');
          }
          return composition.start();
        })
        .then(() => composition.health())
        .then(health => {
          if (!validHealth(health)) throw new DesktopBackendHealthError();
          if (lifecycleState !== 'stopping') lifecycleState = 'running';
          return composition;
        })
        .catch(async error => {
          if (lifecycleState !== 'stopping') lifecycleState = 'failed';
          await stopCompositionOnce().catch(() => undefined);
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
    getInstallAuthorization() {
      if (lifecycleState !== 'running') {
        return Promise.reject(new Error('Embedded backend is not running.'));
      }
      return Promise.resolve().then(() => composition.getInstallAuthorization());
    },
    stop() {
      if (stopPromise !== undefined) return stopPromise;
      if (lifecycleState === 'created' || lifecycleState === 'stopped') return Promise.resolve();
      lifecycleState = 'stopping';
      const waitForStart = startPromise?.catch(() => undefined) ?? Promise.resolve();
      stopPromise = waitForStart
        .then(() => stopCompositionOnce())
        .finally(() => {
          lifecycleState = 'stopped';
          startPromise = undefined;
        });
      return stopPromise;
    },
  });
  return lifecycle;
}

module.exports = {
  DesktopBackendHealthError,
  createEmbeddedBackendLifecycle,
  DesktopPlatformAdapterError,
};
