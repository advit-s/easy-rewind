'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');

const BetterSqlite3 = require('better-sqlite3');
const { DomainError, createRepositoryUtils } = require('../repository-utils');
const { createLearningRepository } = require('./learning-repository');
const { createLearningService } = require('./learning-service');

const START = Date.UTC(2026, 6, 28, 12);

function fixture() {
  const db = new BetterSqlite3(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(readFileSync(join(__dirname, '..', '..', 'database', 'migrations', '001_core.sql'), 'utf8'));
  db.prepare(
    `INSERT INTO profiles(id, display_name, created_at, updated_at)
     VALUES (?, ?, ?, ?)`
  ).run('profile-one', 'One', START, START);
  db.prepare(
    `INSERT INTO profiles(id, display_name, created_at, updated_at)
     VALUES (?, ?, ?, ?)`
  ).run('profile-two', 'Two', START, START);
  db.prepare(
    `INSERT INTO items(id, profile_id, kind, title, created_at, updated_at)
     VALUES (?, ?, 'note', ?, ?, ?)`
  ).run('item-one', 'profile-one', 'One', START, START);
  db.prepare(
    `INSERT INTO items(id, profile_id, kind, title, created_at, updated_at)
     VALUES (?, ?, 'note', ?, ?, ?)`
  ).run('item-two', 'profile-two', 'Two', START, START);

  let currentTime = START;
  let sequence = 0;
  const changes = [];
  const repositoryUtils = createRepositoryUtils({
    db,
    ids: () => `learning-${String((sequence += 1)).padStart(3, '0')}`,
    now: () => currentTime,
  });
  const repository = createLearningRepository({ db, repositoryUtils });
  const service = createLearningService({
    repository,
    syncRecorder: {
      recordChange(change) {
        changes.push(change);
      },
    },
  });

  return {
    changes,
    db,
    repository,
    service,
    setTime(value) {
      currentTime = value;
    },
  };
}

test('flashcard lifecycle is owner scoped and records synchronized mutations', t => {
  const context = fixture();
  t.after(() => context.db.close());

  const card = context.service.createFlashcard({
    profileId: 'profile-one',
    itemId: 'item-one',
    prompt: 'Question?',
    answer: 'Answer.',
  });

  assert.equal(card.profile_id, 'profile-one');
  assert.equal(card.revision, 1);
  assert.equal(context.changes.length, 1);
  assert.equal(context.changes[0].entityType, 'flashcard');
  assert.throws(
    () => context.service.getFlashcard({ profileId: 'profile-two', id: card.id }),
    error => error instanceof DomainError && error.code === 'NOT_FOUND'
  );
  assert.throws(
    () =>
      context.service.createFlashcard({
        profileId: 'profile-one',
        itemId: 'item-two',
        prompt: 'Cross owner',
        answer: 'Rejected',
      }),
    error => error instanceof DomainError && error.code === 'NOT_FOUND'
  );
});

test('due cards are ordered deterministically and exclude suspended or deleted cards', t => {
  const context = fixture();
  t.after(() => context.db.close());

  const later = context.service.createFlashcard({
    profileId: 'profile-one',
    prompt: 'Later',
    answer: 'L',
    dueAt: START + 2_000,
  });
  const first = context.service.createFlashcard({
    profileId: 'profile-one',
    prompt: 'First',
    answer: 'F',
    dueAt: START + 1_000,
  });
  const sameTime = context.service.createFlashcard({
    profileId: 'profile-one',
    prompt: 'Same',
    answer: 'S',
    dueAt: START + 1_000,
  });
  context.repository.setFlashcardState({
    profileId: 'profile-one',
    id: sameTime.id,
    expectedRevision: 1,
    state: 'suspended',
  });
  context.repository.tombstoneFlashcard({
    profileId: 'profile-one',
    id: later.id,
    expectedRevision: 1,
  });

  assert.deepEqual(
    context.service.listDueFlashcards({ profileId: 'profile-one', dueAt: START + 10_000 }).map(card => card.id),
    [first.id]
  );
});

test('reviews are deterministic and a repeated stale review cannot double-apply', t => {
  const context = fixture();
  t.after(() => context.db.close());
  const card = context.service.createFlashcard({
    profileId: 'profile-one',
    prompt: 'Question?',
    answer: 'Answer.',
    dueAt: START,
  });

  context.setTime(START + 500);
  const reviewed = context.service.reviewFlashcard({
    profileId: 'profile-one',
    id: card.id,
    expectedRevision: 1,
    quality: 5,
  });

  assert.equal(reviewed.interval_days, 1);
  assert.equal(reviewed.ease_factor, 2.6);
  assert.equal(reviewed.due_at, START + 500 + 86_400_000);
  assert.equal(reviewed.revision, 2);
  assert.throws(
    () =>
      context.service.reviewFlashcard({
        profileId: 'profile-one',
        id: card.id,
        expectedRevision: 1,
        quality: 5,
      }),
    error => error instanceof DomainError && error.code === 'CONFLICT'
  );
  assert.equal(context.changes.filter(change => change.changeKind === 'review').length, 1);
});

test('quiz results enforce score invariants and feed owner-scoped statistics', t => {
  const context = fixture();
  t.after(() => context.db.close());

  context.service.recordQuizResult({
    profileId: 'profile-one',
    itemId: 'item-one',
    quizKind: 'recall',
    score: 4,
    maxScore: 5,
    answers: { one: true },
  });
  context.service.recordQuizResult({
    profileId: 'profile-two',
    itemId: 'item-two',
    quizKind: 'recall',
    score: 1,
    maxScore: 5,
    answers: {},
  });

  assert.deepEqual(context.service.statistics({ profileId: 'profile-one', dueAt: START }), {
    activeFlashcards: 0,
    averageQuizPercent: 80,
    dueFlashcards: 0,
    quizAttempts: 1,
  });
  assert.throws(
    () =>
      context.service.recordQuizResult({
        profileId: 'profile-one',
        quizKind: 'recall',
        score: 6,
        maxScore: 5,
        answers: {},
      }),
    error => error instanceof DomainError && error.code === 'REPOSITORY_INPUT_INVALID'
  );
});

test('digest periods are validated and remain owner scoped', t => {
  const context = fixture();
  t.after(() => context.db.close());

  const digest = context.service.createDigest({
    profileId: 'profile-one',
    title: 'Week',
    body: 'Summary',
    periodStart: START,
    periodEnd: START + 7 * 86_400_000,
  });

  assert.equal(context.service.listDigests({ profileId: 'profile-one' }).items[0].id, digest.id);
  assert.equal(context.service.listDigests({ profileId: 'profile-two' }).items.length, 0);
  assert.throws(
    () =>
      context.service.createDigest({
        profileId: 'profile-one',
        title: 'Invalid',
        body: '',
        periodStart: START + 1,
        periodEnd: START,
      }),
    error => error instanceof DomainError && error.code === 'REPOSITORY_INPUT_INVALID'
  );
});

test('tombstoning a flashcard advances its revision and hides it from normal reads', t => {
  const context = fixture();
  t.after(() => context.db.close());
  const card = context.service.createFlashcard({
    profileId: 'profile-one',
    prompt: 'Delete me',
    answer: 'Gone',
  });

  const tombstone = context.service.deleteFlashcard({
    profileId: 'profile-one',
    id: card.id,
    expectedRevision: 1,
  });

  assert.equal(tombstone.deleted_at, START);
  assert.equal(tombstone.revision, 2);
  assert.throws(
    () => context.service.getFlashcard({ profileId: 'profile-one', id: card.id }),
    error => error instanceof DomainError && error.code === 'NOT_FOUND'
  );
});
