'use strict';

const { fail } = require('../domain-error');
const { calculateNextReview } = require('./spaced-repetition');

function createLearningService({ repository, syncRecorder } = {}) {
  if (
    repository === null ||
    typeof repository !== 'object' ||
    typeof repository.transaction !== 'function' ||
    syncRecorder === null ||
    typeof syncRecorder !== 'object' ||
    typeof syncRecorder.recordChange !== 'function'
  ) {
    fail('REPOSITORY_CONFIGURATION_INVALID');
  }

  function mutate(work, changeKind = 'upsert') {
    return repository.transaction(() => {
      const record = work();
      syncRecorder.recordChange({
        profileId: record.profile_id,
        entityType:
          record.prompt === undefined ? (record.quiz_kind === undefined ? 'digest' : 'quiz_result') : 'flashcard',
        entityId: record.id,
        revision: record.revision,
        changeKind,
        record,
      });
      return record;
    });
  }

  function reviewFlashcard({ profileId, id, expectedRevision, quality } = {}) {
    return repository.transaction(() => {
      const current = repository.findFlashcard(profileId, id);
      const schedule = calculateNextReview({
        quality,
        intervalDays: current.interval_days,
        easeFactor: current.ease_factor,
        reviewedAt: repository.currentTime(),
      });
      const record = repository.updateFlashcard({
        profileId,
        id,
        expectedRevision,
        ...schedule,
      });
      syncRecorder.recordChange({
        profileId,
        entityType: 'flashcard',
        entityId: record.id,
        revision: record.revision,
        changeKind: 'review',
        record,
      });
      return record;
    });
  }

  return Object.freeze({
    createDigest: input => mutate(() => repository.createDigest(input)),
    createFlashcard: input => mutate(() => repository.createFlashcard(input)),
    deleteFlashcard: input => mutate(() => repository.tombstoneFlashcard(input), 'delete'),
    getFlashcard: input => repository.findFlashcard(input.profileId, input.id),
    listDigests: input => repository.listDigests(input),
    listDueFlashcards: input => repository.listDueFlashcards(input),
    recordQuizResult: input => mutate(() => repository.recordQuizResult(input)),
    reviewFlashcard,
    setFlashcardState: input => mutate(() => repository.setFlashcardState(input)),
    statistics: input => repository.statistics(input),
  });
}

module.exports = { createLearningService };
