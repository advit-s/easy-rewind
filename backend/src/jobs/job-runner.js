'use strict';

const { DomainError } = require('../domain/domain-error');

const DEFAULT_LEASE_MS = 30_000;
const MAX_BACKOFF_MS = 86_400_000;

function validateOptions(options) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('Job runner dependencies are invalid');
  }
  const {
    repository,
    handlers,
    workerId,
    now,
    schedule = { setInterval, clearInterval },
    leaseMs = DEFAULT_LEASE_MS,
    heartbeatMs = Math.max(1, Math.floor(leaseMs / 3)),
  } = options;
  if (
    repository === null ||
    typeof repository !== 'object' ||
    !['acquire', 'cancel', 'complete', 'fail', 'get', 'heartbeat'].every(
      method => typeof repository[method] === 'function'
    ) ||
    handlers === null ||
    typeof handlers !== 'object' ||
    Array.isArray(handlers) ||
    !Object.values(handlers).every(handler => typeof handler === 'function') ||
    typeof workerId !== 'string' ||
    workerId.length === 0 ||
    typeof now !== 'function' ||
    schedule === null ||
    typeof schedule !== 'object' ||
    typeof schedule.setInterval !== 'function' ||
    typeof schedule.clearInterval !== 'function' ||
    !Number.isSafeInteger(leaseMs) ||
    leaseMs < 1 ||
    !Number.isSafeInteger(heartbeatMs) ||
    heartbeatMs < 1 ||
    heartbeatMs >= leaseMs
  ) {
    throw new TypeError('Job runner dependencies are invalid');
  }
  return { repository, handlers, workerId, now, schedule, leaseMs, heartbeatMs };
}

function retryBackoff(attempt) {
  return Math.min(1_000 * 2 ** Math.max(0, attempt - 1), MAX_BACKOFF_MS);
}

function createJobRunner(options) {
  const { repository, handlers, workerId, now, schedule, leaseMs, heartbeatMs } = validateOptions(options);
  const active = new Map();

  async function runOnce() {
    const job = repository.acquire({ workerId, leaseMs });
    if (job === null) return null;

    const controller = new AbortController();
    active.set(job.id, controller);
    const heartbeatTimer = schedule.setInterval(() => {
      try {
        repository.heartbeat({
          id: job.id,
          leaseToken: job.leaseToken,
          leaseMs,
        });
      } catch (error) {
        if (error instanceof DomainError && error.code === 'CONFLICT') controller.abort();
      }
    }, heartbeatMs);
    heartbeatTimer?.unref?.();

    try {
      const startedAt = now();
      if (!Number.isSafeInteger(startedAt) || startedAt < 0) {
        throw new TypeError('Job runner clock is invalid');
      }
      const handler = handlers[job.kind];
      if (typeof handler !== 'function') {
        return repository.fail({
          id: job.id,
          leaseToken: job.leaseToken,
          errorCode: 'JOB_HANDLER_MISSING',
          backoffMs: retryBackoff(job.attempts),
        });
      }
      const result = await handler(
        job.payload,
        Object.freeze({
          attempt: job.attempts,
          idempotencyKey: job.idempotencyKey,
          jobId: job.id,
          profileId: job.profileId,
          signal: controller.signal,
          startedAt,
        })
      );
      return repository.complete({
        id: job.id,
        leaseToken: job.leaseToken,
        result: result === undefined ? {} : result,
      });
    } catch {
      if (controller.signal.aborted) {
        return repository.get({ profileId: job.profileId, id: job.id });
      }
      return repository.fail({
        id: job.id,
        leaseToken: job.leaseToken,
        errorCode: 'JOB_HANDLER_FAILED',
        backoffMs: retryBackoff(job.attempts),
      });
    } finally {
      schedule.clearInterval(heartbeatTimer);
      active.delete(job.id);
    }
  }

  function cancel({ profileId, id } = {}) {
    const cancelled = repository.cancel({ profileId, id });
    active.get(cancelled.id)?.abort();
    return cancelled.state === 'cancelled';
  }

  return Object.freeze({ cancel, runOnce });
}

module.exports = {
  createJobRunner,
};
