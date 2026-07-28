'use strict';

const { createHttpError } = require('../http/error-handler');
const { asyncRoute, authenticated, getRequestContext, requireService } = require('./route-utils');

function objectBody(request) {
  if (request.body === null || typeof request.body !== 'object' || Array.isArray(request.body)) {
    throw createHttpError('validation_failed');
  }
  return request.body;
}

function integer(value, { optional = false, minimum = 1, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (optional && value === undefined) return undefined;
  const parsed =
    typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw createHttpError('validation_failed');
  }
  return parsed;
}

function requiredText(value) {
  if (typeof value !== 'string' || value.trim() === '') throw createHttpError('validation_failed');
  return value;
}

function pagination(query) {
  const result = {
    profileId: undefined,
    cursor: query.cursor,
    limit: integer(query.limit, { optional: true, maximum: 100 }) ?? 25,
    includeArchived: false,
  };
  if (query.cursor !== undefined && (typeof query.cursor !== 'string' || query.cursor === '')) {
    throw createHttpError('validation_failed');
  }
  if (query.includeArchived !== undefined) {
    if (!['true', 'false'].includes(query.includeArchived)) throw createHttpError('validation_failed');
    result.includeArchived = query.includeArchived === 'true';
  }
  return result;
}

function createContentRouter(dependencies = {}) {
  if (dependencies === null || typeof dependencies !== 'object') {
    throw new TypeError('Content route dependencies are invalid');
  }
  const express = require('express');
  const router = express.Router();
  const protect = authenticated(dependencies.localAuthMiddleware);
  const owner = request => getRequestContext(request).profileId;

  router.post(
    '/v1/items',
    protect,
    asyncRoute(async (request, response) => {
      const body = objectBody(request);
      const create = requireService(dependencies.contentService, 'createItem');
      const result = await create({ profileId: owner(request), item: body });
      response.status(201).json(result);
    })
  );

  router.get(
    '/v1/items',
    protect,
    asyncRoute(async (request, response) => {
      const list = requireService(dependencies.contentService, 'listItems');
      const input = pagination(request.query);
      input.profileId = owner(request);
      response.status(200).json(await list(input));
    })
  );

  router.get(
    '/v1/items/:id/related',
    protect,
    asyncRoute(async (request, response) => {
      const related = requireService(dependencies.graphService, 'relatedItems');
      const items = await related({ profileId: owner(request), itemId: requiredText(request.params.id) });
      response.status(200).json({ items, nextCursor: null, hasMore: false });
    })
  );

  router.get(
    '/v1/items/:id',
    protect,
    asyncRoute(async (request, response) => {
      const get = requireService(dependencies.contentService, 'getItem');
      response.status(200).json(await get({ profileId: owner(request), id: requiredText(request.params.id) }));
    })
  );

  router.patch(
    '/v1/items/:id',
    protect,
    asyncRoute(async (request, response) => {
      const body = objectBody(request);
      if (body.patch === null || typeof body.patch !== 'object' || Array.isArray(body.patch)) {
        throw createHttpError('validation_failed');
      }
      const update = requireService(dependencies.contentService, 'updateItem');
      response.status(200).json(
        await update({
          profileId: owner(request),
          id: requiredText(request.params.id),
          expectedRevision: integer(body.expectedRevision),
          patch: body.patch,
        })
      );
    })
  );

  router.delete(
    '/v1/items/:id',
    protect,
    asyncRoute(async (request, response) => {
      const body = objectBody(request);
      const remove = requireService(dependencies.contentService, 'deleteItem');
      response.status(200).json(
        await remove({
          profileId: owner(request),
          id: requiredText(request.params.id),
          expectedRevision: integer(body.expectedRevision),
        })
      );
    })
  );

  const createRoutes = [
    ['/v1/bookmarks', 'createBookmark', body => ({ itemId: requiredText(body.itemId) })],
    [
      '/v1/notes',
      'createNote',
      body => ({
        itemId: body.itemId === undefined || body.itemId === null ? null : requiredText(body.itemId),
        body: requiredText(body.body),
      }),
    ],
    [
      '/v1/highlights',
      'createHighlight',
      body => ({
        itemId: requiredText(body.itemId),
        quote: requiredText(body.quote),
        ...(body.prefix === undefined ? {} : { prefix: body.prefix }),
        ...(body.suffix === undefined ? {} : { suffix: body.suffix }),
        ...(body.color === undefined ? {} : { color: body.color }),
      }),
    ],
    ['/v1/tags', 'createTag', body => ({ name: requiredText(body.name) })],
    ['/v1/item-tags', 'tagItem', body => ({ itemId: requiredText(body.itemId), tagId: requiredText(body.tagId) })],
  ];

  for (const [path, method, map] of createRoutes) {
    router.post(
      path,
      protect,
      asyncRoute(async (request, response) => {
        const body = objectBody(request);
        const create = requireService(dependencies.contentService, method);
        response.status(201).json(await create({ profileId: owner(request), ...map(body) }));
      })
    );
  }

  for (const [collection, entity] of [
    ['bookmarks', 'bookmark'],
    ['notes', 'note'],
    ['highlights', 'highlight'],
    ['tags', 'tag'],
    ['item-tags', 'item_tag'],
  ]) {
    router.get(
      `/v1/${collection}`,
      protect,
      asyncRoute(async (request, response) => {
        const list = requireService(dependencies.contentService, 'listEntities');
        const cursor = request.query.cursor;
        if (cursor !== undefined && (typeof cursor !== 'string' || cursor === '')) {
          throw createHttpError('validation_failed');
        }
        response.status(200).json(
          await list({
            profileId: owner(request),
            entity,
            cursor,
            limit: integer(request.query.limit, { optional: true, maximum: 100 }) ?? 25,
          })
        );
      })
    );
    router.get(
      `/v1/${collection}/:id`,
      protect,
      asyncRoute(async (request, response) => {
        const get = requireService(dependencies.contentService, 'getEntity');
        response.status(200).json(
          await get({
            profileId: owner(request),
            entity,
            id: requiredText(request.params.id),
          })
        );
      })
    );
    router.patch(
      `/v1/${collection}/:id`,
      protect,
      asyncRoute(async (request, response) => {
        const body = objectBody(request);
        if (body.patch === null || typeof body.patch !== 'object' || Array.isArray(body.patch)) {
          throw createHttpError('validation_failed');
        }
        const update = requireService(dependencies.contentService, 'updateEntity');
        response.status(200).json(
          await update({
            profileId: owner(request),
            entity,
            id: requiredText(request.params.id),
            expectedRevision: integer(body.expectedRevision),
            patch: body.patch,
          })
        );
      })
    );
    router.delete(
      `/v1/${collection}/:id`,
      protect,
      asyncRoute(async (request, response) => {
        const body = objectBody(request);
        const remove = requireService(dependencies.contentService, 'deleteEntity');
        response.status(200).json(
          await remove({
            profileId: owner(request),
            entity,
            id: requiredText(request.params.id),
            expectedRevision: integer(body.expectedRevision),
          })
        );
      })
    );
  }

  router.get(
    '/v1/search',
    protect,
    asyncRoute(async (request, response) => {
      const search = requireService(dependencies.contentService, 'searchItems');
      const items = await search({
        profileId: owner(request),
        query: requiredText(request.query.q),
        limit: integer(request.query.limit, { optional: true, maximum: 100 }) ?? 25,
      });
      response.status(200).json({ items, nextCursor: null, hasMore: false });
    })
  );

  router.post(
    '/v1/connections',
    protect,
    asyncRoute(async (request, response) => {
      const body = objectBody(request);
      const create = requireService(dependencies.graphService, 'createConnection');
      response.status(201).json(
        await create({
          profileId: owner(request),
          sourceItemId: requiredText(body.sourceItemId),
          targetItemId: requiredText(body.targetItemId),
          relation: requiredText(body.relation),
          ...(body.note === undefined ? {} : { note: body.note }),
        })
      );
    })
  );

  router.get(
    '/v1/connections',
    protect,
    asyncRoute(async (request, response) => {
      const list = requireService(dependencies.graphService, 'listConnections');
      const cursor = request.query.cursor;
      if (cursor !== undefined && (typeof cursor !== 'string' || cursor === '')) {
        throw createHttpError('validation_failed');
      }
      response.status(200).json(
        await list({
          profileId: owner(request),
          cursor,
          limit: integer(request.query.limit, { optional: true, maximum: 100 }) ?? 25,
        })
      );
    })
  );

  router.get(
    '/v1/connections/:id',
    protect,
    asyncRoute(async (request, response) => {
      const get = requireService(dependencies.graphService, 'getConnection');
      response.status(200).json(
        await get({
          profileId: owner(request),
          id: requiredText(request.params.id),
        })
      );
    })
  );

  router.patch(
    '/v1/connections/:id',
    protect,
    asyncRoute(async (request, response) => {
      const body = objectBody(request);
      if (body.patch === null || typeof body.patch !== 'object' || Array.isArray(body.patch)) {
        throw createHttpError('validation_failed');
      }
      const update = requireService(dependencies.graphService, 'updateConnection');
      response.status(200).json(
        await update({
          profileId: owner(request),
          id: requiredText(request.params.id),
          expectedRevision: integer(body.expectedRevision),
          patch: body.patch,
        })
      );
    })
  );

  router.delete(
    '/v1/connections/:id',
    protect,
    asyncRoute(async (request, response) => {
      const body = objectBody(request);
      const remove = requireService(dependencies.graphService, 'deleteConnection');
      response.status(200).json(
        await remove({
          profileId: owner(request),
          id: requiredText(request.params.id),
          expectedRevision: integer(body.expectedRevision),
        })
      );
    })
  );

  router.get(
    '/v1/knowledge-graph',
    protect,
    asyncRoute(async (request, response) => {
      const graph = requireService(dependencies.graphService, 'knowledgeGraph');
      response.status(200).json(await graph({ profileId: owner(request) }));
    })
  );

  return router;
}

module.exports = { createContentRouter };
