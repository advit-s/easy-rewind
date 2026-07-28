'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const express = require('express');
const request = require('supertest');
const { setRequestContext } = require('../http/request-context');
const { errorHandler } = require('../http/error-handler');
const { createResearchRouter } = require('./research-routes');

function fixture() {
  const calls = [];
  const researchService = {
    async queue(input) {
      calls.push(['queue', input]);
      return { researchId: 'research-one', jobId: 'job-one', state: 'queued' };
    },
    get(input) {
      calls.push(['get', input]);
      return { id: input.id, profile_id: input.profileId, state: 'queued' };
    },
    cancel(input) {
      calls.push(['cancel', input]);
      return { id: input.id, profile_id: input.profileId, state: 'cancelled' };
    },
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
  app.use(createResearchRouter({ researchService, authMiddleware }));
  app.use(errorHandler);
  return { app, calls };
}

test('research queue derives owner context and returns truthful accepted state', async () => {
  const context = fixture();
  const response = await request(context.app).post('/v1/research').send({
    query: 'Investigate local-first synchronization',
    sourceUrl: 'https://example.com/source',
    provider: 'gemini',
    model: 'gemini-2.5-flash',
    idempotencyKey: 'research-request-one',
  });

  assert.equal(response.status, 202);
  assert.deepEqual(response.body, {
    researchId: 'research-one',
    jobId: 'job-one',
    state: 'queued',
  });
  assert.deepEqual(context.calls[0], [
    'queue',
    {
      profileId: 'profile-one',
      query: 'Investigate local-first synchronization',
      sourceUrl: 'https://example.com/source',
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      idempotencyKey: 'research-request-one',
    },
  ]);

  const override = await request(context.app).post('/v1/research').send({
    profileId: 'profile-two',
    query: 'Override',
    sourceUrl: 'https://example.com/',
    provider: 'gemini',
    model: 'gemini-2.5-flash',
  });
  assert.equal(override.status, 403);
  assert.equal(context.calls.length, 1);
});

test('research read and cancellation remain owner scoped and validate revisions', async () => {
  const context = fixture();

  assert.equal((await request(context.app).get('/v1/research/research-one')).status, 200);
  assert.equal(
    (await request(context.app).post('/v1/research/research-one/cancel').send({ expectedRevision: 1 })).status,
    200
  );
  assert.deepEqual(context.calls, [
    ['get', { profileId: 'profile-one', id: 'research-one' }],
    ['cancel', { profileId: 'profile-one', id: 'research-one', expectedRevision: 1 }],
  ]);

  assert.equal(
    (await request(context.app).post('/v1/research/research-one/cancel').send({ expectedRevision: 0 })).status,
    400
  );
});
