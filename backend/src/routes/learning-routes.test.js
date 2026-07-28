'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const express = require('express');
const request = require('supertest');
const { setRequestContext } = require('../http/request-context');
const { errorHandler } = require('../http/error-handler');
const { createLearningRouter } = require('./learning-routes');

function fixture(overrides = {}) {
  const calls = [];
  const service = {
    createFlashcard(input) {
      calls.push(['createFlashcard', input]);
      return { id: 'card-one', profile_id: input.profileId };
    },
    getFlashcard(input) {
      calls.push(['getFlashcard', input]);
      return { id: input.id, profile_id: input.profileId };
    },
    listDueFlashcards(input) {
      calls.push(['listDueFlashcards', input]);
      return [];
    },
    reviewFlashcard(input) {
      calls.push(['reviewFlashcard', input]);
      return { id: input.id, profile_id: input.profileId, revision: 2 };
    },
    deleteFlashcard(input) {
      calls.push(['deleteFlashcard', input]);
      return { id: input.id, deleted_at: 1 };
    },
    recordQuizResult(input) {
      calls.push(['recordQuizResult', input]);
      return { id: 'quiz-one', profile_id: input.profileId };
    },
    statistics(input) {
      calls.push(['statistics', input]);
      return { quizAttempts: 0 };
    },
    createDigest(input) {
      calls.push(['createDigest', input]);
      return { id: 'digest-one', profile_id: input.profileId };
    },
    listDigests(input) {
      calls.push(['listDigests', input]);
      return { items: [], nextCursor: null, hasMore: false };
    },
    ...overrides,
  };
  const authMiddleware = (incoming, _response, next) => {
    setRequestContext(incoming, {
      authenticationType: 'install',
      credentialId: 'credential-one',
      profileId: 'profile-one',
    });
    next();
  };
  const app = express();
  app.use(express.json());
  app.use(createLearningRouter({ learningService: service, authMiddleware }));
  app.use(errorHandler);
  return { app, calls };
}

test('flashcard routes derive ownership only from immutable authentication context', async () => {
  const context = fixture();

  const response = await request(context.app).post('/v1/flashcards').send({
    itemId: 'item-one',
    prompt: 'Question?',
    answer: 'Answer.',
    dueAt: 1_800_000_000_000,
  });

  assert.equal(response.status, 201);
  assert.deepEqual(context.calls[0], [
    'createFlashcard',
    {
      profileId: 'profile-one',
      itemId: 'item-one',
      prompt: 'Question?',
      answer: 'Answer.',
      dueAt: 1_800_000_000_000,
    },
  ]);

  const rejected = await request(context.app)
    .post('/v1/flashcards')
    .send({ profileId: 'profile-two', prompt: 'Override', answer: 'No' });
  assert.equal(rejected.status, 403);
  assert.equal(context.calls.length, 1);
});

test('due, review, and delete routes pass bounded validated input to the service', async () => {
  const context = fixture();

  assert.equal((await request(context.app).get('/v1/flashcards/due?dueAt=1800000000000&limit=25')).status, 200);
  assert.equal(
    (await request(context.app).post('/v1/flashcards/card-one/reviews').send({ expectedRevision: 1, quality: 5 }))
      .status,
    200
  );
  assert.equal(
    (await request(context.app).delete('/v1/flashcards/card-one').send({ expectedRevision: 2 })).status,
    200
  );

  assert.deepEqual(context.calls, [
    ['listDueFlashcards', { profileId: 'profile-one', dueAt: 1_800_000_000_000, limit: 25 }],
    ['reviewFlashcard', { profileId: 'profile-one', id: 'card-one', expectedRevision: 1, quality: 5 }],
    ['deleteFlashcard', { profileId: 'profile-one', id: 'card-one', expectedRevision: 2 }],
  ]);

  assert.equal((await request(context.app).get('/v1/flashcards/due?dueAt=bad')).status, 400);
});

test('quiz, statistics, and digest routes expose the learning service', async () => {
  const context = fixture();

  assert.equal(
    (
      await request(context.app)
        .post('/v1/quizzes/results')
        .send({
          itemId: 'item-one',
          quizKind: 'recall',
          score: 4,
          maxScore: 5,
          answers: { one: true },
        })
    ).status,
    201
  );
  assert.equal((await request(context.app).get('/v1/learning/statistics?dueAt=1800000000000')).status, 200);
  assert.equal(
    (
      await request(context.app).post('/v1/digests').send({
        title: 'Week',
        body: 'Summary',
        periodStart: 1_700_000_000_000,
        periodEnd: 1_800_000_000_000,
      })
    ).status,
    201
  );
  assert.equal((await request(context.app).get('/v1/digests?limit=10')).status, 200);
  assert.deepEqual(
    context.calls.map(call => call[0]),
    ['recordQuizResult', 'statistics', 'createDigest', 'listDigests']
  );
});
