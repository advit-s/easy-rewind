'use strict';

const SAFE_IDENTIFIER = /^[A-Za-z0-9._~-]{1,256}$/;

class DesktopReminderOutboxError extends Error {
  constructor() {
    super('The desktop reminder delivery envelope is invalid.');
    this.name = 'DesktopReminderOutboxError';
    this.code = 'DESKTOP_REMINDER_ENVELOPE_INVALID';
  }
}

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function identifier(value) {
  return typeof value === 'string' && SAFE_IDENTIFIER.test(value);
}

function positiveRevision(value) {
  return Number.isSafeInteger(value) && value >= 1;
}

function validEnvelope(value) {
  if (
    !record(value) ||
    value.channel !== 'desktop' ||
    !identifier(value.profileId) ||
    !identifier(value.deviceId) ||
    !record(value.delivery) ||
    !record(value.reminder)
  ) {
    return false;
  }

  const delivery = value.delivery;
  const reminder = value.reminder;
  return (
    delivery.channel === 'desktop' &&
    delivery.state === 'delivering' &&
    identifier(delivery.id) &&
    identifier(delivery.profile_id) &&
    identifier(delivery.device_id) &&
    identifier(delivery.reminder_id) &&
    positiveRevision(delivery.revision) &&
    identifier(reminder.id) &&
    identifier(reminder.profile_id) &&
    positiveRevision(reminder.revision) &&
    delivery.profile_id === value.profileId &&
    reminder.profile_id === value.profileId &&
    delivery.device_id === value.deviceId &&
    delivery.reminder_id === reminder.id
  );
}

function createDesktopReminderOutboxAdapter() {
  return Object.freeze({
    async deliver(value) {
      if (!validEnvelope(value)) throw new DesktopReminderOutboxError();
    },
  });
}

module.exports = {
  DesktopReminderOutboxError,
  createDesktopReminderOutboxAdapter,
};
