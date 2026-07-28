'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const express = require('express');
const supertest = require('supertest');

const { errorHandler } = require('../http/error-handler');
const { setRequestContext } = require('../http/request-context');
const { createContentRouter } = require('./content-routes');

const PROFILE_ID = '10000000-0000-4000-8000-000000000001';
const OTHER_PROFILE_ID = '10000000-0000-4000-8000-000000000002';

function authenticate(request, _response, next) {
  setRequestContext(request, {
    authenticationType: 'browser_session',
    profileId: PROFILE_ID,
    sessionId: 'session_abcdefghijklmnop',
  });
  next();
}

function appWith({ contentService = {}, graphService = {}, auth = authenticate } = {}) {
  const app = express();
  app.use((request, _response, next) => {
    Object.defineProperty(request, 'requestId', {
      value: 'request_content_routes_0001',
    });
    next();
  });
  app.use(express.json());
  app.use(
    createContentRouter({
      contentService,
      graphService,
      localAuthMiddleware: auth,
    })
  );
  app.use(errorHandler);
  return app;
}

test('item routes derive ownership only from immutable auth context and preserve pagination envelopes', async () => {
  const calls = [];
  const service = {
    createItem(input) {
      calls.push(['create', input]);
      return { id: 'item-1', profileId: input.profileId, revision: 1 };
    },
    listItems(input) {
      calls.push(['list', input]);
      return { items: [{ id: 'item-1' }], nextCursor: null, hasMore: false };
    },
    getItem(input) {
      calls.push(['get', input]);
      return { id: input.id, revision: 1 };
    },
    updateItem(input) {
      calls.push(['update', input]);
      return { id: input.id, revision: 2 };
    },
    deleteItem(input) {
      calls.push(['delete', input]);
      return { id: input.id, revision: 3, deletedAt: 3 };
    },
  };
  const app = appWith({ contentService: service });

  await supertest(app).post('/v1/items').send({ kind: 'note', title: 'Created' }).expect(201);
  const page = await supertest(app).get('/v1/items?limit=10&cursor=opaque&includeArchived=true').expect(200);
  assert.deepEqual(page.body, { items: [{ id: 'item-1' }], nextCursor: null, hasMore: false });
  await supertest(app).get('/v1/items/item-1').expect(200);
  await supertest(app)
    .patch('/v1/items/item-1')
    .send({ expectedRevision: 1, patch: { title: 'Changed' } })
    .expect(200);
  await supertest(app).delete('/v1/items/item-1').send({ expectedRevision: 2 }).expect(200);

  assert.deepEqual(calls, [
    ['create', { profileId: PROFILE_ID, item: { kind: 'note', title: 'Created' } }],
    ['list', { profileId: PROFILE_ID, cursor: 'opaque', limit: 10, includeArchived: true }],
    ['get', { profileId: PROFILE_ID, id: 'item-1' }],
    ['update', { profileId: PROFILE_ID, id: 'item-1', expectedRevision: 1, patch: { title: 'Changed' } }],
    ['delete', { profileId: PROFILE_ID, id: 'item-1', expectedRevision: 2 }],
  ]);

  const override = await supertest(app)
    .post('/v1/items')
    .send({ profileId: OTHER_PROFILE_ID, kind: 'note' })
    .expect(403);
  assert.equal(override.body.error.code, 'forbidden');
  assert.equal(JSON.stringify(override.body).includes(OTHER_PROFILE_ID), false);
});

test('content collection routes map authenticated inputs without accepting owner fields', async () => {
  const calls = [];
  const contentService = {
    createBookmark(input) {
      calls.push(['bookmark', input]);
      return { id: 'bookmark-1', revision: 1 };
    },
    createNote(input) {
      calls.push(['note', input]);
      return { id: 'note-1', revision: 1 };
    },
    createHighlight(input) {
      calls.push(['highlight', input]);
      return { id: 'highlight-1', revision: 1 };
    },
    createTag(input) {
      calls.push(['tag', input]);
      return { id: 'tag-1', revision: 1 };
    },
    tagItem(input) {
      calls.push(['item_tag', input]);
      return { id: 'item-tag-1', revision: 1 };
    },
    listEntities(input) {
      calls.push(['list', input]);
      return { items: [{ id: 'note-1' }], nextCursor: null, hasMore: false };
    },
    getEntity(input) {
      calls.push(['get', input]);
      return { id: input.id, revision: 1 };
    },
    updateEntity(input) {
      calls.push(['update', input]);
      return { id: input.id, revision: 2 };
    },
    deleteEntity(input) {
      calls.push(['delete', input]);
      return { id: input.id, revision: 2, deletedAt: 3 };
    },
    searchItems(input) {
      calls.push(['search', input]);
      return [{ id: 'item-1' }];
    },
  };
  const app = appWith({ contentService });

  await supertest(app).post('/v1/bookmarks').send({ itemId: 'item-1' }).expect(201);
  await supertest(app).post('/v1/notes').send({ itemId: 'item-1', body: 'Body' }).expect(201);
  await supertest(app).post('/v1/highlights').send({ itemId: 'item-1', quote: 'Quote', color: 'yellow' }).expect(201);
  await supertest(app).post('/v1/tags').send({ name: 'Topic' }).expect(201);
  await supertest(app).post('/v1/item-tags').send({ itemId: 'item-1', tagId: 'tag-1' }).expect(201);
  await supertest(app).get('/v1/notes?limit=5&cursor=opaque').expect(200);
  await supertest(app).get('/v1/notes/note-1').expect(200);
  await supertest(app)
    .patch('/v1/notes/note-1')
    .send({ expectedRevision: 1, patch: { body: 'Changed' } })
    .expect(200);
  await supertest(app).delete('/v1/tags/tag-1').send({ expectedRevision: 1 }).expect(200);
  const search = await supertest(app).get('/v1/search?q=term&limit=8').expect(200);
  assert.deepEqual(search.body, { items: [{ id: 'item-1' }], nextCursor: null, hasMore: false });

  assert.deepEqual(calls, [
    ['bookmark', { profileId: PROFILE_ID, itemId: 'item-1' }],
    ['note', { profileId: PROFILE_ID, itemId: 'item-1', body: 'Body' }],
    ['highlight', { profileId: PROFILE_ID, itemId: 'item-1', quote: 'Quote', color: 'yellow' }],
    ['tag', { profileId: PROFILE_ID, name: 'Topic' }],
    ['item_tag', { profileId: PROFILE_ID, itemId: 'item-1', tagId: 'tag-1' }],
    ['list', { profileId: PROFILE_ID, entity: 'note', cursor: 'opaque', limit: 5 }],
    ['get', { profileId: PROFILE_ID, entity: 'note', id: 'note-1' }],
    [
      'update',
      {
        profileId: PROFILE_ID,
        entity: 'note',
        id: 'note-1',
        expectedRevision: 1,
        patch: { body: 'Changed' },
      },
    ],
    ['delete', { profileId: PROFILE_ID, entity: 'tag', id: 'tag-1', expectedRevision: 1 }],
    ['search', { profileId: PROFILE_ID, query: 'term', limit: 8 }],
  ]);
});

test('connection and graph routes preserve edge direction and authenticated ownership', async () => {
  const calls = [];
  const graphService = {
    createConnection(input) {
      calls.push(['create', input]);
      return { id: 'connection-1', ...input, revision: 1 };
    },
    updateConnection(input) {
      calls.push(['update', input]);
      return { id: input.id, revision: 2 };
    },
    deleteConnection(input) {
      calls.push(['delete', input]);
      return { id: input.id, revision: 3, deletedAt: 3 };
    },
    listConnections(input) {
      calls.push(['list', input]);
      return { items: [{ id: 'connection-1' }], nextCursor: null, hasMore: false };
    },
    getConnection(input) {
      calls.push(['get', input]);
      return { id: input.id, revision: 1 };
    },
    relatedItems(input) {
      calls.push(['related', input]);
      return [{ id: 'item-2', direction: 'outgoing' }];
    },
    knowledgeGraph(input) {
      calls.push(['graph', input]);
      return { nodes: [], edges: [] };
    },
  };
  const app = appWith({ graphService });

  await supertest(app)
    .post('/v1/connections')
    .send({ sourceItemId: 'item-1', targetItemId: 'item-2', relation: 'supports' })
    .expect(201);
  await supertest(app).get('/v1/connections?limit=7&cursor=opaque').expect(200);
  await supertest(app).get('/v1/connections/connection-1').expect(200);
  await supertest(app)
    .patch('/v1/connections/connection-1')
    .send({ expectedRevision: 1, patch: { note: 'Updated' } })
    .expect(200);
  await supertest(app).delete('/v1/connections/connection-1').send({ expectedRevision: 2 }).expect(200);
  await supertest(app).get('/v1/items/item-1/related').expect(200);
  await supertest(app).get('/v1/knowledge-graph').expect(200);

  assert.deepEqual(calls, [
    [
      'create',
      {
        profileId: PROFILE_ID,
        sourceItemId: 'item-1',
        targetItemId: 'item-2',
        relation: 'supports',
      },
    ],
    ['list', { profileId: PROFILE_ID, cursor: 'opaque', limit: 7 }],
    ['get', { profileId: PROFILE_ID, id: 'connection-1' }],
    [
      'update',
      {
        profileId: PROFILE_ID,
        id: 'connection-1',
        expectedRevision: 1,
        patch: { note: 'Updated' },
      },
    ],
    ['delete', { profileId: PROFILE_ID, id: 'connection-1', expectedRevision: 2 }],
    ['related', { profileId: PROFILE_ID, itemId: 'item-1' }],
    ['graph', { profileId: PROFILE_ID }],
  ]);
});

test('missing service capabilities and invalid query values use stable safe errors', async () => {
  const app = appWith();
  const missing = await supertest(app).get('/v1/items').expect(501);
  assert.equal(missing.body.error.code, 'not_implemented');

  const invalid = await supertest(
    appWith({
      contentService: {
        listItems() {
          throw new Error('must not be called');
        },
      },
    })
  )
    .get('/v1/items?limit=101')
    .expect(400);
  assert.equal(invalid.body.error.code, 'validation_failed');
});
