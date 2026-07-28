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
  expectedIndexDetails,
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
  'pairing_challenges',
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

function normalizedSql(sql) {
  return sql === null ? null : sql.replace(/\s+/g, ' ').trim();
}

function indexDetails(db, indexName) {
  return {
    sql: normalizedSql(
      db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?").pluck().get(indexName) ?? null
    ),
    terms: db
      .prepare(`PRAGMA index_xinfo(${quotedIdentifier(indexName)})`)
      .all()
      .map(term => ({
        name: term.name,
        collation: term.coll,
        descending: Boolean(term.desc),
        key: Boolean(term.key),
      })),
  };
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

test('every index freezes xinfo key order, collation, direction, and normalized creation SQL', async () => {
  const db = await migratedDatabase();
  try {
    const indexNames = requiredRelationalTables
      .flatMap(table => expectedIndexes[table].map(index => index.name))
      .sort();
    assert.deepEqual(Object.keys(expectedIndexDetails).sort(), indexNames);
    for (const indexName of indexNames) {
      assert.deepEqual(indexDetails(db, indexName), expectedIndexDetails[indexName], `${indexName} details`);
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

test('owned relationships reject parent rows belonging to another valid profile', async t => {
  const db = await migratedDatabase();
  db.prepare('INSERT INTO profiles(id, display_name, created_at, updated_at, revision) VALUES (?, ?, ?, ?, ?)').run(
    'profile-1',
    'First',
    1,
    1,
    1
  );
  db.prepare('INSERT INTO profiles(id, display_name, created_at, updated_at, revision) VALUES (?, ?, ?, ?, ?)').run(
    'profile-2',
    'Second',
    1,
    1,
    1
  );
  const insertItem = db.prepare(
    `INSERT INTO items(id, profile_id, kind, title, created_at, updated_at, revision)
     VALUES (?, ?, 'article', ?, 1, 1, 1)`
  );
  insertItem.run('item-1a', 'profile-1', 'First A');
  insertItem.run('item-1b', 'profile-1', 'First B');
  insertItem.run('item-2a', 'profile-2', 'Second A');
  insertItem.run('item-2b', 'profile-2', 'Second B');
  db.prepare(
    `INSERT INTO tags(id, profile_id, name, normalized_name, created_at, updated_at, revision)
     VALUES (?, ?, ?, ?, 1, 1, 1)`
  ).run('tag-1', 'profile-1', 'First', 'first');
  db.prepare(
    `INSERT INTO tags(id, profile_id, name, normalized_name, created_at, updated_at, revision)
     VALUES (?, ?, ?, ?, 1, 1, 1)`
  ).run('tag-2', 'profile-2', 'Second', 'second');
  db.prepare(
    `INSERT INTO reminders(id, profile_id, item_id, state, due_at, created_at, updated_at, revision)
     VALUES (?, ?, ?, 'scheduled', 10, 1, 1, 1)`
  ).run('reminder-1', 'profile-1', 'item-1a');
  db.prepare(
    `INSERT INTO client_credentials(
       id, profile_id, kind, secret_ref, secret_digest, state, created_at, updated_at
     ) VALUES (?, ?, 'browser_extension', ?, ?, 'active', 1, 1)`
  ).run('credential-1', 'profile-1', 'secret:first', `v1:${'1'.repeat(64)}`);
  const insertDevice = db.prepare(
    `INSERT INTO sync_devices(
       id, profile_id, name, platform, state, created_at, updated_at, revision
     ) VALUES (?, ?, ?, 'browser', 'active', 1, 1, 1)`
  );
  insertDevice.run('device-1a', 'profile-1', 'First A');
  insertDevice.run('device-1b', 'profile-1', 'First B');
  insertDevice.run('device-2a', 'profile-2', 'Second A');
  insertDevice.run('device-2b', 'profile-2', 'Second B');
  db.prepare(
    `INSERT INTO sync_operations(
       id, profile_id, device_id, operation_key, entity_type, entity_id,
       base_revision, payload_json, state, created_at, updated_at
     ) VALUES (?, ?, ?, ?, 'item', ?, 1, '{}', 'pending', 1, 1)`
  ).run('operation-1', 'profile-1', 'device-1a', 'operation:first', 'item-1a');

  const cases = [
    [
      'bookmarks.item_id',
      `INSERT INTO bookmarks(id, profile_id, item_id, created_at, updated_at, revision)
       VALUES ('cross-bookmark', 'profile-2', 'item-1a', 1, 1, 1)`,
    ],
    [
      'notes.item_id',
      `INSERT INTO notes(id, profile_id, item_id, body, created_at, updated_at, revision)
       VALUES ('cross-note', 'profile-2', 'item-1a', 'Body', 1, 1, 1)`,
    ],
    [
      'highlights.item_id',
      `INSERT INTO highlights(
         id, profile_id, item_id, quote, created_at, updated_at, revision
       ) VALUES ('cross-highlight', 'profile-2', 'item-1a', 'Quote', 1, 1, 1)`,
    ],
    [
      'item_tags.item_id',
      `INSERT INTO item_tags(
         id, profile_id, item_id, tag_id, created_at, updated_at, revision
       ) VALUES ('cross-item-tag-item', 'profile-2', 'item-1a', 'tag-2', 1, 1, 1)`,
    ],
    [
      'item_tags.tag_id',
      `INSERT INTO item_tags(
         id, profile_id, item_id, tag_id, created_at, updated_at, revision
       ) VALUES ('cross-item-tag-tag', 'profile-2', 'item-2a', 'tag-1', 1, 1, 1)`,
    ],
    [
      'connections.source_item_id',
      `INSERT INTO connections(
         id, profile_id, source_item_id, target_item_id, relation, created_at, updated_at, revision
       ) VALUES ('cross-connection-source', 'profile-2', 'item-1a', 'item-2b', 'related', 1, 1, 1)`,
    ],
    [
      'connections.target_item_id',
      `INSERT INTO connections(
         id, profile_id, source_item_id, target_item_id, relation, created_at, updated_at, revision
       ) VALUES ('cross-connection-target', 'profile-2', 'item-2a', 'item-1b', 'related', 1, 1, 1)`,
    ],
    [
      'reminders.item_id',
      `INSERT INTO reminders(
         id, profile_id, item_id, state, due_at, created_at, updated_at, revision
       ) VALUES ('cross-reminder', 'profile-2', 'item-1a', 'scheduled', 10, 1, 1, 1)`,
    ],
    [
      'reminder_deliveries.reminder_id',
      `INSERT INTO reminder_deliveries(
         id, profile_id, reminder_id, channel, state, created_at, updated_at, revision
       ) VALUES ('cross-delivery', 'profile-2', 'reminder-1', 'desktop', 'pending', 1, 1, 1)`,
    ],
    [
      'flashcards.item_id',
      `INSERT INTO flashcards(
         id, profile_id, item_id, prompt, answer, created_at, updated_at, revision
       ) VALUES ('cross-card', 'profile-2', 'item-1a', 'Prompt', 'Answer', 1, 1, 1)`,
    ],
    [
      'quiz_results.item_id',
      `INSERT INTO quiz_results(
         id, profile_id, item_id, quiz_kind, score, max_score, completed_at,
         created_at, updated_at, revision
       ) VALUES ('cross-quiz', 'profile-2', 'item-1a', 'recall', 1, 1, 1, 1, 1, 1)`,
    ],
    [
      'browser_sessions.credential_id',
      `INSERT INTO browser_sessions(
         id, profile_id, credential_id, origin, token_hash, csrf_hash, state, expires_at, created_at, updated_at
       ) VALUES (
         'cross-session', 'profile-2', 'credential-1', 'http://127.0.0.1:3210',
         'v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
         'v1:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
         'active', 10, 1, 1
       )`,
    ],
    [
      'sync_operations.device_id',
      `INSERT INTO sync_operations(
         id, profile_id, device_id, operation_key, entity_type, entity_id,
         base_revision, payload_json, state, created_at, updated_at
       ) VALUES (
         'cross-operation', 'profile-2', 'device-1a', 'operation:cross',
         'item', 'item-2a', 1, '{}', 'pending', 1, 1
       )`,
    ],
    [
      'sync_changes.operation_id',
      `INSERT INTO sync_changes(
         id, profile_id, operation_id, sequence, entity_type, entity_id,
         entity_revision, change_kind, created_at
       ) VALUES ('cross-change', 'profile-2', 'operation-1', 1, 'item', 'item-2a', 1, 'upsert', 1)`,
    ],
    [
      'sync_cursors.device_id',
      `INSERT INTO sync_cursors(
         id, profile_id, device_id, peer_device_id, created_at, updated_at
       ) VALUES ('cross-cursor-device', 'profile-2', 'device-1a', 'device-2b', 1, 1)`,
    ],
    [
      'sync_cursors.peer_device_id',
      `INSERT INTO sync_cursors(
         id, profile_id, device_id, peer_device_id, created_at, updated_at
       ) VALUES ('cross-cursor-peer', 'profile-2', 'device-2a', 'device-1b', 1, 1)`,
    ],
  ];

  for (const [label, sql] of cases) {
    await t.test(label, () => {
      assert.throws(() => db.exec(sql), /FOREIGN KEY constraint failed/i);
    });
  }
  db.close();
});

test('nullable owned sync references preserve their owner when the parent is deleted', async () => {
  const db = await migratedDatabase();
  db.exec(`
    INSERT INTO profiles(id, display_name, created_at, updated_at, revision)
    VALUES ('profile-delete', 'Owner', 1, 1, 1);
    INSERT INTO sync_devices(
      id, profile_id, name, platform, state, created_at, updated_at, revision
    ) VALUES ('device-delete', 'profile-delete', 'Device', 'browser', 'active', 1, 1, 1);
    INSERT INTO sync_operations(
      id, profile_id, device_id, operation_key, entity_type, entity_id,
      base_revision, payload_json, state, created_at, updated_at
    ) VALUES (
      'operation-delete', 'profile-delete', 'device-delete', 'delete-key',
      'item', 'item-delete', 0, '{}', 'pending', 1, 1
    );
    INSERT INTO sync_changes(
      id, profile_id, operation_id, sequence, entity_type, entity_id,
      entity_revision, change_kind, created_at
    ) VALUES (
      'change-delete', 'profile-delete', 'operation-delete', 1,
      'item', 'item-delete', 1, 'upsert', 1
    );
    DELETE FROM sync_devices WHERE id = 'device-delete';
  `);
  assert.deepEqual(
    db.prepare("SELECT profile_id, device_id FROM sync_operations WHERE id = 'operation-delete'").get(),
    { profile_id: 'profile-delete', device_id: null }
  );

  db.exec("DELETE FROM sync_operations WHERE id = 'operation-delete'");
  assert.deepEqual(db.prepare("SELECT profile_id, operation_id FROM sync_changes WHERE id = 'change-delete'").get(), {
    profile_id: 'profile-delete',
    operation_id: null,
  });
  db.close();
});

test('stable state checks accept documented states and reject unknown values', async t => {
  const { REMINDER_STATES } = await import('../../../packages/contracts/src/reminders.js');
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
    for (const [index, state] of REMINDER_STATES.entries()) {
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

test('credential digest checks require an exact versioned lowercase SHA-256 value', async () => {
  const db = await migratedDatabase();
  db.prepare('INSERT INTO profiles(id, display_name, created_at, updated_at, revision) VALUES (?, ?, ?, ?, ?)').run(
    'profile-digest',
    'Digest owner',
    1,
    1,
    1
  );
  try {
    assertConstraint(
      db,
      `INSERT INTO client_credentials(
         id, profile_id, kind, secret_digest, state, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'active', 1, 1)`,
      ['credential-invalid-digest', 'profile-digest', 'application_api', `v1:a${'Z'.repeat(63)}`]
    );
  } finally {
    db.close();
  }
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

test('partial unique indexes reject duplicate live rows and allow replacement after tombstone or resolution', async () => {
  const db = await migratedDatabase();
  db.prepare('INSERT INTO profiles(id, display_name, created_at, updated_at, revision) VALUES (?, ?, ?, ?, ?)').run(
    'profile-partial',
    'Owner',
    1,
    1,
    1
  );
  const insertItem = db.prepare(
    `INSERT INTO items(id, profile_id, kind, title, created_at, updated_at, revision)
     VALUES (?, 'profile-partial', 'article', ?, 1, 1, 1)`
  );
  insertItem.run('partial-item-1', 'First');
  insertItem.run('partial-item-2', 'Second');

  const assertLiveThenReplacement = ({ insertFirst, insertDuplicate, retireFirst, insertReplacement }) => {
    insertFirst();
    assert.throws(insertDuplicate, /UNIQUE constraint failed/i);
    retireFirst();
    assert.doesNotThrow(insertReplacement);
  };

  assertLiveThenReplacement({
    insertFirst: () =>
      db
        .prepare(
          `INSERT INTO bookmarks(id, profile_id, item_id, created_at, updated_at, revision)
           VALUES ('partial-bookmark-1', 'profile-partial', 'partial-item-1', 1, 1, 1)`
        )
        .run(),
    insertDuplicate: () =>
      db
        .prepare(
          `INSERT INTO bookmarks(id, profile_id, item_id, created_at, updated_at, revision)
           VALUES ('partial-bookmark-duplicate', 'profile-partial', 'partial-item-1', 1, 1, 1)`
        )
        .run(),
    retireFirst: () =>
      db
        .prepare(
          `UPDATE bookmarks SET deleted_at = 2, updated_at = 2, revision = 2
           WHERE id = 'partial-bookmark-1'`
        )
        .run(),
    insertReplacement: () =>
      db
        .prepare(
          `INSERT INTO bookmarks(id, profile_id, item_id, created_at, updated_at, revision)
           VALUES ('partial-bookmark-2', 'profile-partial', 'partial-item-1', 2, 2, 1)`
        )
        .run(),
  });

  assertLiveThenReplacement({
    insertFirst: () =>
      db
        .prepare(
          `INSERT INTO connections(
             id, profile_id, source_item_id, target_item_id, relation, created_at, updated_at, revision
           ) VALUES (
             'partial-connection-1', 'profile-partial', 'partial-item-1',
             'partial-item-2', 'related', 1, 1, 1
           )`
        )
        .run(),
    insertDuplicate: () =>
      db
        .prepare(
          `INSERT INTO connections(
             id, profile_id, source_item_id, target_item_id, relation, created_at, updated_at, revision
           ) VALUES (
             'partial-connection-duplicate', 'profile-partial', 'partial-item-1',
             'partial-item-2', 'related', 1, 1, 1
           )`
        )
        .run(),
    retireFirst: () =>
      db
        .prepare(
          `UPDATE connections SET deleted_at = 2, updated_at = 2, revision = 2
           WHERE id = 'partial-connection-1'`
        )
        .run(),
    insertReplacement: () =>
      db
        .prepare(
          `INSERT INTO connections(
             id, profile_id, source_item_id, target_item_id, relation, created_at, updated_at, revision
           ) VALUES (
             'partial-connection-2', 'profile-partial', 'partial-item-1',
             'partial-item-2', 'related', 2, 2, 1
           )`
        )
        .run(),
  });

  assertLiveThenReplacement({
    insertFirst: () =>
      db
        .prepare(
          `INSERT INTO tags(
             id, profile_id, name, normalized_name, created_at, updated_at, revision
           ) VALUES ('partial-tag-1', 'profile-partial', 'Topic', 'topic', 1, 1, 1)`
        )
        .run(),
    insertDuplicate: () =>
      db
        .prepare(
          `INSERT INTO tags(
             id, profile_id, name, normalized_name, created_at, updated_at, revision
           ) VALUES ('partial-tag-duplicate', 'profile-partial', 'Topic', 'topic', 1, 1, 1)`
        )
        .run(),
    retireFirst: () =>
      db
        .prepare(
          `UPDATE tags SET deleted_at = 2, updated_at = 2, revision = 2
           WHERE id = 'partial-tag-1'`
        )
        .run(),
    insertReplacement: () =>
      db
        .prepare(
          `INSERT INTO tags(
             id, profile_id, name, normalized_name, created_at, updated_at, revision
           ) VALUES ('partial-tag-2', 'profile-partial', 'Topic', 'topic', 2, 2, 1)`
        )
        .run(),
  });

  assertLiveThenReplacement({
    insertFirst: () =>
      db
        .prepare(
          `INSERT INTO item_tags(
             id, profile_id, item_id, tag_id, created_at, updated_at, revision
           ) VALUES (
             'partial-item-tag-1', 'profile-partial', 'partial-item-1', 'partial-tag-2', 1, 1, 1
           )`
        )
        .run(),
    insertDuplicate: () =>
      db
        .prepare(
          `INSERT INTO item_tags(
             id, profile_id, item_id, tag_id, created_at, updated_at, revision
           ) VALUES (
             'partial-item-tag-duplicate', 'profile-partial', 'partial-item-1', 'partial-tag-2', 1, 1, 1
           )`
        )
        .run(),
    retireFirst: () =>
      db
        .prepare(
          `UPDATE item_tags SET deleted_at = 2, updated_at = 2, revision = 2
           WHERE id = 'partial-item-tag-1'`
        )
        .run(),
    insertReplacement: () =>
      db
        .prepare(
          `INSERT INTO item_tags(
             id, profile_id, item_id, tag_id, created_at, updated_at, revision
           ) VALUES (
             'partial-item-tag-2', 'profile-partial', 'partial-item-1', 'partial-tag-2', 2, 2, 1
           )`
        )
        .run(),
  });

  assertLiveThenReplacement({
    insertFirst: () =>
      db
        .prepare(
          `INSERT INTO settings(
             id, profile_id, key, value_json, created_at, updated_at, revision
           ) VALUES ('partial-setting-1', 'profile-partial', 'theme', '{}', 1, 1, 1)`
        )
        .run(),
    insertDuplicate: () =>
      db
        .prepare(
          `INSERT INTO settings(
             id, profile_id, key, value_json, created_at, updated_at, revision
           ) VALUES ('partial-setting-duplicate', 'profile-partial', 'theme', '{}', 1, 1, 1)`
        )
        .run(),
    retireFirst: () =>
      db
        .prepare(
          `UPDATE settings SET deleted_at = 2, updated_at = 2, revision = 2
           WHERE id = 'partial-setting-1'`
        )
        .run(),
    insertReplacement: () =>
      db
        .prepare(
          `INSERT INTO settings(
             id, profile_id, key, value_json, created_at, updated_at, revision
           ) VALUES ('partial-setting-2', 'profile-partial', 'theme', '{}', 2, 2, 1)`
        )
        .run(),
  });

  assertLiveThenReplacement({
    insertFirst: () =>
      db
        .prepare(
          `INSERT INTO sync_conflicts(
             id, profile_id, entity_type, entity_id, local_revision, remote_revision,
             state, created_at, updated_at
           ) VALUES (
             'partial-conflict-1', 'profile-partial', 'item', 'partial-item-1',
             1, 2, 'open', 1, 1
           )`
        )
        .run(),
    insertDuplicate: () =>
      db
        .prepare(
          `INSERT INTO sync_conflicts(
             id, profile_id, entity_type, entity_id, local_revision, remote_revision,
             state, created_at, updated_at
           ) VALUES (
             'partial-conflict-duplicate', 'profile-partial', 'item', 'partial-item-1',
             1, 2, 'open', 1, 1
           )`
        )
        .run(),
    retireFirst: () =>
      db
        .prepare(
          `UPDATE sync_conflicts
           SET state = 'resolved_local', resolved_at = 2, updated_at = 2
           WHERE id = 'partial-conflict-1'`
        )
        .run(),
    insertReplacement: () =>
      db
        .prepare(
          `INSERT INTO sync_conflicts(
             id, profile_id, entity_type, entity_id, local_revision, remote_revision,
             state, created_at, updated_at
           ) VALUES (
             'partial-conflict-2', 'profile-partial', 'item', 'partial-item-1',
             2, 3, 'open', 2, 2
           )`
        )
        .run(),
  });

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
