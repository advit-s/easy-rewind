'use strict';

const { resolve } = require('node:path');

class DesktopPlatformAdapterError extends Error {
  constructor() {
    super('Windows protected secret and restrictive ACL adapters are required.');
    this.name = 'DesktopPlatformAdapterError';
    this.code = 'WINDOWS_PROTECTED_ADAPTERS_REQUIRED';
  }
}

function hasMethods(value, methods) {
  return value !== null && typeof value === 'object' && methods.every(method => typeof value[method] === 'function');
}

function createEmbeddedBackendLifecycle({
  electronApp,
  platformAdapters,
  createPlatformAdapters,
  createComposition = options => {
    const { createBackendComposition } = require('../backend/src/lifecycle/composition-root');
    return createBackendComposition(options);
  },
} = {}) {
  if (
    electronApp === null ||
    typeof electronApp !== 'object' ||
    typeof electronApp.getPath !== 'function' ||
    (createPlatformAdapters !== undefined && typeof createPlatformAdapters !== 'function') ||
    typeof createComposition !== 'function'
  ) {
    throw new TypeError('Electron backend lifecycle dependencies are invalid');
  }

  let composition;
  let resolvedPlatformAdapters;
  let lifecycleState = 'created';
  let startPromise;
  let stopPromise;

  function assertProtectedAdapters() {
    if (
      !hasMethods(resolvedPlatformAdapters?.secretStoreAdapter, ['get', 'set', 'delete']) ||
      !hasMethods(resolvedPlatformAdapters?.filePermissions, ['restrictDirectory', 'restrictFile']) ||
      typeof resolvedPlatformAdapters?.storageRoot !== 'string' ||
      resolve(resolvedPlatformAdapters.storageRoot) !== resolvedPlatformAdapters.storageRoot
    ) {
      throw new DesktopPlatformAdapterError();
    }
  }

  const lifecycle = Object.freeze({
    start() {
      if (lifecycleState === 'running') return Promise.resolve(composition);
      if (startPromise !== undefined) return startPromise;
      stopPromise = undefined;
      lifecycleState = 'starting';
      startPromise = Promise.resolve()
        .then(() => {
          resolvedPlatformAdapters = platformAdapters ?? createPlatformAdapters?.();
          assertProtectedAdapters();
          composition = createComposition({
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
            adapters: {
              filePermissions: resolvedPlatformAdapters.filePermissions,
              secretStoreAdapter: resolvedPlatformAdapters.secretStoreAdapter,
            },
          });
          if (
            composition === null ||
            typeof composition !== 'object' ||
            typeof composition.start !== 'function' ||
            typeof composition.stop !== 'function'
          ) {
            throw new TypeError('Electron backend composition is invalid');
          }
          return composition.start();
        })
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
        .then(() => composition?.stop())
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
  createEmbeddedBackendLifecycle,
  DesktopPlatformAdapterError,
};
