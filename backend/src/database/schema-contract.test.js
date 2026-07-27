'use strict';

const assert = require('node:assert/strict');
const { mkdirSync, mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const test = require('node:test');

const {
  expectedColumns,
  expectedForeignKeys,
  expectedFtsContract,
  expectedIndexes,
  expectedMigrationMetadata,
} = require('./schema-contract.fixture');

const temporaryRoots = new Set();
const requiredTables = [
  'bookmarks',
  'browser_sessions',
  'client_credentials',
  'connections',
  'diagnostics',
  'digests',
  'flashcards',
  'highlights',
  'item_tags',
  'items',
  'items_fts',
  'jobs',
  'migration_runs',
  'notes',
  'profiles',
  'quiz_results',
  'reminder_deliveries',
  'reminders',
  'research_jobs',
  'schema_migrations',
  'settings',
  'sync_changes',
  'sync_conflicts',
  'sync_cursors',
  'sync_devices',
  'sync_operations',
  'tags',
];
const requiredRelationalTables = requiredTables.filter(table => table !== 'items_fts');

function makePath() {
  const root = mkdtempSync(join(tmpdir(), 'easy-rewind-schema-'));
  temporaryRoots.add(root);
  const parent = join(root, 'database');
  mkdirSync(parent);
  return join(parent, 'schema.sqlite3');
}

const filePermissions = {
  async restrictDirectory() {},
  async restrictFile() {},
};

async function migratedDatabase() {
  const { openDatabase } = require('./open-database');
  const { discoverMigrations, runMigrations } = require('./migration-runner');
  const db = await openDatabase({ path: makePath(), filePermissions });
  runMigrations({ db, migrations: discoverMigrations() });
  return db;
}

function tableColumns(db, table) {
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map(column => column.name);
}

function quotedIdentifier(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

function tableIndexes(db, table) {
  return db
    .prepare(`PRAGMA index_list(${quotedIdentifier(table)})`)
    .all()
    .map(index => ({
      name: index.name,
      unique: Boolean(index.unique),
      origin: index.origin,
      partial: Boolean(index.partial),
      columns: db
        .prepare(`PRAGMA index_info(${quotedIdentifier(index.name)})`)
        .all()
        .map(column => column.name),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function tableForeignKeys(db, table) {
  return db
    .prepare(`PRAGMA foreign_key_list(${quotedIdentifier(table)})`)
    .all()
    .map(foreignKey => ({
      from: foreignKey.from,
      table: foreignKey.table,
      to: foreignKey.to,
      onUpdate: foreignKey.on_update,
      onDelete: foreignKey.on_delete,
    }))
    .sort((left, right) => left.from.localeCompare(right.from));
}

function assertConstraint(db, sql, parameters = []) {
  assert.throws(() => db.prepare(sql).run(...parameters), /CHECK constraint failed/i);
}

test.after(() => {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
});

test('canonical schema exposes the exact required application tables', async () => {
  const db = await migratedDatabase();
  const actual = db
    .prepare(
      `SELECT name
       FROM sqlite_master
       WHERE type IN ('table', 'view')
         AND name NOT LIKE 'sqlite_%'
         AND name NOT LIKE 'items_fts_%'
       ORDER BY name`
    )
    .pluck()
    .all();

  assert.deepEqual(actual, requiredTables);
  db.close();
});

test('every relational table has exact ordered columns', async () => {
  const db = await migratedDatabase();
  try {
    assert.deepEqual(Object.keys(expectedColumns).sort(), requiredRelationalTables);
    for (const table of requiredRelationalTables) {
      assert.deepEqual(tableColumns(db, table), expectedColumns[table], `${table} columns`);
    }
  } finally {
    db.close();
  }
});

test('every relational table has exact named and automatic indexes', async () => {
  const db = await migratedDatabase();
  try {
    assert.deepEqual(Object.keys(expectedIndexes).sort(), requiredRelationalTables);
    for (const table of requiredRelationalTables) {
      assert.deepEqual(
        tableIndexes(db, table),
        expectedIndexes[table].toSorted((left, right) => left.name.localeCompare(right.name)),
        `${table} indexes`
      );
    }
  } finally {
    db.close();
  }
});

test('every relational table has exact foreign-key actions', async () => {
  const db = await migratedDatabase();
  try {
    assert.deepEqual(Object.keys(expectedForeignKeys).sort(), requiredRelationalTables);
    for (const table of requiredRelationalTables) {
      assert.deepEqual(tableForeignKeys(db, table), expectedForeignKeys[table], `${table} foreign keys`);
    }
  } finally {
    db.close();
  }
});

test('schema migration metadata has exact columns and integer primary key', async () => {
  const db = await migratedDatabase();
  try {
    const metadata = db
      .prepare('PRAGMA table_info(schema_migrations)')
      .all()
      .map(({ name, type, notnull, pk }) => ({ name, type, notnull, pk }));
    assert.deepEqual(metadata, expectedMigrationMetadata);
  } finally {
    db.close();
  }
});

test('FTS exposes only intended public columns and characterized internal shadow tables', async () => {
  const db = await migratedDatabase();
  try {
    assert.deepEqual(tableColumns(db, 'items_fts'), expectedFtsContract.publicColumns);
    assert.match(
      db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'items_fts'").pluck().get(),
      /^CREATE VIRTUAL TABLE items_fts USING fts5\(/i
    );
    assert.deepEqual(
      db
        .prepare(
          `SELECT name
           FROM sqlite_master
           WHERE type = 'table' AND name LIKE 'items_fts_%'
           ORDER BY name`
        )
        .pluck()
        .all(),
      expectedFtsContract.shadowTables
    );
  } finally {
    db.close();
  }
});

test('syncable domain rows carry owner, UUID, timestamps, revisions, and tombstones', async () => {
  const db = await migratedDatabase();
  const syncableTables = [
    'bookmarks',
    'connections',
    'digests',
    'flashcards',
    'highlights',
    'item_tags',
    'items',
    'notes',
    'quiz_results',
    'reminder_deliveries',
    'reminders',
    'research_jobs',
    'settings',
    'sync_devices',
    'tags',
  ];

  for (const table of syncableTables) {
    const columns = tableColumns(db, table);
    for (const column of ['id', 'profile_id', 'created_at', 'updated_at', 'revision', 'deleted_at']) {
      assert.equal(columns.includes(column), true, `${table}.${column}`);
    }
    const info = db.prepare(`PRAGMA table_info(${table})`).all();
    assert.equal(info.find(column => column.name === 'id').type, 'TEXT');
    assert.equal(info.find(column => column.name === 'profile_id').notnull, 1);
    assert.equal(info.find(column => column.name === 'revision').notnull, 1);
  }
  db.close();
});

test('critical owner relationships use foreign keys and cascades', async () => {
  const db = await migratedDatabase();
  db.prepare('INSERT INTO profiles(id, display_name, created_at, updated_at, revision) VALUES (?, ?, ?, ?, ?)').run(
    'profile-1',
    'Owner',
    1,
    1,
    1
  );
  db.prepare(
    `INSERT INTO items(
       id, profile_id, kind, title, url, created_at, updated_at, revision
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run('item-1', 'profile-1', 'article', 'Title', 'https://example.test', 1, 1, 1);

  assert.throws(
    () =>
      db
        .prepare(
          `INSERT INTO notes(
             id, profile_id, item_id, body, created_at, updated_at, revision
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run('note-1', 'missing-profile', 'item-1', 'Body', 1, 1, 1),
    /FOREIGN KEY constraint failed/i
  );
  db.prepare('DELETE FROM profiles WHERE id = ?').run('profile-1');
  assert.equal(db.prepare('SELECT count(*) FROM items').pluck().get(), 0);
  db.close();
});

test('stable state checks accept documented states and reject unknown values', async t => {
  const db = await migratedDatabase();
  db.prepare('INSERT INTO profiles(id, display_name, created_at, updated_at, revision) VALUES (?, ?, ?, ?, ?)').run(
    'profile-1',
    'Owner',
    1,
    1,
    1
  );
  db.prepare(
    `INSERT INTO items(
       id, profile_id, kind, title, created_at, updated_at, revision
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run('item-1', 'profile-1', 'article', 'Title', 1, 1, 1);

  await t.test('reminders', () => {
    for (const [index, state] of ['scheduled', 'snoozed', 'completed', 'cancelled'].entries()) {
      db.prepare(
        `INSERT INTO reminders(
           id, profile_id, item_id, state, due_at, created_at, updated_at, revision
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(`reminder-${index}`, 'profile-1', 'item-1', state, 10, 1, 1, 1);
    }
    assertConstraint(
      db,
      `INSERT INTO reminders(
         id, profile_id, state, due_at, created_at, updated_at, revision
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ['reminder-invalid', 'profile-1', 'unknown', 10, 1, 1, 1]
    );
  });

  await t.test('deliveries', () => {
    for (const [index, state] of ['pending', 'delivering', 'delivered', 'failed', 'cancelled'].entries()) {
      db.prepare(
        `INSERT INTO reminder_deliveries(
           id, profile_id, reminder_id, channel, state, attempt_count, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(`delivery-${index}`, 'profile-1', 'reminder-0', 'desktop', state, 0, 1, 1);
    }
    assertConstraint(
      db,
      `INSERT INTO reminder_deliveries(
         id, profile_id, reminder_id, channel, state, attempt_count, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ['delivery-invalid', 'profile-1', 'reminder-0', 'desktop', 'unknown', 0, 1, 1]
    );
  });

  await t.test('devices', () => {
    for (const [index, state] of ['pending', 'active', 'revoked'].entries()) {
      db.prepare(
        `INSERT INTO sync_devices(
           id, profile_id, name, platform, state, created_at, updated_at, revision
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(`device-${index}`, 'profile-1', 'Device', 'browser', state, 1, 1, 1);
    }
    assertConstraint(
      db,
      `INSERT INTO sync_devices(
         id, profile_id, name, platform, state, created_at, updated_at, revision
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ['device-invalid', 'profile-1', 'Device', 'browser', 'unknown', 1, 1, 1]
    );
  });

  await t.test('jobs', () => {
    for (const [index, state] of ['queued', 'running', 'succeeded', 'failed', 'cancelled'].entries()) {
      db.prepare(
        `INSERT INTO jobs(
           id, profile_id, kind, state, attempts, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(`job-${index}`, 'profile-1', 'digest', state, 0, 1, 1);
    }
    assertConstraint(
      db,
      `INSERT INTO jobs(
         id, profile_id, kind, state, attempts, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ['job-invalid', 'profile-1', 'digest', 'unknown', 0, 1, 1]
    );
  });

  await t.test('sync conflicts', () => {
    for (const [index, state] of ['open', 'resolved_local', 'resolved_remote', 'resolved_merged'].entries()) {
      db.prepare(
        `INSERT INTO sync_conflicts(
           id, profile_id, entity_type, entity_id, local_revision, remote_revision,
           state, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(`conflict-${index}`, 'profile-1', 'item', 'item-1', 1, 2, state, 1, 1);
    }
    assertConstraint(
      db,
      `INSERT INTO sync_conflicts(
         id, profile_id, entity_type, entity_id, local_revision, remote_revision,
         state, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['conflict-invalid', 'profile-1', 'item', 'item-1', 1, 2, 'unknown', 1, 1]
    );
  });

  db.close();
});

test('revision and timestamp checks reject invalid syncable records', async () => {
  const db = await migratedDatabase();
  assertConstraint(
    db,
    'INSERT INTO profiles(id, display_name, created_at, updated_at, revision) VALUES (?, ?, ?, ?, ?)',
    ['profile-zero-revision', 'Owner', 1, 1, 0]
  );
  assertConstraint(
    db,
    'INSERT INTO profiles(id, display_name, created_at, updated_at, revision) VALUES (?, ?, ?, ?, ?)',
    ['profile-negative-time', 'Owner', -1, 1, 1]
  );
  db.close();
});

test('owner-scoped uniqueness and lookup indexes prevent duplicate operations', async () => {
  const db = await migratedDatabase();
  const indexes = new Set(
    db
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'index' AND name NOT LIKE 'sqlite_%'`
      )
      .pluck()
      .all()
  );
  for (const name of [
    'idx_connections_profile_endpoints',
    'idx_items_profile_updated',
    'idx_jobs_profile_state_available',
    'idx_reminders_profile_due',
    'idx_sync_conflicts_profile_state',
    'idx_sync_cursors_profile_device',
    'idx_sync_operations_profile_created',
    'idx_tags_profile_name',
    'uq_connections_live_endpoints',
    'uq_item_tags_live',
    'uq_sync_operations_profile_operation',
  ]) {
    assert.equal(indexes.has(name), true, name);
  }

  db.prepare('INSERT INTO profiles(id, display_name, created_at, updated_at, revision) VALUES (?, ?, ?, ?, ?)').run(
    'profile-1',
    'Owner',
    1,
    1,
    1
  );
  db.prepare(
    `INSERT INTO sync_operations(
       id, profile_id, device_id, operation_key, entity_type, entity_id,
       base_revision, payload_json, state, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run('operation-1', 'profile-1', null, 'dedupe-key', 'item', 'item-1', 1, '{}', 'pending', 1, 1);
  assert.throws(
    () =>
      db
        .prepare(
          `INSERT INTO sync_operations(
             id, profile_id, device_id, operation_key, entity_type, entity_id,
             base_revision, payload_json, state, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run('operation-2', 'profile-1', null, 'dedupe-key', 'item', 'item-1', 1, '{}', 'pending', 1, 1),
    /UNIQUE constraint failed/i
  );
  db.close();
});

test('FTS item search follows inserts, content updates, and tombstones', async () => {
  const db = await migratedDatabase();
  db.prepare('INSERT INTO profiles(id, display_name, created_at, updated_at, revision) VALUES (?, ?, ?, ?, ?)').run(
    'profile-1',
    'Owner',
    1,
    1,
    1
  );
  db.prepare(
    `INSERT INTO items(
       id, profile_id, kind, title, excerpt, body, created_at, updated_at, revision
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run('item-1', 'profile-1', 'article', 'Migrating birds', 'Seasonal route', 'Northbound', 1, 1, 1);

  assert.deepEqual(db.prepare("SELECT item_id FROM items_fts WHERE items_fts MATCH 'migrating'").pluck().all(), [
    'item-1',
  ]);
  db.prepare('UPDATE items SET title = ?, body = ?, updated_at = ?, revision = ? WHERE id = ?').run(
    'Ocean currents',
    'Westbound',
    2,
    2,
    'item-1'
  );
  assert.deepEqual(db.prepare("SELECT item_id FROM items_fts WHERE items_fts MATCH 'migrating'").pluck().all(), []);
  assert.deepEqual(db.prepare("SELECT item_id FROM items_fts WHERE items_fts MATCH 'ocean'").pluck().all(), ['item-1']);

  db.prepare('UPDATE items SET deleted_at = ?, updated_at = ?, revision = ? WHERE id = ?').run(3, 3, 3, 'item-1');
  assert.deepEqual(db.prepare("SELECT item_id FROM items_fts WHERE items_fts MATCH 'ocean'").pluck().all(), []);

  db.prepare('UPDATE items SET deleted_at = NULL, title = ?, updated_at = ?, revision = ? WHERE id = ?').run(
    'Restored ocean',
    4,
    4,
    'item-1'
  );
  assert.deepEqual(db.prepare("SELECT item_id FROM items_fts WHERE items_fts MATCH 'restored'").pluck().all(), [
    'item-1',
  ]);
  db.prepare('DELETE FROM items WHERE id = ?').run('item-1');
  assert.deepEqual(db.prepare("SELECT item_id FROM items_fts WHERE items_fts MATCH 'restored'").pluck().all(), []);
  db.close();
});
