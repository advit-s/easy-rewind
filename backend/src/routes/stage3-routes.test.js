'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const request = require('supertest');
const { setRequestContext } = require('../http/request-context');
const { createApp } = require('../http/create-app');

function fixture() {
  const calls = [];
  const localAuthMiddleware = (incoming, _response, next) => {
    setRequestContext(incoming, {
      authenticationType: 'install',
      credentialId: 'credential-one',
      profileId: 'profile-one',
    });
    next();
  };
  const app = createApp({
    health: () => ({
      status: 'ok',
      version: '2.0.0',
      schemaVersion: 4,
      apiVersion: '1',
      mode: 'test',
      components: {
        database: { status: 'ready' },
        applicationApi: { status: 'disabled' },
        scheduler: { status: 'disabled' },
        lanSync: { status: 'disabled' },
      },
      legacyMigrationAvailable: false,
    }),
    generateRequestId: () => 'request_stage3_routes',
    routeDependencies: {
      localAuthMiddleware,
      contentService: {
        createItem(input) {
          calls.push(['item', input]);
          return { id: 'item-one' };
        },
      },
      graphService: {},
      learningService: {
        createFlashcard(input) {
          calls.push(['flashcard', input]);
          return { id: 'card-one' };
        },
      },
      reminderService: {
        createReminder(input) {
          calls.push(['reminder', input]);
          return { id: 'reminder-one' };
        },
      },
      researchService: {
        queue(input) {
          calls.push(['research', input]);
          return { researchId: 'research-one', jobId: 'job-one', state: 'queued' };
        },
      },
      exportService: {
        create(input) {
          calls.push(['export', input]);
          return {
            runId: 'export-one',
            state: 'succeeded',
            checksum: '0'.repeat(64),
            bundle: { manifest: {}, data: {} },
          };
        },
      },
      importService: {
        dryRun(input) {
          calls.push(['import-dry-run', input]);
          return { counts: {}, conflicts: [] };
        },
      },
    },
  });
  return { app, calls };
}

test('createApp advertises completed Stage 3 domain routes with one owner context', async () => {
  const context = fixture();

  assert.equal(
    (
      await request(context.app).post('/v1/items').send({
        kind: 'note',
        title: 'Local-first',
      })
    ).status,
    201
  );
  assert.equal(
    (
      await request(context.app).post('/v1/flashcards').send({
        prompt: 'Question?',
        answer: 'Answer.',
      })
    ).status,
    201
  );
  assert.equal(
    (
      await request(context.app)
        .post('/v1/reminders')
        .send({
          dueAt: 1_800_000_000_000,
          targets: [{ deviceId: 'device-one', channel: 'desktop' }],
        })
    ).status,
    201
  );
  assert.equal(
    (
      await request(context.app).post('/v1/research').send({
        query: 'Investigate',
        sourceUrl: 'https://example.com/source',
        provider: 'gemini',
        model: 'gemini-2.5-flash',
      })
    ).status,
    202
  );
  assert.equal((await request(context.app).post('/v1/exports').send({})).status, 201);
  assert.equal(
    (
      await request(context.app)
        .post('/v1/imports/dry-run')
        .send({ bundle: { manifest: {}, data: {} } })
    ).status,
    200
  );

  assert.deepEqual(
    context.calls.map(call => [call[0], call[1].profileId]),
    [
      ['item', 'profile-one'],
      ['flashcard', 'profile-one'],
      ['reminder', 'profile-one'],
      ['research', 'profile-one'],
      ['export', 'profile-one'],
      ['import-dry-run', 'profile-one'],
    ]
  );
});

test('Stage 3 route mounting preserves owner-override rejection', async () => {
  const context = fixture();
  const response = await request(context.app)
    .post('/v1/items')
    .send({ profileId: 'profile-two', kind: 'note', title: 'Rejected' });

  assert.equal(response.status, 403);
  assert.equal(response.body.error.code, 'forbidden');
  assert.equal(context.calls.length, 0);
});
