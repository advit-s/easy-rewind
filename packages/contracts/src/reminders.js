import { createSchemaValidator, inspectJsonValue, invalidContract } from './validation.js';

const REMINDER_SCHEMA_ID = 'https://contracts.easy-rewind.invalid/schema/reminders.json';

export const REMINDER_STATES = Object.freeze(['scheduled', 'snoozed', 'due', 'completed', 'cancelled', 'failed']);

export const REMINDER_TRANSITIONS = Object.freeze({
  scheduled: Object.freeze(['snoozed', 'due', 'completed', 'cancelled', 'failed']),
  snoozed: Object.freeze(['scheduled', 'due', 'completed', 'cancelled', 'failed']),
  due: Object.freeze(['snoozed', 'completed', 'cancelled', 'failed']),
  completed: Object.freeze([]),
  cancelled: Object.freeze([]),
  failed: Object.freeze([]),
});

export function canTransitionReminder(from, to) {
  return Object.hasOwn(REMINDER_TRANSITIONS, from) && REMINDER_TRANSITIONS[from].includes(to);
}

export function validateReminderTransition(value) {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !inspectJsonValue(value) ||
    Object.keys(value).length !== 2 ||
    !Object.hasOwn(value, 'from') ||
    !Object.hasOwn(value, 'to') ||
    !canTransitionReminder(value.from, value.to)
  ) {
    return invalidContract('Reminder transition is not allowed.');
  }
  return { valid: true, errors: [] };
}

export const validateReminderCreateRequest = createSchemaValidator(
  `${REMINDER_SCHEMA_ID}#/$defs/ReminderCreateRequest`
);
export const validateReminderUpdateRequest = createSchemaValidator(
  `${REMINDER_SCHEMA_ID}#/$defs/ReminderUpdateRequest`
);
export const validateReminderResponse = createSchemaValidator(`${REMINDER_SCHEMA_ID}#/$defs/ReminderResponse`);
