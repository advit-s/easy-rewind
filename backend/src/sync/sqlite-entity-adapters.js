'use strict';

const { containsProviderCredential, SYNC_ENTITY_TYPES } = require('./entity-registry');
const { SyncError, fail } = require('./sync-error');

const DANGEROUS_JSON_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const SENSITIVE_SETTING_KEY = /(?:api[_-]?key|token|secret|credential|password)/i;
const ITEM_KINDS = new Set(['article', 'webpage', 'video', 'pdf', 'note']);
const HIGHLIGHT_COLORS = new Set(['yellow', 'green', 'blue', 'pink', 'purple']);
const REMINDER_STATES = new Set(['scheduled', 'snoozed', 'due', 'completed', 'cancelled', 'failed']);
const FLASHCARD_STATES = new Set(['active', 'suspended', 'retired']);
const RESEARCH_STATES = new Set(['queued', 'running', 'succeeded', 'failed', 'cancelled']);

function field(key, column, validate, options = {}) {
  return Object.freeze({ key, column, validate, ...options });
}

function isText(value, { empty = true, maximum = 32_768 } = {}) {
  return typeof value === 'string' && value.length <= maximum && (empty || value.trim() !== '');
}

function isNullableText(value) {
  return value === null || isText(value);
}

function isTimestamp(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isNullableTimestamp(value) {
  return value === null || isTimestamp(value);
}

function isIdentifier(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 256 &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function isNullableIdentifier(value) {
  return value === null || isIdentifier(value);
}

function isUrl(value) {
  if (value === null) return true;
  if (!isText(value, { maximum: 8_192 })) return false;
  try {
    const parsed = new URL(value);
    return ['http:', 'https:'].includes(parsed.protocol) && parsed.username === '' && parsed.password === '';
  } catch {
    return false;
  }
}

function isScore(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function canonicalJson(value, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('SYNC_PAYLOAD_INVALID');
    return value;
  }
  if (typeof value !== 'object' || ancestors.has(value)) fail('SYNC_PAYLOAD_INVALID');
  const array = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (!array && prototype !== Object.prototype && prototype !== null) fail('SYNC_PAYLOAD_INVALID');

  ancestors.add(value);
  try {
    if (array) {
      const result = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) fail('SYNC_PAYLOAD_INVALID');
        result.push(canonicalJson(value[index], ancestors));
      }
      return result;
    }
    const result = {};
    for (const key of Object.keys(value).sort()) {
      if (DANGEROUS_JSON_KEYS.has(key)) fail('SYNC_PAYLOAD_INVALID');
      result[key] = canonicalJson(value[key], ancestors);
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

function jsonField(key, column) {
  return field(key, column, () => true, {
    encode(value) {
      const encoded = JSON.stringify(canonicalJson(value));
      if (encoded.length > 32_768) fail('SYNC_PAYLOAD_INVALID');
      return encoded;
    },
    decode(value) {
      try {
        return canonicalJson(JSON.parse(value));
      } catch (error) {
        if (error instanceof SyncError) throw error;
        fail('SYNC_PAYLOAD_INVALID');
      }
    },
  });
}

function relation(key, column, table, nullable = false) {
  return field(key, column, nullable ? isNullableIdentifier : isIdentifier, {
    relation: Object.freeze({ table, nullable }),
  });
}

const CONFIGURATIONS = Object.freeze({
  item: Object.freeze({
    table: 'items',
    fields: Object.freeze([
      field('kind', 'kind', value => ITEM_KINDS.has(value)),
      field('title', 'title', value => isText(value, { maximum: 4_096 })),
      field('url', 'url', isUrl),
      field('excerpt', 'excerpt', isText),
      field('body', 'body', isText),
      field('source', 'source', isNullableText),
      field('publishedAt', 'published_at', isNullableTimestamp),
      field('archivedAt', 'archived_at', isNullableTimestamp),
    ]),
  }),
  bookmark: Object.freeze({
    table: 'bookmarks',
    fields: Object.freeze([relation('itemId', 'item_id', 'items')]),
  }),
  note: Object.freeze({
    table: 'notes',
    fields: Object.freeze([
      relation('itemId', 'item_id', 'items', true),
      field('body', 'body', value => isText(value, { empty: false })),
    ]),
  }),
  highlight: Object.freeze({
    table: 'highlights',
    fields: Object.freeze([
      relation('itemId', 'item_id', 'items'),
      field('quote', 'quote', value => isText(value, { empty: false })),
      field('prefix', 'prefix', isText),
      field('suffix', 'suffix', isText),
      field('color', 'color', value => HIGHLIGHT_COLORS.has(value)),
    ]),
  }),
  tag: Object.freeze({
    table: 'tags',
    fields: Object.freeze([
      field('name', 'name', value => isText(value, { empty: false, maximum: 256 })),
      field(
        'normalizedName',
        'normalized_name',
        (value, payload) =>
          isText(value, { empty: false, maximum: 256 }) &&
          value === payload.name.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US')
      ),
    ]),
  }),
  item_tag: Object.freeze({
    table: 'item_tags',
    fields: Object.freeze([relation('itemId', 'item_id', 'items'), relation('tagId', 'tag_id', 'tags')]),
  }),
  connection: Object.freeze({
    table: 'connections',
    fields: Object.freeze([
      relation('sourceItemId', 'source_item_id', 'items'),
      field(
        'targetItemId',
        'target_item_id',
        (value, payload) => isIdentifier(value) && value !== payload.sourceItemId,
        { relation: Object.freeze({ table: 'items', nullable: false }) }
      ),
      field('relation', 'relation', value => isText(value, { empty: false, maximum: 256 })),
      field('note', 'note', isText),
    ]),
  }),
  reminder: Object.freeze({
    table: 'reminders',
    fields: Object.freeze([
      relation('itemId', 'item_id', 'items', true),
      field('state', 'state', value => REMINDER_STATES.has(value)),
      field('dueAt', 'due_at', isTimestamp),
      field('completedAt', 'completed_at', isNullableTimestamp),
    ]),
  }),
  flashcard: Object.freeze({
    table: 'flashcards',
    fields: Object.freeze([
      relation('itemId', 'item_id', 'items', true),
      field('prompt', 'prompt', value => isText(value, { empty: false })),
      field('answer', 'answer', value => isText(value, { empty: false })),
      field('state', 'state', value => FLASHCARD_STATES.has(value)),
      field('dueAt', 'due_at', isNullableTimestamp),
      field('intervalDays', 'interval_days', value => Number.isSafeInteger(value) && value >= 0),
      field('easeFactor', 'ease_factor', value => Number.isFinite(value) && value > 0),
    ]),
  }),
  quiz_result: Object.freeze({
    table: 'quiz_results',
    fields: Object.freeze([
      relation('itemId', 'item_id', 'items', true),
      field('quizKind', 'quiz_kind', value => isText(value, { empty: false, maximum: 256 })),
      field('score', 'score', isScore),
      field(
        'maxScore',
        'max_score',
        (value, payload) => Number.isSafeInteger(value) && value > 0 && payload.score <= value
      ),
      jsonField('answers', 'answers_json'),
      field('completedAt', 'completed_at', isTimestamp),
    ]),
  }),
  research_job: Object.freeze({
    table: 'research_jobs',
    fields: Object.freeze([
      field('query', 'query', value => isText(value, { empty: false, maximum: 20_000 })),
      field('state', 'state', value => RESEARCH_STATES.has(value)),
      field('result', 'result_json', value => value === null || typeof value === 'object', {
        encode(value) {
          return value === null ? null : JSON.stringify(canonicalJson(value));
        },
        decode(value) {
          return value === null ? null : canonicalJson(JSON.parse(value));
        },
      }),
      field('errorCode', 'error_code', value => value === null || isText(value, { empty: false, maximum: 128 })),
      field('startedAt', 'started_at', isNullableTimestamp),
      field('finishedAt', 'finished_at', isNullableTimestamp),
    ]),
  }),
  digest: Object.freeze({
    table: 'digests',
    fields: Object.freeze([
      field('title', 'title', value => isText(value, { empty: false, maximum: 4_096 })),
      field('body', 'body', isText),
      field('periodStart', 'period_start', isTimestamp),
      field('periodEnd', 'period_end', (value, payload) => isTimestamp(value) && value >= payload.periodStart),
    ]),
  }),
  setting: Object.freeze({
    table: 'settings',
    fields: Object.freeze([
      field(
        'key',
        'key',
        value =>
          isText(value, { empty: false, maximum: 256 }) && value.trim() === value && !SENSITIVE_SETTING_KEY.test(value)
      ),
      jsonField('value', 'value_json'),
    ]),
  }),
});

function validateConfiguration({ db, now } = {}) {
  if (
    db === null ||
    typeof db !== 'object' ||
    typeof db.prepare !== 'function' ||
    typeof db.transaction !== 'function' ||
    typeof now !== 'function'
  ) {
    fail('SYNC_CONFIGURATION_INVALID');
  }
  return { db, now };
}

function validateIdentity(profileId, entityId) {
  if (!isIdentifier(profileId) || !isIdentifier(entityId)) fail('SYNC_INPUT_INVALID');
}

function validatePayload(configuration, payload) {
  if (
    payload === null ||
    typeof payload !== 'object' ||
    Array.isArray(payload) ||
    Object.getPrototypeOf(payload) !== Object.prototype ||
    containsProviderCredential(payload)
  ) {
    fail('SYNC_PAYLOAD_INVALID');
  }
  const actual = Object.keys(payload).sort();
  const expected = configuration.fields.map(entry => entry.key).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail('SYNC_PAYLOAD_INVALID');
  }
  const values = [];
  for (const entry of configuration.fields) {
    const value = payload[entry.key];
    let valid;
    try {
      valid = entry.validate(value, payload);
    } catch (error) {
      if (error instanceof SyncError) throw error;
      fail('SYNC_PAYLOAD_INVALID');
    }
    if (!valid) fail('SYNC_PAYLOAD_INVALID');
    values.push(entry.encode ? entry.encode(value) : value);
  }
  return values;
}

function validateDeletePayload(payload) {
  if (
    payload === null ||
    typeof payload !== 'object' ||
    Array.isArray(payload) ||
    Object.getPrototypeOf(payload) !== Object.prototype ||
    Object.keys(payload).length !== 0
  ) {
    fail('SYNC_PAYLOAD_INVALID');
  }
}

function readPayload(configuration, row) {
  const payload = {};
  for (const entry of configuration.fields) {
    try {
      payload[entry.key] = entry.decode ? entry.decode(row[entry.column]) : row[entry.column];
    } catch (error) {
      if (error instanceof SyncError) throw error;
      fail('SYNC_PAYLOAD_INVALID');
    }
  }
  return payload;
}

function resultFromRow(configuration, row) {
  const deleted = row.deleted_at !== null;
  return {
    revision: row.revision,
    deleted,
    payload: deleted ? {} : readPayload(configuration, row),
  };
}

function createAdapter({ db, now }, configuration) {
  const select = db.prepare(
    `SELECT *
     FROM ${configuration.table}
     WHERE profile_id = ? AND id = ?
     LIMIT 1`
  );
  const findOwner = db.prepare(`SELECT profile_id FROM ${configuration.table} WHERE id = ? LIMIT 1`);
  const profileExists = db.prepare(
    `SELECT 1
     FROM profiles
     WHERE id = ? AND deleted_at IS NULL
     LIMIT 1`
  );
  const relationStatements = new Map(
    configuration.fields
      .filter(entry => entry.relation)
      .map(entry => [
        entry.key,
        db.prepare(
          `SELECT 1
           FROM ${entry.relation.table}
           WHERE profile_id = ? AND id = ? AND deleted_at IS NULL
           LIMIT 1`
        ),
      ])
  );
  const columns = configuration.fields.map(entry => entry.column);
  const insert = db.prepare(
    `INSERT INTO ${configuration.table}(
       id, profile_id, ${columns.join(', ')}, created_at, updated_at, revision, deleted_at
     ) VALUES (
       ?, ?, ${columns.map(() => '?').join(', ')}, ?, ?, ?, NULL
     )`
  );
  const update = db.prepare(
    `UPDATE ${configuration.table}
     SET ${columns.map(column => `${column} = ?`).join(', ')},
         updated_at = ?, revision = ?, deleted_at = NULL
     WHERE profile_id = ? AND id = ?`
  );
  const tombstone = db.prepare(
    `UPDATE ${configuration.table}
     SET updated_at = ?, revision = ?, deleted_at = ?
     WHERE profile_id = ? AND id = ?`
  );
  const snapshot = db.prepare(
    `SELECT *
     FROM ${configuration.table}
     WHERE profile_id = ?
     ORDER BY id ASC`
  );

  function read({ profileId, entityId } = {}) {
    validateIdentity(profileId, entityId);
    const row = select.get(profileId, entityId);
    return row ? resultFromRow(configuration, row) : null;
  }

  function requireClock(current) {
    let value;
    try {
      value = now();
    } catch {
      fail('SYNC_CONFIGURATION_INVALID');
    }
    if (!isTimestamp(value)) fail('SYNC_CONFIGURATION_INVALID');
    return current ? Math.max(value, current.created_at, current.updated_at) : value;
  }

  function apply({ profileId, entityId, kind, revision, payload } = {}) {
    validateIdentity(profileId, entityId);
    if (!['upsert', 'delete'].includes(kind) || !Number.isSafeInteger(revision) || revision < 1) {
      fail('SYNC_INPUT_INVALID');
    }
    if (kind === 'delete') validateDeletePayload(payload);
    const current = select.get(profileId, entityId);
    if (!current) {
      if (findOwner.get(entityId)) fail('SYNC_INPUT_INVALID');
      if (kind === 'delete') fail('NOT_FOUND');
    }
    const expectedRevision = current ? current.revision + 1 : 1;
    if (revision !== expectedRevision) fail('SYNC_INPUT_INVALID');
    if (!profileExists.get(profileId)) fail('SYNC_INPUT_INVALID');
    const at = requireClock(current);

    try {
      if (kind === 'delete') {
        const changed = tombstone.run(at, revision, at, profileId, entityId);
        if (changed.changes !== 1) fail('NOT_FOUND');
      } else {
        const values = validatePayload(configuration, payload);
        for (const entry of configuration.fields) {
          if (!entry.relation || payload[entry.key] === null) continue;
          if (!relationStatements.get(entry.key).get(profileId, payload[entry.key])) {
            fail('SYNC_PAYLOAD_INVALID');
          }
        }
        if (current) {
          const changed = update.run(...values, at, revision, profileId, entityId);
          if (changed.changes !== 1) fail('NOT_FOUND');
        } else {
          insert.run(entityId, profileId, ...values, at, at, revision);
        }
      }
    } catch (error) {
      if (error instanceof SyncError) throw error;
      if (typeof error?.code === 'string' && error.code.startsWith('SQLITE_CONSTRAINT')) {
        fail('SYNC_PAYLOAD_INVALID');
      }
      throw error;
    }
    return read({ profileId, entityId });
  }

  function createSnapshot({ profileId } = {}) {
    if (!isIdentifier(profileId)) fail('SYNC_INPUT_INVALID');
    return snapshot.all(profileId).map(row => {
      const record = resultFromRow(configuration, row);
      return {
        entityId: row.id,
        revision: record.revision,
        kind: record.deleted ? 'delete' : 'upsert',
        payload: record.payload,
      };
    });
  }

  return Object.freeze({ apply, get: read, snapshot: createSnapshot });
}

function createSqliteEntityAdapters(options) {
  const context = validateConfiguration(options);
  const adapters = {};
  for (const entityType of SYNC_ENTITY_TYPES) {
    const configuration = CONFIGURATIONS[entityType];
    if (!configuration) fail('SYNC_CONFIGURATION_INVALID');
    adapters[entityType] = createAdapter(context, configuration);
  }
  return Object.freeze(adapters);
}

module.exports = { createSqliteEntityAdapters };
