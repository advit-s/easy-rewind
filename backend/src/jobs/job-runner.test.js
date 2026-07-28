'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const Database = require('better-sqlite3');

const { createJobRepository } = require('./job-repository');
const { createJobRunner } = require('./job-runner');

function createDatabase() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE profiles (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE jobs (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
      payload_json TEXT NOT NULL DEFAULT '{}',
      result_json TEXT,
      error_code TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      available_at INTEGER NOT NULL DEFAULT 0,
      locked_at INTEGER,
      locked_by TEXT,
      started_at INTEGER,
      finished_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      lease_token TEXT,
      lease_expires_at INTEGER,
      heartbeat_at INTEGER,
      idempotency_key TEXT
    );

    CREATE UNIQUE INDEX uq_jobs_profile_idempotency
      ON jobs(profile_id, idempotency_key)
      WHERE idempotency_key IS NOT NULL;
    CREATE INDEX idx_jobs_profile_lease
      ON jobs(profile_id, state, lease_expires_at, available_at, id);
  `);
  db.prepare('INSERT INTO profiles(id, created_at, updated_at) VALUES (?, ?, ?)').run('owner-a', 1, 1);
  db.prepare('INSERT INTO profiles(id, created_at, updated_at) VALUES (?, ?, ?)').run('owner-b', 1, 1);
  return db;
}

function createFixture({ start = 1_700_000_000_000 } = {}) {
  const db = createDatabase();
  let currentTime = start;
  let nextId = 0;
  const repository = createJobRepository({
    db,
    now: () => currentTime,
    ids: () => `generated-${++nextId}`,
  });
  return {
    db,
    repository,
    advance(milliseconds) {
      currentTime += milliseconds;
    },
    now() {
      return currentTime;
    },
  };
}

test('enqueue deduplicates an idempotency key within one owner without sharing across owners', () => {
  const fixture = createFixture();

  const first = fixture.repository.enqueue({
    profileId: 'owner-a',
    kind: 'digest',
    payload: { item: 'one' },
    idempotencyKey: 'daily-2026-07-28',
  });
  const duplicate = fixture.repository.enqueue({
    profileId: 'owner-a',
    kind: 'digest',
    payload: { item: 'changed' },
    idempotencyKey: 'daily-2026-07-28',
  });
  const otherOwner = fixture.repository.enqueue({
    profileId: 'owner-b',
    kind: 'digest',
    payload: { item: 'two' },
    idempotencyKey: 'daily-2026-07-28',
  });

  assert.equal(duplicate.id, first.id);
  assert.deepEqual(duplicate.payload, { item: 'one' });
  assert.notEqual(otherOwner.id, first.id);
  assert.equal(fixture.db.prepare('SELECT COUNT(*) FROM jobs').pluck().get(), 2);
  fixture.db.close();
});

test('lease acquisition is exclusive and an expired lease is recovered after restart', () => {
  const fixture = createFixture();
  const queued = fixture.repository.enqueue({
    profileId: 'owner-a',
    kind: 'research',
    payload: { topic: 'leases' },
  });

  const firstLease = fixture.repository.acquire({ workerId: 'worker-one', leaseMs: 1_000 });
  const competingLease = fixture.repository.acquire({ workerId: 'worker-two', leaseMs: 1_000 });

  assert.equal(firstLease.id, queued.id);
  assert.equal(firstLease.attempts, 1);
  assert.equal(firstLease.state, 'running');
  assert.equal(competingLease, null);

  fixture.advance(1_000);
  const recovered = fixture.repository.acquire({ workerId: 'worker-after-restart', leaseMs: 2_000 });

  assert.equal(recovered.id, queued.id);
  assert.equal(recovered.attempts, 2);
  assert.equal(recovered.lockedBy, 'worker-after-restart');
  assert.notEqual(recovered.leaseToken, firstLease.leaseToken);
  assert.equal(recovered.leaseExpiresAt, fixture.now() + 2_000);
  fixture.db.close();
});

test('restart recovery terminally fails an expired final attempt before leasing more work', () => {
  const fixture = createFixture();
  const exhausted = fixture.repository.enqueue({
    profileId: 'owner-a',
    kind: 'research',
    payload: {},
    maxAttempts: 1,
  });
  fixture.repository.acquire({ workerId: 'crashed-worker', leaseMs: 1_000 });

  fixture.advance(1_000);
  assert.equal(fixture.repository.acquire({ workerId: 'replacement-worker', leaseMs: 1_000 }), null);
  const recovered = fixture.repository.get({ profileId: 'owner-a', id: exhausted.id });

  assert.equal(recovered.state, 'failed');
  assert.equal(recovered.errorCode, 'JOB_LEASE_EXPIRED');
  assert.equal(recovered.finishedAt, fixture.now());
  fixture.db.close();
});

test('heartbeat renews only a live matching lease and stale workers cannot complete jobs', () => {
  const fixture = createFixture();
  fixture.repository.enqueue({ profileId: 'owner-a', kind: 'research', payload: {} });
  const staleLease = fixture.repository.acquire({ workerId: 'worker-one', leaseMs: 1_000 });

  fixture.advance(500);
  const renewed = fixture.repository.heartbeat({
    id: staleLease.id,
    leaseToken: staleLease.leaseToken,
    leaseMs: 1_000,
  });
  assert.equal(renewed.heartbeatAt, fixture.now());
  assert.equal(renewed.leaseExpiresAt, fixture.now() + 1_000);

  fixture.advance(1_000);
  const activeLease = fixture.repository.acquire({ workerId: 'worker-two', leaseMs: 1_000 });
  assert.throws(
    () =>
      fixture.repository.complete({
        id: staleLease.id,
        leaseToken: staleLease.leaseToken,
        result: { leaked: true },
      }),
    { code: 'CONFLICT' }
  );
  const completed = fixture.repository.complete({
    id: activeLease.id,
    leaseToken: activeLease.leaseToken,
    result: { ok: true },
  });
  assert.equal(completed.state, 'succeeded');
  assert.deepEqual(completed.result, { ok: true });
  fixture.db.close();
});

test('failure applies bounded backoff and stops retrying at max attempts', () => {
  const fixture = createFixture();
  fixture.repository.enqueue({
    profileId: 'owner-a',
    kind: 'research',
    payload: {},
    maxAttempts: 2,
  });
  const firstLease = fixture.repository.acquire({ workerId: 'worker', leaseMs: 1_000 });

  const retry = fixture.repository.fail({
    id: firstLease.id,
    leaseToken: firstLease.leaseToken,
    errorCode: 'REMOTE_UNAVAILABLE',
    backoffMs: Number.MAX_SAFE_INTEGER,
  });

  assert.equal(retry.state, 'queued');
  assert.equal(retry.availableAt, fixture.now() + 86_400_000);
  assert.equal(fixture.repository.acquire({ workerId: 'worker', leaseMs: 1_000 }), null);

  fixture.advance(86_400_000);
  const finalLease = fixture.repository.acquire({ workerId: 'worker', leaseMs: 1_000 });
  const failed = fixture.repository.fail({
    id: finalLease.id,
    leaseToken: finalLease.leaseToken,
    errorCode: 'REMOTE_UNAVAILABLE',
    backoffMs: 10,
  });

  assert.equal(failed.state, 'failed');
  assert.equal(failed.finishedAt, fixture.now());
  assert.equal(fixture.repository.acquire({ workerId: 'worker', leaseMs: 1_000 }), null);
  fixture.db.close();
});

test('cancellation is terminal and rejects completion by the cancelled worker', () => {
  const fixture = createFixture();
  const job = fixture.repository.enqueue({
    profileId: 'owner-a',
    kind: 'research',
    payload: {},
  });
  const lease = fixture.repository.acquire({ workerId: 'worker', leaseMs: 1_000 });

  const cancelled = fixture.repository.cancel({ profileId: 'owner-a', id: job.id });

  assert.equal(cancelled.state, 'cancelled');
  assert.equal(cancelled.finishedAt, fixture.now());
  assert.throws(() => fixture.repository.complete({ id: job.id, leaseToken: lease.leaseToken, result: {} }), {
    code: 'CONFLICT',
  });
  assert.throws(() => fixture.repository.cancel({ profileId: 'owner-b', id: job.id }), {
    code: 'NOT_FOUND',
  });
  fixture.db.close();
});

test('runner passes abort and idempotency context, heartbeats, and completes with the lease token', async () => {
  const fixture = createFixture();
  fixture.repository.enqueue({
    profileId: 'owner-a',
    kind: 'digest',
    payload: { day: 28 },
    idempotencyKey: 'digest-28',
  });
  const intervals = [];
  let release;
  const waiting = new Promise(resolve => {
    release = resolve;
  });
  let observed;
  const runner = createJobRunner({
    repository: fixture.repository,
    handlers: {
      async digest(payload, context) {
        observed = { payload, context };
        await waiting;
        return { delivered: true };
      },
    },
    workerId: 'runner-one',
    now: () => fixture.now(),
    leaseMs: 3_000,
    heartbeatMs: 1_000,
    schedule: {
      setInterval(callback, milliseconds) {
        const timer = { callback, milliseconds };
        intervals.push(timer);
        return timer;
      },
      clearInterval(timer) {
        timer.cleared = true;
      },
    },
  });

  const running = runner.runOnce();
  await Promise.resolve();
  assert.deepEqual(observed.payload, { day: 28 });
  assert.equal(observed.context.idempotencyKey, 'digest-28');
  assert.equal(observed.context.attempt, 1);
  assert.equal(observed.context.signal.aborted, false);
  assert.equal(intervals[0].milliseconds, 1_000);

  fixture.advance(1_000);
  intervals[0].callback();
  release();
  const completed = await running;

  assert.equal(completed.state, 'succeeded');
  assert.deepEqual(completed.result, { delivered: true });
  assert.equal(intervals[0].cleared, true);
  fixture.db.close();
});

test('runner retries handler errors with exponential bounded backoff and can abort active work', async () => {
  const fixture = createFixture();
  const job = fixture.repository.enqueue({
    profileId: 'owner-a',
    kind: 'research',
    payload: {},
    maxAttempts: 3,
  });
  const runner = createJobRunner({
    repository: fixture.repository,
    handlers: {
      research(_payload, { signal }) {
        return new Promise((resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              const error = new Error('aborted');
              error.name = 'AbortError';
              reject(error);
            },
            { once: true }
          );
        });
      },
    },
    workerId: 'runner-one',
    now: () => fixture.now(),
    schedule: {
      setInterval() {
        return {};
      },
      clearInterval() {},
    },
  });

  const active = runner.runOnce();
  await Promise.resolve();
  assert.equal(runner.cancel({ profileId: 'owner-a', id: job.id }), true);
  const cancelled = await active;

  assert.equal(cancelled.state, 'cancelled');

  fixture.repository.enqueue({
    profileId: 'owner-a',
    kind: 'broken',
    payload: {},
    maxAttempts: 3,
  });
  const failingRunner = createJobRunner({
    repository: fixture.repository,
    handlers: {
      async broken() {
        throw new Error('sensitive provider detail');
      },
    },
    workerId: 'runner-two',
    now: () => fixture.now(),
    schedule: {
      setInterval() {
        return {};
      },
      clearInterval() {},
    },
  });
  const retry = await failingRunner.runOnce();

  assert.equal(retry.state, 'queued');
  assert.equal(retry.errorCode, 'JOB_HANDLER_FAILED');
  assert.equal(retry.availableAt, fixture.now() + 1_000);
  fixture.db.close();
});
