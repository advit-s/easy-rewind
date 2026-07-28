'use strict';

const { DomainError, fail } = require('./domain-error');

const MAX_CURSOR_LENGTH = 512;
const MAX_JSON_LENGTH = 1_048_576;
const MAX_PAGE_SIZE = 100;
const DANGEROUS_JSON_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function table(hasDeletedAt = true) {
  return Object.freeze({ hasDeletedAt });
}

const TABLES = Object.freeze({
  bookmarks: table(),
  connections: table(),
  digests: table(),
  flashcards: table(),
  highlights: table(),
  interactions: table(),
  items: table(),
  item_tags: table(),
  memory_scores: table(),
  notes: table(),
  provider_configurations: table(),
  quiz_results: table(),
  reminder_deliveries: table(),
  reminders: table(),
  research_jobs: table(),
  settings: table(),
  sync_devices: table(),
  tags: table(),
});

function isIdentifier(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 256 &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function requireIdentifier(value, code = 'REPOSITORY_INPUT_INVALID') {
  if (!isIdentifier(value)) fail(code);
  return value;
}

function requireTable(value) {
  if (typeof value !== 'string' || !Object.hasOwn(TABLES, value)) {
    fail('REPOSITORY_INPUT_INVALID');
  }
  return Object.freeze({ name: value, ...TABLES[value] });
}

function requireTimestamp(value, code) {
  if (!Number.isSafeInteger(value) || value < 0) fail(code);
  return value;
}

function cursorPayload(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('CURSOR_INVALID');
  }
  const keys = Object.keys(value);
  if (keys.length !== 2 || !keys.includes('updatedAt') || !keys.includes('id')) {
    fail('CURSOR_INVALID');
  }
  return {
    updatedAt: requireTimestamp(value.updatedAt, 'CURSOR_INVALID'),
    id: requireIdentifier(value.id, 'CURSOR_INVALID'),
  };
}

function encodeCursor(value) {
  const payload = cursorPayload(value);
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeCursor(cursor) {
  if (
    typeof cursor !== 'string' ||
    cursor.length === 0 ||
    cursor.length > MAX_CURSOR_LENGTH ||
    !/^[A-Za-z0-9_-]+$/.test(cursor)
  ) {
    fail('CURSOR_INVALID');
  }

  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const payload = cursorPayload(JSON.parse(decoded));
    if (encodeCursor(payload) !== cursor) fail('CURSOR_INVALID');
    return payload;
  } catch (error) {
    if (error instanceof DomainError) throw error;
    fail('CURSOR_INVALID');
  }
}

function canonicalJson(value, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('JSON_INVALID');
    return value;
  }
  if (typeof value !== 'object') fail('JSON_INVALID');
  if (ancestors.has(value)) fail('JSON_INVALID');

  const prototype = Object.getPrototypeOf(value);
  const isArray = Array.isArray(value);
  if (!isArray && prototype !== Object.prototype && prototype !== null) {
    fail('JSON_INVALID');
  }

  ancestors.add(value);
  try {
    if (isArray) {
      const copy = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) fail('JSON_INVALID');
        copy.push(canonicalJson(value[index], ancestors));
      }
      return copy;
    }

    const copy = {};
    for (const key of Object.keys(value).sort()) {
      if (DANGEROUS_JSON_KEYS.has(key)) fail('JSON_INVALID');
      copy[key] = canonicalJson(value[key], ancestors);
    }
    return copy;
  } finally {
    ancestors.delete(value);
  }
}

function serializeJson(value) {
  try {
    const serialized = JSON.stringify(canonicalJson(value));
    if (typeof serialized !== 'string' || serialized.length > MAX_JSON_LENGTH) {
      fail('JSON_INVALID');
    }
    return serialized;
  } catch (error) {
    if (error instanceof DomainError) throw error;
    fail('JSON_INVALID');
  }
}

function parseJson(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_JSON_LENGTH) {
    fail('JSON_INVALID');
  }
  try {
    return canonicalJson(JSON.parse(value));
  } catch (error) {
    if (error instanceof DomainError) throw error;
    fail('JSON_INVALID');
  }
}

function normalizeIdAllocator(ids) {
  if (typeof ids === 'function') return ids;
  if (ids !== null && typeof ids === 'object') {
    if (typeof ids.next === 'function') return ids.next.bind(ids);
    if (typeof ids.create === 'function') return ids.create.bind(ids);
  }
  fail('REPOSITORY_CONFIGURATION_INVALID');
}

function validateConfiguration(options) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    fail('REPOSITORY_CONFIGURATION_INVALID');
  }
  const { db, ids, now } = options;
  if (
    db === null ||
    typeof db !== 'object' ||
    typeof db.prepare !== 'function' ||
    typeof db.transaction !== 'function' ||
    typeof now !== 'function'
  ) {
    fail('REPOSITORY_CONFIGURATION_INVALID');
  }
  return { db, allocateId: normalizeIdAllocator(ids), now };
}

function createRepositoryUtils(options) {
  const { db, allocateId, now } = validateConfiguration(options);

  function nextId() {
    let value;
    try {
      value = allocateId();
    } catch (error) {
      if (error instanceof DomainError) throw error;
      fail('ID_INVALID');
    }
    return requireIdentifier(value, 'ID_INVALID');
  }

  function timestamp() {
    let value;
    try {
      value = now();
    } catch (error) {
      if (error instanceof DomainError) throw error;
      fail('CLOCK_INVALID');
    }
    return requireTimestamp(value, 'CLOCK_INVALID');
  }

  function newRecord() {
    const id = nextId();
    const createdAt = timestamp();
    return {
      id,
      createdAt,
      updatedAt: createdAt,
      revision: 1,
    };
  }

  function page({ profileId, table: tableName, cursor, limit = 25 } = {}) {
    const owner = requireIdentifier(profileId);
    const selectedTable = requireTable(tableName);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
      fail('PAGINATION_INVALID');
    }
    const position = cursor === undefined || cursor === null ? null : decodeCursor(cursor);
    const livePredicate = selectedTable.hasDeletedAt ? ' AND deleted_at IS NULL' : '';
    const cursorPredicate = position === null ? '' : ' AND (updated_at < ? OR (updated_at = ? AND id < ?))';
    const statement = db.prepare(
      `SELECT *
       FROM ${selectedTable.name}
       WHERE profile_id = ?${livePredicate}${cursorPredicate}
       ORDER BY updated_at DESC, id DESC
       LIMIT ?`
    );
    const parameters =
      position === null ? [owner, limit + 1] : [owner, position.updatedAt, position.updatedAt, position.id, limit + 1];
    const rows = statement.all(...parameters);
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items.at(-1);
    return {
      items,
      nextCursor:
        hasMore && last
          ? encodeCursor({
              updatedAt: last.updated_at,
              id: last.id,
            })
          : null,
      hasMore,
    };
  }

  function requireById({ profileId, table: tableName, id } = {}) {
    const owner = requireIdentifier(profileId);
    const recordId = requireIdentifier(id);
    const selectedTable = requireTable(tableName);
    const livePredicate = selectedTable.hasDeletedAt ? ' AND deleted_at IS NULL' : '';
    const row = db
      .prepare(
        `SELECT *
         FROM ${selectedTable.name}
         WHERE profile_id = ? AND id = ?${livePredicate}
         LIMIT 1`
      )
      .get(owner, recordId);
    if (!row) fail('NOT_FOUND');
    return row;
  }

  function allocateRevision({ profileId, table: tableName, id, expectedRevision } = {}) {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      fail('REPOSITORY_INPUT_INVALID');
    }
    const row = requireById({ profileId, table: tableName, id });
    if (row.revision !== expectedRevision || row.revision >= Number.MAX_SAFE_INTEGER) {
      fail('CONFLICT');
    }
    return row.revision + 1;
  }

  function transaction(work) {
    if (typeof work !== 'function') fail('REPOSITORY_INPUT_INVALID');
    if (db.inTransaction) return work();
    const boundary = db.transaction(work);
    if (typeof boundary?.immediate !== 'function') {
      fail('REPOSITORY_CONFIGURATION_INVALID');
    }
    return boundary.immediate();
  }

  return Object.freeze({
    allocateRevision,
    newRecord,
    nextId,
    page,
    parseJson,
    requireById,
    serializeJson,
    timestamp,
    transaction,
  });
}

module.exports = {
  DomainError,
  createRepositoryUtils,
  decodeCursor,
  encodeCursor,
};
