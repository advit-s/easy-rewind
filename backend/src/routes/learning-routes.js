'use strict';

const { createHttpError } = require('../http/error-handler');
const { asyncRoute, authenticated, getRequestContext, requireService } = require('./route-utils');

function invalid() {
  throw createHttpError('validation_failed');
}

function integer(value, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  const normalized = typeof value === 'string' && /^(?:0|[1-9]\d*)$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(normalized) || normalized < minimum || normalized > maximum) {
    invalid();
  }
  return normalized;
}

function text(value, { optional = false } = {}) {
  if (optional && (value === undefined || value === null)) return null;
  if (typeof value !== 'string' || value.length === 0 || value.length > 100_000 || value.trim() !== value) {
    invalid();
  }
  return value;
}

function profileId(request) {
  return getRequestContext(request).profileId;
}

function createLearningRouter({ learningService, authMiddleware } = {}) {
  if (learningService === null || typeof learningService !== 'object') {
    throw new TypeError('Learning route dependencies are invalid');
  }
  const express = require('express');
  const router = express.Router();
  const protect = authenticated(authMiddleware);

  router.post(
    '/v1/flashcards',
    protect,
    asyncRoute(async (request, response) => {
      const create = requireService(learningService, 'createFlashcard');
      const result = await create({
        profileId: profileId(request),
        itemId: text(request.body.itemId, { optional: true }),
        prompt: text(request.body.prompt),
        answer: text(request.body.answer),
        dueAt: request.body.dueAt === undefined ? undefined : integer(request.body.dueAt),
      });
      response.status(201).json({ flashcard: result });
    })
  );

  router.get(
    '/v1/flashcards/due',
    protect,
    asyncRoute(async (request, response) => {
      const list = requireService(learningService, 'listDueFlashcards');
      const result = await list({
        profileId: profileId(request),
        dueAt: integer(request.query.dueAt),
        limit: request.query.limit === undefined ? 100 : integer(request.query.limit, { minimum: 1, maximum: 100 }),
      });
      response.status(200).json({ items: result });
    })
  );

  router.get(
    '/v1/flashcards/:id',
    protect,
    asyncRoute(async (request, response) => {
      const get = requireService(learningService, 'getFlashcard');
      const result = await get({
        profileId: profileId(request),
        id: text(request.params.id),
      });
      response.status(200).json({ flashcard: result });
    })
  );

  router.post(
    '/v1/flashcards/:id/reviews',
    protect,
    asyncRoute(async (request, response) => {
      const review = requireService(learningService, 'reviewFlashcard');
      const result = await review({
        profileId: profileId(request),
        id: text(request.params.id),
        expectedRevision: integer(request.body.expectedRevision, { minimum: 1 }),
        quality: integer(request.body.quality, { maximum: 5 }),
      });
      response.status(200).json({ flashcard: result });
    })
  );

  router.delete(
    '/v1/flashcards/:id',
    protect,
    asyncRoute(async (request, response) => {
      const remove = requireService(learningService, 'deleteFlashcard');
      const result = await remove({
        profileId: profileId(request),
        id: text(request.params.id),
        expectedRevision: integer(request.body.expectedRevision, { minimum: 1 }),
      });
      response.status(200).json({ flashcard: result });
    })
  );

  router.post(
    '/v1/quizzes/results',
    protect,
    asyncRoute(async (request, response) => {
      const record = requireService(learningService, 'recordQuizResult');
      const result = await record({
        profileId: profileId(request),
        itemId: text(request.body.itemId, { optional: true }),
        quizKind: text(request.body.quizKind),
        score: integer(request.body.score),
        maxScore: integer(request.body.maxScore, { minimum: 1 }),
        answers: request.body.answers,
      });
      response.status(201).json({ quizResult: result });
    })
  );

  router.get(
    '/v1/learning/statistics',
    protect,
    asyncRoute(async (request, response) => {
      const statistics = requireService(learningService, 'statistics');
      const result = await statistics({
        profileId: profileId(request),
        dueAt: integer(request.query.dueAt),
      });
      response.status(200).json({ statistics: result });
    })
  );

  router.post(
    '/v1/digests',
    protect,
    asyncRoute(async (request, response) => {
      const create = requireService(learningService, 'createDigest');
      const result = await create({
        profileId: profileId(request),
        title: text(request.body.title),
        body:
          typeof request.body.body === 'string' && request.body.body.length <= 1_000_000
            ? request.body.body
            : invalid(),
        periodStart: integer(request.body.periodStart),
        periodEnd: integer(request.body.periodEnd),
      });
      response.status(201).json({ digest: result });
    })
  );

  router.get(
    '/v1/digests',
    protect,
    asyncRoute(async (request, response) => {
      const list = requireService(learningService, 'listDigests');
      const result = await list({
        profileId: profileId(request),
        cursor: request.query.cursor === undefined ? undefined : text(request.query.cursor),
        limit: request.query.limit === undefined ? 25 : integer(request.query.limit, { minimum: 1, maximum: 100 }),
      });
      response.status(200).json(result);
    })
  );

  return router;
}

module.exports = { createLearningRouter };
