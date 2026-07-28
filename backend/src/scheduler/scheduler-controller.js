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
  let state = enabled ? 'stopped' : 'disabled';
  let lastRunFailed = false;

  function start() {
    if (!enabled || state === 'running') return Promise.resolve();
    state = 'starting';
    try {
      for (const job of jobs) {
        const timer = timers.setInterval(() => {
          Promise.resolve()
            .then(() => job.run())
            .then(
              () => {
                lastRunFailed = false;
              },
              () => {
                lastRunFailed = true;
              }
            );
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

  function stop() {
    for (const timer of activeTimers.splice(0).reverse()) timers.clearInterval(timer);
    state = enabled ? 'stopped' : 'disabled';
    return Promise.resolve();
  }

  function health() {
    if (!enabled) return Object.freeze({ status: 'disabled' });
    if (state === 'running') {
      return Object.freeze({ status: lastRunFailed ? 'degraded' : 'ready' });
    }
    return Object.freeze({ status: state === 'failed' ? 'unavailable' : 'degraded' });
  }

  return Object.freeze({ health, start, stop });
}

module.exports = { createSchedulerController };
