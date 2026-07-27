'use strict';

const { createHash } = require('node:crypto');
const { lstatSync, readFileSync, readdirSync } = require('node:fs');
const { join, resolve } = require('node:path');

const defaultMigrationDirectory = join(__dirname, 'migrations');
const migrationFilenamePattern = /^(\d{3})_([a-z][a-z0-9_]*)\.sql$/;

const MIGRATION_ERROR_MESSAGES = Object.freeze({
  MIGRATION_OPTIONS_INVALID: 'Migration runner options are invalid.',
  MIGRATION_DIRECTORY_INVALID: 'The migration directory is invalid.',
  MIGRATION_DIRECTORY_LINKED: 'The migration directory and files must not be links.',
  MIGRATION_FILENAME_INVALID: 'Migration SQL filenames must use the canonical versioned format.',
  MIGRATION_VERSION_INVALID: 'Migration versions must be positive integers.',
  MIGRATION_VERSION_DUPLICATE: 'Migration versions must be unique.',
  MIGRATION_VERSION_GAP: 'Migration versions must be contiguous and start at one.',
  MIGRATION_NAME_DUPLICATE: 'Migration names must be unique.',
  MIGRATION_MANIFEST_INVALID: 'The migration manifest is invalid.',
  MIGRATION_DATABASE_NEWER: 'The database schema is newer than this application.',
  MIGRATION_HISTORY_INVALID: 'The applied migration history is invalid.',
  MIGRATION_NAME_MISMATCH: 'An applied migration name does not match the canonical manifest.',
  MIGRATION_CHECKSUM_MISMATCH: 'An applied migration checksum does not match the canonical bytes.',
  MIGRATION_BUSY: 'The database migration lock could not be acquired.',
  MIGRATION_SQL_FAILED: 'A database migration could not be applied atomically.',
  MIGRATION_CLOCK_INVALID: 'The migration timestamp is invalid.',
});

class MigrationError extends Error {
  constructor(code) {
    super(MIGRATION_ERROR_MESSAGES[code]);
    this.name = 'MigrationError';
    this.code = code;
  }
}

function fail(code) {
  throw new MigrationError(code);
}

function checksum(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function assertRegularUnlinked(path, expectedDirectory) {
  let metadata;
  try {
    metadata = lstatSync(path);
  } catch {
    fail('MIGRATION_DIRECTORY_INVALID');
  }
  if (metadata.isSymbolicLink()) fail('MIGRATION_DIRECTORY_LINKED');
  if (expectedDirectory ? !metadata.isDirectory() : !metadata.isFile()) {
    fail('MIGRATION_DIRECTORY_INVALID');
  }
}

function validateManifest(migrations) {
  if (!Array.isArray(migrations) || migrations.length === 0) fail('MIGRATION_MANIFEST_INVALID');
  const versions = new Set();
  const names = new Set();
  const normalized = migrations.map(migration => {
    if (
      migration === null ||
      typeof migration !== 'object' ||
      !Number.isSafeInteger(migration.version) ||
      migration.version < 1 ||
      typeof migration.name !== 'string' ||
      !/^[a-z][a-z0-9_]*$/.test(migration.name) ||
      !Buffer.isBuffer(migration.bytes) ||
      typeof migration.checksum !== 'string' ||
      !/^[a-f0-9]{64}$/.test(migration.checksum) ||
      checksum(migration.bytes) !== migration.checksum
    ) {
      fail('MIGRATION_MANIFEST_INVALID');
    }
    if (versions.has(migration.version)) fail('MIGRATION_VERSION_DUPLICATE');
    if (names.has(migration.name)) fail('MIGRATION_NAME_DUPLICATE');
    versions.add(migration.version);
    names.add(migration.name);
    return Object.freeze({
      version: migration.version,
      name: migration.name,
      checksum: migration.checksum,
      bytes: Buffer.from(migration.bytes),
    });
  });
  normalized.sort((left, right) => left.version - right.version);
  normalized.forEach((migration, index) => {
    if (migration.version !== index + 1) fail('MIGRATION_VERSION_GAP');
  });
  return normalized;
}

function discoverMigrations({ directory = defaultMigrationDirectory } = {}) {
  if (typeof directory !== 'string' || resolve(directory) !== directory) {
    fail('MIGRATION_DIRECTORY_INVALID');
  }
  assertRegularUnlinked(directory, true);
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    fail('MIGRATION_DIRECTORY_INVALID');
  }

  const migrations = [];
  const versions = new Set();
  const names = new Set();
  for (const entry of entries) {
    if (!entry.name.endsWith('.sql')) continue;
    const match = migrationFilenamePattern.exec(entry.name);
    if (!match) fail('MIGRATION_FILENAME_INVALID');
    const version = Number(match[1]);
    const name = match[2];
    if (version < 1) fail('MIGRATION_VERSION_INVALID');
    if (versions.has(version)) fail('MIGRATION_VERSION_DUPLICATE');
    if (names.has(name)) fail('MIGRATION_NAME_DUPLICATE');
    versions.add(version);
    names.add(name);

    const path = join(directory, entry.name);
    assertRegularUnlinked(path, false);
    let bytes;
    try {
      bytes = readFileSync(path);
    } catch {
      fail('MIGRATION_DIRECTORY_INVALID');
    }
    migrations.push({ version, name, bytes, checksum: checksum(bytes) });
  }
  return Object.freeze(validateManifest(migrations));
}

function createMigrationTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY CHECK (version >= 1),
      name TEXT NOT NULL UNIQUE CHECK (name <> ''),
      checksum TEXT NOT NULL CHECK (length(checksum) = 64),
      applied_at INTEGER NOT NULL CHECK (applied_at >= 0)
    )
  `);
}

function readApplied(db) {
  return db
    .prepare(
      `SELECT version, name, checksum, applied_at
       FROM schema_migrations
       ORDER BY version`
    )
    .all();
}

function validateApplied(applied, migrations) {
  const latestKnown = migrations.at(-1).version;
  if (applied.some(row => Number.isSafeInteger(row.version) && row.version > latestKnown)) {
    fail('MIGRATION_DATABASE_NEWER');
  }
  for (const [index, row] of applied.entries()) {
    if (
      !Number.isSafeInteger(row.version) ||
      row.version !== index + 1 ||
      typeof row.name !== 'string' ||
      typeof row.checksum !== 'string' ||
      !Number.isSafeInteger(row.applied_at) ||
      row.applied_at < 0
    ) {
      fail('MIGRATION_HISTORY_INVALID');
    }
    const canonical = migrations[row.version - 1];
    if (row.name !== canonical.name) fail('MIGRATION_NAME_MISMATCH');
    if (row.checksum !== canonical.checksum) fail('MIGRATION_CHECKSUM_MISMATCH');
  }
  return applied.length;
}

function rollback(db) {
  try {
    if (db.inTransaction) db.exec('ROLLBACK');
  } catch {
    // The original stable migration failure remains authoritative.
  }
}

function beginImmediate(db) {
  try {
    db.exec('BEGIN IMMEDIATE');
  } catch (error) {
    if (error?.code === 'SQLITE_BUSY' || error?.code === 'SQLITE_LOCKED') fail('MIGRATION_BUSY');
    fail('MIGRATION_SQL_FAILED');
  }
}

function runMigrations({ db, migrations = discoverMigrations(), now = Date.now } = {}) {
  if (
    db === null ||
    typeof db !== 'object' ||
    typeof db.exec !== 'function' ||
    typeof db.prepare !== 'function' ||
    typeof now !== 'function'
  ) {
    fail('MIGRATION_OPTIONS_INVALID');
  }
  const manifest = validateManifest(migrations);

  let appliedCount;
  beginImmediate(db);
  try {
    createMigrationTable(db);
    appliedCount = validateApplied(readApplied(db), manifest);
    db.exec('COMMIT');
  } catch (error) {
    rollback(db);
    if (error instanceof MigrationError) throw error;
    fail('MIGRATION_SQL_FAILED');
  }

  const appliedVersions = [];
  for (const migration of manifest.slice(appliedCount)) {
    beginImmediate(db);
    try {
      createMigrationTable(db);
      const currentCount = validateApplied(readApplied(db), manifest);
      if (currentCount >= migration.version) {
        db.exec('COMMIT');
        continue;
      }
      if (currentCount !== migration.version - 1) fail('MIGRATION_HISTORY_INVALID');
      const appliedAt = now();
      if (!Number.isSafeInteger(appliedAt) || appliedAt < 0) fail('MIGRATION_CLOCK_INVALID');
      db.exec(migration.bytes.toString('utf8'));
      db.prepare(
        `INSERT INTO schema_migrations(version, name, checksum, applied_at)
         VALUES (?, ?, ?, ?)`
      ).run(migration.version, migration.name, migration.checksum, appliedAt);
      db.exec('COMMIT');
      appliedVersions.push(migration.version);
    } catch (error) {
      rollback(db);
      if (error instanceof MigrationError) throw error;
      fail('MIGRATION_SQL_FAILED');
    }
  }

  return Object.freeze({
    appliedVersions: Object.freeze(appliedVersions),
    currentVersion: manifest.at(-1).version,
  });
}

module.exports = {
  MIGRATION_ERROR_MESSAGES,
  MigrationError,
  discoverMigrations,
  runMigrations,
};
