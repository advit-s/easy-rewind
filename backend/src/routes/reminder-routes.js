'use strict';

const { createHttpError } = require('../http/error-handler');
const { REMINDER_STATES } = require('../domain/reminders/reminder-state');
const { asyncRoute, authenticated, getRequestContext, requireService } = require('./route-utils');

const DELIVERY_CHANNELS = new Set(['desktop', 'browser', 'email']);

function invalid() {
  throw createHttpError('validation_failed');
}

function integer(value, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  const normalized = typeof value === 'string' && /^(?:0|[1-9]\d*)$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(normalized) || normalized < minimum || normalized > maximum) invalid();
  return normalized;
}

function text(value, { optional = false, maximum = 256 } = {}) {
  if (optional && (value === undefined || value === null)) return null;
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximum ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    invalid();
  }
  return value;
}

function targets(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) invalid();
  const seen = new Set();
  return value.map(target => {
    if (
      target === null ||
      typeof target !== 'object' ||
      Array.isArray(target) ||
      Object.keys(target).some(key => !['deviceId', 'channel'].includes(key))
    ) {
      return invalid();
    }
    const deviceId = text(target.deviceId);
    const channel = text(target.channel, { maximum: 16 });
    if (!DELIVERY_CHANNELS.has(channel)) invalid();
    const key = `${deviceId}\u0000${channel}`;
    if (seen.has(key)) invalid();
    seen.add(key);
    return { deviceId, channel };
  });
}

function createReminderRouter({ reminderService, authMiddleware } = {}) {
  if (reminderService === null || typeof reminderService !== 'object') {
    throw new TypeError('Reminder route dependencies are invalid');
  }
  const express = require('express');
  const router = express.Router();
  const protect = authenticated(authMiddleware);
  const acknowledgeDelivery = asyncRoute(async (request, response) => {
    const acknowledge = requireService(reminderService, 'acknowledgeDelivery');
    const context = getRequestContext(request);
    const result = await acknowledge({
      profileId: context.profileId,
      deviceId: text(context.deviceId),
      deliveryId: text(request.params.id),
    });
    response.status(200).json({ delivery: result });
  });

  router.post(
    '/v1/reminders',
    protect,
    asyncRoute(async (request, response) => {
      const create = requireService(reminderService, 'createReminder');
      const result = await create({
        profileId: getRequestContext(request).profileId,
        itemId: text(request.body.itemId, { optional: true }),
        dueAt: integer(request.body.dueAt),
        targets: targets(request.body.targets),
      });
      response.status(201).json({ reminder: result });
    })
  );

  router.get(
    '/v1/reminders',
    protect,
    asyncRoute(async (request, response) => {
      const list = requireService(reminderService, 'listReminders');
      const result = await list({
        profileId: getRequestContext(request).profileId,
        cursor: request.query.cursor === undefined ? undefined : text(request.query.cursor, { maximum: 512 }),
        limit: request.query.limit === undefined ? 25 : integer(request.query.limit, { minimum: 1, maximum: 100 }),
      });
      response.status(200).json(result);
    })
  );

  router.get(
    '/v1/reminders/:id',
    protect,
    asyncRoute(async (request, response) => {
      const get = requireService(reminderService, 'getReminder');
      const result = await get({
        profileId: getRequestContext(request).profileId,
        id: text(request.params.id),
      });
      response.status(200).json({ reminder: result });
    })
  );

  router.patch(
    '/v1/reminders/:id',
    protect,
    asyncRoute(async (request, response) => {
      const transition = requireService(reminderService, 'transitionReminder');
      const action = text(request.body.action, { maximum: 16 });
      if (!REMINDER_STATES.includes(action)) invalid();
      const result = await transition({
        profileId: getRequestContext(request).profileId,
        id: text(request.params.id),
        expectedRevision: integer(request.body.expectedRevision, { minimum: 1 }),
        action,
        snoozeUntil:
          request.body.snoozeUntil === undefined ? undefined : integer(request.body.snoozeUntil, { minimum: 1 }),
      });
      response.status(200).json({ reminder: result });
    })
  );

  router.post(
    '/v1/reminders/:id/repeat',
    protect,
    asyncRoute(async (request, response) => {
      const repeat = requireService(reminderService, 'repeatReminder');
      const result = await repeat({
        profileId: getRequestContext(request).profileId,
        id: text(request.params.id),
        expectedRevision: integer(request.body.expectedRevision, { minimum: 1 }),
        nextDueAt: integer(request.body.nextDueAt),
      });
      response.status(201).json({ reminder: result });
    })
  );

  router.post('/v1/reminder-deliveries/:id/acknowledge', protect, acknowledgeDelivery);

  router.get(
    '/api/reminder-deliveries',
    protect,
    asyncRoute(async (request, response) => {
      const list = requireService(reminderService, 'listDeliveryOutbox');
      const context = getRequestContext(request);
      const channel = text(request.query.channel, { maximum: 16 });
      if (channel !== 'desktop') invalid();
      const result = await list({
        profileId: context.profileId,
        deviceId: text(context.deviceId),
        channel,
        cursor: request.query.cursor === undefined ? undefined : text(request.query.cursor, { maximum: 512 }),
        limit: request.query.limit === undefined ? 25 : integer(request.query.limit, { minimum: 1, maximum: 100 }),
      });
      response.status(200).json({
        deliveries: result.items,
        nextCursor: result.nextCursor,
        hasMore: result.hasMore,
      });
    })
  );

  router.post('/api/reminder-deliveries/:id/acknowledge', protect, acknowledgeDelivery);

  return router;
}

module.exports = { createReminderRouter };
