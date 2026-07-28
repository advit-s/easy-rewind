'use strict';

const DAY_MS = 24 * 60 * 60 * 1000;
const MINIMUM_EASE_FACTOR = 1.3;

function requireIntegerInRange(value, name, minimum, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
}

function requirePositiveNumber(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive finite number`);
  }
}

function roundEaseFactor(value) {
  return Math.round(value * 100) / 100;
}

function calculateNextReview({ quality, intervalDays, easeFactor, reviewedAt } = {}) {
  requireIntegerInRange(quality, 'quality', 0, 5);
  requireIntegerInRange(intervalDays, 'intervalDays', 0);
  requirePositiveNumber(easeFactor, 'easeFactor');
  requireIntegerInRange(reviewedAt, 'reviewedAt', 0);

  const qualityDelta = 5 - quality;
  const nextEaseFactor = roundEaseFactor(
    Math.max(MINIMUM_EASE_FACTOR, easeFactor + 0.1 - qualityDelta * (0.08 + qualityDelta * 0.02))
  );

  let nextIntervalDays;
  if (quality < 3) {
    nextIntervalDays = 1;
  } else if (intervalDays === 0) {
    nextIntervalDays = 1;
  } else if (intervalDays === 1) {
    nextIntervalDays = 6;
  } else {
    nextIntervalDays = Math.max(1, Math.round(intervalDays * easeFactor));
  }

  const dueAt = reviewedAt + nextIntervalDays * DAY_MS;
  requireIntegerInRange(dueAt, 'dueAt', reviewedAt);

  return Object.freeze({
    dueAt,
    easeFactor: nextEaseFactor,
    intervalDays: nextIntervalDays,
  });
}

module.exports = { calculateNextReview };
