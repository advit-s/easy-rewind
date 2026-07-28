'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const BetterSqlite3 = require('better-sqlite3');

const { discoverMigrations, runMigrations } = require('../database/migration-runner');

const warning = 'Contains sensitive personal legacy data and is not secure credential storage.';
const roots = new Set();

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex').toUpperCase();
}

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'easy-rewind-legacy-migration-'));
  roots.add(root);
  return root;
}

function permissions() {
  return {
    async restrictDirectory(path) {
      chmodSync(path, 0o700);
    },
    async restrictFile(path) {
      chmodSync(path, 0o600);
    },
  };
}

function createCanonicalDatabase(root) {
  const path = join(root, 'runtime.sqlite3');
  const database = new BetterSqlite3(path);
  database.pragma('foreign_keys = ON');
  runMigrations({
    db: database,
    migrations: discoverMigrations({ directory: resolve(__dirname, '..', 'database', 'migrations') }),
    now: () => 1_730_000_000_000,
  });
  database.close();
  return path;
}

function createLegacySnapshot(root, schemaName, rowsSql) {
  const quarantinePath = join(root, 'quarantine', '20260724T120000000Z');
  mkdirSync(quarantinePath, { recursive: true });
  const databasePath = join(quarantinePath, 'easy-rewind.db');
  const database = new BetterSqlite3(databasePath);
  database.exec(readFileSync(resolve(__dirname, '..', '..', 'test', 'fixtures', 'legacy', schemaName), 'utf8'));
  database.exec(rowsSql);
  database.pragma('wal_checkpoint(TRUNCATE)');
  database.close();
  for (const name of ['easy-rewind.db-wal', 'easy-rewind.db-shm']) {
    if (!existsSync(join(quarantinePath, name))) writeFileSync(join(quarantinePath, name), '');
  }
  writeFileSync(join(quarantinePath, 'settings.json'), '{"apiKey":"MUST_NOT_LEAK"}');
  const files = ['easy-rewind.db', 'easy-rewind.db-wal', 'easy-rewind.db-shm', 'settings.json'];
  const manifestPath = join(quarantinePath, 'manifest.json');
  const entries = files.map(name => {
    const bytes = readFileSync(join(quarantinePath, name));
    return {
      name,
      originalPath: join(root, 'legacy-source', name),
      backupRelativePath: name,
      size: bytes.length,
      sha256: hash(bytes),
    };
  });
  writeFileSync(
    manifestPath,
    `${JSON.stringify({
      schemaVersion: 1,
      sensitive: true,
      warning,
      backupTimeUtc: '2026-07-24T12:00:00.000Z',
      sqliteOpened: false,
      sourceRoot: join(root, 'legacy-source'),
      quarantinePath,
      manifestPath,
      files: entries,
    })}\n`
  );
  return { manifestPath, quarantinePath, files: entries };
}

function migrationOptions(root, snapshot, destinationPath) {
  const workRoot = join(root, 'work');
  const recoveryRoot = join(root, 'recovery');
  const rollbackRoot = join(root, 'rollback');
  mkdirSync(workRoot);
  mkdirSync(recoveryRoot);
  mkdirSync(rollbackRoot);
  return {
    manifestPath: snapshot.manifestPath,
    destinationPath,
    workRoot,
    recoveryRoot,
    rollbackRoot,
    filePermissions: permissions(),
    availableDiskBytes: Number.MAX_SAFE_INTEGER,
    now: () => Date.parse('2026-07-28T12:00:00.000Z'),
    generateId: () => 'fixed-run',
  };
}

test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

test('dry-run reports aggregate skips, transforms, conflicts, warnings, disk, and rollback without row content', async () => {
  const root = makeRoot();
  const destinationPath = createCanonicalDatabase(root);
  const snapshot = createLegacySnapshot(
    root,
    'schema-v1.sql',
    `
      ALTER TABLE bookmarks ADD COLUMN unknown_secret TEXT;
      INSERT INTO bookmarks VALUES
        (1, 'owner-a', 'HTTPS://Example.com:443/a#fragment', 'private title', '', '', NULL, 0, '2026-01-01T00:00:00Z', 'secret-a'),
        (1, 'owner-a', 'https://other.invalid/', 'duplicate', '', '', NULL, 0, '2026-01-02T00:00:00Z', 'secret-b'),
        (3, 'owner-a', 'https://example.com/a', 'url conflict', '', '', NULL, 0, '2026-01-03T00:00:00Z', 'secret-c'),
        (4, 'owner-a', 'https://valid.invalid/', 'bad time', '', '', NULL, 0, 'not-a-time', 'secret-d');
      INSERT INTO notes VALUES
        (8, 'owner-a', 'private note body', NULL, NULL, NULL, 0, NULL, 0, '2026-01-04T00:00:00Z');
    `
  );
  const { createLegacyMigrationPlan } = require('./plan-migration');

  const plan = await createLegacyMigrationPlan(migrationOptions(root, snapshot, destinationPath));

  assert.equal(plan.counts.sourceRows, 5);
  assert.equal(plan.counts.importableRows, 2);
  assert.equal(plan.counts.skippedRows, 3);
  assert.equal(plan.skips.duplicateIds, 1);
  assert.equal(plan.skips.normalizedUrlConflicts, 1);
  assert.equal(plan.skips.invalidTimestamps, 1);
  assert.equal(plan.transforms.urlNormalizations, 1);
  assert.deepEqual(plan.conflicts, {
    duplicateIds: 1,
    normalizedUrls: 1,
    orphanedRows: 0,
  });
  assert.deepEqual(plan.warnings, [{ code: 'UNKNOWN_COLUMNS', count: 1 }]);
  assert.equal(plan.requiredDiskBytes > statSync(snapshot.manifestPath).size, true);
  assert.match(plan.rollbackPath, /rollback/);
  assert.match(plan.fingerprint, /^[a-f0-9]{64}$/);
  assert.match(plan.sourceFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(existsSync(plan.recoveryManifestPath), true);
  const serialized = JSON.stringify(plan);
  assert.doesNotMatch(serialized, /owner-a|private title|private note|secret-|MUST_NOT_LEAK|example\.com/);
});

test('planning counts orphaned item tags and rejects insufficient disk before creating recovery data', async () => {
  const root = makeRoot();
  const destinationPath = createCanonicalDatabase(root);
  const snapshot = createLegacySnapshot(
    root,
    'schema-v2.sql',
    `
      ALTER TABLE items ADD COLUMN unexpected TEXT;
      INSERT INTO items VALUES
        (10, 'owner-b', 'https://item.invalid', 'title', 'body', '', '', 'web', 0, 0, NULL,
         '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 'private');
      INSERT INTO item_tags VALUES (1, 999, 'orphan');
    `
  );
  const { createLegacyMigrationPlan } = require('./plan-migration');
  const options = migrationOptions(root, snapshot, destinationPath);
  const plan = await createLegacyMigrationPlan(options);
  assert.equal(plan.skips.orphanedRows, 1);
  assert.equal(plan.counts.importableRows, 1);

  const secondRoot = makeRoot();
  const secondDestination = createCanonicalDatabase(secondRoot);
  const secondSnapshot = createLegacySnapshot(
    secondRoot,
    'schema-v1.sql',
    `INSERT INTO bookmarks VALUES (1, 'owner', 'https://safe.invalid', '', '', '', NULL, 0, '2026-01-01Z');`
  );
  const insufficient = migrationOptions(secondRoot, secondSnapshot, secondDestination);
  insufficient.availableDiskBytes = 0;
  await assert.rejects(
    createLegacyMigrationPlan(insufficient),
    error => error.code === 'LEGACY_MIGRATION_INSUFFICIENT_DISK'
  );
  assert.deepEqual(require('node:fs').readdirSync(insufficient.recoveryRoot), []);
});

test('confirmation is bound to the exact plan and migration is transactional, invariant-checked, and repeat-safe', async () => {
  const root = makeRoot();
  const destinationPath = createCanonicalDatabase(root);
  const snapshot = createLegacySnapshot(
    root,
    'schema-v1.sql',
    `
      INSERT INTO bookmarks VALUES
        (1, 'owner', 'https://one.invalid', 'One', '', '', NULL, 0, '2026-01-01T00:00:00Z'),
        (2, 'owner', 'https://two.invalid', 'Two', '', '', NULL, 0, '2026-01-02T00:00:00Z');
    `
  );
  const options = migrationOptions(root, snapshot, destinationPath);
  const { createLegacyMigrationPlan } = require('./plan-migration');
  const { runLegacyMigration } = require('./run-migration');
  const plan = await createLegacyMigrationPlan(options);

  await assert.rejects(
    runLegacyMigration({ ...options, plan, confirmationFingerprint: '0'.repeat(64) }),
    error => error.code === 'LEGACY_MIGRATION_CONFIRMATION_MISMATCH'
  );
  let destination = new BetterSqlite3(destinationPath);
  assert.equal(destination.prepare('SELECT COUNT(*) FROM items').pluck().get(), 0);
  destination.close();

  const result = await runLegacyMigration({
    ...options,
    plan,
    confirmationFingerprint: plan.fingerprint,
  });
  assert.equal(result.state, 'succeeded');
  assert.equal(result.importedRows, 2);
  assert.equal(existsSync(result.rollbackMetadataPath), true);

  destination = new BetterSqlite3(destinationPath);
  assert.equal(destination.prepare('SELECT COUNT(*) FROM items').pluck().get(), 2);
  assert.equal(destination.prepare('SELECT COUNT(*) FROM bookmarks').pluck().get(), 2);
  assert.equal(destination.prepare('PRAGMA foreign_key_check').all().length, 0);
  assert.equal(
    destination
      .prepare('SELECT COUNT(*) FROM migration_runs WHERE id = ?')
      .pluck()
      .get(`legacy:${plan.sourceFingerprint}`),
    1
  );
  destination.close();

  await assert.rejects(
    runLegacyMigration({ ...options, plan, confirmationFingerprint: plan.fingerprint }),
    error => error.code === 'LEGACY_MIGRATION_ALREADY_APPLIED'
  );
});

test('an interrupted migration rolls back all destination rows and leaves a failed run absent', async () => {
  const root = makeRoot();
  const destinationPath = createCanonicalDatabase(root);
  const snapshot = createLegacySnapshot(
    root,
    'schema-v1.sql',
    `
      INSERT INTO bookmarks VALUES
        (1, 'owner', 'https://one.invalid', 'One', '', '', NULL, 0, '2026-01-01T00:00:00Z'),
        (2, 'owner', 'https://two.invalid', 'Two', '', '', NULL, 0, '2026-01-02T00:00:00Z');
    `
  );
  const options = migrationOptions(root, snapshot, destinationPath);
  const { createLegacyMigrationPlan } = require('./plan-migration');
  const { runLegacyMigration } = require('./run-migration');
  const plan = await createLegacyMigrationPlan(options);

  await assert.rejects(
    runLegacyMigration({
      ...options,
      plan,
      confirmationFingerprint: plan.fingerprint,
      interruptAfterWrites: 1,
    }),
    error => error.code === 'LEGACY_MIGRATION_INTERRUPTED'
  );
  const destination = new BetterSqlite3(destinationPath);
  assert.equal(destination.prepare('SELECT COUNT(*) FROM items').pluck().get(), 0);
  assert.equal(destination.prepare('SELECT COUNT(*) FROM migration_runs').pluck().get(), 0);
  destination.close();
  for (const file of snapshot.files) {
    assert.equal(hash(readFileSync(join(snapshot.quarantinePath, file.name))), file.sha256);
  }
});

test('confirmation is bound to the planned destination, not only the source snapshot', async () => {
  const root = makeRoot();
  const destinationPath = createCanonicalDatabase(root);
  const otherRoot = makeRoot();
  const otherDestinationPath = createCanonicalDatabase(otherRoot);
  const snapshot = createLegacySnapshot(
    root,
    'schema-v1.sql',
    `INSERT INTO bookmarks VALUES (1, 'owner', 'https://one.invalid', 'One', '', '', NULL, 0, '2026-01-01T00:00:00Z');`
  );
  const options = migrationOptions(root, snapshot, destinationPath);
  const { createLegacyMigrationPlan } = require('./plan-migration');
  const { runLegacyMigration } = require('./run-migration');
  const plan = await createLegacyMigrationPlan(options);

  await assert.rejects(
    runLegacyMigration({
      ...options,
      plan,
      destinationPath: otherDestinationPath,
      confirmationFingerprint: plan.fingerprint,
    }),
    error => error.code === 'LEGACY_MIGRATION_CONFIRMATION_MISMATCH'
  );
  const other = new BetterSqlite3(otherDestinationPath);
  assert.equal(other.prepare('SELECT COUNT(*) FROM items').pluck().get(), 0);
  other.close();
});

test('rollback metadata verifies unchanged post-import state and restores the pre-migration database', async () => {
  const root = makeRoot();
  const destinationPath = createCanonicalDatabase(root);
  const snapshot = createLegacySnapshot(
    root,
    'schema-v1.sql',
    `INSERT INTO bookmarks VALUES (1, 'owner', 'https://one.invalid', 'One', '', '', NULL, 0, '2026-01-01T00:00:00Z');`
  );
  const options = migrationOptions(root, snapshot, destinationPath);
  const { createLegacyMigrationPlan } = require('./plan-migration');
  const { runLegacyMigration } = require('./run-migration');
  const { rollbackLegacyMigration } = require('./rollback-migration');
  const plan = await createLegacyMigrationPlan(options);
  const result = await runLegacyMigration({
    ...options,
    plan,
    confirmationFingerprint: plan.fingerprint,
  });

  const rollback = await rollbackLegacyMigration({
    metadataPath: result.rollbackMetadataPath,
    destinationPath,
    filePermissions: permissions(),
  });
  assert.equal(rollback.state, 'rolled-back');
  const destination = new BetterSqlite3(destinationPath);
  assert.equal(destination.prepare('SELECT COUNT(*) FROM items').pluck().get(), 0);
  assert.equal(destination.prepare('SELECT COUNT(*) FROM migration_runs').pluck().get(), 0);
  assert.equal(destination.pragma('integrity_check', { simple: true }), 'ok');
  destination.close();
});

test('rollback refuses an active or changed WAL sidecar instead of discarding uncheckpointed state', async () => {
  const root = makeRoot();
  const destinationPath = createCanonicalDatabase(root);
  const snapshot = createLegacySnapshot(
    root,
    'schema-v1.sql',
    `INSERT INTO bookmarks VALUES (1, 'owner', 'https://one.invalid', 'One', '', '', NULL, 0, '2026-01-01T00:00:00Z');`
  );
  const options = migrationOptions(root, snapshot, destinationPath);
  const { createLegacyMigrationPlan } = require('./plan-migration');
  const { runLegacyMigration } = require('./run-migration');
  const { rollbackLegacyMigration } = require('./rollback-migration');
  const plan = await createLegacyMigrationPlan(options);
  const result = await runLegacyMigration({
    ...options,
    plan,
    confirmationFingerprint: plan.fingerprint,
  });
  writeFileSync(`${destinationPath}-wal`, 'changed-wal-state');

  await assert.rejects(
    rollbackLegacyMigration({
      metadataPath: result.rollbackMetadataPath,
      destinationPath,
      filePermissions: permissions(),
    }),
    error => error.code === 'LEGACY_MIGRATION_ROLLBACK_DRIFT'
  );
});

test('migration modules and CLI are import-inert and never auto-run', () => {
  const modules = [
    './plan-migration.js',
    './run-migration.js',
    './rollback-migration.js',
    '../../../scripts/legacy/migrate-legacy.mjs',
  ].map(relativePath => pathToFileURL(resolve(__dirname, relativePath)).href);
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', `await Promise.all(${JSON.stringify(modules)}.map(value => import(value)));`],
    { encoding: 'utf8', windowsHide: true }
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});
