'use strict';

const { createHttpError } = require('../http/error-handler');
const {
  asyncRoute,
  authenticated,
  getRequestContext,
  hasProviderCredential,
  requireService,
  requireValid,
} = require('./route-utils');

let syncContractsPromise;

function contracts() {
  syncContractsPromise ??= import('../../../packages/contracts/src/sync.js');
  return syncContractsPromise;
}

function invalid() {
  throw createHttpError('validation_failed');
}

function text(value, maximum = 512) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximum ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    invalid();
  }
  return value;
}

function integer(value, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) invalid();
  return value;
}

function requireDevice(request) {
  const context = getRequestContext(request);
  const deviceId = text(request.body.deviceId);
  if (context.authenticationType !== 'sync_device' || context.deviceId !== deviceId) {
    throw createHttpError('forbidden');
  }
  return context;
}

function createSyncRouter({ syncService, authMiddleware } = {}) {
  if (syncService === null || typeof syncService !== 'object') {
    throw new TypeError('Sync route dependencies are invalid');
  }
  const express = require('express');
  const router = express.Router();
  const protect = authenticated(authMiddleware);

  router.post(
    '/v1/sync/push',
    protect,
    asyncRoute(async (request, response) => {
      const sync = await contracts();
      requireValid(sync.validateSyncPushRequest(request.body));
      if (hasProviderCredential(request.body)) invalid();
      const context = requireDevice(request);
      const result = await requireService(syncService, 'push')({ context, request: request.body });
      requireValid(sync.validateSyncPushResponse(result));
      response.status(200).json(result);
    })
  );

  router.post(
    '/v1/sync/pull',
    protect,
    asyncRoute(async (request, response) => {
      const sync = await contracts();
      requireValid(sync.validateSyncPullRequest(request.body));
      const context = requireDevice(request);
      const result = await requireService(syncService, 'pull')({ context, request: request.body });
      requireValid(sync.validateSyncPullResponse(result));
      response.status(200).json(result);
    })
  );

  router.post(
    '/v1/sync/acknowledgements',
    protect,
    asyncRoute(async (request, response) => {
      if (
        request.body === null ||
        typeof request.body !== 'object' ||
        Array.isArray(request.body) ||
        Object.keys(request.body).some(key => !['deviceId', 'sequence'].includes(key))
      ) {
        invalid();
      }
      const context = requireDevice(request);
      const result = await requireService(
        syncService,
        'acknowledge'
      )({
        profileId: context.profileId,
        deviceId: context.deviceId,
        sequence: integer(request.body.sequence),
      });
      response.status(200).json(result);
    })
  );

  router.get(
    '/v1/sync/conflicts',
    protect,
    asyncRoute(async (request, response) => {
      const context = getRequestContext(request);
      if (context.authenticationType !== 'sync_device' || typeof context.deviceId !== 'string') {
        throw createHttpError('forbidden');
      }
      const result = await requireService(
        syncService,
        'listConflicts'
      )({
        profileId: context.profileId,
        cursor: request.query.cursor === undefined ? undefined : text(request.query.cursor),
        limit:
          request.query.limit === undefined ? 25 : integer(Number(request.query.limit), { minimum: 1, maximum: 100 }),
      });
      response.status(200).json(result);
    })
  );

  router.post(
    '/v1/sync/conflicts/:id/resolve',
    protect,
    asyncRoute(async (request, response) => {
      const context = getRequestContext(request);
      if (context.authenticationType !== 'sync_device' || typeof context.deviceId !== 'string') {
        throw createHttpError('forbidden');
      }
      if (
        request.body === null ||
        typeof request.body !== 'object' ||
        Array.isArray(request.body) ||
        Object.keys(request.body).some(key => !['resolution', 'mergedPayload'].includes(key)) ||
        !['server', 'client', 'merged'].includes(request.body.resolution) ||
        (request.body.resolution === 'merged' &&
          (request.body.mergedPayload === null ||
            typeof request.body.mergedPayload !== 'object' ||
            Array.isArray(request.body.mergedPayload) ||
            hasProviderCredential(request.body.mergedPayload)))
      ) {
        invalid();
      }
      const result = await requireService(
        syncService,
        'resolveConflict'
      )({
        profileId: context.profileId,
        conflictId: text(request.params.id),
        resolution: request.body.resolution,
        mergedPayload: request.body.mergedPayload,
      });
      response.status(200).json(result);
    })
  );

  router.post(
    '/v1/sync/snapshots',
    protect,
    asyncRoute(async (request, response) => {
      if (
        request.body === null ||
        typeof request.body !== 'object' ||
        Array.isArray(request.body) ||
        Object.keys(request.body).some(key => key !== 'deviceId')
      ) {
        invalid();
      }
      const context = requireDevice(request);
      const result = await requireService(
        syncService,
        'createSnapshot'
      )({
        profileId: context.profileId,
        deviceId: context.deviceId,
      });
      response.status(201).json(result);
    })
  );

  return router;
}

module.exports = { createSyncRouter };
