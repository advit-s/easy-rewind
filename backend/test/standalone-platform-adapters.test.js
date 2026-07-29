'use strict';

const assert = require('node:assert/strict');
const { resolve } = require('node:path');
const test = require('node:test');

test('standalone defaults its canonical runtime and protected adapters under LOCALAPPDATA', async () => {
  const localAppData = 'C:\\Users\\fixture\\AppData\\Local';
  const frontendDirectory = resolve(__dirname, '..', '..', 'frontend');
  const events = [];
  const platformAdapters = {
    filePermissions: { restrictDirectory() {}, restrictFile() {} },
    secretStoreAdapter: { delete() {}, get() {}, set() {} },
    storageRoot: resolve(localAppData, 'easy-rewind', 'runtime'),
  };
  const { createStandaloneConfigFromEnvironment, runStandalone } = require('../server');
  const config = createStandaloneConfigFromEnvironment({ LOCALAPPDATA: localAppData });
  assert.equal(config.storageRoot, platformAdapters.storageRoot);

  const result = await runStandalone({
    createPlatformAdapters(input) {
      events.push(['adapters', input]);
      return platformAdapters;
    },
    environment: { EASY_REWIND_SCHEDULERS_ENABLED: 'false', LOCALAPPDATA: localAppData },
    logger: { error: assert.fail, info() {} },
    signalSource: { exitCode: 0 },
    async start(options) {
      events.push(['start', options]);
      return { running: true };
    },
  });

  assert.deepEqual(result, { running: true });
  assert.equal(events[0][0], 'adapters');
  assert.equal(events[0][1].localAppData, localAppData);
  assert.equal(events[1][1].config.storageRoot, platformAdapters.storageRoot);
  assert.equal(events[1][1].adapters, platformAdapters);
  assert.equal(events[1][1].dashboardDirectory, frontendDirectory);
  assert.equal(Object.hasOwn(events[1][1].config, 'dashboardDirectory'), false);
  assert.equal(Object.hasOwn(platformAdapters, 'dashboardDirectory'), false);
});

test('standalone startup fails safely before composition when LOCALAPPDATA protection is unavailable', async () => {
  const errors = [];
  const signalSource = { exitCode: 0 };
  const { runStandalone } = require('../server');
  const result = await runStandalone({
    createPlatformAdapters() {
      throw new Error('private environment detail');
    },
    environment: { LOCALAPPDATA: 'C:\\private\\path' },
    logger: {
      error(message) {
        errors.push(message);
      },
      info() {},
    },
    signalSource,
    start: assert.fail,
  });

  assert.equal(result, undefined);
  assert.equal(signalSource.exitCode, 1);
  assert.deepEqual(errors, ['Easy Rewind backend startup failed safely.']);
  assert.equal(errors[0].includes('private'), false);
});
