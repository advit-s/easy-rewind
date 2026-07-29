import { normalizeExternalUrl } from './dom.js';

export const MAX_COLLECTION_ITEMS = 200;
export const MAX_SHORT_TEXT_LENGTH = 240;
export const MAX_LONG_TEXT_LENGTH = 4_000;

const MAX_TAGS = 20;
const MAX_TAG_LENGTH = 64;
const MAX_CURSOR_LENGTH = 1_024;
const SAFE_IDENTIFIER = /^[^\u0000-\u001f\u007f]{1,256}$/u;
const SAFE_CURSOR = /^[^\u0000-\u001f\u007f]{1,1024}$/u;
const ERROR = Object.freeze({
  code: 'view_unavailable',
  message: 'This dashboard section is temporarily unavailable.',
});

class ProfileIsolationError extends Error {
  constructor() {
    super('Dashboard data crossed the active profile boundary.');
    this.name = 'ProfileIsolationError';
    this.code = 'PROFILE_ISOLATION_VIOLATION';
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertProfile(record, expectedProfileId) {
  const observed = [record.profileId, record.profile_id].filter(value => value !== undefined);
  if (observed.some(value => value !== expectedProfileId)) {
    throw new ProfileIsolationError();
  }
  return observed.includes(expectedProfileId);
}

function identifier(value) {
  return typeof value === 'string' && value.trim() === value && SAFE_IDENTIFIER.test(value) ? value : null;
}

function text(value, maximum, fallback = '') {
  if (typeof value !== 'string') return fallback;
  return value.slice(0, maximum);
}

function timestamp(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function boundedInteger(value, minimum, maximum, fallback = minimum) {
  if (!Number.isSafeInteger(value)) return fallback;
  return Math.max(minimum, Math.min(maximum, value));
}

function boundedNumber(value, minimum, maximum, fallback = minimum) {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.min(maximum, value));
}

function tags(value) {
  if (!Array.isArray(value)) return Object.freeze([]);
  return Object.freeze(
    value
      .filter(entry => typeof entry === 'string' && entry.trim() !== '')
      .slice(0, MAX_TAGS)
      .map(entry => entry.slice(0, MAX_TAG_LENGTH))
  );
}

function common(record, expectedProfileId) {
  if (!isObject(record) || !assertProfile(record, expectedProfileId)) return null;
  const id = identifier(record.id);
  if (id === null) return null;
  return { id, profileId: expectedProfileId };
}

function bookmark(record, expectedProfileId) {
  const base = common(record, expectedProfileId);
  if (base === null) return null;
  return Object.freeze({
    ...base,
    title: text(record.title, MAX_SHORT_TEXT_LENGTH, 'Untitled bookmark'),
    description: text(record.description, MAX_LONG_TEXT_LENGTH),
    url: normalizeExternalUrl(record.url),
    tags: tags(record.tags),
    createdAt: timestamp(record.createdAt ?? record.created_at),
  });
}

function note(record, expectedProfileId) {
  const base = common(record, expectedProfileId);
  if (base === null) return null;
  return Object.freeze({
    ...base,
    title: text(record.title, MAX_SHORT_TEXT_LENGTH, 'Untitled note'),
    body: text(record.body, MAX_LONG_TEXT_LENGTH),
    completed: record.completed === true,
    updatedAt: timestamp(record.updatedAt ?? record.updated_at),
  });
}

function research(record, expectedProfileId) {
  const base = common(record, expectedProfileId);
  if (base === null) return null;
  return Object.freeze({
    ...base,
    title: text(record.title, MAX_SHORT_TEXT_LENGTH, 'Untitled research'),
    summary: text(record.summary, MAX_LONG_TEXT_LENGTH),
    state: text(record.state, 64, 'unknown'),
    url: normalizeExternalUrl(record.url),
    updatedAt: timestamp(record.updatedAt ?? record.updated_at),
  });
}

function memory(record, expectedProfileId) {
  const base = common(record, expectedProfileId);
  if (base === null) return null;
  return Object.freeze({
    ...base,
    title: text(record.title, MAX_SHORT_TEXT_LENGTH, 'Untitled memory'),
    summary: text(record.summary, MAX_LONG_TEXT_LENGTH),
    url: normalizeExternalUrl(record.url),
    memoryScore: boundedNumber(record.memoryScore ?? record.memory_score, 0, 1),
    createdAt: timestamp(record.createdAt ?? record.created_at),
  });
}

function highlight(record, expectedProfileId) {
  const base = common(record, expectedProfileId);
  if (base === null) return null;
  return Object.freeze({
    ...base,
    text: text(record.text, MAX_LONG_TEXT_LENGTH),
    pageTitle: text(record.pageTitle ?? record.page_title, MAX_SHORT_TEXT_LENGTH, 'Untitled source'),
    url: normalizeExternalUrl(record.url),
    color: ['yellow', 'green', 'blue', 'pink', 'purple'].includes(record.color) ? record.color : 'yellow',
    createdAt: timestamp(record.createdAt ?? record.created_at),
  });
}

function reminder(record, expectedProfileId) {
  const base = common(record, expectedProfileId);
  const dueAt = timestamp(record?.dueAt ?? record?.due_at);
  if (base === null || dueAt === null) return null;
  return Object.freeze({
    ...base,
    title: text(record.title, MAX_SHORT_TEXT_LENGTH, 'Reminder'),
    message: text(record.message, MAX_LONG_TEXT_LENGTH),
    state: text(record.state, 64, 'scheduled'),
    dueAt,
  });
}

function digest(record, expectedProfileId) {
  const base = common(record, expectedProfileId);
  if (base === null) return null;
  return Object.freeze({
    ...base,
    title: text(record.title, MAX_SHORT_TEXT_LENGTH, 'Digest'),
    state: text(record.state, 64, 'ready'),
    itemCount: boundedInteger(record.itemCount ?? record.item_count, 0, 10_000),
    createdAt: timestamp(record.createdAt ?? record.created_at),
  });
}

function pagination(nextCursor, hasMore) {
  if (
    typeof hasMore !== 'boolean' ||
    (hasMore &&
      (typeof nextCursor !== 'string' || nextCursor.length > MAX_CURSOR_LENGTH || !SAFE_CURSOR.test(nextCursor))) ||
    (!hasMore && nextCursor !== null && nextCursor !== undefined)
  ) {
    throw new TypeError('Dashboard pagination is invalid.');
  }
  return Object.freeze({
    nextCursor: hasMore ? nextCursor : null,
    hasMore,
  });
}

function createView(kind, normalizeRecord, input = {}) {
  const expectedProfileId = identifier(input.profileId);
  if (expectedProfileId === null) throw new TypeError('Dashboard profile is invalid.');
  const status = input.status ?? 'ready';
  if (!['loading', 'ready', 'error'].includes(status)) {
    throw new TypeError('Dashboard view status is invalid.');
  }
  if (status !== 'ready') {
    return Object.freeze({
      kind,
      state: status,
      items: Object.freeze([]),
      pagination: pagination(null, false),
      omittedCount: 0,
      error: status === 'error' ? ERROR : null,
    });
  }
  if (!Array.isArray(input.items)) throw new TypeError('Dashboard items are invalid.');

  const normalized = [];
  for (const record of input.items) {
    const item = normalizeRecord(record, expectedProfileId);
    if (item !== null && normalized.length < MAX_COLLECTION_ITEMS) normalized.push(item);
  }
  const page = pagination(input.nextCursor ?? null, input.hasMore ?? false);
  const omittedCount = input.items.length - normalized.length;
  const state =
    normalized.length === 0 && omittedCount === 0 ? 'empty' : omittedCount > 0 || page.hasMore ? 'partial' : 'ready';
  return Object.freeze({
    kind,
    state,
    items: Object.freeze(normalized),
    pagination: page,
    omittedCount,
    error: null,
  });
}

export const createBookmarksView = input => createView('bookmarks', bookmark, input);
export const createNotesView = input => createView('notes', note, input);
export const createResearchView = input => createView('research', research, input);
export const createMemoriesView = input => createView('memories', memory, input);
export const createHighlightsView = input => createView('highlights', highlight, input);
export const createRemindersView = input => createView('reminders', reminder, input);
export const createDigestsView = input => createView('digests', digest, input);
