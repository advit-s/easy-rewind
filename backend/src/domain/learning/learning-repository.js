'use strict';

const { fail } = require('../domain-error');

const FLASHCARD_STATES = new Set(['active', 'suspended', 'retired']);

function nonEmptyText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function optionalId(value) {
  return value === undefined || value === null || nonEmptyText(value);
}

function timestamp(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function score(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function createLearningRepository({ db, repositoryUtils } = {}) {
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
    typeof repositoryUtils.page !== 'function' ||
    typeof repositoryUtils.transaction !== 'function'
  ) {
    fail('REPOSITORY_CONFIGURATION_INVALID');
  }

  function findFlashcard(profileId, id) {
    return repositoryUtils.requireById({
      profileId,
      table: 'flashcards',
      id,
    });
  }

  function createFlashcard({ profileId, itemId = null, prompt, answer, dueAt, state = 'active' } = {}) {
    if (!nonEmptyText(prompt) || !nonEmptyText(answer) || !optionalId(itemId) || !FLASHCARD_STATES.has(state)) {
      fail('REPOSITORY_INPUT_INVALID');
    }
    if (itemId !== null) {
      repositoryUtils.requireById({ profileId, table: 'items', id: itemId });
    }
    const record = repositoryUtils.newRecord();
    const resolvedDueAt = dueAt === undefined ? record.createdAt : dueAt;
    if (resolvedDueAt !== null && !timestamp(resolvedDueAt)) {
      fail('REPOSITORY_INPUT_INVALID');
    }
    db.prepare(
      `INSERT INTO flashcards(
         id, profile_id, item_id, prompt, answer, state, due_at,
         interval_days, ease_factor, created_at, updated_at, revision
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 2.5, ?, ?, 1)`
    ).run(
      record.id,
      profileId,
      itemId,
      prompt.trim(),
      answer.trim(),
      state,
      resolvedDueAt,
      record.createdAt,
      record.updatedAt
    );
    return findFlashcard(profileId, record.id);
  }

  function listDueFlashcards({ profileId, dueAt, limit = 100 } = {}) {
    if (!timestamp(dueAt) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      fail('REPOSITORY_INPUT_INVALID');
    }
    return db
      .prepare(
        `SELECT *
         FROM flashcards
         WHERE profile_id = ?
           AND state = 'active'
           AND deleted_at IS NULL
           AND due_at IS NOT NULL
           AND due_at <= ?
         ORDER BY due_at ASC, id ASC
         LIMIT ?`
      )
      .all(profileId, dueAt, limit);
  }

  function updateFlashcard({ profileId, id, expectedRevision, dueAt, intervalDays, easeFactor } = {}) {
    if (
      !timestamp(dueAt) ||
      !Number.isSafeInteger(intervalDays) ||
      intervalDays < 0 ||
      typeof easeFactor !== 'number' ||
      !Number.isFinite(easeFactor) ||
      easeFactor <= 0
    ) {
      fail('REPOSITORY_INPUT_INVALID');
    }
    const revision = repositoryUtils.allocateRevision({
      profileId,
      table: 'flashcards',
      id,
      expectedRevision,
    });
    const updatedAt = repositoryUtils.timestamp();
    const result = db
      .prepare(
        `UPDATE flashcards
         SET due_at = ?, interval_days = ?, ease_factor = ?,
             updated_at = ?, revision = ?
         WHERE profile_id = ? AND id = ? AND revision = ? AND deleted_at IS NULL`
      )
      .run(dueAt, intervalDays, easeFactor, updatedAt, revision, profileId, id, expectedRevision);
    if (result.changes !== 1) fail('CONFLICT');
    return findFlashcard(profileId, id);
  }

  function setFlashcardState({ profileId, id, expectedRevision, state } = {}) {
    if (!FLASHCARD_STATES.has(state)) fail('REPOSITORY_INPUT_INVALID');
    const revision = repositoryUtils.allocateRevision({
      profileId,
      table: 'flashcards',
      id,
      expectedRevision,
    });
    const updatedAt = repositoryUtils.timestamp();
    const result = db
      .prepare(
        `UPDATE flashcards
         SET state = ?, updated_at = ?, revision = ?
         WHERE profile_id = ? AND id = ? AND revision = ? AND deleted_at IS NULL`
      )
      .run(state, updatedAt, revision, profileId, id, expectedRevision);
    if (result.changes !== 1) fail('CONFLICT');
    return findFlashcard(profileId, id);
  }

  function tombstoneFlashcard({ profileId, id, expectedRevision } = {}) {
    const revision = repositoryUtils.allocateRevision({
      profileId,
      table: 'flashcards',
      id,
      expectedRevision,
    });
    const deletedAt = repositoryUtils.timestamp();
    const result = db
      .prepare(
        `UPDATE flashcards
         SET deleted_at = ?, updated_at = ?, revision = ?
         WHERE profile_id = ? AND id = ? AND revision = ? AND deleted_at IS NULL`
      )
      .run(deletedAt, deletedAt, revision, profileId, id, expectedRevision);
    if (result.changes !== 1) fail('CONFLICT');
    return db.prepare('SELECT * FROM flashcards WHERE profile_id = ? AND id = ? LIMIT 1').get(profileId, id);
  }

  function recordQuizResult({ profileId, itemId = null, quizKind, score: achieved, maxScore, answers } = {}) {
    if (
      !optionalId(itemId) ||
      !nonEmptyText(quizKind) ||
      !score(achieved) ||
      !Number.isSafeInteger(maxScore) ||
      maxScore < 1 ||
      achieved > maxScore
    ) {
      fail('REPOSITORY_INPUT_INVALID');
    }
    if (itemId !== null) {
      repositoryUtils.requireById({ profileId, table: 'items', id: itemId });
    }
    const answersJson = repositoryUtils.serializeJson(answers);
    const record = repositoryUtils.newRecord();
    db.prepare(
      `INSERT INTO quiz_results(
         id, profile_id, item_id, quiz_kind, score, max_score, answers_json,
         completed_at, created_at, updated_at, revision
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
    ).run(
      record.id,
      profileId,
      itemId,
      quizKind.trim(),
      achieved,
      maxScore,
      answersJson,
      record.createdAt,
      record.createdAt,
      record.updatedAt
    );
    return repositoryUtils.requireById({
      profileId,
      table: 'quiz_results',
      id: record.id,
    });
  }

  function statistics({ profileId, dueAt } = {}) {
    if (!timestamp(dueAt)) fail('REPOSITORY_INPUT_INVALID');
    const cards = db
      .prepare(
        `SELECT
           COUNT(*) AS active_flashcards,
           SUM(CASE WHEN due_at IS NOT NULL AND due_at <= ? THEN 1 ELSE 0 END) AS due_flashcards
         FROM flashcards
         WHERE profile_id = ? AND state = 'active' AND deleted_at IS NULL`
      )
      .get(dueAt, profileId);
    const quizzes = db
      .prepare(
        `SELECT
           COUNT(*) AS quiz_attempts,
           COALESCE(AVG((score * 100.0) / max_score), 0) AS average_quiz_percent
         FROM quiz_results
         WHERE profile_id = ? AND deleted_at IS NULL`
      )
      .get(profileId);
    return {
      activeFlashcards: cards.active_flashcards,
      averageQuizPercent: Math.round(quizzes.average_quiz_percent * 100) / 100,
      dueFlashcards: cards.due_flashcards || 0,
      quizAttempts: quizzes.quiz_attempts,
    };
  }

  function createDigest({ profileId, title, body, periodStart, periodEnd } = {}) {
    if (
      !nonEmptyText(title) ||
      typeof body !== 'string' ||
      !timestamp(periodStart) ||
      !timestamp(periodEnd) ||
      periodEnd < periodStart
    ) {
      fail('REPOSITORY_INPUT_INVALID');
    }
    const record = repositoryUtils.newRecord();
    db.prepare(
      `INSERT INTO digests(
         id, profile_id, title, body, period_start, period_end,
         created_at, updated_at, revision
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`
    ).run(record.id, profileId, title.trim(), body, periodStart, periodEnd, record.createdAt, record.updatedAt);
    return repositoryUtils.requireById({
      profileId,
      table: 'digests',
      id: record.id,
    });
  }

  return Object.freeze({
    createDigest,
    createFlashcard,
    currentTime: repositoryUtils.timestamp,
    findFlashcard,
    listDigests: options => repositoryUtils.page({ ...options, table: 'digests' }),
    listDueFlashcards,
    recordQuizResult,
    setFlashcardState,
    statistics,
    tombstoneFlashcard,
    transaction: repositoryUtils.transaction,
    updateFlashcard,
  });
}

module.exports = { createLearningRepository };
