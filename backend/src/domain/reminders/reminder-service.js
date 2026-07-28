'use strict';

const { fail } = require('../domain-error');

function createReminderService({ repository, jobs, syncRecorder, now, ids } = {}) {
  if (
    repository === null ||
    typeof repository !== 'object' ||
    typeof repository.transaction !== 'function' ||
    jobs === null ||
    typeof jobs !== 'object' ||
    typeof jobs.enqueue !== 'function' ||
    syncRecorder === null ||
    typeof syncRecorder !== 'object' ||
    typeof syncRecorder.recordChange !== 'function' ||
    typeof now !== 'function' ||
    (ids !== undefined && typeof ids !== 'function')
  ) {
    fail('REPOSITORY_CONFIGURATION_INVALID');
  }

  function recordChange(record) {
    syncRecorder.recordChange({
      profileId: record.profile_id,
      entityType: 'reminder',
      entityId: record.id,
      revision: record.revision,
      changeKind: 'upsert',
      record,
    });
  }

  function enqueueDelivery(delivery) {
    jobs.enqueue({
      profileId: delivery.profile_id,
      kind: 'reminder_delivery',
      idempotencyKey: `reminder-delivery:${delivery.id}:${delivery.scheduled_at}`,
      availableAt: delivery.scheduled_at,
      payload: {
        deliveryId: delivery.id,
        reminderId: delivery.reminder_id,
        deviceId: delivery.device_id,
        channel: delivery.channel,
      },
    });
  }

  function createWithTargets({ profileId, itemId = null, dueAt, targets } = {}) {
    if (!Array.isArray(targets) || targets.length === 0 || targets.length > 100) {
      fail('REPOSITORY_INPUT_INVALID');
    }
    const reminder = repository.createReminder({ profileId, itemId, dueAt });
    for (const target of targets) {
      const delivery = repository.createDelivery({
        profileId,
        reminderId: reminder.id,
        deviceId: target?.deviceId,
        channel: target?.channel,
        scheduledAt: dueAt,
      });
      enqueueDelivery(delivery);
    }
    return reminder;
  }

  function createReminder(input) {
    return repository.transaction(() => {
      const reminder = createWithTargets(input);
      recordChange(reminder);
      return reminder;
    });
  }

  function transition(input = {}) {
    return repository.transaction(() => {
      const reminder = repository.updateReminder(input);
      if (input.action === 'snoozed') {
        const deliveries = repository.reschedulePendingDeliveries({
          profileId: input.profileId,
          reminderId: input.id,
          scheduledAt: input.snoozeUntil,
        });
        for (const delivery of deliveries) {
          if (delivery.state === 'pending') enqueueDelivery(delivery);
        }
      } else if (['completed', 'cancelled', 'failed'].includes(input.action)) {
        repository.cancelOpenDeliveries({
          profileId: input.profileId,
          reminderId: input.id,
        });
      }
      recordChange(reminder);
      return reminder;
    });
  }

  function repeatReminder({ profileId, id, expectedRevision, nextDueAt } = {}) {
    return repository.transaction(() => {
      const current = repository.findReminder(profileId, id);
      const targets = repository
        .listDeliveries({ profileId, reminderId: id })
        .map(delivery => ({ deviceId: delivery.device_id, channel: delivery.channel }));
      const completed = repository.updateReminder({
        profileId,
        id,
        expectedRevision,
        action: 'completed',
      });
      repository.cancelOpenDeliveries({ profileId, reminderId: id });
      recordChange(completed);
      const repeated = createWithTargets({
        profileId,
        itemId: current.item_id,
        dueAt: nextDueAt,
        targets,
      });
      recordChange(repeated);
      return repeated;
    });
  }

  return Object.freeze({
    acknowledgeDelivery: ({ profileId, deviceId, deliveryId } = {}) =>
      repository.acknowledgeDelivery({ profileId, deviceId, id: deliveryId }),
    createReminder,
    getReminder: ({ profileId, id } = {}) => repository.findReminder(profileId, id),
    listReminders: input => repository.listReminders(input),
    repeatReminder,
    transitionReminder: transition,
  });
}

module.exports = { createReminderService };
