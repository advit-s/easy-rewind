'use strict';

const { createHash, randomUUID } = require('node:crypto');
const { constants, copyFileSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { basename, isAbsolute, join, relative, resolve, sep } = require('node:path');

const inspection = require('./inspect-legacy');

const expectedColumns = Object.freeze({
  bookmarks: ['id', 'user_id', 'url', 'title', 'topic', 'notes', 'remind_at', 'reminded', 'created_at'],
  item_tags: ['id', 'item_id', 'tag'],
  items: [
    'id',
    'user_id',
    'url',
    'title',
    'content',
    'ai_summary',
    'tags',
    'source_type',
    'memory_score',
    'interaction_count',
    'last_accessed_at',
    'created_at',
    'updated_at',
  ],
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
});

class LegacyMigrationError extends Error {
  constructor(code) {
    const messages = {
      LEGACY_MIGRATION_INPUT_INVALID: 'Legacy migration options are invalid.',
      LEGACY_MIGRATION_INSUFFICIENT_DISK: 'There is not enough disk space for a safe legacy migration.',
      LEGACY_MIGRATION_RECOVERY_FAILED: 'The second legacy recovery copy could not be created and verified.',
      LEGACY_MIGRATION_PLAN_FAILED: 'The legacy migration plan could not be created safely.',
      LEGACY_MIGRATION_CONFIRMATION_MISMATCH: 'Confirmation does not match the exact migration plan.',
      LEGACY_MIGRATION_ALREADY_APPLIED: 'This legacy snapshot has already been imported.',
      LEGACY_MIGRATION_INTERRUPTED: 'The legacy migration was interrupted and rolled back.',
      LEGACY_MIGRATION_IMPORT_FAILED: 'The legacy migration failed and the destination was restored.',
      LEGACY_MIGRATION_INVARIANT_FAILED: 'Post-import migration invariants failed.',
      LEGACY_MIGRATION_ROLLBACK_INVALID: 'Legacy rollback metadata is invalid.',
      LEGACY_MIGRATION_ROLLBACK_DRIFT:
        'The destination changed after migration and cannot be rolled back automatically.',
      LEGACY_MIGRATION_ROLLBACK_FAILED: 'The verified legacy rollback could not be completed.',
    };
    super(messages[code] ?? messages.LEGACY_MIGRATION_PLAN_FAILED);
    this.name = 'LegacyMigrationError';
    this.code = code;
  }
}

function fail(code) {
  throw new LegacyMigrationError(code);
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function fingerprintObject(value) {
  return digest(JSON.stringify(value));
}

function verifyManifest(manifestPath) {
  const verify = inspection.verifyQuarantineManifest ?? inspection.verifyLegacyManifest;
  if (typeof verify !== 'function') fail('LEGACY_MIGRATION_INPUT_INVALID');
  return verify(manifestPath);
}

function isContained(parent, candidate) {
  const value = relative(resolve(parent), resolve(candidate));
  return value === '' || (!isAbsolute(value) && value !== '..' && !value.startsWith(`..${sep}`));
}

function exactDirectory(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path) fail('LEGACY_MIGRATION_INPUT_INVALID');
  let metadata;
  try {
    metadata = lstatSync(path);
  } catch {
    fail('LEGACY_MIGRATION_INPUT_INVALID');
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) fail('LEGACY_MIGRATION_INPUT_INVALID');
  return path;
}

function safeLeaf(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(value)) {
    fail('LEGACY_MIGRATION_INPUT_INVALID');
  }
  return value;
}

function safeInteger(value) {
  if (!Number.isSafeInteger(value) || value < 0) fail('LEGACY_MIGRATION_PLAN_FAILED');
  return value;
}

function sourceFingerprint(snapshot) {
  const descriptor = [...snapshot.files]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(entry => `${entry.name}:${entry.size}:${entry.sha256}`)
    .join('\n');
  return digest(descriptor);
}

function timestamp(value) {
  if (Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value !== 'string' || value.length === 0) return null;
  const parsed = Date.parse(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function normalizedUrl(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

function tableNames(database) {
  return database
    .prepare(
      `SELECT name
       FROM sqlite_master
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
       ORDER BY name`
    )
    .pluck()
    .all();
}

function tableColumns(database, table) {
  if (!Object.hasOwn(expectedColumns, table)) return [];
  return database
    .prepare(`PRAGMA table_xinfo("${table}")`)
    .all()
    .map(column => column.name);
}

function rows(database, table) {
  return database.prepare(`SELECT rowid AS __legacy_rowid__, * FROM "${table}" ORDER BY rowid`).all();
}

function tableCount(database, table) {
  if (!/^[a-z_]+$/.test(table)) fail('LEGACY_MIGRATION_PLAN_FAILED');
  return safeInteger(database.prepare(`SELECT COUNT(*) FROM "${table}"`).pluck().get());
}

function analyzeLegacyDatabase(database) {
  database.pragma('query_only = ON');
  const names = tableNames(database);
  const counts = new Map(names.map(name => [name, tableCount(database, name)]));
  const operations = [];
  const acceptedItems = new Map();
  const seenIds = new Map();
  const seenUrls = new Set();
  const skips = {
    duplicateIds: 0,
    normalizedUrlConflicts: 0,
    invalidTimestamps: 0,
    orphanedRows: 0,
    unsupportedRows: 0,
  };
  const transforms = {
    profileMappings: 0,
    urlNormalizations: 0,
    timestampConversions: 0,
    bookmarkItems: 0,
  };
  const warningCounts = new Map();
  const profileUsers = new Set();

  for (const name of names) {
    if (!Object.hasOwn(expectedColumns, name)) {
      skips.unsupportedRows += counts.get(name);
      if (counts.get(name) > 0)
        warningCounts.set('UNSUPPORTED_TABLES', (warningCounts.get('UNSUPPORTED_TABLES') ?? 0) + 1);
      continue;
    }
    const extras = tableColumns(database, name).filter(column => !expectedColumns[name].includes(column));
    if (extras.length > 0)
      warningCounts.set('UNKNOWN_COLUMNS', (warningCounts.get('UNKNOWN_COLUMNS') ?? 0) + extras.length);
  }

  function duplicate(table, id) {
    const key = String(id);
    let values = seenIds.get(table);
    if (!values) {
      values = new Set();
      seenIds.set(table, values);
    }
    if (values.has(key)) {
      skips.duplicateIds += 1;
      return true;
    }
    values.add(key);
    return false;
  }

  function registerProfile(userId) {
    if (!profileUsers.has(userId)) {
      profileUsers.add(userId);
      transforms.profileMappings += 1;
    }
  }

  if (names.includes('bookmarks')) {
    for (const row of rows(database, 'bookmarks')) {
      if (duplicate('bookmarks', row.id)) continue;
      const createdAt = timestamp(row.created_at);
      if (createdAt === null) {
        skips.invalidTimestamps += 1;
        continue;
      }
      const url = normalizedUrl(row.url);
      if (url === null) {
        skips.normalizedUrlConflicts += 1;
        continue;
      }
      const urlKey = `${String(row.user_id)}\u0000${url}`;
      if (seenUrls.has(urlKey)) {
        skips.normalizedUrlConflicts += 1;
        continue;
      }
      seenUrls.add(urlKey);
      registerProfile(String(row.user_id));
      if (url !== row.url) transforms.urlNormalizations += 1;
      transforms.timestampConversions += 1;
      transforms.bookmarkItems += 1;
      operations.push({
        kind: 'bookmark',
        legacyId: String(row.id),
        userId: String(row.user_id),
        url,
        title: typeof row.title === 'string' ? row.title : '',
        body: typeof row.notes === 'string' ? row.notes : '',
        createdAt,
      });
    }
  }

  if (names.includes('notes')) {
    for (const row of rows(database, 'notes')) {
      if (duplicate('notes', row.id)) continue;
      const createdAt = timestamp(row.created_at);
      if (createdAt === null) {
        skips.invalidTimestamps += 1;
        continue;
      }
      registerProfile(String(row.user_id));
      transforms.timestampConversions += 1;
      operations.push({
        kind: 'note',
        legacyId: String(row.id),
        userId: String(row.user_id),
        body: typeof row.content === 'string' ? row.content : '',
        createdAt,
      });
    }
  }

  if (names.includes('items')) {
    for (const row of rows(database, 'items')) {
      if (duplicate('items', row.id)) continue;
      const createdAt = timestamp(row.created_at);
      const updatedAt = timestamp(row.updated_at);
      if (createdAt === null || updatedAt === null || updatedAt < createdAt) {
        skips.invalidTimestamps += 1;
        continue;
      }
      const url = row.url === null || row.url === '' ? null : normalizedUrl(row.url);
      if (row.url && url === null) {
        skips.normalizedUrlConflicts += 1;
        continue;
      }
      const urlKey = url === null ? null : `${String(row.user_id)}\u0000${url}`;
      if (urlKey !== null && seenUrls.has(urlKey)) {
        skips.normalizedUrlConflicts += 1;
        continue;
      }
      if (urlKey !== null) seenUrls.add(urlKey);
      acceptedItems.set(String(row.id), String(row.user_id));
      registerProfile(String(row.user_id));
      if (url !== row.url) transforms.urlNormalizations += 1;
      transforms.timestampConversions += 2;
      operations.push({
        kind: 'item',
        legacyId: String(row.id),
        userId: String(row.user_id),
        url,
        title: typeof row.title === 'string' ? row.title : '',
        body: typeof row.content === 'string' ? row.content : '',
        createdAt,
        updatedAt,
      });
    }
  }

  if (names.includes('item_tags')) {
    for (const row of rows(database, 'item_tags')) {
      if (duplicate('item_tags', row.id)) continue;
      const itemUserId = acceptedItems.get(String(row.item_id));
      if (itemUserId === undefined) {
        skips.orphanedRows += 1;
        continue;
      }
      const tag = typeof row.tag === 'string' ? row.tag.normalize('NFKC').trim() : '';
      if (tag.length === 0) {
        skips.unsupportedRows += 1;
        continue;
      }
      operations.push({
        kind: 'item_tag',
        legacyId: String(row.id),
        itemLegacyId: String(row.item_id),
        userId: itemUserId,
        tag,
      });
    }
  }

  const sourceRows = [...counts.values()].reduce((total, count) => total + count, 0);
  const skippedRows = Object.values(skips).reduce((total, count) => total + count, 0);
  const tables = names.map(name => ({
    name,
    rowCount: counts.get(name),
  }));
  const warnings = [...warningCounts]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([code, count]) => ({ code, count }));
  const schemaVersion = names.includes('items') ? 2 : 1;
  const distinctTags = new Set(
    operations
      .filter(operation => operation.kind === 'item_tag')
      .map(operation => `${operation.userId}\u0000${operation.tag.toLowerCase()}`)
  ).size;
  const publicAnalysis = {
    schemaVersion,
    tables,
    counts: {
      sourceRows,
      importableRows: operations.length,
      skippedRows,
      destinationChanges:
        operations.length +
        operations.filter(operation => operation.kind === 'bookmark').length +
        profileUsers.size +
        distinctTags,
    },
    skips,
    transforms,
    conflicts: {
      duplicateIds: skips.duplicateIds,
      normalizedUrls: skips.normalizedUrlConflicts,
      orphanedRows: skips.orphanedRows,
    },
    warnings,
  };
  return { operations, publicAnalysis, analysisFingerprint: fingerprintObject(publicAnalysis) };
}

function validateOptions(options) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    fail('LEGACY_MIGRATION_INPUT_INVALID');
  }
  const {
    manifestPath,
    destinationPath,
    workRoot,
    recoveryRoot,
    rollbackRoot,
    filePermissions,
    availableDiskBytes,
    now = Date.now,
    generateId = randomUUID,
  } = options;
  if (
    typeof manifestPath !== 'string' ||
    !isAbsolute(manifestPath) ||
    resolve(manifestPath) !== manifestPath ||
    typeof destinationPath !== 'string' ||
    !isAbsolute(destinationPath) ||
    resolve(destinationPath) !== destinationPath ||
    typeof now !== 'function' ||
    typeof generateId !== 'function' ||
    !Number.isSafeInteger(availableDiskBytes) ||
    availableDiskBytes < 0 ||
    filePermissions === null ||
    typeof filePermissions !== 'object' ||
    typeof filePermissions.restrictDirectory !== 'function' ||
    typeof filePermissions.restrictFile !== 'function'
  ) {
    fail('LEGACY_MIGRATION_INPUT_INVALID');
  }
  exactDirectory(workRoot);
  exactDirectory(recoveryRoot);
  exactDirectory(rollbackRoot);
  if (
    isContained(recoveryRoot, workRoot) ||
    isContained(workRoot, recoveryRoot) ||
    isContained(rollbackRoot, recoveryRoot) ||
    isContained(recoveryRoot, rollbackRoot)
  ) {
    fail('LEGACY_MIGRATION_INPUT_INVALID');
  }
  let destinationSize;
  try {
    const metadata = lstatSync(destinationPath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) fail('LEGACY_MIGRATION_INPUT_INVALID');
    destinationSize = metadata.size;
  } catch (error) {
    if (error instanceof LegacyMigrationError) throw error;
    fail('LEGACY_MIGRATION_INPUT_INVALID');
  }
  return {
    manifestPath,
    destinationPath,
    workRoot,
    recoveryRoot,
    rollbackRoot,
    filePermissions,
    availableDiskBytes,
    now,
    generateId,
    destinationSize,
  };
}

async function createRecoveryCopy(options, snapshot, fingerprint, leaf, stamp) {
  const recoveryPath = join(options.recoveryRoot, `legacy-recovery-${stamp}-${leaf}`);
  const recoveryManifestPath = join(recoveryPath, 'manifest.json');
  if (!isContained(options.recoveryRoot, recoveryPath)) fail('LEGACY_MIGRATION_INPUT_INVALID');
  let created = false;
  try {
    await inspection.withDisposableLegacyCopy(
      {
        manifestPath: options.manifestPath,
        workRoot: options.workRoot,
        filePermissions: options.filePermissions,
        generateId: () => `recovery-${leaf}`,
      },
      async copy => {
        mkdirSync(recoveryPath, { mode: 0o700 });
        created = true;
        await options.filePermissions.restrictDirectory(recoveryPath);
        for (const entry of snapshot.files) {
          const source = join(copy.root, entry.name);
          const destination = join(recoveryPath, entry.name);
          copyFileSync(source, destination, constants.COPYFILE_EXCL);
          await options.filePermissions.restrictFile(destination);
          const bytes = readFileSync(destination);
          if (bytes.length !== entry.size || digest(bytes).toUpperCase() !== entry.sha256) {
            fail('LEGACY_MIGRATION_RECOVERY_FAILED');
          }
        }
        const original = JSON.parse(readFileSync(options.manifestPath, 'utf8'));
        const recoveryManifest = {
          ...original,
          manifestPath: recoveryManifestPath,
          quarantinePath: recoveryPath,
          recoverySourceFingerprint: fingerprint,
          files: original.files.map(entry => ({
            ...entry,
            backupRelativePath: entry.name,
          })),
        };
        writeFileSync(recoveryManifestPath, `${JSON.stringify(recoveryManifest)}\n`, {
          flag: 'wx',
          mode: 0o600,
        });
        await options.filePermissions.restrictFile(recoveryManifestPath);
      }
    );
    verifyManifest(recoveryManifestPath);
    return recoveryManifestPath;
  } catch (error) {
    if (created && isContained(options.recoveryRoot, recoveryPath)) {
      try {
        rmSync(recoveryPath, { recursive: true, force: true });
      } catch {
        // The stable recovery failure remains authoritative.
      }
    }
    if (error instanceof LegacyMigrationError) throw error;
    fail('LEGACY_MIGRATION_RECOVERY_FAILED');
  }
}

async function analyzeManifest({ manifestPath, workRoot, filePermissions, generateId = randomUUID }) {
  return inspection.withDisposableLegacyCopy(
    {
      manifestPath,
      workRoot,
      filePermissions,
      generateId,
    },
    copy => {
      const BetterSqlite3 = require('better-sqlite3');
      let database;
      try {
        database = new BetterSqlite3(copy.databasePath, { readonly: true, fileMustExist: true });
        return analyzeLegacyDatabase(database);
      } finally {
        database?.close();
      }
    }
  );
}

async function createLegacyMigrationPlan(options = {}) {
  const normalized = validateOptions(options);
  const snapshot = verifyManifest(normalized.manifestPath);
  const fingerprint = sourceFingerprint(snapshot);
  const snapshotBytes = snapshot.files.reduce((total, entry) => total + entry.size, 0);
  const requiredDiskBytes = safeInteger(snapshotBytes * 2 + normalized.destinationSize * 2);
  if (normalized.availableDiskBytes < requiredDiskBytes) fail('LEGACY_MIGRATION_INSUFFICIENT_DISK');

  let time;
  let leaf;
  try {
    time = normalized.now();
    leaf = safeLeaf(normalized.generateId());
  } catch (error) {
    if (error instanceof LegacyMigrationError) throw error;
    fail('LEGACY_MIGRATION_INPUT_INVALID');
  }
  if (!Number.isSafeInteger(time) || time < 0) fail('LEGACY_MIGRATION_INPUT_INVALID');
  const stamp = new Date(time).toISOString().replace(/[-:.]/g, '');
  const recoveryManifestPath = await createRecoveryCopy(normalized, snapshot, fingerprint, leaf, stamp);
  const analysis = await analyzeManifest({
    manifestPath: recoveryManifestPath,
    workRoot: normalized.workRoot,
    filePermissions: normalized.filePermissions,
    generateId: () => `plan-${leaf}`,
  });
  const rollbackPath = join(normalized.rollbackRoot, `legacy-rollback-${stamp}-${leaf}.sqlite3`);
  const planWithoutFingerprint = {
    classification: 'SENSITIVE MIGRATION METADATA',
    planVersion: 1,
    sourceFingerprint: fingerprint,
    analysisFingerprint: analysis.analysisFingerprint,
    recoveryReference: basename(resolve(recoveryManifestPath, '..')),
    recoveryManifestPath,
    destinationPath: normalized.destinationPath,
    rollbackPath,
    requiredDiskBytes,
    ...analysis.publicAnalysis,
  };
  return Object.freeze({
    ...planWithoutFingerprint,
    fingerprint: fingerprintObject(planWithoutFingerprint),
  });
}

module.exports = {
  LegacyMigrationError,
  analyzeLegacyDatabase,
  analyzeManifest,
  createLegacyMigrationPlan,
  fingerprintObject,
  planLegacyMigration: createLegacyMigrationPlan,
  sourceFingerprint,
  verifyManifest,
};
