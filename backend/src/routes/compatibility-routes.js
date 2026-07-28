'use strict';

const { createHttpError } = require('../http/error-handler');
const { createLocalAuthMiddleware } = require('../auth/auth-middleware');
const {
  asyncRoute,
  authenticated,
  getRequestContext,
  hasProviderCredential,
  withoutProviderCredentials,
} = require('./route-utils');

const ROUTES = Object.freeze([
  ['get', '/items', 'items.list', true],
  ['get', '/items/search', 'items.search'],
  ['post', '/items', 'items.create'],
  ['delete', '/items/:id', 'items.delete'],
  ['get', '/items/:id/related', 'items.related'],
  ['post', '/items/:id/connect', 'items.connect'],
  ['post', '/highlights', 'highlights.create'],
  ['get', '/highlights', 'highlights.list', true],
  ['get', '/highlights/stats', 'highlights.stats'],
  ['delete', '/highlights/:id', 'highlights.delete'],
  ['get', '/settings', 'settings.read'],
  ['post', '/settings', 'settings.update'],
  ['post', '/quick-lookup', 'lookup.quick'],
  ['post', '/page-summary', 'pages.summarize'],
  ['post', '/analyze-url', 'urls.analyze'],
  ['post', '/bookmark', 'bookmarks.create'],
  ['get', '/bookmarks', 'bookmarks.list', true],
  ['delete', '/bookmark/:id', 'bookmarks.delete'],
  ['post', '/notes', 'notes.create'],
  ['get', '/notes', 'notes.list', true],
  ['patch', '/notes/:id/toggle', 'notes.toggle'],
  ['delete', '/notes/:id', 'notes.delete'],
  ['post', '/research', 'research.create'],
  ['get', '/research', 'research.list', true],
  ['get', '/reminders', 'reminders.list', true],
  ['patch', '/reminders/:id', 'reminders.update'],
  ['get', '/search', 'search.query'],
  ['get', '/export', 'data.export'],
  ['post', '/import', 'data.import'],
  ['get', '/knowledge-graph', 'knowledgeGraph.read'],
  ['post', '/connections/discover', 'connections.discover'],
  ['get', '/digest', 'digest.list', true],
  ['post', '/digest/generate', 'digest.generate'],
  ['get', '/digest/settings', 'digestSettings.read'],
  ['post', '/digest/settings', 'digestSettings.update'],
]);

let paginationPromise;

function loadPaginationContract() {
  paginationPromise ??= import('../../../packages/contracts/src/pagination.js');
  return paginationPromise;
}

async function readPagination(query) {
  if (query.offset !== undefined || query.page !== undefined || query.pageSize !== undefined) {
    throw createHttpError('validation_failed');
  }
  const pagination = {};
  if (query.cursor !== undefined) pagination.cursor = query.cursor;
  if (query.limit !== undefined) {
    if (!/^[1-9][0-9]*$/.test(query.limit)) throw createHttpError('validation_failed');
    pagination.limit = Number(query.limit);
  }
  const { validatePaginationRequest } = await loadPaginationContract();
  if (!validatePaginationRequest(pagination).valid) throw createHttpError('validation_failed');
  return pagination;
}

function sendResult(response, result) {
  const status = result !== null && typeof result === 'object' && Number.isInteger(result.status) ? result.status : 200;
  const body = result !== null && typeof result === 'object' && Object.hasOwn(result, 'body') ? result.body : result;
  if (status === 204) {
    response.status(status).end();
    return;
  }
  response.status(status).json(withoutProviderCredentials(body));
}

function createCompatibilityRouter({ health, ...dependencies } = {}) {
  if (typeof health !== 'function') throw new TypeError('Compatibility health dependency is invalid');
  const express = require('express');
  const router = express.Router();
  const canInstallAuthenticate = typeof dependencies.installTokenService?.authenticate === 'function';
  const canBrowserAuthenticate = typeof dependencies.browserSessionService?.authenticate === 'function';
  const auth =
    typeof dependencies.compatibilityAuthMiddleware === 'function'
      ? dependencies.compatibilityAuthMiddleware
      : canInstallAuthenticate || canBrowserAuthenticate
        ? createLocalAuthMiddleware(dependencies)
        : undefined;

  router.get(
    '/health',
    asyncRoute(async (_request, response) => {
      response.status(200).json(await health());
    })
  );

  for (const [method, path, operation, paginated] of ROUTES) {
    router[method](
      path,
      authenticated(auth),
      asyncRoute(async (request, response) => {
        if (hasProviderCredential(request.body)) throw createHttpError('validation_failed');
        if (
          dependencies.compatibilityService === null ||
          typeof dependencies.compatibilityService !== 'object' ||
          typeof dependencies.compatibilityService.handle !== 'function'
        ) {
          throw createHttpError('not_implemented');
        }
        const pagination = paginated ? await readPagination(request.query) : undefined;
        const result = await dependencies.compatibilityService.handle({
          operation,
          context: getRequestContext(request),
          params: { ...request.params },
          query: { ...request.query },
          body: request.body,
          pagination,
        });
        if (result === undefined) throw createHttpError('not_implemented');
        if (
          paginated &&
          result !== null &&
          typeof result === 'object' &&
          Array.isArray(result.items) &&
          Object.hasOwn(result, 'nextCursor') &&
          Object.hasOwn(result, 'hasMore')
        ) {
          const { validatePaginationResponse } = await loadPaginationContract();
          if (!validatePaginationResponse(result).valid) throw createHttpError('internal_error');
        }
        sendResult(response, result);
      })
    );
  }

  return router;
}

module.exports = { createCompatibilityRouter };
