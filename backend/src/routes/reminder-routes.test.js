'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const express = require('express');
const request = require('supertest');
const { errorHandler } = require('../http/error-handler');
const { setRequestContext } = require('../http/request-context');
const { createReminderRouter } = require('./reminder-routes');

function fixture(overrides = {}) {
  const calls = [];
  const service = {
    createReminder(input) {
      calls.push(['createReminder', input]);
      return { id: 'reminder-one', profile_id: input.profileId };
    },
    getReminder(input) {
      calls.push(['getReminder', input]);
      return { id: input.id, profile_id: input.profileId };
    },
    listReminders(input) {
      calls.push(['listReminders', input]);
      return { items: [], nextCursor: null, hasMore: false };
    },
    listDeliveryOutbox(input) {
      calls.push(['listDeliveryOutbox', input]);
      return {
        items: [{ delivery: { id: 'delivery-one', state: 'delivered' } }],
        nextCursor: 'next_cursor',
        hasMore: true,
      };
    },
    transitionReminder(input) {
      calls.push(['transitionReminder', input]);
      return { id: input.id, profile_id: input.profileId, state: input.action };
    },
    repeatReminder(input) {
      calls.push(['repeatReminder', input]);
      return { id: 'reminder-two', profile_id: input.profileId };
    },
    acknowledgeDelivery(input) {
      calls.push(['acknowledgeDelivery', input]);
      return { id: input.deliveryId, profile_id: input.profileId, device_id: input.deviceId };
    },
    ...overrides,
  };
  const authMiddleware = (incoming, _response, next) => {
    setRequestContext(incoming, {
      authenticationType: 'sync_device',
      credentialId: 'credential-one',
      profileId: 'profile-one',
      deviceId: 'device-phone',
    });
    next();
  };
  const app = express();
  app.use(express.json());
  app.use(createReminderRouter({ reminderService: service, authMiddleware }));
  app.use(errorHandler);
  return { app, calls };
}

test('create and list routes derive reminder ownership from immutable context', async () => {
  const context = fixture();
  const createResponse = await request(context.app)
    .post('/v1/reminders')
    .send({
      itemId: 'item-one',
      dueAt: 1_800_000_000_000,
      targets: [
        { deviceId: 'device-pc', channel: 'desktop' },
        { deviceId: 'device-phone', channel: 'browser' },
      ],
    });
  assert.equal(createResponse.status, 201);
  assert.equal((await request(context.app).get('/v1/reminders?limit=10')).status, 200);
  assert.deepEqual(context.calls, [
    [
      'createReminder',
      {
        profileId: 'profile-one',
        itemId: 'item-one',
        dueAt: 1_800_000_000_000,
        targets: [
          { deviceId: 'device-pc', channel: 'desktop' },
          { deviceId: 'device-phone', channel: 'browser' },
        ],
      },
    ],
    ['listReminders', { profileId: 'profile-one', cursor: undefined, limit: 10 }],
  ]);

  const rejected = await request(context.app)
    .post('/v1/reminders')
    .send({
      profileId: 'profile-two',
      dueAt: 1_800_000_000_000,
      targets: [{ deviceId: 'device-phone', channel: 'browser' }],
    });
  assert.equal(rejected.status, 403);
  assert.equal(context.calls.length, 2);
});

test('transition and repeat routes pass bounded scheduling input', async () => {
  const context = fixture();
  assert.equal(
    (
      await request(context.app).patch('/v1/reminders/reminder-one').send({
        expectedRevision: 1,
        action: 'snoozed',
        snoozeUntil: 1_800_000_060_000,
      })
    ).status,
    200
  );
  assert.equal(
    (
      await request(context.app).post('/v1/reminders/reminder-one/repeat').send({
        expectedRevision: 2,
        nextDueAt: 1_800_086_400_000,
      })
    ).status,
    201
  );
  assert.deepEqual(context.calls, [
    [
      'transitionReminder',
      {
        profileId: 'profile-one',
        id: 'reminder-one',
        expectedRevision: 1,
        action: 'snoozed',
        snoozeUntil: 1_800_000_060_000,
      },
    ],
    [
      'repeatReminder',
      {
        profileId: 'profile-one',
        id: 'reminder-one',
        expectedRevision: 2,
        nextDueAt: 1_800_086_400_000,
      },
    ],
  ]);
  assert.equal(
    (
      await request(context.app).patch('/v1/reminders/reminder-one').send({
        expectedRevision: 1,
        action: 'unknown',
      })
    ).status,
    400
  );
});

test('delivery acknowledgement uses only the authenticated device identity', async () => {
  const context = fixture();
  const response = await request(context.app)
    .post('/v1/reminder-deliveries/delivery-one/acknowledge')
    .send({ deviceId: 'device-pc' });

  assert.equal(response.status, 200);
  assert.deepEqual(context.calls, [
    [
      'acknowledgeDelivery',
      {
        profileId: 'profile-one',
        deviceId: 'device-phone',
        deliveryId: 'delivery-one',
      },
    ],
  ]);
});

test('desktop compatibility outbox is bounded and derives profile and device from authentication', async () => {
  const context = fixture();
  const response = await request(context.app).get(
    '/api/reminder-deliveries?channel=desktop&limit=10&cursor=cursor_one'
  );

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, {
    deliveries: [{ delivery: { id: 'delivery-one', state: 'delivered' } }],
    nextCursor: 'next_cursor',
    hasMore: true,
  });
  assert.deepEqual(context.calls, [
    [
      'listDeliveryOutbox',
      {
        profileId: 'profile-one',
        deviceId: 'device-phone',
        channel: 'desktop',
        cursor: 'cursor_one',
        limit: 10,
      },
    ],
  ]);

  for (const path of [
    '/api/reminder-deliveries',
    '/api/reminder-deliveries?channel=browser',
    '/api/reminder-deliveries?channel=desktop&limit=0',
    '/api/reminder-deliveries?channel=desktop&limit=101',
  ]) {
    assert.equal((await request(context.app).get(path)).status, 400, path);
  }
  assert.equal(context.calls.length, 1);
});

test('desktop compatibility acknowledgement has the same scoped semantics as the canonical action', async () => {
  const context = fixture();
  const response = await request(context.app)
    .post('/api/reminder-deliveries/delivery-two/acknowledge')
    .send({ deviceId: 'device-pc' });

  assert.equal(response.status, 200);
  assert.deepEqual(context.calls, [
    [
      'acknowledgeDelivery',
      {
        profileId: 'profile-one',
        deviceId: 'device-phone',
        deliveryId: 'delivery-two',
      },
    ],
  ]);
});
