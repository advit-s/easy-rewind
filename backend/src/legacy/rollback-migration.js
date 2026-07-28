'use strict';

const { createHash } = require('node:crypto');
const { copyFileSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } = require('node:fs');
const { dirname, isAbsolute, resolve } = require('node:path');

const { LegacyMigrationError } = require('./plan-migration');

function fail(code) {
  throw new LegacyMigrationError(code);
}

function hashFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function readMetadata(metadataPath, destinationPath) {
  if (
    typeof metadataPath !== 'string' ||
    !isAbsolute(metadataPath) ||
    resolve(metadataPath) !== metadataPath ||
    typeof destinationPath !== 'string' ||
    !isAbsolute(destinationPath) ||
    resolve(destinationPath) !== destinationPath
  ) {
    fail('LEGACY_MIGRATION_ROLLBACK_INVALID');
  }
  let metadata;
  try {
    metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
  } catch {
    fail('LEGACY_MIGRATION_ROLLBACK_INVALID');
  }
  if (
    metadata === null ||
    typeof metadata !== 'object' ||
    Array.isArray(metadata) ||
    metadata.metadataVersion !== 1 ||
    metadata.state !== 'succeeded' ||
    metadata.destinationPath !== destinationPath ||
    typeof metadata.rollbackPath !== 'string' ||
    !isAbsolute(metadata.rollbackPath) ||
    resolve(metadata.rollbackPath) !== metadata.rollbackPath ||
    metadataPath !== `${metadata.rollbackPath}.metadata.json` ||
    dirname(metadata.rollbackPath) !== dirname(metadataPath) ||
    typeof metadata.rollbackFingerprint !== 'string' ||
    !/^[a-f0-9]{64}$/.test(metadata.rollbackFingerprint) ||
    typeof metadata.postImportFingerprint !== 'string' ||
    !/^[a-f0-9]{64}$/.test(metadata.postImportFingerprint) ||
    metadata.beforeCounts === null ||
    typeof metadata.beforeCounts !== 'object'
  ) {
    fail('LEGACY_MIGRATION_ROLLBACK_INVALID');
  }
  return metadata;
}

function verifySqlite(path, beforeCounts) {
  const BetterSqlite3 = require('better-sqlite3');
  let database;
  try {
    database = new BetterSqlite3(path, { readonly: true, fileMustExist: true });
    if (database.pragma('integrity_check', { simple: true }) !== 'ok') {
      fail('LEGACY_MIGRATION_ROLLBACK_FAILED');
    }
    if (database.prepare('PRAGMA foreign_key_check').all().length !== 0) {
      fail('LEGACY_MIGRATION_ROLLBACK_FAILED');
    }
    for (const [table, count] of Object.entries(beforeCounts)) {
      if (!/^[a-z_]+$/.test(table) || !Number.isSafeInteger(count) || count < 0) {
        fail('LEGACY_MIGRATION_ROLLBACK_INVALID');
      }
      const actual = database.prepare(`SELECT COUNT(*) FROM "${table}"`).pluck().get();
      if (actual !== count) fail('LEGACY_MIGRATION_ROLLBACK_FAILED');
    }
  } finally {
    database?.close();
  }
}

async function rollbackLegacyMigration(options = {}) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    fail('LEGACY_MIGRATION_ROLLBACK_INVALID');
  }
  const { metadataPath, destinationPath, filePermissions } = options;
  if (
    filePermissions === null ||
    typeof filePermissions !== 'object' ||
    typeof filePermissions.restrictFile !== 'function'
  ) {
    fail('LEGACY_MIGRATION_ROLLBACK_INVALID');
  }
  const metadata = readMetadata(metadataPath, destinationPath);
  if (!existsSync(metadata.rollbackPath) || hashFile(metadata.rollbackPath) !== metadata.rollbackFingerprint) {
    fail('LEGACY_MIGRATION_ROLLBACK_INVALID');
  }
  if (['-wal', '-shm'].some(suffix => existsSync(`${destinationPath}${suffix}`))) {
    fail('LEGACY_MIGRATION_ROLLBACK_DRIFT');
  }
  if (!existsSync(destinationPath) || hashFile(destinationPath) !== metadata.postImportFingerprint) {
    fail('LEGACY_MIGRATION_ROLLBACK_DRIFT');
  }

  const temporaryPath = `${destinationPath}.legacy-restore-${process.pid}`;
  const safetyPath = `${destinationPath}.legacy-pre-rollback-${process.pid}`;
  if (existsSync(temporaryPath) || existsSync(safetyPath)) fail('LEGACY_MIGRATION_ROLLBACK_INVALID');
  let destinationMoved = false;
  try {
    copyFileSync(metadata.rollbackPath, temporaryPath);
    await filePermissions.restrictFile(temporaryPath);
    if (hashFile(temporaryPath) !== metadata.rollbackFingerprint) {
      fail('LEGACY_MIGRATION_ROLLBACK_FAILED');
    }
    verifySqlite(temporaryPath, metadata.beforeCounts);
    renameSync(destinationPath, safetyPath);
    destinationMoved = true;
    renameSync(temporaryPath, destinationPath);
    for (const suffix of ['-wal', '-shm']) rmSync(`${destinationPath}${suffix}`, { force: true });
    await filePermissions.restrictFile(destinationPath);
    if (hashFile(destinationPath) !== metadata.rollbackFingerprint) {
      fail('LEGACY_MIGRATION_ROLLBACK_FAILED');
    }
    verifySqlite(destinationPath, metadata.beforeCounts);
    rmSync(safetyPath, { force: true });
    destinationMoved = false;

    const completedMetadataPath = `${metadataPath}.rolled-back.json`;
    writeFileSync(
      completedMetadataPath,
      `${JSON.stringify({
        classification: 'SENSITIVE MIGRATION METADATA',
        metadataVersion: 1,
        state: 'rolled-back',
        planFingerprint: metadata.planFingerprint,
        sourceFingerprint: metadata.sourceFingerprint,
        restoredFingerprint: metadata.rollbackFingerprint,
      })}\n`,
      { flag: 'wx', mode: 0o600 }
    );
    await filePermissions.restrictFile(completedMetadataPath);
    return Object.freeze({ state: 'rolled-back', completedMetadataPath });
  } catch (error) {
    try {
      rmSync(temporaryPath, { force: true });
      if (destinationMoved && existsSync(safetyPath)) {
        rmSync(destinationPath, { force: true });
        renameSync(safetyPath, destinationPath);
      }
    } catch {
      fail('LEGACY_MIGRATION_ROLLBACK_FAILED');
    }
    if (error instanceof LegacyMigrationError) throw error;
    fail('LEGACY_MIGRATION_ROLLBACK_FAILED');
  }
}

module.exports = {
  rollbackLegacyMigration,
};
