import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import {
  MOBILE_MIGRATIONS,
  MobileMigrationError,
  applyMobileMigrations,
  createMobileMigration,
} from '../src/db/migrations.ts';
import { openMobileDatabase } from '../src/db/open-database.ts';
import { MOBILE_SCHEMA_INDEXES, MOBILE_SCHEMA_TABLES } from '../src/db/schema.ts';

const EXPECTED_TABLES = [
  'bookmarks',
  'conflicts',
  'device_metadata',
  'flashcards',
  'highlights',
  'inbox_acknowledgements',
  'item_tags',
  'items',
  'notes',
  'outbox',
  'reminders',
  'schema_migrations',
  'sync_cursor',
  'tags',
  'tombstones',
];

const EXPECTED_INDEXES = [
  'idx_mobile_bookmarks_profile_item',
  'idx_mobile_conflicts_profile_state',
  'idx_mobile_device_metadata_profile_device',
  'idx_mobile_flashcards_profile_due',
  'idx_mobile_highlights_profile_item',
  'idx_mobile_inbox_profile_change',
  'idx_mobile_item_tags_profile_item',
  'idx_mobile_item_tags_profile_tag',
  'idx_mobile_items_profile_created',
  'idx_mobile_items_profile_updated',
  'idx_mobile_notes_profile_item',
  'idx_mobile_outbox_profile_device_sequence',
  'idx_mobile_outbox_profile_state',
  'idx_mobile_reminders_profile_due',
  'idx_mobile_sync_cursor_profile_device',
  'idx_mobile_tags_profile_name',
  'idx_mobile_tombstones_profile_entity',
];

function makeDatabase() {
  const database = new Database(':memory:');
  database.pragma('foreign_keys = ON');
  return database;
}

function expectMigrationError(action, code) {
  assert.throws(action, error => {
    assert.ok(error instanceof MobileMigrationError);
    assert.equal(error.code, code);
    return true;
  });
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

test('canonical migrations create the frozen owner-scoped mobile schema', t => {
  const database = makeDatabase();
  t.after(() => database.close());

  const result = applyMobileMigrations({
    database,
    now: () => 1_800_000_000_000,
  });

  assert.deepEqual(result, {
    appliedVersions: [1, 2, 3],
    currentVersion: 3,
  });
  assert.deepEqual(tableNames(database), EXPECTED_TABLES);
  assert.deepEqual([...MOBILE_SCHEMA_TABLES], EXPECTED_TABLES);

  for (const table of EXPECTED_TABLES.filter(name => name !== 'schema_migrations')) {
    const columns = database.prepare(`PRAGMA table_info("${table}")`).all();
    const byName = new Map(columns.map(column => [column.name, column]));

    assert.equal(byName.get('profile_id')?.type, 'TEXT', `${table}.profile_id`);
    assert.equal(byName.get('revision')?.type, 'INTEGER', `${table}.revision`);
    assert.equal(byName.get('created_at')?.type, 'INTEGER', `${table}.created_at`);
    assert.equal(byName.get('updated_at')?.type, 'INTEGER', `${table}.updated_at`);
    assert.equal(byName.get('profile_id')?.notnull, 1, table);
    assert.equal(byName.get('revision')?.notnull, 1, table);
    assert.equal(byName.get('created_at')?.notnull, 1, table);
    assert.equal(byName.get('updated_at')?.notnull, 1, table);
  }

  const indexes = database
    .prepare(
      `SELECT name
       FROM sqlite_master
       WHERE type = 'index' AND name LIKE 'idx_mobile_%'
       ORDER BY name`
    )
    .pluck()
    .all();
  assert.deepEqual(indexes, EXPECTED_INDEXES);
  assert.deepEqual([...MOBILE_SCHEMA_INDEXES], EXPECTED_INDEXES);
});

test('canonical migrations have ordered stable SHA-256 checksums and reapply as a no-op', t => {
  const database = makeDatabase();
  t.after(() => database.close());

  assert.deepEqual(
    MOBILE_MIGRATIONS.map(({ version, name }) => ({ version, name })),
    [
      { version: 1, name: 'content' },
      { version: 2, name: 'learning' },
      { version: 3, name: 'sync' },
    ]
  );
  for (const migration of MOBILE_MIGRATIONS) {
    assert.match(migration.checksum, /^[a-f0-9]{64}$/);
    assert.ok(Object.isFrozen(migration));
  }
  assert.equal(
    createMobileMigration(9, 'sha_fixture', '').checksum,
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
  );

  const first = applyMobileMigrations({
    database,
    now: () => 1_800_000_000_000,
  });
  const second = applyMobileMigrations({
    database,
    now: () => {
      throw new Error('a no-op migration must not read the clock');
    },
  });

  assert.deepEqual(first.appliedVersions, [1, 2, 3]);
  assert.deepEqual(second, { appliedVersions: [], currentVersion: 3 });
  assert.deepEqual(
    database.prepare('SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version').all(),
    MOBILE_MIGRATIONS.map(migration => ({
      version: migration.version,
      name: migration.name,
      checksum: migration.checksum,
      applied_at: 1_800_000_000_000,
    }))
  );
});

test('migration manifests reject checksum tampering and version gaps before database writes', t => {
  const database = makeDatabase();
  t.after(() => database.close());

  const valid = createMobileMigration(1, 'one', 'CREATE TABLE one(id TEXT);');
  const tampered = { ...valid, sql: `${valid.sql}\n-- changed` };

  expectMigrationError(
    () => applyMobileMigrations({ database, migrations: [tampered] }),
    'MOBILE_MIGRATION_MANIFEST_INVALID'
  );
  assert.deepEqual(tableNames(database), []);

  const third = createMobileMigration(3, 'three', 'CREATE TABLE three(id TEXT);');
  expectMigrationError(
    () => applyMobileMigrations({ database, migrations: [valid, third] }),
    'MOBILE_MIGRATION_VERSION_GAP'
  );
  assert.deepEqual(tableNames(database), []);
});

test('applied checksum drift and databases newer than the client are rejected', t => {
  const database = makeDatabase();
  t.after(() => database.close());

  const original = createMobileMigration(1, 'feature', 'CREATE TABLE feature(id TEXT);');
  applyMobileMigrations({ database, migrations: [original], now: () => 1 });

  const changed = createMobileMigration(1, 'feature', 'CREATE TABLE feature(id TEXT, changed TEXT);');
  expectMigrationError(
    () => applyMobileMigrations({ database, migrations: [changed] }),
    'MOBILE_MIGRATION_CHECKSUM_MISMATCH'
  );

  database
    .prepare(
      `INSERT INTO schema_migrations(version, name, checksum, applied_at)
       VALUES (?, ?, ?, ?)`
    )
    .run(2, 'future', 'f'.repeat(64), 2);
  expectMigrationError(
    () => applyMobileMigrations({ database, migrations: [original] }),
    'MOBILE_MIGRATION_DATABASE_NEWER'
  );
});

test('corrupt applied gaps are rejected without running later migrations', t => {
  const database = makeDatabase();
  t.after(() => database.close());

  const first = createMobileMigration(1, 'one', 'CREATE TABLE one(id TEXT);');
  const second = createMobileMigration(2, 'two', 'CREATE TABLE two(id TEXT);');
  applyMobileMigrations({ database, migrations: [first, second], now: () => 1 });
  database.prepare('DELETE FROM schema_migrations WHERE version = 1').run();

  expectMigrationError(
    () => applyMobileMigrations({ database, migrations: [first, second] }),
    'MOBILE_MIGRATION_HISTORY_INVALID'
  );
});

test('a failed migration rolls back its partial schema and history row', t => {
  const database = makeDatabase();
  t.after(() => database.close());

  const failing = createMobileMigration(
    1,
    'failing',
    `
      CREATE TABLE must_rollback(id TEXT);
      INSERT INTO missing_table(id) VALUES ('failure');
    `
  );

  expectMigrationError(
    () =>
      applyMobileMigrations({
        database,
        migrations: [failing],
        now: () => 1,
      }),
    'MOBILE_MIGRATION_FAILED'
  );
  assert.deepEqual(tableNames(database), ['schema_migrations']);
  assert.equal(database.prepare('SELECT COUNT(*) FROM schema_migrations').pluck().get(), 0);
});

test('openMobileDatabase opens only the injected path and applies migrations', t => {
  const root = mkdtempSync(path.join(tmpdir(), 'easy-rewind-mobile-db-'));
  const databasePath = path.join(root, 'profile.sqlite');
  const opened = [];

  const result = openMobileDatabase({
    databasePath,
    open: requestedPath => {
      opened.push(requestedPath);
      return new Database(requestedPath);
    },
    now: () => 1_800_000_000_000,
  });
  t.after(() => {
    result.database.close?.();
    rmSync(root, { recursive: true, force: true });
  });

  assert.deepEqual(opened, [databasePath]);
  assert.deepEqual(result.migration.appliedVersions, [1, 2, 3]);
  assert.deepEqual(tableNames(result.database), EXPECTED_TABLES);
  assert.equal(result.database.pragma('foreign_keys', { simple: true }), 1);
});

test('openMobileDatabase rejects invalid paths before invoking the opener', () => {
  let calls = 0;
  expectMigrationError(
    () =>
      openMobileDatabase({
        databasePath: '   ',
        open: () => {
          calls += 1;
          return makeDatabase();
        },
      }),
    'MOBILE_DATABASE_PATH_INVALID'
  );
  assert.equal(calls, 0);
});
