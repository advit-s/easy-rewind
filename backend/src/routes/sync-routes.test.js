'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const express = require('express');
const request = require('supertest');

const { errorHandler } = require('../http/error-handler');
const { setRequestContext } = require('../http/request-context');
const { createSyncRouter } = require('./sync-routes');

const PROFILE = '00000000-0000-4000-8000-000000000001';
const DEVICE = '00000000-0000-4000-8000-000000000002';
const OPERATION = '00000000-0000-4000-8000-000000000003';
const ENTITY = '00000000-0000-4000-8000-000000000004';

function fixture({ contextDevice = DEVICE } = {}) {
  const calls = [];
  const syncService = {
    push(input) {
      calls.push(['push', input]);
      return {
        results: [{ operationId: OPERATION, status: 'accepted', revision: 1 }],
        serverTime: 1_800_000_000_000,
      };
    },
    pull(input) {
      calls.push(['pull', input]);
      return { changes: [], nextCursor: null, hasMore: false, serverTime: 1_800_000_000_000 };
    },
    acknowledge(input) {
      calls.push(['acknowledge', input]);
      return { acknowledgedSequence: input.sequence };
    },
    listConflicts(input) {
      calls.push(['listConflicts', input]);
      return { items: [], nextCursor: null, hasMore: false };
    },
    resolveConflict(input) {
      calls.push(['resolveConflict', input]);
      return { revision: 2, changeSequence: 4 };
    },
    createSnapshot(input) {
      calls.push(['createSnapshot', input]);
      return { snapshotId: 'snapshot', baseSequence: 4, checksum: 'a'.repeat(64), entities: [] };
    },
  };
  const authMiddleware = (incoming, _response, next) => {
    setRequestContext(incoming, {
      authenticationType: 'sync_device',
      credentialId: 'credential',
      profileId: PROFILE,
      deviceId: contextDevice,
    });
    next();
  };
  const app = express();
  app.use(express.json());
  app.use(createSyncRouter({ syncService, authMiddleware }));
  app.use(errorHandler);
  return { app, calls };
}

function validOperation() {
  return {
    operationId: OPERATION,
    deviceId: DEVICE,
    entityType: 'item',
    entityId: ENTITY,
    kind: 'upsert',
    baseRevision: 0,
    deviceSequence: 1,
    schemaVersion: 4,
    protocolVersion: '1',
    payload: { title: 'A' },
    occurredAt: 1,
  };
}

test('push and pull are authenticated device routes and pass immutable context', async () => {
  const context = fixture();
  assert.equal(
    (
      await request(context.app)
        .post('/v1/sync/push')
        .send({ deviceId: DEVICE, operations: [validOperation()] })
    ).status,
    200
  );
  assert.equal((await request(context.app).post('/v1/sync/pull').send({ deviceId: DEVICE, limit: 10 })).status, 200);
  assert.deepEqual(
    context.calls.map(call => call[0]),
    ['push', 'pull']
  );
  assert.equal(context.calls[0][1].context.profileId, PROFILE);
  assert.equal(context.calls[0][1].context.deviceId, DEVICE);
});

test('routes reject device-context mismatch, owner overrides, and provider credentials', async () => {
  const mismatch = fixture({ contextDevice: '00000000-0000-4000-8000-000000000099' });
  assert.equal((await request(mismatch.app).post('/v1/sync/pull').send({ deviceId: DEVICE, limit: 10 })).status, 403);
  assert.equal(mismatch.calls.length, 0);

  const context = fixture();
  assert.equal(
    (
      await request(context.app)
        .post('/v1/sync/push')
        .send({
          deviceId: DEVICE,
          operations: [validOperation()],
          profileId: PROFILE,
        })
    ).status,
    403
  );
  assert.equal(
    (
      await request(context.app)
        .post('/v1/sync/push')
        .send({
          deviceId: DEVICE,
          operations: [{ ...validOperation(), payload: { providerToken: 'secret' } }],
        })
    ).status,
    400
  );
  assert.equal(context.calls.length, 0);
});

test('acknowledgement, conflict, resolution, and snapshot routes remain device scoped', async () => {
  const context = fixture();
  assert.equal(
    (await request(context.app).post('/v1/sync/acknowledgements').send({ deviceId: DEVICE, sequence: 7 })).status,
    200
  );
  assert.equal((await request(context.app).get('/v1/sync/conflicts?limit=5')).status, 200);
  assert.equal(
    (
      await request(context.app)
        .post('/v1/sync/conflicts/00000000-0000-4000-8000-000000000010/resolve')
        .send({ resolution: 'merged', mergedPayload: { title: 'Merged' } })
    ).status,
    200
  );
  assert.equal((await request(context.app).post('/v1/sync/snapshots').send({ deviceId: DEVICE })).status, 201);
  assert.deepEqual(
    context.calls.map(call => call[0]),
    ['acknowledge', 'listConflicts', 'resolveConflict', 'createSnapshot']
  );
  assert.equal(
    context.calls.every(call => call[1].profileId === PROFILE),
    true
  );
  assert.equal(context.calls[0][1].deviceId, DEVICE);
  assert.equal(context.calls[3][1].deviceId, DEVICE);
});
