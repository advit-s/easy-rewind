'use strict';

const { createHttpError } = require('../http/error-handler');
const { asyncRoute, authenticated, getRequestContext, requireService } = require('./route-utils');

function invalid() {
  throw createHttpError('validation_failed');
}

function identifier(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256 || value.trim() !== value) {
    invalid();
  }
  return value;
}

function strategy(value) {
  if (!new Set(['fail', 'skip', 'replace']).has(value)) invalid();
  return value;
}

function requireBundle(body) {
  const value = body?.bundle;
  if (value === undefined || value === null || (typeof value !== 'object' && typeof value !== 'string')) {
    invalid();
  }
  return value;
}

function mapServiceError(error) {
  if (error?.code === 'EXPORT_OWNER_NOT_FOUND' || error?.code === 'IMPORT_NOT_FOUND') {
    throw createHttpError('not_found');
  }
  if (
    error?.code === 'EXPORT_STATE_INVALID' ||
    error?.code === 'IMPORT_STATE_INVALID' ||
    error?.code === 'IMPORT_CONFLICT' ||
    error?.code === 'IMPORT_BACKUP_REQUIRED' ||
    error?.code === 'EXPORT_CANCELLED' ||
    error?.code === 'IMPORT_CANCELLED'
  ) {
    throw createHttpError('conflict');
  }
  if (
    typeof error?.code === 'string' &&
    (error.code.startsWith('IMPORT_') || error.code.startsWith('EXPORT_')) &&
    error.code !== 'IMPORT_APPLY_FAILED' &&
    error.code !== 'IMPORT_ROLLBACK_FAILED' &&
    error.code !== 'EXPORT_FAILED'
  ) {
    throw createHttpError('validation_failed');
  }
  throw error;
}

async function invoke(service, method, input) {
  try {
    return await requireService(service, method)(input);
  } catch (error) {
    return mapServiceError(error);
  }
}

function createImportExportRouter({ exportService, importService, authMiddleware } = {}) {
  if (
    exportService === null ||
    typeof exportService !== 'object' ||
    importService === null ||
    typeof importService !== 'object'
  ) {
    throw new TypeError('Import/export route dependencies are invalid');
  }
  const express = require('express');
  const router = express.Router();
  const protect = authenticated(authMiddleware);

  router.post(
    '/v1/exports',
    protect,
    asyncRoute(async (request, response) => {
      const result = await invoke(exportService, 'create', {
        profileId: getRequestContext(request).profileId,
      });
      response.status(201).json({
        runId: result.runId,
        state: result.state,
        checksum: result.checksum,
        bundle: result.bundle,
      });
    })
  );

  router.post(
    '/v1/exports/:id/cancel',
    protect,
    asyncRoute(async (request, response) => {
      const result = await invoke(exportService, 'cancel', {
        profileId: getRequestContext(request).profileId,
        runId: identifier(request.params.id),
      });
      response.status(200).json(result);
    })
  );

  router.post(
    '/v1/imports/dry-run',
    protect,
    asyncRoute(async (request, response) => {
      const report = await invoke(importService, 'dryRun', {
        profileId: getRequestContext(request).profileId,
        bundle: requireBundle(request.body),
      });
      response.status(200).json({ report });
    })
  );

  router.post(
    '/v1/imports',
    protect,
    asyncRoute(async (request, response) => {
      const result = await invoke(importService, 'apply', {
        profileId: getRequestContext(request).profileId,
        bundle: requireBundle(request.body),
        conflictStrategy: strategy(request.body?.conflictStrategy ?? 'fail'),
      });
      response.status(201).json({
        runId: result.runId,
        state: result.state,
        report: result.report,
        backupCreated: true,
      });
    })
  );

  router.post(
    '/v1/imports/:id/rollback',
    protect,
    asyncRoute(async (request, response) => {
      const result = await invoke(importService, 'rollback', {
        profileId: getRequestContext(request).profileId,
        runId: identifier(request.params.id),
      });
      response.status(200).json(result);
    })
  );

  router.post(
    '/v1/imports/:id/cancel',
    protect,
    asyncRoute(async (request, response) => {
      const result = await invoke(importService, 'cancel', {
        profileId: getRequestContext(request).profileId,
        runId: identifier(request.params.id),
      });
      response.status(200).json(result);
    })
  );

  return router;
}

module.exports = { createImportExportRouter };
