'use strict';

const { fail } = require('../domain-error');

const RESEARCH_STATES = new Set(['queued', 'running', 'succeeded', 'failed', 'cancelled']);

function text(value, maximum = 20_000) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum && value.trim() === value;
}

function createResearchRepository({ db, repositoryUtils } = {}) {
  if (
    db === null ||
    typeof db !== 'object' ||
    typeof db.prepare !== 'function' ||
    repositoryUtils === null ||
    typeof repositoryUtils !== 'object' ||
    typeof repositoryUtils.newRecord !== 'function' ||
    typeof repositoryUtils.requireById !== 'function' ||
    typeof repositoryUtils.allocateRevision !== 'function' ||
    typeof repositoryUtils.timestamp !== 'function' ||
    typeof repositoryUtils.serializeJson !== 'function' ||
    typeof repositoryUtils.parseJson !== 'function' ||
    typeof repositoryUtils.transaction !== 'function'
  ) {
    fail('REPOSITORY_CONFIGURATION_INVALID');
  }

  function normalize(row) {
    return Object.freeze({
      ...row,
      result: row.result_json === null ? null : repositoryUtils.parseJson(row.result_json),
    });
  }

  function get({ profileId, id } = {}) {
    return normalize(
      repositoryUtils.requireById({
        profileId,
        table: 'research_jobs',
        id,
      })
    );
  }

  function createQueued({ profileId, query } = {}) {
    if (!text(query)) fail('REPOSITORY_INPUT_INVALID');
    const record = repositoryUtils.newRecord();
    db.prepare(
      `INSERT INTO research_jobs(
         id, profile_id, query, state, result_json, error_code,
         started_at, finished_at, created_at, updated_at, revision
       ) VALUES (?, ?, ?, 'queued', NULL, NULL, NULL, NULL, ?, ?, 1)`
    ).run(record.id, profileId, query, record.createdAt, record.updatedAt);
    return get({ profileId, id: record.id });
  }

  function transition({ profileId, id, expectedRevision, from, to, result = null, errorCode = null } = {}) {
    if (!RESEARCH_STATES.has(from) || !RESEARCH_STATES.has(to) || (errorCode !== null && !text(errorCode, 128))) {
      fail('REPOSITORY_INPUT_INVALID');
    }
    const revision = repositoryUtils.allocateRevision({
      profileId,
      table: 'research_jobs',
      id,
      expectedRevision,
    });
    const current = get({ profileId, id });
    if (current.state !== from) fail('CONFLICT');
    const updatedAt = repositoryUtils.timestamp();
    const startedAt = to === 'running' ? updatedAt : current.started_at;
    const finishedAt = ['succeeded', 'failed', 'cancelled'].includes(to) ? updatedAt : null;
    const resultJson = result === null ? null : repositoryUtils.serializeJson(result);
    const changed = db
      .prepare(
        `UPDATE research_jobs
         SET state = ?, result_json = ?, error_code = ?,
             started_at = ?, finished_at = ?, updated_at = ?, revision = ?
         WHERE profile_id = ? AND id = ? AND revision = ? AND deleted_at IS NULL`
      )
      .run(to, resultJson, errorCode, startedAt, finishedAt, updatedAt, revision, profileId, id, expectedRevision);
    if (changed.changes !== 1) fail('CONFLICT');
    return get({ profileId, id });
  }

  return Object.freeze({
    cancel: input =>
      transition({
        ...input,
        from: input.from ?? 'queued',
        to: 'cancelled',
      }),
    complete: input => transition({ ...input, from: 'running', to: 'succeeded' }),
    createQueued,
    fail: input => transition({ ...input, from: 'running', to: 'failed' }),
    get,
    markRunning: input => transition({ ...input, from: 'queued', to: 'running' }),
    transaction: repositoryUtils.transaction,
  });
}

module.exports = { createResearchRepository };
