'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const supertest = require('supertest');

const { setRequestContext } = require('./request-context');
const { createApp } = require('./create-app');

const PROFILE_ID = '10000000-0000-4000-8000-000000000001';
const CURSOR = 'cursor_abcdefghijklmnopqrstu';
const HEALTH = Object.freeze({
  status: 'ok',
  version: '2.0.0',
  schemaVersion: 3,
  apiVersion: '1',
  mode: 'test',
  components: {
    database: { status: 'ready' },
    applicationApi: { status: 'ready' },
    scheduler: { status: 'disabled' },
    lanSync: { status: 'disabled' },
  },
});

function authenticated(request, _response, next) {
  setRequestContext(request, {
    authenticationType: 'browser_session',
    profileId: PROFILE_ID,
    sessionId: 'session_abcdefghijklmnop',
  });
  next();
}

function appWith(routeDependencies = {}, options = {}) {
  return createApp({
    health: async () => HEALTH,
    generateRequestId: () => 'request_compatibility_0001',
    routeDependencies: {
      compatibilityAuthMiddleware: authenticated,
      ...routeDependencies,
    },
    ...options,
  });
}

test('compatibility health aliases canonical sanitized health without authentication', async () => {
  const response = await supertest(appWith()).get('/api/health').expect(200);

  assert.deepEqual(response.body, HEALTH);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers['x-request-id'], 'request_compatibility_0001');
});

test('every endpoint called by current clients is registered and returns stable not_implemented', async () => {
  const app = appWith();
  const endpoints = [
    ['get', '/api/items'],
    ['get', '/api/items/search?q=term'],
    ['post', '/api/items'],
    ['delete', '/api/items/42'],
    ['get', '/api/items/42/related'],
    ['post', '/api/items/42/connect'],
    ['post', '/api/highlights'],
    ['get', '/api/highlights'],
    ['get', '/api/highlights/stats'],
    ['delete', '/api/highlights/42'],
    ['get', '/api/settings'],
    ['post', '/api/settings'],
    ['post', '/api/quick-lookup'],
    ['post', '/api/page-summary'],
    ['post', '/api/analyze-url'],
    ['post', '/api/bookmark'],
    ['get', '/api/bookmarks'],
    ['delete', '/api/bookmark/42'],
    ['post', '/api/notes'],
    ['get', '/api/notes'],
    ['patch', '/api/notes/42/toggle'],
    ['delete', '/api/notes/42'],
    ['post', '/api/research'],
    ['get', '/api/research'],
    ['get', '/api/reminders'],
    ['patch', '/api/reminders/42'],
    ['get', '/api/search?q=term'],
    ['get', '/api/export'],
    ['post', '/api/import'],
    ['get', '/api/knowledge-graph'],
    ['post', '/api/connections/discover'],
    ['get', '/api/digest'],
    ['post', '/api/digest/generate'],
    ['get', '/api/digest/settings'],
    ['post', '/api/digest/settings'],
  ];

  for (const [method, path] of endpoints) {
    const response = await supertest(app)
      [method](path)
      .set('Content-Type', 'application/json')
      .send(method === 'get' || method === 'delete' ? undefined : {})
      .expect(501);
    assert.equal(response.body.error.code, 'not_implemented', `${method.toUpperCase()} ${path}`);
  }
});

test('compatibility routes reject request-provided ownership and never call the service', async () => {
  let called = false;
  const app = appWith({
    compatibilityService: {
      async handle() {
        called = true;
        return {};
      },
    },
  });

  const response = await supertest(app).get('/api/items').set('x-user-id', 'attacker').expect(403);

  assert.equal(response.body.error.code, 'forbidden');
  assert.equal(
    (await supertest(app).post('/api/items').send({ user_id: 'attacker' }).expect(403)).body.error.code,
    'forbidden'
  );
  assert.equal((await supertest(app).get('/api/items?profile_id=attacker').expect(403)).body.error.code, 'forbidden');
  assert.equal(
    (
      await supertest(app)
        .post('/api/import')
        .send({ data: { rows: [{ ownerId: 'attacker' }] } })
        .expect(403)
    ).body.error.code,
    'forbidden'
  );
  assert.equal(called, false);
});

test('compatibility services receive authenticated ownership and cursor pagination only', async () => {
  let invocation;
  const app = appWith({
    compatibilityService: {
      async handle(input) {
        invocation = input;
        return {
          items: [{ id: 'item-1' }],
          nextCursor: null,
          hasMore: false,
        };
      },
    },
  });

  const response = await supertest(app).get(`/api/items?cursor=${CURSOR}&limit=25`).expect(200);

  assert.equal(invocation.operation, 'items.list');
  assert.equal(invocation.context.profileId, PROFILE_ID);
  assert.deepEqual(invocation.pagination, { cursor: CURSOR, limit: 25 });
  assert.deepEqual(response.body, {
    items: [{ id: 'item-1' }],
    nextCursor: null,
    hasMore: false,
  });

  assert.equal((await supertest(app).get('/api/items?offset=1').expect(400)).body.error.code, 'validation_failed');
  assert.equal((await supertest(app).get('/api/items?limit=101').expect(400)).body.error.code, 'validation_failed');
});

test('compatibility settings reject provider credentials and strip them from responses', async () => {
  const app = appWith({
    compatibilityService: {
      async handle() {
        return {
          theme: 'dark',
          api_key: 'provider-secret',
          nested: { providerToken: 'provider-secret' },
        };
      },
    },
  });

  const rejected = await supertest(app).post('/api/settings').send({ api_key: 'provider-secret' }).expect(400);
  assert.equal(rejected.body.error.code, 'validation_failed');

  const accepted = await supertest(app).get('/api/settings').expect(200);
  assert.deepEqual(accepted.body, { theme: 'dark', nested: {} });
  assert.equal(JSON.stringify(accepted.body).includes('provider-secret'), false);
});
