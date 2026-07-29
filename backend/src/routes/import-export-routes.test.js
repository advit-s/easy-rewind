'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const express = require('express');
const request = require('supertest');
const { setRequestContext } = require('../http/request-context');
const { errorHandler } = require('../http/error-handler');
const { createImportExportRouter } = require('./import-export-routes');

function fixture() {
  const calls = [];
  const exportService = {
    create(input) {
      calls.push(['export', input]);
      return { runId: 'export-one', state: 'succeeded', checksum: 'a'.repeat(64) };
    },
    cancel(input) {
      calls.push(['cancel-export', input]);
      return { runId: input.runId, state: 'cancelled' };
    },
  };
  const importService = {
    dryRun(input) {
      calls.push(['dry-run', input]);
      return { totalRows: 1, counts: {}, conflicts: [] };
    },
    apply(input) {
      calls.push(['apply', input]);
      return { runId: 'import-one', state: 'succeeded', backupRef: 'sensitive-reference' };
    },
    rollback(input) {
      calls.push(['rollback', input]);
      return { runId: input.runId, state: 'rolled_back' };
    },
    cancel(input) {
      calls.push(['cancel-import', input]);
      return { runId: input.runId, state: 'cancelled' };
    },
  };
  const authMiddleware = (incoming, _response, next) => {
    setRequestContext(incoming, {
      authenticationType: 'install',
      credentialId: 'credential-one',
      profileId: 'owner-one',
    });
    next();
  };
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use(createImportExportRouter({ exportService, importService, authMiddleware }));
  app.use(errorHandler);
  return { app, calls };
}

test('import and export routes derive owner only from authenticated context', async () => {
  const context = fixture();
  const bundle = { manifest: {}, data: {} };

  assert.equal((await request(context.app).post('/v1/exports').send({})).status, 201);
  assert.equal((await request(context.app).post('/v1/imports/dry-run').send({ bundle })).status, 200);
  assert.equal(
    (await request(context.app).post('/v1/imports').send({ bundle, conflictStrategy: 'replace' })).status,
    201
  );
  assert.equal((await request(context.app).post('/v1/imports/import-one/rollback').send({})).status, 200);

  assert.deepEqual(context.calls, [
    ['export', { profileId: 'owner-one' }],
    ['dry-run', { profileId: 'owner-one', bundle }],
    ['apply', { profileId: 'owner-one', bundle, conflictStrategy: 'replace' }],
    ['rollback', { profileId: 'owner-one', runId: 'import-one' }],
  ]);

  const override = await request(context.app).post('/v1/imports/dry-run').send({ profileId: 'owner-two', bundle });
  assert.equal(override.status, 403);
  assert.equal(context.calls.length, 4);
});

test('cancellation routes are owner scoped and identifiers and strategies are bounded', async () => {
  const context = fixture();

  assert.equal((await request(context.app).post('/v1/exports/export-one/cancel').send({})).status, 200);
  assert.equal((await request(context.app).post('/v1/imports/import-one/cancel').send({})).status, 200);
  assert.deepEqual(context.calls.slice(-2), [
    ['cancel-export', { profileId: 'owner-one', runId: 'export-one' }],
    ['cancel-import', { profileId: 'owner-one', runId: 'import-one' }],
  ]);

  assert.equal(
    (
      await request(context.app)
        .post('/v1/imports')
        .send({ bundle: { manifest: {}, data: {} }, conflictStrategy: 'overwrite-everything' })
    ).status,
    400
  );
  assert.equal(
    (
      await request(context.app)
        .post(`/v1/imports/${'x'.repeat(257)}/rollback`)
        .send({})
    ).status,
    400
  );
});

test('service validation failures use the frozen safe HTTP error envelope', async () => {
  const failing = express();
  failing.use(express.json());
  failing.use(
    createImportExportRouter({
      exportService: {
        create() {
          throw Object.assign(new Error('unsafe bundle detail'), {
            code: 'EXPORT_OWNER_NOT_FOUND',
          });
        },
      },
      importService: {
        dryRun() {
          throw Object.assign(new Error('unsafe version detail'), {
            code: 'IMPORT_VERSION_UNSUPPORTED',
          });
        },
      },
      authMiddleware(incoming, _response, next) {
        setRequestContext(incoming, {
          authenticationType: 'install',
          credentialId: 'credential-one',
          profileId: 'owner-one',
        });
        next();
      },
    })
  );
  failing.use(errorHandler);

  const missing = await request(failing).post('/v1/exports').send({});
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'not_found');
  assert.equal(JSON.stringify(missing.body).includes('unsafe'), false);

  const unsupported = await request(failing)
    .post('/v1/imports/dry-run')
    .send({ bundle: { manifest: {}, data: {} } });
  assert.equal(unsupported.status, 400);
  assert.equal(unsupported.body.error.code, 'validation_failed');
  assert.equal(JSON.stringify(unsupported.body).includes('unsafe'), false);
});
