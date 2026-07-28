'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

test('embedded backend lifecycle starts and stops one production composition idempotently', async () => {
  const events = [];
  const composition = {
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
  const platformAdapters = {
    storageRoot: 'C:\\Users\\fixture\\AppData\\Local\\easy-rewind\\runtime',
    filePermissions: {
      restrictDirectory() {},
      restrictFile() {},
    },
    secretStoreAdapter: {
      delete() {},
      get() {},
      set() {},
    },
  };
  const { createEmbeddedBackendLifecycle } = require('./backend-lifecycle');
  const lifecycle = createEmbeddedBackendLifecycle({
    createComposition,
    electronApp: {
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
  assert.equal(options.adapters.secretStoreAdapter, platformAdapters.secretStoreAdapter);
});

test('embedded backend lifecycle fails safely when Windows protected adapters are unavailable', async () => {
  let compositionCalls = 0;
  const { createEmbeddedBackendLifecycle, DesktopPlatformAdapterError } = require('./backend-lifecycle');
  const lifecycle = createEmbeddedBackendLifecycle({
    createComposition() {
      compositionCalls += 1;
    },
    electronApp: {
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
