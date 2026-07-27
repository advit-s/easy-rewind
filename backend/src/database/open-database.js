'use strict';

const { lstatSync, realpathSync } = require('node:fs');
const { dirname, isAbsolute, join, parse, relative, resolve, sep } = require('node:path');

const DATABASE_OPEN_ERROR_MESSAGES = Object.freeze({
  DATABASE_OPTIONS_INVALID: 'Database open options are invalid.',
  DATABASE_PATH_INVALID: 'The database path must be one exact absolute path.',
  DATABASE_PARENT_MISSING: 'The database parent directory must already exist.',
  DATABASE_PARENT_INVALID: 'The database parent must be a regular directory.',
  DATABASE_PATH_LINKED: 'Database paths must not contain links or reparse points.',
  DATABASE_TARGET_INVALID: 'The database target must be a regular file.',
  DATABASE_READONLY_MISSING: 'The readonly database target must already exist.',
  DATABASE_BUSY_TIMEOUT_INVALID: 'The database busy timeout is invalid.',
  DATABASE_FILE_PERMISSIONS_INVALID: 'A restrictive file-permission adapter is required.',
  DATABASE_FILE_PERMISSIONS_FAILED: 'Restrictive database file permissions could not be applied.',
  DATABASE_OPEN_FAILED: 'The database could not be opened safely.',
});

class DatabaseOpenError extends Error {
  constructor(code) {
    super(DATABASE_OPEN_ERROR_MESSAGES[code]);
    this.name = 'DatabaseOpenError';
    this.code = code;
  }
}

function fail(code) {
  throw new DatabaseOpenError(code);
}

function comparable(path) {
  const normalized = resolve(path);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function inspectExisting(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    fail('DATABASE_OPEN_FAILED');
  }
}

function assertNotLinked(path, metadata) {
  if (metadata.isSymbolicLink()) fail('DATABASE_PATH_LINKED');
  let canonical;
  try {
    canonical = realpathSync.native(path);
  } catch {
    fail('DATABASE_OPEN_FAILED');
  }
  if (comparable(canonical) !== comparable(path)) fail('DATABASE_PATH_LINKED');
}

function inspectPath(path) {
  const root = parse(path).root;
  let current = root;
  let targetMetadata = null;

  for (const component of relative(root, path).split(sep).filter(Boolean)) {
    current = join(current, component);
    const metadata = inspectExisting(current);
    if (metadata === null) break;
    assertNotLinked(current, metadata);
    if (comparable(current) === comparable(path)) targetMetadata = metadata;
  }
  return targetMetadata;
}

function normalizeOptions(options) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    fail('DATABASE_OPTIONS_INVALID');
  }
  const { path, readonly = false, filePermissions, busyTimeoutMs = 5000 } = options;
  if (
    typeof path !== 'string' ||
    path.length === 0 ||
    path.trim() !== path ||
    !isAbsolute(path) ||
    resolve(path) !== path
  ) {
    fail('DATABASE_PATH_INVALID');
  }
  if (typeof readonly !== 'boolean') fail('DATABASE_OPTIONS_INVALID');
  if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0 || busyTimeoutMs > 2_147_483_647) {
    fail('DATABASE_BUSY_TIMEOUT_INVALID');
  }
  if (
    filePermissions === null ||
    typeof filePermissions !== 'object' ||
    typeof filePermissions.restrictDirectory !== 'function' ||
    typeof filePermissions.restrictFile !== 'function'
  ) {
    fail('DATABASE_FILE_PERMISSIONS_INVALID');
  }
  return { path, readonly, filePermissions, busyTimeoutMs };
}

function makeCloseIdempotent(db) {
  const nativeClose = db.close.bind(db);
  let closed = false;
  db.close = () => {
    if (closed) return;
    closed = true;
    nativeClose();
  };
  return db;
}

async function openDatabase(options) {
  const normalized = normalizeOptions(options);
  const parent = dirname(normalized.path);
  const parentMetadata = inspectPath(parent);
  if (parentMetadata === null) fail('DATABASE_PARENT_MISSING');
  if (!parentMetadata.isDirectory()) fail('DATABASE_PARENT_INVALID');

  const targetMetadata = inspectPath(normalized.path);
  if (targetMetadata !== null && !targetMetadata.isFile()) fail('DATABASE_TARGET_INVALID');
  if (normalized.readonly && targetMetadata === null) fail('DATABASE_READONLY_MISSING');

  let db;
  try {
    const BetterSqlite3 = require('better-sqlite3');
    db = new BetterSqlite3(normalized.path, {
      readonly: normalized.readonly,
      fileMustExist: normalized.readonly,
    });
    db.pragma('foreign_keys = ON');
    db.pragma(`busy_timeout = ${normalized.busyTimeoutMs}`);
    if (normalized.readonly) db.pragma('query_only = ON');
    else db.pragma('journal_mode = WAL');
  } catch {
    if (db?.open) {
      try {
        db.close();
      } catch {
        // The stable open error remains authoritative.
      }
    }
    fail('DATABASE_OPEN_FAILED');
  }

  try {
    await normalized.filePermissions.restrictFile(normalized.path);
  } catch {
    try {
      db.close();
    } catch {
      // The stable permission error remains authoritative.
    }
    fail('DATABASE_FILE_PERMISSIONS_FAILED');
  }

  return makeCloseIdempotent(db);
}

module.exports = {
  DATABASE_OPEN_ERROR_MESSAGES,
  DatabaseOpenError,
  openDatabase,
};
