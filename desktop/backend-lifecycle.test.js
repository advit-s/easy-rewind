'use strict';

const assert = require('node:assert/strict');
const { resolve } = require('node:path');
const test = require('node:test');

const READY_HEALTH = Object.freeze({
  status: 'ok',
  components: Object.freeze({
    applicationApi: Object.freeze({ status: 'ready' }),
  }),
});

function protectedPlatformAdapters(overrides = {}) {
  return {
    storageRoot: 'C:\\Users\\fixture\\AppData\\Local\\easy-rewind\\runtime',
    filePermissions: {
      restrictDirectory() {},
      restrictFile() {},
    },
    artifactFilePermissions: {
      restrictFile() {},
    },
    secretStoreAdapter: {
      delete() {},
      get() {},
      set() {},
    },
    ...overrides,
  };
}

test('embedded backend lifecycle starts and stops one production composition idempotently', async () => {
  const events = [];
  const composition = {
    async getInstallAuthorization() {
      return 'Bearer lifecycle-fixture';
    },
    health() {
      return READY_HEALTH;
    },
    async start() {
      events.push('composition:start');
    },
    async stop() {
      events.push('composition:stop');
    },
  };
  const createComposition = options => {
    events.push(['composition:create', options]);
    return composition;
  };
  const platformAdapters = protectedPlatformAdapters();
  const { createEmbeddedBackendLifecycle } = require('./backend-lifecycle');
  const lifecycle = createEmbeddedBackendLifecycle({
    createComposition,
    electronApp: {
      isPackaged: false,
      getPath(name) {
        assert.fail(`Electron path fallback must not be used: ${name}`);
      },
    },
    platformAdapters,
  });

  const firstStart = lifecycle.start();
  const secondStart = lifecycle.start();
  assert.equal(firstStart, secondStart);
  await firstStart;
  assert.equal(lifecycle.state(), 'running');

  const firstStop = lifecycle.stop();
  const secondStop = lifecycle.stop();
  assert.equal(firstStop, secondStop);
  await firstStop;
  assert.equal(lifecycle.state(), 'stopped');
  assert.deepEqual(
    events.filter(event => typeof event === 'string'),
    ['composition:start', 'composition:stop']
  );
  const [, options] = events[0];
  assert.equal(options.config.mode, 'production');
  assert.equal(options.config.storageRoot, platformAdapters.storageRoot);
  assert.equal(options.adapters.filePermissions, platformAdapters.filePermissions);
  assert.equal(options.adapters.artifactFilePermissions, platformAdapters.artifactFilePermissions);
  assert.equal(options.adapters.secretStoreAdapter, platformAdapters.secretStoreAdapter);
  assert.equal(options.dashboardDirectory, resolve(__dirname, '..', 'frontend'));
  assert.equal(Object.hasOwn(options.config, 'dashboardDirectory'), false);
  assert.equal(Object.hasOwn(options.adapters, 'dashboardDirectory'), false);
});

test('embedded lifecycle forwards an optional desktop reminder notifier unchanged', async () => {
  const reminderNotifier = Object.freeze({
    async deliver() {},
  });
  let compositionOptions;
  const composition = {
    getInstallAuthorization() {},
    health: () => READY_HEALTH,
    async start() {},
    async stop() {},
  };
  const { createEmbeddedBackendLifecycle } = require('./backend-lifecycle');
  const lifecycle = createEmbeddedBackendLifecycle({
    createComposition(options) {
      compositionOptions = options;
      return composition;
    },
    electronApp: { getPath() {}, isPackaged: false },
    platformAdapters: protectedPlatformAdapters({ reminderNotifier }),
  });

  await lifecycle.start();

  assert.equal(compositionOptions.adapters.reminderNotifier, reminderNotifier);
  assert.deepEqual(Object.keys(compositionOptions.adapters).sort(), [
    'artifactFilePermissions',
    'filePermissions',
    'reminderNotifier',
    'secretStoreAdapter',
  ]);
  await lifecycle.stop();
});

test('embedded lifecycle rejects a malformed optional reminder notifier before composition', async () => {
  let compositionCalls = 0;
  const { createEmbeddedBackendLifecycle, DesktopPlatformAdapterError } = require('./backend-lifecycle');
  const lifecycle = createEmbeddedBackendLifecycle({
    createComposition() {
      compositionCalls += 1;
    },
    electronApp: { getPath() {}, isPackaged: false },
    platformAdapters: protectedPlatformAdapters({ reminderNotifier: { deliver: 'not-a-function' } }),
  });

  await assert.rejects(lifecycle.start(), error => error instanceof DesktopPlatformAdapterError);
  assert.equal(compositionCalls, 0);
});

test('embedded backend lifecycle retrieves install authorization only while running without retaining it', async () => {
  const issued = ['Bearer first-sensitive-value', 'Bearer second-sensitive-value'];
  let authorizationReads = 0;
  const composition = {
    async getInstallAuthorization() {
      const authorization = issued[authorizationReads];
      authorizationReads += 1;
      return authorization;
    },
    health() {
      return READY_HEALTH;
    },
    async start() {},
    async stop() {},
  };
  const platformAdapters = protectedPlatformAdapters();
  const { createEmbeddedBackendLifecycle } = require('./backend-lifecycle');
  const lifecycle = createEmbeddedBackendLifecycle({
    createComposition: () => composition,
    electronApp: { getPath() {}, isPackaged: false },
    platformAdapters,
  });

  await assert.rejects(lifecycle.getInstallAuthorization(), /not running/i);
  assert.equal(authorizationReads, 0);

  await lifecycle.start();
  assert.equal(await lifecycle.getInstallAuthorization(), issued[0]);
  assert.equal(await lifecycle.getInstallAuthorization(), issued[1]);
  assert.equal(authorizationReads, 2);
  assert.equal(JSON.stringify(lifecycle).includes('sensitive-value'), false);
  assert.equal(JSON.stringify(lifecycle.state()).includes('sensitive-value'), false);

  await lifecycle.stop();
  await assert.rejects(lifecycle.getInstallAuthorization(), /not running/i);
  assert.equal(authorizationReads, 2);
});

test('embedded backend lifecycle fails safely when Windows protected adapters are unavailable', async () => {
  let compositionCalls = 0;
  const { createEmbeddedBackendLifecycle, DesktopPlatformAdapterError } = require('./backend-lifecycle');
  const lifecycle = createEmbeddedBackendLifecycle({
    createComposition() {
      compositionCalls += 1;
    },
    electronApp: {
      isPackaged: false,
      getPath() {
        return 'C:\\Users\\fixture\\AppData\\EasyRewind';
      },
    },
  });

  await assert.rejects(
    lifecycle.start(),
    error => error instanceof DesktopPlatformAdapterError && error.code === 'WINDOWS_PROTECTED_ADAPTERS_REQUIRED'
  );
  assert.equal(compositionCalls, 0);
  assert.equal(lifecycle.state(), 'failed');
  await lifecycle.stop();
  await lifecycle.stop();
  assert.equal(lifecycle.state(), 'stopped');
});

test('running state waits for successful composition start and ready application health', async () => {
  let resolveStart;
  let resolveHealth;
  const startGate = new Promise(resolvePromise => {
    resolveStart = resolvePromise;
  });
  const healthGate = new Promise(resolvePromise => {
    resolveHealth = resolvePromise;
  });
  const composition = {
    getInstallAuthorization() {},
    async health() {
      return healthGate;
    },
    async start() {
      return startGate;
    },
    async stop() {},
  };
  const { createEmbeddedBackendLifecycle } = require('./backend-lifecycle');
  const lifecycle = createEmbeddedBackendLifecycle({
    createComposition: () => composition,
    electronApp: { getPath() {}, isPackaged: false },
    platformAdapters: protectedPlatformAdapters(),
  });

  const starting = lifecycle.start();
  await Promise.resolve();
  assert.equal(lifecycle.state(), 'starting');
  resolveStart();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(lifecycle.state(), 'starting');
  resolveHealth({
    status: 'degraded',
    components: { applicationApi: { status: 'ready' } },
  });
  await starting;
  assert.equal(lifecycle.state(), 'running');
  await lifecycle.stop();
});

test('failed or unavailable health stops composition once and never reports running', async () => {
  const healthResults = [
    () => ({ status: 'failed', components: { applicationApi: { status: 'ready' } } }),
    () => ({ status: 'ok', components: { applicationApi: { status: 'degraded' } } }),
    () => {
      throw new Error('private health failure');
    },
    undefined,
  ];
  const { createEmbeddedBackendLifecycle } = require('./backend-lifecycle');

  for (const health of healthResults) {
    const events = [];
    const composition = {
      getInstallAuthorization() {},
      async start() {
        events.push('start');
      },
      async stop() {
        events.push('stop');
      },
      ...(health === undefined ? {} : { health }),
    };
    const lifecycle = createEmbeddedBackendLifecycle({
      createComposition: () => composition,
      electronApp: { getPath() {}, isPackaged: false },
      platformAdapters: protectedPlatformAdapters(),
    });

    await assert.rejects(lifecycle.start(), /health|composition/i);
    assert.equal(lifecycle.state(), 'failed');
    assert.equal(events.at(-1), 'stop');
    await lifecycle.stop();
    await lifecycle.stop();
    assert.equal(lifecycle.state(), 'stopped');
    assert.equal(events.filter(event => event === 'stop').length, 1);
  }
});
