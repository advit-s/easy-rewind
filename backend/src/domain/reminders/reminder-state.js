'use strict';

const { fail } = require('../domain-error');

const REMINDER_STATES = Object.freeze(['scheduled', 'snoozed', 'due', 'completed', 'cancelled', 'failed']);

const REMINDER_TRANSITIONS = Object.freeze({
  scheduled: Object.freeze(['snoozed', 'due', 'completed', 'cancelled', 'failed']),
  snoozed: Object.freeze(['scheduled', 'due', 'completed', 'cancelled', 'failed']),
  due: Object.freeze(['snoozed', 'completed', 'cancelled', 'failed']),
  completed: Object.freeze([]),
  cancelled: Object.freeze([]),
  failed: Object.freeze([]),
});

function isTimestamp(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function canTransitionReminder(current, action) {
  return (
    typeof current === 'string' &&
    typeof action === 'string' &&
    Object.hasOwn(REMINDER_TRANSITIONS, current) &&
    REMINDER_TRANSITIONS[current].includes(action)
  );
}

function transitionReminder({ current, action, now, snoozeUntil } = {}) {
  if (!REMINDER_STATES.includes(current) || !REMINDER_STATES.includes(action) || !isTimestamp(now)) {
    fail('REPOSITORY_INPUT_INVALID');
  }
  if (!canTransitionReminder(current, action)) fail('CONFLICT');

  if (action === 'snoozed') {
    if (!isTimestamp(snoozeUntil) || snoozeUntil <= now) {
      fail('REPOSITORY_INPUT_INVALID');
    }
    return Object.freeze({ dueAt: snoozeUntil, state: action });
  }
  if (snoozeUntil !== undefined) fail('REPOSITORY_INPUT_INVALID');

  if (action === 'completed') {
    return Object.freeze({ completedAt: now, state: action });
  }
  return Object.freeze({ state: action });
}

module.exports = {
  REMINDER_STATES,
  REMINDER_TRANSITIONS,
  canTransitionReminder,
  transitionReminder,
};
