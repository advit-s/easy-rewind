'use strict';

const { fail } = require('../domain-error');
const { decodeCursor, encodeCursor } = require('../repository-utils');
const { transitionReminder } = require('./reminder-state');

const DELIVERY_CHANNELS = new Set(['desktop', 'browser', 'email']);

function timestamp(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function nonEmptyText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function optionalId(value) {
  return value === undefined || value === null || nonEmptyText(value);
}

function createReminderRepository({ db, repositoryUtils } = {}) {
  if (
    db === null ||
    typeof db !== 'object' ||
    typeof db.prepare !== 'function' ||
    repositoryUtils === null ||
    typeof repositoryUtils !== 'object' ||
    typeof repositoryUtils.newRecord !== 'function' ||
    typeof repositoryUtils.requireById !== 'function' ||
    typeof repositoryUtils.allocateRevision !== 'function' ||
    typeof repositoryUtils.timestamp !== 'function' ||
    typeof repositoryUtils.page !== 'function' ||
    typeof repositoryUtils.transaction !== 'function'
  ) {
    fail('REPOSITORY_CONFIGURATION_INVALID');
  }

  function findReminder(profileId, id) {
    return repositoryUtils.requireById({ profileId, table: 'reminders', id });
  }

  function getDelivery(profileId, id) {
    return repositoryUtils.requireById({ profileId, table: 'reminder_deliveries', id });
  }

  function createReminder({ profileId, itemId = null, dueAt } = {}) {
    if (!optionalId(itemId) || !timestamp(dueAt)) fail('REPOSITORY_INPUT_INVALID');
    if (itemId !== null) repositoryUtils.requireById({ profileId, table: 'items', id: itemId });
    const record = repositoryUtils.newRecord();
    db.prepare(
      `INSERT INTO reminders(
         id, profile_id, item_id, state, due_at, created_at, updated_at, revision
       ) VALUES (?, ?, ?, 'scheduled', ?, ?, ?, 1)`
    ).run(record.id, profileId, itemId, dueAt, record.createdAt, record.updatedAt);
    return findReminder(profileId, record.id);
  }

  function listDeliveries({ profileId, reminderId } = {}) {
    findReminder(profileId, reminderId);
    return db
      .prepare(
        `SELECT *
         FROM reminder_deliveries
         WHERE profile_id = ? AND reminder_id = ? AND deleted_at IS NULL
         ORDER BY device_id ASC, channel ASC, id ASC`
      )
      .all(profileId, reminderId);
  }

  function createDelivery({ profileId, reminderId, deviceId, channel, scheduledAt } = {}) {
    if (!nonEmptyText(deviceId) || !DELIVERY_CHANNELS.has(channel) || !timestamp(scheduledAt)) {
      fail('REPOSITORY_INPUT_INVALID');
    }
    findReminder(profileId, reminderId);
    const device = db
      .prepare(
        `SELECT id
         FROM sync_devices
         WHERE profile_id = ? AND id = ? AND state = 'active' AND deleted_at IS NULL
         LIMIT 1`
      )
      .get(profileId, deviceId);
    if (!device) fail('NOT_FOUND');

    const existing = db
      .prepare(
        `SELECT *
         FROM reminder_deliveries
         WHERE profile_id = ? AND reminder_id = ? AND device_id = ? AND channel = ?
           AND deleted_at IS NULL
         LIMIT 1`
      )
      .get(profileId, reminderId, deviceId, channel);
    if (existing) return existing;

    const record = repositoryUtils.newRecord();
    db.prepare(
      `INSERT INTO reminder_deliveries(
         id, profile_id, reminder_id, device_id, channel, state, attempt_count,
         scheduled_at, created_at, updated_at, revision
       ) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, 1)`
    ).run(record.id, profileId, reminderId, deviceId, channel, scheduledAt, record.createdAt, record.updatedAt);
    return getDelivery(profileId, record.id);
  }

  function updateReminder({ profileId, id, expectedRevision, action, snoozeUntil } = {}) {
    const current = findReminder(profileId, id);
    const revision = repositoryUtils.allocateRevision({
      profileId,
      table: 'reminders',
      id,
      expectedRevision,
    });
    const updatedAt = repositoryUtils.timestamp();
    const patch = transitionReminder({
      current: current.state,
      action,
      now: updatedAt,
      snoozeUntil,
    });
    const dueAt = patch.dueAt === undefined ? current.due_at : patch.dueAt;
    const completedAt = patch.completedAt === undefined ? current.completed_at : patch.completedAt;
    const result = db
      .prepare(
        `UPDATE reminders
         SET state = ?, due_at = ?, completed_at = ?, updated_at = ?, revision = ?
         WHERE profile_id = ? AND id = ? AND revision = ? AND deleted_at IS NULL`
      )
      .run(patch.state, dueAt, completedAt, updatedAt, revision, profileId, id, expectedRevision);
    if (result.changes !== 1) fail('CONFLICT');
    return findReminder(profileId, id);
  }

  function reschedulePendingDeliveries({ profileId, reminderId, scheduledAt } = {}) {
    if (!timestamp(scheduledAt)) fail('REPOSITORY_INPUT_INVALID');
    findReminder(profileId, reminderId);
    const updatedAt = repositoryUtils.timestamp();
    db.prepare(
      `UPDATE reminder_deliveries
       SET state = 'pending', scheduled_at = ?, error_code = NULL,
           updated_at = ?, revision = revision + 1
       WHERE profile_id = ? AND reminder_id = ? AND deleted_at IS NULL
         AND state IN ('pending', 'delivering')`
    ).run(scheduledAt, updatedAt, profileId, reminderId);
    return listDeliveries({ profileId, reminderId });
  }

  function cancelOpenDeliveries({ profileId, reminderId } = {}) {
    findReminder(profileId, reminderId);
    const updatedAt = repositoryUtils.timestamp();
    db.prepare(
      `UPDATE reminder_deliveries
       SET state = 'cancelled', updated_at = ?, revision = revision + 1
       WHERE profile_id = ? AND reminder_id = ? AND deleted_at IS NULL
         AND state IN ('pending', 'delivering')`
    ).run(updatedAt, profileId, reminderId);
    return listDeliveries({ profileId, reminderId });
  }

  function listReadyDeliveries({ profileId, dueAt, limit = 25, maxAttempts = 3 } = {}) {
    if (
      !timestamp(dueAt) ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      !Number.isSafeInteger(maxAttempts) ||
      maxAttempts < 1
    ) {
      fail('REPOSITORY_INPUT_INVALID');
    }
    return db
      .prepare(
        `SELECT *
         FROM reminder_deliveries
         WHERE profile_id = ? AND state = 'pending' AND deleted_at IS NULL
           AND scheduled_at IS NOT NULL AND scheduled_at <= ? AND attempt_count < ?
         ORDER BY scheduled_at ASC, id ASC
         LIMIT ?`
      )
      .all(profileId, dueAt, maxAttempts, limit);
  }

  function listDeliveryOutbox({ profileId, deviceId, channel, cursor, limit = 25 } = {}) {
    if (
      !nonEmptyText(profileId) ||
      !nonEmptyText(deviceId) ||
      !DELIVERY_CHANNELS.has(channel) ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100
    ) {
      fail('REPOSITORY_INPUT_INVALID');
    }
    const position = cursor === undefined || cursor === null ? null : decodeCursor(cursor);
    const cursorPredicate =
      position === null
        ? ''
        : ` AND (
              deliveries.updated_at < ?
              OR (deliveries.updated_at = ? AND deliveries.id < ?)
            )`;
    const rows = db
      .prepare(
        `SELECT
           deliveries.id AS delivery_id,
           deliveries.channel AS delivery_channel,
           deliveries.state AS delivery_state,
           deliveries.scheduled_at AS delivery_scheduled_at,
           deliveries.delivered_at AS delivery_delivered_at,
           deliveries.acknowledged_at AS delivery_acknowledged_at,
           deliveries.updated_at AS delivery_updated_at,
           reminders.id AS reminder_id,
           reminders.state AS reminder_state,
           reminders.due_at AS reminder_due_at,
           reminders.revision AS reminder_revision,
           items.id AS item_id,
           items.kind AS item_kind,
           substr(items.title, 1, 256) AS item_title,
           items.url AS item_url,
           substr(items.excerpt, 1, 512) AS item_excerpt,
           substr(items.body, 1, 512) AS item_body
         FROM reminder_deliveries AS deliveries
         JOIN reminders
           ON reminders.profile_id = deliveries.profile_id
          AND reminders.id = deliveries.reminder_id
          AND reminders.deleted_at IS NULL
         LEFT JOIN items
           ON items.profile_id = reminders.profile_id
          AND items.id = reminders.item_id
          AND items.deleted_at IS NULL
         WHERE deliveries.profile_id = ?
           AND deliveries.device_id = ?
           AND deliveries.channel = ?
           AND deliveries.state = 'delivered'
           AND deliveries.acknowledged_at IS NULL
           AND deliveries.deleted_at IS NULL${cursorPredicate}
         ORDER BY deliveries.updated_at DESC, deliveries.id DESC
         LIMIT ?`
      )
      .all(
        ...(position === null
          ? [profileId, deviceId, channel, limit + 1]
          : [profileId, deviceId, channel, position.updatedAt, position.updatedAt, position.id, limit + 1])
      );
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items.at(-1);
    return {
      items,
      nextCursor:
        hasMore && last
          ? encodeCursor({
              updatedAt: last.delivery_updated_at,
              id: last.delivery_id,
            })
          : null,
      hasMore,
    };
  }

  function claimDelivery({ profileId, id, expectedRevision } = {}) {
    const revision = repositoryUtils.allocateRevision({
      profileId,
      table: 'reminder_deliveries',
      id,
      expectedRevision,
    });
    const updatedAt = repositoryUtils.timestamp();
    const result = db
      .prepare(
        `UPDATE reminder_deliveries
         SET state = 'delivering', updated_at = ?, revision = ?
         WHERE profile_id = ? AND id = ? AND revision = ?
           AND state = 'pending' AND deleted_at IS NULL`
      )
      .run(updatedAt, revision, profileId, id, expectedRevision);
    if (result.changes !== 1) return null;
    return getDelivery(profileId, id);
  }

  function markDelivered({ profileId, id, attemptedAt } = {}) {
    if (!timestamp(attemptedAt)) fail('REPOSITORY_INPUT_INVALID');
    const current = getDelivery(profileId, id);
    if (!['pending', 'delivering'].includes(current.state)) fail('CONFLICT');
    const updatedAt = repositoryUtils.timestamp();
    const result = db
      .prepare(
        `UPDATE reminder_deliveries
         SET state = 'delivered', attempt_count = attempt_count + 1,
             delivered_at = ?, error_code = NULL, updated_at = ?, revision = revision + 1
         WHERE profile_id = ? AND id = ? AND revision = ? AND deleted_at IS NULL
           AND state IN ('pending', 'delivering')`
      )
      .run(attemptedAt, updatedAt, profileId, id, current.revision);
    if (result.changes !== 1) fail('CONFLICT');
    return getDelivery(profileId, id);
  }

  function markDeliveryFailedAttempt({ profileId, id, attemptedAt, maxAttempts, errorCode } = {}) {
    if (!timestamp(attemptedAt) || !Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || !nonEmptyText(errorCode)) {
      fail('REPOSITORY_INPUT_INVALID');
    }
    const current = getDelivery(profileId, id);
    if (current.state !== 'delivering') fail('CONFLICT');
    const exhausted = current.attempt_count + 1 >= maxAttempts;
    const updatedAt = repositoryUtils.timestamp();
    const result = db
      .prepare(
        `UPDATE reminder_deliveries
         SET state = ?, attempt_count = attempt_count + 1, scheduled_at = ?,
             error_code = ?, updated_at = ?, revision = revision + 1
         WHERE profile_id = ? AND id = ? AND revision = ?
           AND state = 'delivering' AND deleted_at IS NULL`
      )
      .run(exhausted ? 'failed' : 'pending', attemptedAt, errorCode.trim(), updatedAt, profileId, id, current.revision);
    if (result.changes !== 1) fail('CONFLICT');
    return getDelivery(profileId, id);
  }

  function failReminderAfterExhaustedDelivery({ profileId, reminderId, deliveryId, maxAttempts } = {}) {
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) fail('REPOSITORY_INPUT_INVALID');
    const reminder = findReminder(profileId, reminderId);
    if (['completed', 'cancelled', 'failed'].includes(reminder.state)) return reminder;
    const exhausted = db
      .prepare(
        `SELECT id
         FROM reminder_deliveries
         WHERE profile_id = ? AND reminder_id = ? AND id = ?
           AND state = 'failed' AND attempt_count >= ? AND deleted_at IS NULL
         LIMIT 1`
      )
      .get(profileId, reminderId, deliveryId, maxAttempts);
    if (!exhausted) fail('CONFLICT');
    return updateReminder({
      profileId,
      id: reminderId,
      expectedRevision: reminder.revision,
      action: 'failed',
    });
  }

  function acknowledgeDelivery({ profileId, deviceId, id } = {}) {
    if (!nonEmptyText(deviceId)) fail('REPOSITORY_INPUT_INVALID');
    const current = db
      .prepare(
        `SELECT *
         FROM reminder_deliveries
         WHERE profile_id = ? AND device_id = ? AND id = ?
           AND state = 'delivered' AND deleted_at IS NULL
         LIMIT 1`
      )
      .get(profileId, deviceId, id);
    if (!current) fail('NOT_FOUND');
    if (current.acknowledged_at !== null) return current;
    const updatedAt = repositoryUtils.timestamp();
    const result = db
      .prepare(
        `UPDATE reminder_deliveries
         SET acknowledged_at = ?, updated_at = ?, revision = revision + 1
         WHERE profile_id = ? AND device_id = ? AND id = ? AND revision = ?
           AND state = 'delivered' AND acknowledged_at IS NULL AND deleted_at IS NULL`
      )
      .run(updatedAt, updatedAt, profileId, deviceId, id, current.revision);
    if (result.changes !== 1) fail('CONFLICT');
    return getDelivery(profileId, id);
  }

  function recoverInterruptedDeliveries({ profileId } = {}) {
    const updatedAt = repositoryUtils.timestamp();
    const result = db
      .prepare(
        `UPDATE reminder_deliveries
         SET state = 'pending', updated_at = ?, revision = revision + 1
         WHERE profile_id = ? AND state = 'delivering' AND deleted_at IS NULL`
      )
      .run(updatedAt, profileId);
    return result.changes;
  }

  return Object.freeze({
    acknowledgeDelivery,
    cancelOpenDeliveries,
    claimDelivery,
    createDelivery,
    createReminder,
    failReminderAfterExhaustedDelivery,
    findReminder,
    getDelivery,
    listDeliveries,
    listDeliveryOutbox,
    listReadyDeliveries,
    listReminders: options => repositoryUtils.page({ ...options, table: 'reminders' }),
    markDelivered,
    markDeliveryFailedAttempt,
    recoverInterruptedDeliveries,
    reschedulePendingDeliveries,
    transaction: repositoryUtils.transaction,
    updateReminder,
  });
}

module.exports = { createReminderRepository };
