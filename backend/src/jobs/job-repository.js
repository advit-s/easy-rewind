'use strict';

const { fail } = require('../domain/domain-error');
const { createRepositoryUtils } = require('../domain/repository-utils');

const MAX_BACKOFF_MS = 86_400_000;
const MAX_ATTEMPTS = 100;
const MAX_LEASE_MS = 86_400_000;

function requireIdentifier(value) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 256 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    fail('REPOSITORY_INPUT_INVALID');
  }
  return value;
}

function requirePositiveInteger(value, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    fail('REPOSITORY_INPUT_INVALID');
  }
  return value;
}

function requireNonnegativeInteger(value) {
  if (!Number.isSafeInteger(value) || value < 0) fail('REPOSITORY_INPUT_INVALID');
  return value;
}

function normalizeRow(row, utils) {
  if (!row) return null;
  return Object.freeze({
    id: row.id,
    profileId: row.profile_id,
    kind: row.kind,
    state: row.state,
    payload: utils.parseJson(row.payload_json),
    result: row.result_json === null ? null : utils.parseJson(row.result_json),
    errorCode: row.error_code,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    availableAt: row.available_at,
    lockedAt: row.locked_at,
    lockedBy: row.locked_by,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    leaseToken: row.lease_token,
    leaseExpiresAt: row.lease_expires_at,
    heartbeatAt: row.heartbeat_at,
    idempotencyKey: row.idempotency_key,
  });
}

function createJobRepository(options) {
  const utils = createRepositoryUtils(options);
  const { db } = options;

  function rowById(id) {
    return db.prepare('SELECT * FROM jobs WHERE id = ? LIMIT 1').get(id);
  }

  function get({ profileId, id } = {}) {
    const owner = requireIdentifier(profileId);
    const jobId = requireIdentifier(id);
    const row = db.prepare('SELECT * FROM jobs WHERE profile_id = ? AND id = ? LIMIT 1').get(owner, jobId);
    if (!row) fail('NOT_FOUND');
    return normalizeRow(row, utils);
  }

  function enqueue({ profileId, kind, payload = {}, idempotencyKey = null, maxAttempts = 3, availableAt } = {}) {
    const owner = requireIdentifier(profileId);
    const jobKind = requireIdentifier(kind);
    const key = idempotencyKey === null ? null : requireIdentifier(idempotencyKey);
    const attemptsLimit = requirePositiveInteger(maxAttempts, MAX_ATTEMPTS);
    const payloadJson = utils.serializeJson(payload);

    return utils.transaction(() => {
      if (key !== null) {
        const existing = db
          .prepare('SELECT * FROM jobs WHERE profile_id = ? AND idempotency_key = ? LIMIT 1')
          .get(owner, key);
        if (existing) return normalizeRow(existing, utils);
      }

      const timestamp = utils.timestamp();
      const readyAt = availableAt === undefined ? timestamp : requireNonnegativeInteger(availableAt);
      const id = utils.nextId();
      db.prepare(
        `INSERT INTO jobs(
           id, profile_id, kind, state, payload_json, result_json, error_code,
           attempts, max_attempts, available_at, locked_at, locked_by,
           started_at, finished_at, created_at, updated_at, lease_token,
           lease_expires_at, heartbeat_at, idempotency_key
         ) VALUES (?, ?, ?, 'queued', ?, NULL, NULL, 0, ?, ?, NULL, NULL,
                   NULL, NULL, ?, ?, NULL, NULL, NULL, ?)`
      ).run(id, owner, jobKind, payloadJson, attemptsLimit, readyAt, timestamp, timestamp, key);
      return normalizeRow(rowById(id), utils);
    });
  }

  function acquire({ workerId, leaseMs } = {}) {
    const worker = requireIdentifier(workerId);
    const duration = requirePositiveInteger(leaseMs, MAX_LEASE_MS);

    return utils.transaction(() => {
      const timestamp = utils.timestamp();
      db.prepare(
        `UPDATE jobs
         SET state = 'failed',
             error_code = 'JOB_LEASE_EXPIRED',
             finished_at = ?,
             updated_at = ?,
             locked_at = NULL,
             locked_by = NULL,
             lease_token = NULL,
             lease_expires_at = NULL,
             heartbeat_at = NULL
         WHERE state = 'running'
           AND lease_expires_at IS NOT NULL
           AND lease_expires_at <= ?
           AND attempts >= max_attempts`
      ).run(timestamp, timestamp, timestamp);
      const candidate = db
        .prepare(
          `SELECT id
           FROM jobs
           WHERE attempts < max_attempts
             AND (
               (state = 'queued' AND available_at <= ?)
               OR (state = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
             )
           ORDER BY available_at, created_at, id
           LIMIT 1`
        )
        .get(timestamp, timestamp);
      if (!candidate) return null;

      const leaseToken = utils.nextId();
      const leaseExpiresAt = timestamp + duration;
      if (!Number.isSafeInteger(leaseExpiresAt)) fail('CLOCK_INVALID');
      const changed = db
        .prepare(
          `UPDATE jobs
           SET state = 'running',
               attempts = attempts + 1,
               locked_at = ?,
               locked_by = ?,
               started_at = COALESCE(started_at, ?),
               finished_at = NULL,
               updated_at = ?,
               lease_token = ?,
               lease_expires_at = ?,
               heartbeat_at = ?
           WHERE id = ?
             AND attempts < max_attempts
             AND (
               (state = 'queued' AND available_at <= ?)
               OR (state = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
             )`
        )
        .run(
          timestamp,
          worker,
          timestamp,
          timestamp,
          leaseToken,
          leaseExpiresAt,
          timestamp,
          candidate.id,
          timestamp,
          timestamp
        );
      if (changed.changes !== 1) return null;
      return normalizeRow(rowById(candidate.id), utils);
    });
  }

  function heartbeat({ id, leaseToken, leaseMs } = {}) {
    const jobId = requireIdentifier(id);
    const token = requireIdentifier(leaseToken);
    const duration = requirePositiveInteger(leaseMs, MAX_LEASE_MS);
    const timestamp = utils.timestamp();
    const leaseExpiresAt = timestamp + duration;
    if (!Number.isSafeInteger(leaseExpiresAt)) fail('CLOCK_INVALID');
    const changed = db
      .prepare(
        `UPDATE jobs
         SET heartbeat_at = ?, lease_expires_at = ?, updated_at = ?
         WHERE id = ? AND state = 'running' AND lease_token = ? AND lease_expires_at > ?`
      )
      .run(timestamp, leaseExpiresAt, timestamp, jobId, token, timestamp);
    if (changed.changes !== 1) fail('CONFLICT');
    return normalizeRow(rowById(jobId), utils);
  }

  function complete({ id, leaseToken, result = {} } = {}) {
    const jobId = requireIdentifier(id);
    const token = requireIdentifier(leaseToken);
    const resultJson = utils.serializeJson(result);
    const timestamp = utils.timestamp();
    const changed = db
      .prepare(
        `UPDATE jobs
         SET state = 'succeeded',
             result_json = ?,
             error_code = NULL,
             finished_at = ?,
             updated_at = ?,
             locked_at = NULL,
             locked_by = NULL,
             lease_token = NULL,
             lease_expires_at = NULL,
             heartbeat_at = NULL
         WHERE id = ? AND state = 'running' AND lease_token = ? AND lease_expires_at > ?`
      )
      .run(resultJson, timestamp, timestamp, jobId, token, timestamp);
    if (changed.changes !== 1) fail('CONFLICT');
    return normalizeRow(rowById(jobId), utils);
  }

  function failJob({ id, leaseToken, errorCode, backoffMs = 0 } = {}) {
    const jobId = requireIdentifier(id);
    const token = requireIdentifier(leaseToken);
    const code = requireIdentifier(errorCode);
    const requestedBackoff = requireNonnegativeInteger(backoffMs);
    const boundedBackoff = Math.min(requestedBackoff, MAX_BACKOFF_MS);

    return utils.transaction(() => {
      const timestamp = utils.timestamp();
      const row = rowById(jobId);
      if (
        !row ||
        row.state !== 'running' ||
        row.lease_token !== token ||
        row.lease_expires_at === null ||
        row.lease_expires_at <= timestamp
      ) {
        fail('CONFLICT');
      }
      const terminal = row.attempts >= row.max_attempts;
      const availableAt = terminal ? row.available_at : timestamp + boundedBackoff;
      if (!Number.isSafeInteger(availableAt)) fail('CLOCK_INVALID');
      const state = terminal ? 'failed' : 'queued';
      db.prepare(
        `UPDATE jobs
         SET state = ?,
             result_json = NULL,
             error_code = ?,
             available_at = ?,
             finished_at = ?,
             updated_at = ?,
             locked_at = NULL,
             locked_by = NULL,
             lease_token = NULL,
             lease_expires_at = NULL,
             heartbeat_at = NULL
         WHERE id = ? AND state = 'running' AND lease_token = ?`
      ).run(state, code, availableAt, terminal ? timestamp : null, timestamp, jobId, token);
      return normalizeRow(rowById(jobId), utils);
    });
  }

  function cancel({ profileId, id } = {}) {
    const owner = requireIdentifier(profileId);
    const jobId = requireIdentifier(id);
    return utils.transaction(() => {
      const timestamp = utils.timestamp();
      const row = db.prepare('SELECT * FROM jobs WHERE profile_id = ? AND id = ? LIMIT 1').get(owner, jobId);
      if (!row) fail('NOT_FOUND');
      if (row.state === 'cancelled') return normalizeRow(row, utils);
      if (row.state === 'succeeded' || row.state === 'failed') fail('CONFLICT');
      db.prepare(
        `UPDATE jobs
         SET state = 'cancelled',
             finished_at = ?,
             updated_at = ?,
             locked_at = NULL,
             locked_by = NULL,
             lease_token = NULL,
             lease_expires_at = NULL,
             heartbeat_at = NULL
         WHERE profile_id = ? AND id = ?`
      ).run(timestamp, timestamp, owner, jobId);
      return normalizeRow(rowById(jobId), utils);
    });
  }

  return Object.freeze({
    acquire,
    cancel,
    complete,
    enqueue,
    fail: failJob,
    get,
    heartbeat,
  });
}

module.exports = {
  createJobRepository,
};
