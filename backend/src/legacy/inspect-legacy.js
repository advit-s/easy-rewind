'use strict';

const { createHash, randomUUID } = require('node:crypto');
const {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const { basename, dirname, isAbsolute, join, relative, resolve, sep } = require('node:path');

const { createLegacyReport } = require('./legacy-report');

const sensitivityWarning = 'Contains sensitive personal legacy data and is not secure credential storage.';
const requiredNames = Object.freeze(['easy-rewind.db', 'easy-rewind.db-wal', 'easy-rewind.db-shm', 'settings.json']);
const requiredNameSet = new Set(requiredNames);

const knownLegacyColumns = Object.freeze({
  bookmarks: ['id', 'user_id', 'url', 'title', 'topic', 'notes', 'remind_at', 'reminded', 'created_at'],
  cache: ['id', 'term', 'definition', 'created_at'],
  search_log: ['id', 'user_id', 'query', 'found', 'created_at'],
  notes: [
    'id',
    'user_id',
    'content',
    'source_url',
    'source_title',
    'remind_at',
    'reminded',
    'reminder_note',
    'completed',
    'created_at',
  ],
  reminders: [
    'id',
    'user_id',
    'reminder_type',
    'reference_type',
    'reference_id',
    'title',
    'message',
    'remind_at',
    'reminded',
    'dismissed',
    'created_at',
    'repeat_interval_days',
    'repeat_count',
    'max_repeats',
    'next_review_at',
  ],
  push_subscriptions: ['id', 'user_id', 'endpoint', 'keys', 'created_at'],
  research_queue: [
    'id',
    'user_id',
    'url',
    'title',
    'user_notes',
    'research_result',
    'status',
    'error_message',
    'remind_when_done',
    'created_at',
    'completed_at',
  ],
  highlights: ['id', 'user_id', 'url', 'page_title', 'text', 'context', 'color', 'tags', 'note', 'created_at'],
  items: [
    'id',
    'user_id',
    'url',
    'title',
    'content',
    'ai_summary',
    'tags',
    'embedding',
    'source_type',
    'memory_score',
    'interaction_count',
    'last_interaction',
    'created_at',
  ],
  item_tags: ['id', 'item_id', 'tag'],
  memory_connections: [
    'id',
    'user_id',
    'source_item_id',
    'target_item_id',
    'relationship',
    'confidence',
    'source',
    'auto_discovered',
    'created_at',
  ],
  error_log: ['id', 'user_id', 'level', 'component', 'message', 'stack', 'metadata', 'created_at'],
  flashcards: [
    'id',
    'user_id',
    'term',
    'definition',
    'source',
    'source_id',
    'source_url',
    'ease_factor',
    'interval_days',
    'repetitions',
    'next_review_at',
    'last_reviewed_at',
    'created_at',
  ],
  quiz_results: ['id', 'user_id', 'item_id', 'item_type', 'correct', 'time_spent_ms', 'quizzed_at'],
  digests: [
    'id',
    'user_id',
    'title',
    'summary',
    'period_start',
    'period_end',
    'bookmark_count',
    'note_count',
    'highlight_count',
    'flashcard_count',
    'quiz_accuracy',
    'top_topics',
    'top_items',
    'sent_at',
    'created_at',
  ],
  items_fts: ['id', 'title', 'content', 'tags'],
});

const conflictKeys = Object.freeze({
  bookmarks: ['user_id', 'url'],
  flashcards: ['user_id', 'term'],
  highlights: ['user_id', 'url', 'text'],
  item_tags: ['item_id', 'tag'],
  items: ['user_id', 'url'],
  memory_connections: ['source_item_id', 'target_item_id'],
  push_subscriptions: ['user_id', 'endpoint'],
});

const supportedValues = Object.freeze({
  'flashcards.source': ['bookmark', 'item', 'manual'],
  'highlights.color': ['yellow', 'green', 'blue', 'pink', 'purple'],
  'items.source_type': ['web', 'youtube', 'github', 'blog', 'news', 'docs', 'note'],
  'reminders.reminder_type': ['bookmark_review', 'note_action', 'research_done', 'custom', 'tab_close'],
  'research_queue.status': ['pending', 'processing', 'done', 'failed'],
});

class LegacyInspectionError extends Error {
  constructor(code) {
    const messages = {
      LEGACY_INPUT_INVALID: 'Legacy inspection input is invalid.',
      LEGACY_MANIFEST_INVALID: 'The quarantine manifest is invalid.',
      LEGACY_MANIFEST_MISMATCH: 'The quarantine snapshot does not match its manifest.',
      LEGACY_COPY_FAILED: 'The disposable inspection copy could not be created safely.',
      LEGACY_CLEANUP_FAILED: 'The disposable inspection copy could not be removed safely.',
      LEGACY_INSPECTION_FAILED: 'The legacy snapshot could not be inspected safely.',
    };
    super(messages[code] ?? messages.LEGACY_INSPECTION_FAILED);
    this.name = 'LegacyInspectionError';
    this.code = code;
  }
}

function fail(code) {
  throw new LegacyInspectionError(code);
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex').toUpperCase();
}

function comparable(path) {
  const normalized = resolve(path);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function samePath(left, right) {
  return comparable(left) === comparable(right);
}

function isContained(parent, candidate) {
  const value = relative(resolve(parent), resolve(candidate));
  return value === '' || (!isAbsolute(value) && value !== '..' && !value.startsWith(`..${sep}`));
}

function regularUnlinked(path, code, expectedKind = 'file') {
  let metadata;
  try {
    metadata = lstatSync(path);
  } catch {
    fail(code);
  }
  const expected = expectedKind === 'directory' ? metadata.isDirectory() : metadata.isFile();
  let canonical;
  try {
    canonical = realpathSync.native(path);
  } catch {
    fail(code);
  }
  if (!expected || metadata.isSymbolicLink() || !samePath(canonical, path)) fail(code);
  return metadata;
}

function hasSameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function readRegularFile(path, code) {
  const before = regularUnlinked(path, code);
  let handle;
  try {
    const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
    handle = openSync(path, constants.O_RDONLY | noFollow);
    const held = fstatSync(handle);
    if (!held.isFile() || !hasSameIdentity(before, held) || held.nlink !== 1) fail(code);
    const bytes = readFileSync(handle);
    const after = fstatSync(handle);
    if (!hasSameIdentity(held, after) || held.size !== after.size || after.nlink !== 1) fail(code);
    return bytes;
  } catch (error) {
    if (error instanceof LegacyInspectionError) throw error;
    fail(code);
  } finally {
    if (handle !== undefined) {
      try {
        closeSync(handle);
      } catch {
        fail(code);
      }
    }
  }
}

function normalizeManifestPath(manifestPath) {
  if (
    typeof manifestPath !== 'string' ||
    manifestPath.length === 0 ||
    !isAbsolute(manifestPath) ||
    resolve(manifestPath) !== manifestPath ||
    basename(manifestPath) !== 'manifest.json'
  ) {
    fail('LEGACY_INPUT_INVALID');
  }
  return manifestPath;
}

function verifyEntry(quarantinePath, entry, code) {
  const backupPath = join(quarantinePath, entry.name);
  if (!isContained(quarantinePath, backupPath)) fail('LEGACY_MANIFEST_INVALID');
  const bytes = readRegularFile(backupPath, code);
  if (bytes.length !== entry.size || digest(bytes) !== entry.sha256) fail(code);
}

function verifyLegacyManifest(manifestPath) {
  const normalizedPath = normalizeManifestPath(manifestPath);
  const quarantinePath = dirname(normalizedPath);
  regularUnlinked(quarantinePath, 'LEGACY_MANIFEST_INVALID', 'directory');
  const bytes = readRegularFile(normalizedPath, 'LEGACY_MANIFEST_INVALID');
  if (bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) fail('LEGACY_MANIFEST_INVALID');
  let manifest;
  try {
    manifest = JSON.parse(bytes.toString('utf8'));
  } catch {
    fail('LEGACY_MANIFEST_INVALID');
  }
  if (
    manifest === null ||
    typeof manifest !== 'object' ||
    Array.isArray(manifest) ||
    manifest.schemaVersion !== 1 ||
    manifest.sensitive !== true ||
    manifest.warning !== sensitivityWarning ||
    manifest.sqliteOpened !== false ||
    manifest.manifestPath !== normalizedPath ||
    manifest.quarantinePath !== quarantinePath ||
    typeof manifest.backupTimeUtc !== 'string' ||
    Number.isNaN(Date.parse(manifest.backupTimeUtc)) ||
    !Array.isArray(manifest.files) ||
    manifest.files.length !== requiredNames.length
  ) {
    fail('LEGACY_MANIFEST_INVALID');
  }
  const names = new Set(manifest.files.map(entry => entry?.name));
  if (names.size !== requiredNames.length || requiredNames.some(name => !names.has(name))) {
    fail('LEGACY_MANIFEST_INVALID');
  }
  const files = manifest.files.map(entry => {
    if (
      entry === null ||
      typeof entry !== 'object' ||
      Array.isArray(entry) ||
      !requiredNameSet.has(entry.name) ||
      entry.backupRelativePath !== entry.name ||
      basename(entry.name) !== entry.name ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0 ||
      typeof entry.sha256 !== 'string' ||
      !/^[A-F0-9]{64}$/.test(entry.sha256)
    ) {
      fail('LEGACY_MANIFEST_INVALID');
    }
    const vetted = Object.freeze({ name: entry.name, size: entry.size, sha256: entry.sha256 });
    verifyEntry(quarantinePath, vetted, 'LEGACY_MANIFEST_MISMATCH');
    return vetted;
  });
  return Object.freeze({
    manifestPath: normalizedPath,
    quarantinePath,
    files: Object.freeze(files),
  });
}

function validateCopyOptions(options) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) fail('LEGACY_INPUT_INVALID');
  const { manifestPath, workRoot, filePermissions, generateId = randomUUID, removeDisposable = rmSync } = options;
  if (
    typeof workRoot !== 'string' ||
    !isAbsolute(workRoot) ||
    resolve(workRoot) !== workRoot ||
    typeof generateId !== 'function' ||
    typeof removeDisposable !== 'function' ||
    filePermissions === null ||
    typeof filePermissions !== 'object' ||
    typeof filePermissions.restrictDirectory !== 'function' ||
    typeof filePermissions.restrictFile !== 'function'
  ) {
    fail('LEGACY_INPUT_INVALID');
  }
  regularUnlinked(workRoot, 'LEGACY_INPUT_INVALID', 'directory');
  return { manifestPath, workRoot, filePermissions, generateId, removeDisposable };
}

function copyVerifiedFile(source, destination, entry) {
  const bytes = readRegularFile(source, 'LEGACY_MANIFEST_MISMATCH');
  if (bytes.length !== entry.size || digest(bytes) !== entry.sha256) fail('LEGACY_MANIFEST_MISMATCH');
  try {
    writeFileSync(destination, bytes, { flag: 'wx', mode: 0o600 });
  } catch {
    fail('LEGACY_COPY_FAILED');
  }
}

async function withDisposableLegacyCopy(options, operation) {
  const normalized = validateCopyOptions(options);
  if (typeof operation !== 'function') fail('LEGACY_INPUT_INVALID');
  const snapshot = verifyLegacyManifest(normalized.manifestPath);
  if (
    isContained(snapshot.quarantinePath, normalized.workRoot) ||
    isContained(normalized.workRoot, snapshot.quarantinePath)
  ) {
    fail('LEGACY_INPUT_INVALID');
  }
  let leaf;
  try {
    leaf = normalized.generateId();
  } catch {
    fail('LEGACY_INPUT_INVALID');
  }
  if (typeof leaf !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(leaf)) {
    fail('LEGACY_INPUT_INVALID');
  }
  const disposableRoot = join(normalized.workRoot, `legacy-inspection-${leaf}`);
  if (!isContained(normalized.workRoot, disposableRoot)) fail('LEGACY_INPUT_INVALID');

  let created = false;
  let operationStarted = false;
  let pendingError;
  let result;
  try {
    mkdirSync(disposableRoot, { recursive: false, mode: 0o700 });
    created = true;
    await normalized.filePermissions.restrictDirectory(disposableRoot);
    for (const entry of snapshot.files) {
      const source = join(snapshot.quarantinePath, entry.name);
      const destination = join(disposableRoot, entry.name);
      copyVerifiedFile(source, destination, entry);
      await normalized.filePermissions.restrictFile(destination);
      verifyEntry(disposableRoot, entry, 'LEGACY_COPY_FAILED');
    }
    operationStarted = true;
    const copy = Object.freeze({
      root: disposableRoot,
      databasePath: join(disposableRoot, 'easy-rewind.db'),
      walPath: join(disposableRoot, 'easy-rewind.db-wal'),
      shmPath: join(disposableRoot, 'easy-rewind.db-shm'),
      settingsPath: join(disposableRoot, 'settings.json'),
    });
    result = await operation(copy);
    for (const entry of snapshot.files) {
      verifyEntry(snapshot.quarantinePath, entry, 'LEGACY_MANIFEST_MISMATCH');
    }
  } catch (error) {
    if (error instanceof LegacyInspectionError) pendingError = error;
    else pendingError = new LegacyInspectionError(operationStarted ? 'LEGACY_INSPECTION_FAILED' : 'LEGACY_COPY_FAILED');
  } finally {
    if (created && isContained(normalized.workRoot, disposableRoot)) {
      try {
        normalized.removeDisposable(disposableRoot, { recursive: true, force: true });
      } catch {
        pendingError = new LegacyInspectionError('LEGACY_CLEANUP_FAILED');
      }
    } else if (created) {
      pendingError = new LegacyInspectionError('LEGACY_CLEANUP_FAILED');
    }
  }
  if (pendingError) throw pendingError;
  return result;
}

function quotedIdentifier(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 255 || value.includes('\0')) {
    fail('LEGACY_INSPECTION_FAILED');
  }
  return `"${value.replaceAll('"', '""')}"`;
}

function safeCount(value) {
  if (!Number.isSafeInteger(value) || value < 0) fail('LEGACY_INSPECTION_FAILED');
  return value;
}

function schemaColumn(column) {
  if (
    column === null ||
    typeof column !== 'object' ||
    typeof column.name !== 'string' ||
    column.name.length === 0 ||
    column.name.length > 255 ||
    column.name.includes('\0') ||
    typeof column.type !== 'string' ||
    !Number.isInteger(column.notnull) ||
    !Number.isInteger(column.pk) ||
    (column.hidden !== undefined && !Number.isInteger(column.hidden))
  ) {
    fail('LEGACY_INSPECTION_FAILED');
  }
  return Object.freeze({
    name: column.name,
    type: column.type.toUpperCase(),
    notnull: column.notnull,
    pk: column.pk,
    hidden: column.hidden ?? 0,
  });
}

function duplicateCount(database, tableName, columns) {
  const identifiers = columns.map(quotedIdentifier);
  const table = quotedIdentifier(tableName);
  const sql = `SELECT COALESCE(SUM(duplicate_count - 1), 0) AS count
    FROM (
      SELECT COUNT(*) AS duplicate_count
      FROM ${table}
      GROUP BY ${identifiers.join(', ')}
      HAVING COUNT(*) > 1
    )`;
  return safeCount(database.prepare(sql).pluck().get());
}

function unsupportedValueCount(database, tableName, columnName, values) {
  const placeholders = values.map(() => '?').join(', ');
  const sql = `SELECT COUNT(*) AS count
    FROM ${quotedIdentifier(tableName)}
    WHERE ${quotedIdentifier(columnName)} IS NOT NULL
      AND ${quotedIdentifier(columnName)} NOT IN (${placeholders})`;
  return safeCount(
    database
      .prepare(sql)
      .pluck()
      .get(...values)
  );
}

function inspectDatabase(database) {
  if (
    database === null ||
    typeof database !== 'object' ||
    typeof database.prepare !== 'function' ||
    typeof database.pragma !== 'function'
  ) {
    fail('LEGACY_INSPECTION_FAILED');
  }
  database.pragma('query_only = ON');
  if (database.pragma('query_only', { simple: true }) !== 1) fail('LEGACY_INSPECTION_FAILED');
  const tableRows = database
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table'
         AND name NOT LIKE 'sqlite_%'
         AND name NOT IN (SELECT name FROM pragma_table_list WHERE type = 'shadow')
       ORDER BY name`
    )
    .all();
  if (!Array.isArray(tableRows)) fail('LEGACY_INSPECTION_FAILED');

  const schema = [];
  const tables = [];
  const unsupportedTables = [];
  const unsupportedColumns = [];
  const conflictTables = [];
  const unsupportedValueCounts = [];
  let totalRows = 0;
  let supportedRows = 0;

  for (const tableRow of tableRows) {
    const name = tableRow?.name;
    const identifier = quotedIdentifier(name);
    const rawColumns = database.prepare(`PRAGMA table_xinfo(${identifier})`).all();
    if (!Array.isArray(rawColumns)) fail('LEGACY_INSPECTION_FAILED');
    const columns = rawColumns.map(schemaColumn);
    const rowCount = safeCount(database.prepare(`SELECT COUNT(*) FROM ${identifier}`).pluck().get());
    totalRows += rowCount;
    if (!Number.isSafeInteger(totalRows)) fail('LEGACY_INSPECTION_FAILED');
    tables.push(Object.freeze({ name, rowCount }));
    schema.push(Object.freeze({ name, columns }));

    const expectedColumns = knownLegacyColumns[name];
    if (!expectedColumns) {
      unsupportedTables.push(name);
      continue;
    }
    supportedRows += rowCount;
    const actualNames = new Set(columns.map(column => column.name));
    const extras = columns
      .map(column => column.name)
      .filter(columnName => !expectedColumns.includes(columnName))
      .sort((left, right) => left.localeCompare(right));
    if (extras.length > 0) {
      unsupportedColumns.push(Object.freeze({ table: name, columns: Object.freeze(extras) }));
    }
    const keys = conflictKeys[name];
    if (keys?.every(key => actualNames.has(key))) {
      const count = duplicateCount(database, name, keys);
      if (count > 0) conflictTables.push(Object.freeze({ table: name, count }));
    }
    for (const [rule, values] of Object.entries(supportedValues)) {
      const [ruleTable, column] = rule.split('.');
      if (ruleTable !== name || !actualNames.has(column)) continue;
      const count = unsupportedValueCount(database, name, column, values);
      if (count > 0) unsupportedValueCounts.push(Object.freeze({ table: name, column, count }));
    }
  }

  const schemaSignature = createHash('sha256').update(JSON.stringify(schema)).digest('hex');
  const conflictTotal = conflictTables.reduce((total, entry) => total + entry.count, 0);
  const unsupportedValueTotal = unsupportedValueCounts.reduce((total, entry) => total + entry.count, 0);
  const unknownRows = tables
    .filter(table => unsupportedTables.includes(table.name))
    .reduce((total, table) => total + table.rowCount, 0);
  return createLegacyReport({
    schemaSignature,
    tables,
    totalRows,
    likelyConflicts: {
      total: conflictTotal,
      tables: conflictTables,
    },
    unsupportedSchema: {
      tables: unsupportedTables,
      columns: unsupportedColumns,
      values: unsupportedValueCounts,
    },
    estimatedActions: {
      inspectableRows: totalRows,
      likelyImports: Math.max(0, supportedRows - conflictTotal - unsupportedValueTotal),
      reviewRequired: conflictTotal + unsupportedValueTotal + unknownRows,
      importPerformed: false,
      schemaConversionPerformed: false,
    },
  });
}

async function inspectLegacy({ openDatabase, ...copyOptions } = {}) {
  if (openDatabase === undefined) openDatabase = require('../database/open-database').openDatabase;
  if (typeof openDatabase !== 'function') fail('LEGACY_INPUT_INVALID');
  return withDisposableLegacyCopy(copyOptions, async copy => {
    let database;
    try {
      database = await openDatabase({
        path: copy.databasePath,
        readonly: true,
        filePermissions: copyOptions.filePermissions,
      });
      return inspectDatabase(database);
    } finally {
      try {
        database?.close();
      } catch {
        // The stable inspection failure remains authoritative.
      }
    }
  });
}

module.exports = {
  LegacyInspectionError,
  inspectLegacy,
  verifyLegacyManifest,
  withDisposableLegacyCopy,
};
