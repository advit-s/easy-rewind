'use strict';

const { createHash, randomUUID } = require('node:crypto');

const FORMAT = 'easy-rewind';
const FORMAT_VERSION = 1;
const SCHEMA_VERSION = 4;
const MAX_BYTES = 10_000_000;
const MAX_DEPTH = 12;
const MAX_ROWS = 10_000;
const SECRET_SETTING = /(?:api[_-]?key|token|secret|credential|password)/i;

const table = (columns, references = []) =>
  Object.freeze({
    columns: Object.freeze(columns),
    references: Object.freeze(references.map(reference => Object.freeze(reference))),
  });

const tables = Object.freeze({
  items: table([
    'id',
    'profile_id',
    'kind',
    'title',
    'url',
    'excerpt',
    'body',
    'source',
    'published_at',
    'archived_at',
    'created_at',
    'updated_at',
    'revision',
    'deleted_at',
  ]),
  tags: table(['id', 'profile_id', 'name', 'normalized_name', 'created_at', 'updated_at', 'revision', 'deleted_at']),
  bookmarks: table(
    ['id', 'profile_id', 'item_id', 'created_at', 'updated_at', 'revision', 'deleted_at'],
    [{ column: 'item_id', table: 'items' }]
  ),
  notes: table(
    ['id', 'profile_id', 'item_id', 'body', 'created_at', 'updated_at', 'revision', 'deleted_at'],
    [{ column: 'item_id', table: 'items', optional: true }]
  ),
  highlights: table(
    [
      'id',
      'profile_id',
      'item_id',
      'quote',
      'prefix',
      'suffix',
      'color',
      'created_at',
      'updated_at',
      'revision',
      'deleted_at',
    ],
    [{ column: 'item_id', table: 'items' }]
  ),
  item_tags: table(
    ['id', 'profile_id', 'item_id', 'tag_id', 'created_at', 'updated_at', 'revision', 'deleted_at'],
    [
      { column: 'item_id', table: 'items' },
      { column: 'tag_id', table: 'tags' },
    ]
  ),
  connections: table(
    [
      'id',
      'profile_id',
      'source_item_id',
      'target_item_id',
      'relation',
      'note',
      'created_at',
      'updated_at',
      'revision',
      'deleted_at',
    ],
    [
      { column: 'source_item_id', table: 'items' },
      { column: 'target_item_id', table: 'items' },
    ]
  ),
  reminders: table(
    [
      'id',
      'profile_id',
      'item_id',
      'state',
      'due_at',
      'completed_at',
      'created_at',
      'updated_at',
      'revision',
      'deleted_at',
    ],
    [{ column: 'item_id', table: 'items', optional: true }]
  ),
  flashcards: table(
    [
      'id',
      'profile_id',
      'item_id',
      'prompt',
      'answer',
      'state',
      'due_at',
      'interval_days',
      'ease_factor',
      'created_at',
      'updated_at',
      'revision',
      'deleted_at',
    ],
    [{ column: 'item_id', table: 'items', optional: true }]
  ),
  quiz_results: table(
    [
      'id',
      'profile_id',
      'item_id',
      'quiz_kind',
      'score',
      'max_score',
      'answers_json',
      'completed_at',
      'created_at',
      'updated_at',
      'revision',
      'deleted_at',
    ],
    [{ column: 'item_id', table: 'items', optional: true }]
  ),
  digests: table([
    'id',
    'profile_id',
    'title',
    'body',
    'period_start',
    'period_end',
    'created_at',
    'updated_at',
    'revision',
    'deleted_at',
  ]),
  settings: table(['id', 'profile_id', 'key', 'value_json', 'created_at', 'updated_at', 'revision', 'deleted_at']),
  interactions: table(
    [
      'id',
      'profile_id',
      'item_id',
      'kind',
      'value_json',
      'occurred_at',
      'created_at',
      'updated_at',
      'revision',
      'deleted_at',
    ],
    [{ column: 'item_id', table: 'items' }]
  ),
  memory_scores: table(
    [
      'id',
      'profile_id',
      'item_id',
      'score',
      'confidence',
      'last_interaction_at',
      'created_at',
      'updated_at',
      'revision',
      'deleted_at',
    ],
    [{ column: 'item_id', table: 'items' }]
  ),
});

const BUNDLE_SCHEMA = Object.freeze({
  format: FORMAT,
  formatVersion: FORMAT_VERSION,
  schemaVersion: SCHEMA_VERSION,
  tables,
});

const SAFE_MESSAGES = Object.freeze({
  EXPORT_OPTIONS_INVALID: 'Export service options are invalid.',
  EXPORT_OWNER_INVALID: 'The export owner is invalid.',
  EXPORT_OWNER_NOT_FOUND: 'The export owner was not found.',
  EXPORT_CLOCK_INVALID: 'The export clock is invalid.',
  EXPORT_CANCELLED: 'The export was cancelled.',
  EXPORT_FAILED: 'The export could not be completed.',
  EXPORT_NOT_FOUND: 'The export was not found.',
  EXPORT_STATE_INVALID: 'The export state does not allow this operation.',
  BACKUP_OPTIONS_INVALID: 'Backup service options are invalid.',
  BACKUP_INPUT_INVALID: 'The backup input is invalid.',
  BACKUP_FAILED: 'The backup could not be created.',
  BACKUP_INVALID: 'The backup is invalid.',
  BACKUP_CHECKSUM_INVALID: 'The backup checksum is invalid.',
  IMPORT_OPTIONS_INVALID: 'Import service options are invalid.',
  IMPORT_OWNER_INVALID: 'The import owner is invalid.',
  IMPORT_JSON_INVALID: 'The import JSON is invalid.',
  IMPORT_TOO_LARGE: 'The import exceeds the byte limit.',
  IMPORT_TOO_DEEP: 'The import exceeds the nesting limit.',
  IMPORT_TOO_MANY_ROWS: 'The import exceeds the row limit.',
  IMPORT_BUNDLE_INVALID: 'The import bundle is invalid.',
  IMPORT_VERSION_UNSUPPORTED: 'The import version is unsupported.',
  IMPORT_CHECKSUM_INVALID: 'The import checksum is invalid.',
  IMPORT_DUPLICATE_ID: 'The import contains duplicate identifiers.',
  IMPORT_OWNER_MISMATCH: 'The import owner does not match.',
  IMPORT_REFERENCE_INVALID: 'The import contains an invalid reference.',
  IMPORT_SECRET_INVALID: 'The import contains a protected setting.',
  IMPORT_CONFLICT: 'The import conflicts with current data.',
  IMPORT_BACKUP_REQUIRED: 'A verified destination backup is required.',
  IMPORT_APPLY_FAILED: 'The import could not be applied.',
  IMPORT_NOT_FOUND: 'The import was not found.',
  IMPORT_STATE_INVALID: 'The import state does not allow this operation.',
  IMPORT_CANCELLED: 'The import was cancelled.',
  IMPORT_ROLLBACK_FAILED: 'The import rollback could not be completed.',
});

class ImportExportError extends Error {
  constructor(code) {
    super(SAFE_MESSAGES[code] ?? 'The operation could not be completed.');
    this.name = 'ImportExportError';
    this.code = code;
  }
}

function fail(code) {
  throw new ImportExportError(code);
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function bundleChecksum(data) {
  return sha256(Buffer.from(stableStringify(data)));
}

function exactKeys(value, keys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function assertIdentifier(value, code) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 256 || value.trim() !== value) {
    fail(code);
  }
  return value;
}

function assertNow(now, code = 'EXPORT_CLOCK_INVALID') {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) fail(code);
  return value;
}

function createId(ids) {
  const value = ids();
  return assertIdentifier(value, 'IMPORT_OPTIONS_INVALID');
}

function defaultIds() {
  return randomUUID();
}

function assertNotAborted(signal, code) {
  if (signal?.aborted === true) fail(code);
}

function isAbort(error) {
  return error?.name === 'AbortError' || error?.code === 'ABORT_ERR';
}

function containsSecretKey(value, observed = new WeakSet()) {
  if (value === null || typeof value !== 'object' || observed.has(value)) return false;
  observed.add(value);
  if (Array.isArray(value)) return value.some(nested => containsSecretKey(nested, observed));
  return Object.entries(value).some(([key, nested]) => SECRET_SETTING.test(key) || containsSecretKey(nested, observed));
}

function settingContainsSecret(row) {
  if (SECRET_SETTING.test(row.key)) return true;
  try {
    return containsSecretKey(JSON.parse(row.value_json));
  } catch {
    return false;
  }
}

function tableRows(db, profileId, tableName) {
  const declaration = tables[tableName];
  const columns = declaration.columns.map(column => `"${column}"`).join(', ');
  const rows = db
    .prepare(
      `SELECT ${columns}
       FROM "${tableName}"
       WHERE profile_id = ?
       ORDER BY id COLLATE BINARY ASC`
    )
    .all(profileId);
  if (tableName === 'settings') return rows.filter(row => !settingContainsSecret(row));
  return rows;
}

function collectData(db, profileId) {
  return Object.fromEntries(Object.keys(tables).map(tableName => [tableName, tableRows(db, profileId, tableName)]));
}

function buildBundle({ db, profileId, createdAt }) {
  const data = collectData(db, profileId);
  return {
    manifest: {
      format: FORMAT,
      formatVersion: FORMAT_VERSION,
      schemaVersion: SCHEMA_VERSION,
      ownerId: profileId,
      createdAt,
      checksum: bundleChecksum(data),
    },
    data,
  };
}

module.exports = {
  BUNDLE_SCHEMA,
  ImportExportError,
  MAX_BYTES,
  MAX_DEPTH,
  MAX_ROWS,
  SECRET_SETTING,
  assertIdentifier,
  assertNotAborted,
  assertNow,
  buildBundle,
  bundleChecksum,
  createId,
  defaultIds,
  exactKeys,
  fail,
  isAbort,
  settingContainsSecret,
  sha256,
  stableStringify,
};
