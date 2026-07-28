'use strict';

function validateJob(job) {
  return (
    job !== null &&
    typeof job === 'object' &&
    typeof job.name === 'string' &&
    job.name.length > 0 &&
    Number.isSafeInteger(job.intervalMs) &&
    job.intervalMs > 0 &&
    typeof job.run === 'function'
  );
}

function createSchedulerController({ enabled, jobs = [], timers = { setInterval, clearInterval } } = {}) {
  if (
    typeof enabled !== 'boolean' ||
    !Array.isArray(jobs) ||
    !jobs.every(validateJob) ||
    timers === null ||
    typeof timers !== 'object' ||
    typeof timers.setInterval !== 'function' ||
    typeof timers.clearInterval !== 'function'
  ) {
    throw new TypeError('Scheduler dependencies are invalid');
  }
  const activeTimers = [];
  const inFlight = new Set();
  const jobStates = new Map(jobs.map(job => [job.name, { running: false, lastFailed: false }]));
  let state = enabled ? 'stopped' : 'disabled';

  function start() {
    if (!enabled || state === 'running') return Promise.resolve();
    state = 'starting';
    try {
      for (const job of jobs) {
        const jobState = jobStates.get(job.name);
        const timer = timers.setInterval(() => {
          if (state !== 'running' || jobState.running) return;
          jobState.running = true;
          const running = Promise.resolve()
            .then(() => job.run())
            .then(
              () => {
                jobState.lastFailed = false;
              },
              () => {
                jobState.lastFailed = true;
              }
            )
            .finally(() => {
              jobState.running = false;
              inFlight.delete(running);
            });
          inFlight.add(running);
        }, job.intervalMs);
        timer?.unref?.();
        activeTimers.push(timer);
      }
      state = 'running';
      return Promise.resolve();
    } catch (error) {
      for (const timer of activeTimers.splice(0).reverse()) timers.clearInterval(timer);
      state = 'failed';
      return Promise.reject(error);
    }
  }

  async function stop() {
    for (const timer of activeTimers.splice(0).reverse()) timers.clearInterval(timer);
    if (enabled) state = 'stopping';
    await Promise.allSettled([...inFlight]);
    state = enabled ? 'stopped' : 'disabled';
  }

  function health() {
    if (!enabled) return Object.freeze({ status: 'disabled' });
    if (state === 'running') {
      const failed = [...jobStates.values()].some(job => job.lastFailed);
      return Object.freeze({ status: failed ? 'degraded' : 'ready' });
    }
    return Object.freeze({ status: state === 'failed' ? 'unavailable' : 'degraded' });
  }

  return Object.freeze({ health, start, stop });
}

module.exports = { createSchedulerController };
