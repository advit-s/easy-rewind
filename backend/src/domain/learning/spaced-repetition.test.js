'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { calculateNextReview } = require('./spaced-repetition');

const DAY_MS = 24 * 60 * 60 * 1000;
const REVIEWED_AT = Date.UTC(2026, 6, 28, 12);

test('starts a successful card at a one-day interval without reading the wall clock', () => {
  assert.deepEqual(
    calculateNextReview({
      quality: 5,
      intervalDays: 0,
      easeFactor: 2.5,
      reviewedAt: REVIEWED_AT,
    }),
    {
      dueAt: REVIEWED_AT + DAY_MS,
      easeFactor: 2.6,
      intervalDays: 1,
    }
  );
});

test('uses the six-day second interval and then grows by the updated ease factor', () => {
  const second = calculateNextReview({
    quality: 4,
    intervalDays: 1,
    easeFactor: 2.5,
    reviewedAt: REVIEWED_AT,
  });
  const later = calculateNextReview({
    quality: 4,
    intervalDays: 6,
    easeFactor: 2.5,
    reviewedAt: REVIEWED_AT,
  });

  assert.deepEqual(second, {
    dueAt: REVIEWED_AT + 6 * DAY_MS,
    easeFactor: 2.5,
    intervalDays: 6,
  });
  assert.deepEqual(later, {
    dueAt: REVIEWED_AT + 15 * DAY_MS,
    easeFactor: 2.5,
    intervalDays: 15,
  });
});

test('resets a failed recall and never lowers the ease factor below 1.3', () => {
  assert.deepEqual(
    calculateNextReview({
      quality: 0,
      intervalDays: 30,
      easeFactor: 1.3,
      reviewedAt: REVIEWED_AT,
    }),
    {
      dueAt: REVIEWED_AT + DAY_MS,
      easeFactor: 1.3,
      intervalDays: 1,
    }
  );
});

test('rejects invalid quality, card state, and review timestamps', () => {
  const valid = {
    quality: 3,
    intervalDays: 0,
    easeFactor: 2.5,
    reviewedAt: REVIEWED_AT,
  };

  for (const quality of [-1, 1.5, 6, '5']) {
    assert.throws(() => calculateNextReview({ ...valid, quality }), RangeError);
  }
  for (const intervalDays of [-1, 1.5, '1']) {
    assert.throws(() => calculateNextReview({ ...valid, intervalDays }), RangeError);
  }
  for (const easeFactor of [0, -1, Number.NaN, '2.5']) {
    assert.throws(() => calculateNextReview({ ...valid, easeFactor }), RangeError);
  }
  for (const reviewedAt of [-1, 1.5, '2026-07-28T12:00:00.000Z']) {
    assert.throws(() => calculateNextReview({ ...valid, reviewedAt }), RangeError);
  }
});
