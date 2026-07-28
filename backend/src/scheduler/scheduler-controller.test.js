'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { createSchedulerController } = require('./scheduler-controller');

test('disabled scheduler allocates no timers', async () => {
  const scheduler = createSchedulerController({
    enabled: false,
    jobs: [],
    timers: {
      setInterval() {
        throw new Error('disabled scheduler allocated a timer');
      },
      clearInterval() {},
    },
  });

  await scheduler.start();
  assert.deepEqual(scheduler.health(), { status: 'disabled' });
  await scheduler.stop();
});

test('scheduler prevents overlap and stop waits for in-flight work', async () => {
  let intervalCallback;
  let runs = 0;
  let release;
  const blocked = new Promise(resolve => {
    release = resolve;
  });
  const scheduler = createSchedulerController({
    enabled: true,
    jobs: [
      {
        name: 'durable-jobs',
        intervalMs: 1_000,
        async run() {
          runs += 1;
          await blocked;
        },
      },
    ],
    timers: {
      setInterval(callback) {
        intervalCallback = callback;
        return { unref() {} };
      },
      clearInterval() {},
    },
  });

  await scheduler.start();
  intervalCallback();
  intervalCallback();
  await Promise.resolve();
  assert.equal(runs, 1);

  let stopped = false;
  const stopping = scheduler.stop().then(() => {
    stopped = true;
  });
  await Promise.resolve();
  assert.equal(stopped, false);
  release();
  await stopping;
  assert.equal(stopped, true);
  assert.deepEqual(scheduler.health(), { status: 'degraded' });
});

test('scheduler rolls back partial timer allocation', async () => {
  const cleared = [];
  let allocations = 0;
  const scheduler = createSchedulerController({
    enabled: true,
    jobs: [
      { name: 'one', intervalMs: 1_000, run() {} },
      { name: 'two', intervalMs: 1_000, run() {} },
    ],
    timers: {
      setInterval() {
        allocations += 1;
        if (allocations === 2) throw new Error('fixture allocation failure');
        return { id: allocations };
      },
      clearInterval(timer) {
        cleared.push(timer.id);
      },
    },
  });

  await assert.rejects(scheduler.start(), /fixture allocation failure/);
  assert.deepEqual(cleared, [1]);
  assert.deepEqual(scheduler.health(), { status: 'unavailable' });
});

test('scheduler health remains degraded while any scheduled job last failed', async () => {
  const callbacks = [];
  let firstFails = true;
  const scheduler = createSchedulerController({
    enabled: true,
    jobs: [
      {
        name: 'first',
        intervalMs: 1_000,
        run() {
          if (firstFails) throw new Error('fixture');
        },
      },
      { name: 'second', intervalMs: 1_000, run() {} },
    ],
    timers: {
      setInterval(callback) {
        callbacks.push(callback);
        return {};
      },
      clearInterval() {},
    },
  });
  await scheduler.start();

  callbacks[0]();
  await new Promise(resolve => setImmediate(resolve));
  callbacks[1]();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(scheduler.health(), { status: 'degraded' });

  firstFails = false;
  callbacks[0]();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(scheduler.health(), { status: 'ready' });
  await scheduler.stop();
});
