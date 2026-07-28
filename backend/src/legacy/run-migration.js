'use strict';

const { createHash } = require('node:crypto');
const { copyFileSync, existsSync, lstatSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { dirname, isAbsolute, resolve } = require('node:path');

const { openDatabase: defaultOpenDatabase } = require('../database/open-database');
const {
  LegacyMigrationError,
  analyzeManifest,
  fingerprintObject,
  sourceFingerprint,
  verifyManifest,
} = require('./plan-migration');

function fail(code) {
  throw new LegacyMigrationError(code);
}

function hashFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function stableId(kind, source, ...parts) {
  const value = createHash('sha256')
    .update([kind, source, ...parts].join('\u0000'))
    .digest('hex');
  return `legacy:${kind}:${value}`;
}

function validPlan(plan) {
  if (
    plan === null ||
    typeof plan !== 'object' ||
    Array.isArray(plan) ||
    plan.planVersion !== 1 ||
    typeof plan.fingerprint !== 'string' ||
    !/^[a-f0-9]{64}$/.test(plan.fingerprint) ||
    typeof plan.sourceFingerprint !== 'string' ||
    !/^[a-f0-9]{64}$/.test(plan.sourceFingerprint) ||
    typeof plan.analysisFingerprint !== 'string' ||
    !/^[a-f0-9]{64}$/.test(plan.analysisFingerprint) ||
    typeof plan.recoveryManifestPath !== 'string' ||
    !isAbsolute(plan.recoveryManifestPath) ||
    resolve(plan.recoveryManifestPath) !== plan.recoveryManifestPath ||
    typeof plan.destinationPath !== 'string' ||
    !isAbsolute(plan.destinationPath) ||
    resolve(plan.destinationPath) !== plan.destinationPath ||
    typeof plan.rollbackPath !== 'string' ||
    !isAbsolute(plan.rollbackPath) ||
    resolve(plan.rollbackPath) !== plan.rollbackPath
  ) {
    fail('LEGACY_MIGRATION_INPUT_INVALID');
  }
  const { fingerprint, ...unsigned } = plan;
  if (fingerprintObject(unsigned) !== fingerprint) fail('LEGACY_MIGRATION_CONFIRMATION_MISMATCH');
  return plan;
}

function validateOptions(options) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    fail('LEGACY_MIGRATION_INPUT_INVALID');
  }
  const {
    plan,
    confirmationFingerprint,
    destinationPath,
    workRoot,
    filePermissions,
    now = Date.now,
    openDatabase = defaultOpenDatabase,
    interruptAfterWrites,
  } = options;
  validPlan(plan);
  if (confirmationFingerprint !== plan.fingerprint || destinationPath !== plan.destinationPath) {
    fail('LEGACY_MIGRATION_CONFIRMATION_MISMATCH');
  }
  if (
    typeof destinationPath !== 'string' ||
    !isAbsolute(destinationPath) ||
    resolve(destinationPath) !== destinationPath ||
    typeof workRoot !== 'string' ||
    !isAbsolute(workRoot) ||
    resolve(workRoot) !== workRoot ||
    filePermissions === null ||
    typeof filePermissions !== 'object' ||
    typeof filePermissions.restrictDirectory !== 'function' ||
    typeof filePermissions.restrictFile !== 'function' ||
    typeof now !== 'function' ||
    typeof openDatabase !== 'function' ||
    (interruptAfterWrites !== undefined && (!Number.isSafeInteger(interruptAfterWrites) || interruptAfterWrites < 1))
  ) {
    fail('LEGACY_MIGRATION_INPUT_INVALID');
  }
  let parent;
  try {
    parent = lstatSync(dirname(plan.rollbackPath));
  } catch {
    fail('LEGACY_MIGRATION_INPUT_INVALID');
  }
  if (!parent.isDirectory() || parent.isSymbolicLink()) fail('LEGACY_MIGRATION_INPUT_INVALID');
  return {
    plan,
    destinationPath,
    workRoot,
    filePermissions,
    now,
    openDatabase,
    interruptAfterWrites,
  };
}

function destinationCounts(database) {
  const result = {};
  for (const table of ['profiles', 'items', 'bookmarks', 'notes', 'tags', 'item_tags', 'migration_runs']) {
    result[table] = database.prepare(`SELECT COUNT(*) FROM "${table}"`).pluck().get();
  }
  return result;
}

function createWriters(database, source) {
  const profile = database.prepare(
    `INSERT INTO profiles(id, display_name, timezone, locale, created_at, updated_at, revision)
     VALUES (?, 'Imported legacy profile', 'UTC', 'en', ?, ?, 1)`
  );
  const item = database.prepare(
    `INSERT INTO items(
       id, profile_id, kind, title, url, excerpt, body, source, created_at, updated_at, revision
     ) VALUES (?, ?, ?, ?, ?, '', ?, 'legacy-migration', ?, ?, 1)`
  );
  const bookmark = database.prepare(
    `INSERT INTO bookmarks(id, profile_id, item_id, created_at, updated_at, revision)
     VALUES (?, ?, ?, ?, ?, 1)`
  );
  const note = database.prepare(
    `INSERT INTO notes(id, profile_id, item_id, body, created_at, updated_at, revision)
     VALUES (?, ?, NULL, ?, ?, ?, 1)`
  );
  const tag = database.prepare(
    `INSERT INTO tags(id, profile_id, name, normalized_name, created_at, updated_at, revision)
     VALUES (?, ?, ?, ?, ?, ?, 1)`
  );
  const itemTag = database.prepare(
    `INSERT INTO item_tags(id, profile_id, item_id, tag_id, created_at, updated_at, revision)
     VALUES (?, ?, ?, ?, ?, ?, 1)`
  );
  const profiles = new Map();
  const items = new Map();
  const tags = new Map();

  function profileId(userId, createdAt) {
    let id = profiles.get(userId);
    if (id) return id;
    id = stableId('profile', source, userId);
    profile.run(id, createdAt, createdAt);
    profiles.set(userId, id);
    return id;
  }

  function write(operation) {
    if (operation.kind === 'bookmark') {
      const owner = profileId(operation.userId, operation.createdAt);
      const itemId = stableId('bookmark-item', source, operation.legacyId);
      item.run(
        itemId,
        owner,
        'webpage',
        operation.title,
        operation.url,
        operation.body,
        operation.createdAt,
        operation.createdAt
      );
      bookmark.run(
        stableId('bookmark', source, operation.legacyId),
        owner,
        itemId,
        operation.createdAt,
        operation.createdAt
      );
      return;
    }
    if (operation.kind === 'note') {
      const owner = profileId(operation.userId, operation.createdAt);
      note.run(
        stableId('note', source, operation.legacyId),
        owner,
        operation.body,
        operation.createdAt,
        operation.createdAt
      );
      return;
    }
    if (operation.kind === 'item') {
      const owner = profileId(operation.userId, operation.createdAt);
      const id = stableId('item', source, operation.legacyId);
      item.run(
        id,
        owner,
        operation.url === null ? 'note' : 'webpage',
        operation.title,
        operation.url,
        operation.body,
        operation.createdAt,
        operation.updatedAt
      );
      items.set(operation.legacyId, { id, owner, createdAt: operation.createdAt });
      return;
    }
    if (operation.kind === 'item_tag') {
      const target = items.get(operation.itemLegacyId);
      if (!target) fail('LEGACY_MIGRATION_INVARIANT_FAILED');
      const normalizedName = operation.tag.normalize('NFKC').trim().toLowerCase();
      if (normalizedName.length === 0) fail('LEGACY_MIGRATION_INVARIANT_FAILED');
      const key = `${target.owner}\u0000${normalizedName}`;
      let tagId = tags.get(key);
      if (!tagId) {
        tagId = stableId('tag', source, key);
        tag.run(tagId, target.owner, operation.tag.trim(), normalizedName, target.createdAt, target.createdAt);
        tags.set(key, tagId);
      }
      itemTag.run(
        stableId('item-tag', source, operation.legacyId),
        target.owner,
        target.id,
        tagId,
        target.createdAt,
        target.createdAt
      );
    }
  }

  return { write };
}

function assertInvariants(database, before, analysis) {
  if (database.pragma('integrity_check', { simple: true }) !== 'ok') {
    fail('LEGACY_MIGRATION_INVARIANT_FAILED');
  }
  if (database.prepare('PRAGMA foreign_key_check').all().length !== 0) {
    fail('LEGACY_MIGRATION_INVARIANT_FAILED');
  }
  const after = destinationCounts(database);
  const expectedItems = analysis.operations.filter(operation => ['bookmark', 'item'].includes(operation.kind)).length;
  const expectedBookmarks = analysis.operations.filter(operation => operation.kind === 'bookmark').length;
  const expectedNotes = analysis.operations.filter(operation => operation.kind === 'note').length;
  const expectedItemTags = analysis.operations.filter(operation => operation.kind === 'item_tag').length;
  const expectedProfiles = new Set(
    analysis.operations.filter(operation => operation.userId !== undefined).map(operation => operation.userId)
  ).size;
  const expectedTags = new Set(
    analysis.operations
      .filter(operation => operation.kind === 'item_tag')
      .map(operation => `${operation.userId}\u0000${operation.tag.normalize('NFKC').trim().toLowerCase()}`)
  ).size;
  if (
    after.profiles - before.profiles !== expectedProfiles ||
    after.items - before.items !== expectedItems ||
    after.bookmarks - before.bookmarks !== expectedBookmarks ||
    after.notes - before.notes !== expectedNotes ||
    after.tags - before.tags !== expectedTags ||
    after.item_tags - before.item_tags !== expectedItemTags ||
    after.migration_runs - before.migration_runs !== 1
  ) {
    fail('LEGACY_MIGRATION_INVARIANT_FAILED');
  }
  return after;
}

function verifySqlite(path) {
  const BetterSqlite3 = require('better-sqlite3');
  let database;
  try {
    database = new BetterSqlite3(path, { readonly: true, fileMustExist: true });
    if (database.pragma('integrity_check', { simple: true }) !== 'ok') {
      fail('LEGACY_MIGRATION_IMPORT_FAILED');
    }
  } finally {
    database?.close();
  }
}

function restoreBackup(destinationPath, rollbackPath) {
  try {
    copyFileSync(rollbackPath, destinationPath);
    for (const suffix of ['-wal', '-shm']) rmSync(`${destinationPath}${suffix}`, { force: true });
    if (hashFile(destinationPath) !== hashFile(rollbackPath)) fail('LEGACY_MIGRATION_IMPORT_FAILED');
    verifySqlite(destinationPath);
  } catch (error) {
    if (error instanceof LegacyMigrationError) throw error;
    fail('LEGACY_MIGRATION_IMPORT_FAILED');
  }
}

async function createRollbackBackup(database, rollbackPath, filePermissions) {
  if (existsSync(rollbackPath)) fail('LEGACY_MIGRATION_INPUT_INVALID');
  await database.backup(rollbackPath);
  await filePermissions.restrictFile(rollbackPath);
  verifySqlite(rollbackPath);
  return hashFile(rollbackPath);
}

async function runLegacyMigration(options = {}) {
  const normalized = validateOptions(options);
  const { plan } = normalized;
  const snapshot = verifyManifest(plan.recoveryManifestPath);
  if (sourceFingerprint(snapshot) !== plan.sourceFingerprint) fail('LEGACY_MIGRATION_CONFIRMATION_MISMATCH');
  const analysis = await analyzeManifest({
    manifestPath: plan.recoveryManifestPath,
    workRoot: normalized.workRoot,
    filePermissions: normalized.filePermissions,
  });
  if (analysis.analysisFingerprint !== plan.analysisFingerprint) {
    fail('LEGACY_MIGRATION_CONFIRMATION_MISMATCH');
  }

  let database;
  let transactionOpen = false;
  let backupCreated = false;
  let rollbackHash;
  let before;
  let after;
  let committed = false;
  const runId = `legacy:${plan.sourceFingerprint}`;
  let startedAt;
  try {
    startedAt = normalized.now();
    if (!Number.isSafeInteger(startedAt) || startedAt < 0) fail('LEGACY_MIGRATION_INPUT_INVALID');
    database = await normalized.openDatabase({
      path: normalized.destinationPath,
      readonly: false,
      filePermissions: normalized.filePermissions,
    });
    if (database.prepare('SELECT COUNT(*) FROM migration_runs WHERE id = ?').pluck().get(runId) !== 0) {
      fail('LEGACY_MIGRATION_ALREADY_APPLIED');
    }
    database.pragma('wal_checkpoint(TRUNCATE)');
    rollbackHash = await createRollbackBackup(database, plan.rollbackPath, normalized.filePermissions);
    backupCreated = true;
    before = destinationCounts(database);

    database.exec('BEGIN IMMEDIATE');
    transactionOpen = true;
    database
      .prepare(
        `INSERT INTO migration_runs(
           id, profile_id, from_version, to_version, state, error_code, started_at, finished_at, created_at
         ) VALUES (?, NULL, ?, 3, 'running', NULL, ?, NULL, ?)`
      )
      .run(runId, analysis.publicAnalysis.schemaVersion, startedAt, startedAt);
    const writers = createWriters(database, plan.sourceFingerprint);
    let writes = 0;
    for (const operation of analysis.operations) {
      writers.write(operation);
      writes += 1;
      if (writes === normalized.interruptAfterWrites) fail('LEGACY_MIGRATION_INTERRUPTED');
    }
    const finishedAt = normalized.now();
    if (!Number.isSafeInteger(finishedAt) || finishedAt < startedAt) fail('LEGACY_MIGRATION_INPUT_INVALID');
    database
      .prepare(`UPDATE migration_runs SET state = 'succeeded', finished_at = ? WHERE id = ?`)
      .run(finishedAt, runId);
    after = assertInvariants(database, before, analysis);
    database.exec('COMMIT');
    transactionOpen = false;
    committed = true;
    database.pragma('wal_checkpoint(TRUNCATE)');
    database.close();
    database = null;

    const postImportFingerprint = hashFile(normalized.destinationPath);
    const rollbackMetadataPath = `${plan.rollbackPath}.metadata.json`;
    const metadata = {
      classification: 'SENSITIVE MIGRATION METADATA',
      metadataVersion: 1,
      state: 'succeeded',
      planFingerprint: plan.fingerprint,
      sourceFingerprint: plan.sourceFingerprint,
      runId,
      destinationPath: normalized.destinationPath,
      rollbackPath: plan.rollbackPath,
      rollbackFingerprint: rollbackHash,
      postImportFingerprint,
      beforeCounts: before,
      afterCounts: after,
      createdAt: startedAt,
    };
    writeFileSync(rollbackMetadataPath, `${JSON.stringify(metadata, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    await normalized.filePermissions.restrictFile(rollbackMetadataPath);
    if (JSON.parse(readFileSync(rollbackMetadataPath, 'utf8')).postImportFingerprint !== postImportFingerprint) {
      fail('LEGACY_MIGRATION_IMPORT_FAILED');
    }
    return Object.freeze({
      state: 'succeeded',
      importedRows: analysis.publicAnalysis.counts.importableRows,
      skippedRows: analysis.publicAnalysis.counts.skippedRows,
      sourceFingerprint: plan.sourceFingerprint,
      rollbackMetadataPath,
    });
  } catch (error) {
    if (transactionOpen && database) {
      try {
        database.exec('ROLLBACK');
      } catch {
        // Restoration from the verified backup remains the final recovery path.
      }
    }
    try {
      database?.close();
    } catch {
      // Restoration from the verified backup remains the final recovery path.
    }
    if (backupCreated && (!committed || error instanceof Error)) {
      try {
        restoreBackup(normalized.destinationPath, plan.rollbackPath);
      } catch {
        fail('LEGACY_MIGRATION_IMPORT_FAILED');
      }
    }
    if (error instanceof LegacyMigrationError) throw error;
    fail('LEGACY_MIGRATION_IMPORT_FAILED');
  }
}

module.exports = {
  runLegacyMigration,
};
