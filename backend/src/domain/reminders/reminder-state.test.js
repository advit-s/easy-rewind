'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { DomainError } = require('../domain-error');
const { REMINDER_STATES, canTransitionReminder, transitionReminder } = require('./reminder-state');

const NOW = Date.UTC(2026, 6, 28, 15);

test('uses the frozen reminder vocabulary and transition graph', () => {
  assert.deepEqual(REMINDER_STATES, ['scheduled', 'snoozed', 'due', 'completed', 'cancelled', 'failed']);

  assert.equal(canTransitionReminder('scheduled', 'due'), true);
  assert.equal(canTransitionReminder('due', 'snoozed'), true);
  assert.equal(canTransitionReminder('snoozed', 'scheduled'), true);
  assert.equal(canTransitionReminder('due', 'due'), false);
});

test('terminal reminder states cannot transition', () => {
  for (const current of ['completed', 'cancelled', 'failed']) {
    for (const action of REMINDER_STATES) {
      assert.equal(canTransitionReminder(current, action), false);
      assert.throws(
        () => transitionReminder({ current, action, now: NOW }),
        error => error instanceof DomainError && error.code === 'CONFLICT'
      );
    }
  }
});

test('snoozing requires one future timestamp and returns a deterministic patch', () => {
  const snoozeUntil = NOW + 15 * 60 * 1000;

  assert.deepEqual(
    transitionReminder({
      current: 'due',
      action: 'snoozed',
      now: NOW,
      snoozeUntil,
    }),
    {
      dueAt: snoozeUntil,
      state: 'snoozed',
    }
  );

  for (const invalid of [undefined, NOW, NOW - 1, 1.5, 'later']) {
    assert.throws(
      () =>
        transitionReminder({
          current: 'due',
          action: 'snoozed',
          now: NOW,
          snoozeUntil: invalid,
        }),
      error => error instanceof DomainError && error.code === 'REPOSITORY_INPUT_INVALID'
    );
  }
});

test('completion records the injected time and ordinary transitions stay minimal', () => {
  assert.deepEqual(transitionReminder({ current: 'due', action: 'completed', now: NOW }), {
    completedAt: NOW,
    state: 'completed',
  });
  assert.deepEqual(transitionReminder({ current: 'scheduled', action: 'due', now: NOW }), {
    state: 'due',
  });
});

test('invalid states and timestamps fail without exposing input values', () => {
  for (const input of [
    { current: 'unknown', action: 'due', now: NOW },
    { current: 'due', action: 'unknown', now: NOW },
    { current: 'due', action: 'completed', now: -1 },
    { current: 'due', action: 'completed', now: 1.5 },
  ]) {
    assert.throws(
      () => transitionReminder(input),
      error =>
        error instanceof DomainError && error.code === 'REPOSITORY_INPUT_INVALID' && !error.message.includes('unknown')
    );
  }
});
