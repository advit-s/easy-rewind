'use strict';

const { createHttpError } = require('../http/error-handler');
const { asyncRoute, authenticated, getRequestContext, requireService } = require('./route-utils');

function invalid() {
  throw createHttpError('validation_failed');
}

function text(value, maximum = 20_000, optional = false) {
  if (optional && (value === undefined || value === null)) return null;
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || value.trim() !== value) {
    invalid();
  }
  return value;
}

function positiveInteger(value) {
  if (!Number.isSafeInteger(value) || value < 1) invalid();
  return value;
}

function createResearchRouter({ researchService, authMiddleware } = {}) {
  if (researchService === null || typeof researchService !== 'object') {
    throw new TypeError('Research route dependencies are invalid');
  }
  const express = require('express');
  const router = express.Router();
  const protect = authenticated(authMiddleware);

  router.post(
    '/v1/research',
    protect,
    asyncRoute(async (request, response) => {
      const queue = requireService(researchService, 'queue');
      const result = await queue({
        profileId: getRequestContext(request).profileId,
        query: text(request.body.query),
        sourceUrl: text(request.body.sourceUrl, 2_048),
        provider: text(request.body.provider, 128),
        model: text(request.body.model, 128),
        idempotencyKey: text(request.body.idempotencyKey, 256, true),
      });
      response.status(result.state === 'queued' ? 202 : 200).json(result);
    })
  );

  router.get(
    '/v1/research/:id',
    protect,
    asyncRoute(async (request, response) => {
      const get = requireService(researchService, 'get');
      const result = await get({
        profileId: getRequestContext(request).profileId,
        id: text(request.params.id, 256),
      });
      response.status(200).json({ research: result });
    })
  );

  router.post(
    '/v1/research/:id/cancel',
    protect,
    asyncRoute(async (request, response) => {
      const cancel = requireService(researchService, 'cancel');
      const result = await cancel({
        profileId: getRequestContext(request).profileId,
        id: text(request.params.id, 256),
        expectedRevision: positiveInteger(request.body.expectedRevision),
      });
      response.status(200).json({ research: result });
    })
  );

  return router;
}

module.exports = { createResearchRouter };
