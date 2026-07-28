'use strict';

const { fail } = require('../domain-error');

function createReminderWorker({ repository, notifier, leases, now, maxAttempts = 3 } = {}) {
  if (
    repository === null ||
    typeof repository !== 'object' ||
    typeof repository.recoverInterruptedDeliveries !== 'function' ||
    typeof repository.listReadyDeliveries !== 'function' ||
    typeof repository.claimDelivery !== 'function' ||
    typeof repository.markDelivered !== 'function' ||
    typeof repository.markDeliveryFailedAttempt !== 'function' ||
    typeof repository.failReminderAfterExhaustedDelivery !== 'function' ||
    notifier === null ||
    typeof notifier !== 'object' ||
    typeof notifier.deliver !== 'function' ||
    leases === null ||
    typeof leases !== 'object' ||
    typeof leases.withLease !== 'function' ||
    typeof now !== 'function' ||
    !Number.isSafeInteger(maxAttempts) ||
    maxAttempts < 1
  ) {
    fail('REPOSITORY_CONFIGURATION_INVALID');
  }

  async function deliver(candidate) {
    return leases.withLease(`reminder-delivery:${candidate.id}`, async () => {
      const claimed = repository.claimDelivery({
        profileId: candidate.profile_id,
        id: candidate.id,
        expectedRevision: candidate.revision,
      });
      if (!claimed) return false;
      const attemptedAt = now();
      try {
        const reminder = repository.findReminder(claimed.profile_id, claimed.reminder_id);
        await notifier.deliver({
          profileId: claimed.profile_id,
          reminder,
          delivery: claimed,
          deviceId: claimed.device_id,
          channel: claimed.channel,
        });
        repository.markDelivered({
          profileId: claimed.profile_id,
          id: claimed.id,
          attemptedAt,
        });
      } catch {
        const failed = repository.markDeliveryFailedAttempt({
          profileId: claimed.profile_id,
          id: claimed.id,
          attemptedAt,
          maxAttempts,
          errorCode: 'NOTIFICATION_FAILED',
        });
        if (failed.state === 'failed') {
          repository.failReminderAfterExhaustedDelivery({
            profileId: failed.profile_id,
            reminderId: failed.reminder_id,
            deliveryId: failed.id,
            maxAttempts,
          });
        }
      }
      return true;
    });
  }

  async function runOnce({ profileId, limit = 25 } = {}) {
    const deliveries = repository.listReadyDeliveries({
      profileId,
      dueAt: now(),
      limit,
      maxAttempts,
    });
    let processed = 0;
    for (const candidate of deliveries) {
      if (await deliver(candidate)) processed += 1;
    }
    return processed;
  }

  async function start({ profileId, limit = 25 } = {}) {
    repository.recoverInterruptedDeliveries({ profileId });
    return runOnce({ profileId, limit });
  }

  return Object.freeze({ runOnce, start });
}

module.exports = { createReminderWorker };
