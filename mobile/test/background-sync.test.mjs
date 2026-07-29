import assert from 'node:assert/strict';
import test from 'node:test';

import { createExpoBackgroundScheduler } from '../src/platform/expo-background-scheduler.ts';
import { createSyncTriggers } from '../src/sync/sync-triggers.ts';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createHarness(overrides = {}) {
  let now = 1_800_000_000_000;
  const listeners = new Set();
  const registered = new Map();
  const unregistered = [];
  const sleeps = [];
  let connected = false;
  let attempts = 0;
  const coordinator = {
    async synchronize() {
      attempts += 1;
      return { push: {}, pull: {} };
    },
    ...overrides.coordinator,
  };
  const clock = {
    now: () => now,
    async sleep(delayMs) {
      sleeps.push(delayMs);
      now += delayMs;
    },
    ...overrides.clock,
  };
  const network = {
    async getStatus() {
      return { connected, internetReachable: connected, connectionType: connected ? 'wifi' : 'none' };
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    ...overrides.network,
  };
  const scheduler = {
    async register(name, task, options) {
      registered.set(name, { task, options });
    },
    async unregister(name) {
      unregistered.push(name);
      registered.delete(name);
    },
    ...overrides.scheduler,
  };
  const triggers = createSyncTriggers({
    coordinator,
    clock,
    jitter: maximum => maximum,
    network,
    scheduler,
    retry: {
      baseDelayMs: 1_000,
      maximumDelayMs: 2_200,
      maximumAttempts: 5,
      jitterRatio: 0.25,
    },
  });

  return {
    triggers,
    registered,
    unregistered,
    sleeps,
    get attempts() {
      return attempts;
    },
    connect() {
      connected = true;
      for (const listener of listeners) {
        listener({ connected: true, internetReachable: true, connectionType: 'wifi' });
      }
    },
  };
}

test('app open, committed mutation, manual request, network return, and periodic work all request sync', async () => {
  const harness = createHarness();

  await harness.triggers.start();
  assert.deepEqual(harness.registered.get('easy-rewind-sync')?.options, {
    minimumIntervalMinutes: 15,
    requiresNetwork: true,
  });

  await harness.triggers.appOpened();
  await harness.triggers.localMutationCommitted();
  await harness.triggers.manualRequested();
  harness.connect();
  await new Promise(resolve => setImmediate(resolve));
  await harness.registered.get('easy-rewind-sync').task();

  assert.equal(harness.attempts, 5);
  assert.deepEqual(harness.triggers.getStatus(), {
    state: 'idle',
    queued: false,
    activeTrigger: null,
    lastAttemptAt: 1_800_000_000_000,
    lastSuccessAt: 1_800_000_000_000,
    nextRetryAt: null,
    terminalReason: null,
    backgroundScheduled: true,
    backgroundScheduleError: null,
  });
});

test('concurrent requests become one active run and one coalesced trailing run', async () => {
  const first = deferred();
  let calls = 0;
  const harness = createHarness({
    coordinator: {
      async synchronize() {
        calls += 1;
        if (calls === 1) await first.promise;
        return { push: {}, pull: {} };
      },
    },
  });

  const appOpen = harness.triggers.appOpened();
  const mutation = harness.triggers.localMutationCommitted();
  const manual = harness.triggers.manualRequested();
  assert.equal(calls, 1);
  assert.equal(harness.triggers.getStatus().queued, true);

  first.resolve();
  await Promise.all([appOpen, mutation, manual]);

  assert.equal(calls, 2);
  assert.equal(harness.triggers.getStatus().queued, false);
  assert.equal(harness.triggers.getStatus().lastSuccessAt, 1_800_000_000_000);
});

test('transient failures use bounded exponential retry with injected jitter', async () => {
  let calls = 0;
  const harness = createHarness({
    coordinator: {
      async synchronize() {
        calls += 1;
        if (calls < 4) throw Object.assign(new Error('offline'), { code: 'network_unavailable' });
        return { push: {}, pull: {} };
      },
    },
  });

  await harness.triggers.manualRequested();

  assert.equal(calls, 4);
  assert.deepEqual(harness.sleeps, [1_250, 2_200, 2_200]);
  assert.equal(harness.triggers.getStatus().state, 'idle');
  assert.equal(harness.triggers.getStatus().queued, false);
  assert.equal(harness.triggers.getStatus().lastSuccessAt, 1_800_000_005_650);
});

test('exhausted transient retry remains truthfully queued without claiming a success', async () => {
  const harness = createHarness({
    coordinator: {
      async synchronize() {
        throw new Error('still offline');
      },
    },
  });

  await assert.rejects(() => harness.triggers.manualRequested(), /still offline/);

  const status = harness.triggers.getStatus();
  assert.equal(status.state, 'queued');
  assert.equal(status.queued, true);
  assert.equal(status.lastSuccessAt, null);
  assert.equal(status.nextRetryAt, null);
  assert.equal(harness.attempts, 0);
  assert.deepEqual(harness.sleeps, [1_250, 2_200, 2_200, 2_200]);
});

for (const terminalCode of ['device_revoked', 'tls_fingerprint_mismatch']) {
  test(`stops scheduling and retries after terminal ${terminalCode}`, async () => {
    let calls = 0;
    const harness = createHarness({
      coordinator: {
        async synchronize() {
          calls += 1;
          throw Object.assign(new Error(terminalCode), { code: terminalCode });
        },
      },
    });
    await harness.triggers.start();

    await assert.rejects(
      () => harness.triggers.manualRequested(),
      error => error.code === terminalCode
    );
    await harness.triggers.appOpened();

    assert.equal(calls, 1);
    assert.deepEqual(harness.sleeps, []);
    assert.deepEqual(harness.unregistered, ['easy-rewind-sync']);
    assert.equal(harness.triggers.getStatus().state, 'blocked');
    assert.equal(harness.triggers.getStatus().queued, true);
    assert.equal(harness.triggers.getStatus().terminalReason, terminalCode);
  });
}

test('background registration is best effort and foreground sync remains available', async () => {
  const harness = createHarness({
    scheduler: {
      async register() {
        throw new Error('development build unavailable');
      },
    },
  });

  await harness.triggers.start();
  assert.equal(harness.triggers.getStatus().backgroundScheduled, false);
  assert.equal(harness.triggers.getStatus().backgroundScheduleError, 'development build unavailable');

  await harness.triggers.manualRequested();
  assert.equal(harness.attempts, 1);
  assert.equal(harness.triggers.getStatus().lastSuccessAt, 1_800_000_000_000);
});

test('Expo adapter imports modules only when registration is invoked and maps task outcomes', async () => {
  const imported = [];
  const definitions = new Map();
  const registrations = [];
  const unregisters = [];
  const modules = {
    'expo-task-manager': {
      defineTask(name, task) {
        definitions.set(name, task);
      },
      isTaskDefined(name) {
        return definitions.has(name);
      },
    },
    'expo-background-task': {
      BackgroundTaskResult: { Success: 'success', Failed: 'failed' },
      async registerTaskAsync(name, options) {
        registrations.push({ name, options });
      },
      async unregisterTaskAsync(name) {
        unregisters.push(name);
      },
    },
  };
  const adapter = createExpoBackgroundScheduler({
    async loadModule(specifier) {
      imported.push(specifier);
      return modules[specifier];
    },
  });

  assert.deepEqual(imported, []);
  let executions = 0;
  await adapter.register(
    'background-test',
    async () => {
      executions += 1;
    },
    { minimumIntervalMinutes: 20, requiresNetwork: true }
  );

  assert.deepEqual(imported, ['expo-task-manager', 'expo-background-task']);
  assert.deepEqual(registrations, [
    {
      name: 'background-test',
      options: { minimumInterval: 20 },
    },
  ]);
  assert.equal(await definitions.get('background-test')(), 'success');
  assert.equal(executions, 1);

  await adapter.unregister('background-test');
  assert.deepEqual(unregisters, ['background-test']);
});

test('Expo adapter reports failed background execution without throwing into the native runner', async () => {
  const definitions = new Map();
  const adapter = createExpoBackgroundScheduler({
    async loadModule(specifier) {
      if (specifier === 'expo-task-manager') {
        return {
          defineTask(name, task) {
            definitions.set(name, task);
          },
          isTaskDefined() {
            return false;
          },
        };
      }
      return {
        BackgroundTaskResult: { Success: 1, Failed: 2 },
        async registerTaskAsync() {},
        async unregisterTaskAsync() {},
      };
    },
  });
  await adapter.register(
    'failing-task',
    async () => {
      throw new Error('sync failed');
    },
    { minimumIntervalMinutes: 15, requiresNetwork: true }
  );

  assert.equal(await definitions.get('failing-task')(), 2);
});
