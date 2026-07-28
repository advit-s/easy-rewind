'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { mkdirSync, mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const test = require('node:test');

const { discoverMigrations, runMigrations } = require('./migration-runner');
const { openDatabase } = require('./open-database');

const roots = new Set();
const stage3Tables = [
  'interactions',
  'memory_scores',
  'sync_device_sequences',
  'sync_acknowledgements',
  'sync_snapshots',
  'import_runs',
  'export_runs',
  'provider_configurations',
];

const expectedAdditiveColumns = {
  jobs: ['lease_token', 'lease_expires_at', 'heartbeat_at', 'idempotency_key'],
  sync_changes: ['tombstone_expires_at'],
  sync_conflicts: ['resolution_change_id'],
  sync_operations: ['operation_type', 'device_sequence', 'protocol_version', 'schema_version'],
};

const originalMigrationChecksums = {
  '001_core.sql': '6e1e26210b7ed0a208563004424fac939c0d929ee76ffdfd926f96d0c7b7a73f',
  '002_auth_and_devices.sql': '5a1ab333861e5f8a84bde1a76802872f9fcd2665f1a60eed2db2af85009f5826',
  '003_jobs_and_sync.sql': '5ea93ba525bd14a1f5864efc85ef2a69d1970e16a3e34e686c344e30741e2f53',
};

const filePermissions = {
  async restrictDirectory() {},
  async restrictFile() {},
};

async function migratedDatabase() {
  const root = mkdtempSync(join(tmpdir(), 'easy-rewind-stage3-schema-'));
  roots.add(root);
  const parent = join(root, 'database');
  mkdirSync(parent);
  const db = await openDatabase({ path: join(parent, 'stage3.sqlite3'), filePermissions });
  runMigrations({ db, migrations: discoverMigrations(), now: () => 1 });
  return db;
}

function columns(db, table) {
  return db
    .prepare(`PRAGMA table_info("${table}")`)
    .all()
    .map(column => column.name);
}

function indexNames(db, table) {
  return new Set(
    db
      .prepare(`PRAGMA index_list("${table}")`)
      .all()
      .map(index => index.name)
  );
}

test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

test('Stage 3 migration is additive and creates the frozen tables and columns', async () => {
  const migrations = discoverMigrations();
  assert.equal(migrations.at(-1).version, 4);
  assert.equal(migrations.at(-1).name, 'stage3');

  const db = await migratedDatabase();
  try {
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").pluck().all());
    for (const table of stage3Tables) assert.equal(tables.has(table), true, table);
    for (const [table, additions] of Object.entries(expectedAdditiveColumns)) {
      const actual = columns(db, table);
      for (const column of additions) assert.equal(actual.includes(column), true, `${table}.${column}`);
    }
  } finally {
    db.close();
  }
});

test('Stage 3 owner relationships reject cross-profile parents and cascade with their profile', async () => {
  const db = await migratedDatabase();
  try {
    db.exec(`
      INSERT INTO profiles(id, display_name, created_at, updated_at, revision)
      VALUES ('owner-a', 'A', 1, 1, 1), ('owner-b', 'B', 1, 1, 1);
      INSERT INTO items(id, profile_id, kind, title, created_at, updated_at, revision)
      VALUES ('item-a', 'owner-a', 'article', 'A', 1, 1, 1);
      INSERT INTO sync_devices(id, profile_id, name, platform, state, created_at, updated_at, revision)
      VALUES ('device-a', 'owner-a', 'A', 'android', 'active', 1, 1, 1);
    `);

    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO interactions(
               id, profile_id, item_id, kind, occurred_at, created_at, updated_at, revision
             ) VALUES ('interaction-cross', 'owner-b', 'item-a', 'view', 1, 1, 1, 1)`
          )
          .run(),
      /FOREIGN KEY constraint failed/i
    );
    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO sync_device_sequences(
               id, profile_id, device_id, last_sequence, created_at, updated_at
             ) VALUES ('sequence-cross', 'owner-b', 'device-a', 0, 1, 1)`
          )
          .run(),
      /FOREIGN KEY constraint failed/i
    );

    db.prepare(
      `INSERT INTO interactions(
         id, profile_id, item_id, kind, occurred_at, created_at, updated_at, revision
       ) VALUES ('interaction-a', 'owner-a', 'item-a', 'view', 1, 1, 1, 1)`
    ).run();
    db.prepare("DELETE FROM profiles WHERE id = 'owner-a'").run();
    assert.equal(db.prepare("SELECT count(*) FROM interactions WHERE id = 'interaction-a'").pluck().get(), 0);
  } finally {
    db.close();
  }
});

test('reminder deliveries require an owner-matched target device and deduplicate each device channel', async () => {
  const db = await migratedDatabase();
  try {
    const deviceColumn = db
      .prepare('PRAGMA table_info(reminder_deliveries)')
      .all()
      .find(column => column.name === 'device_id');
    assert.deepEqual({ type: deviceColumn?.type, notnull: deviceColumn?.notnull }, { type: 'TEXT', notnull: 1 });

    db.exec(`
      INSERT INTO profiles(id, display_name, created_at, updated_at, revision)
      VALUES ('delivery-owner-a', 'A', 1, 1, 1), ('delivery-owner-b', 'B', 1, 1, 1);
      INSERT INTO sync_devices(id, profile_id, name, platform, state, created_at, updated_at, revision)
      VALUES
        ('delivery-device-a', 'delivery-owner-a', 'A', 'windows', 'active', 1, 1, 1),
        ('delivery-device-b', 'delivery-owner-b', 'B', 'android', 'active', 1, 1, 1);
      INSERT INTO reminders(
        id, profile_id, state, due_at, created_at, updated_at, revision
      ) VALUES ('delivery-reminder-a', 'delivery-owner-a', 'scheduled', 10, 1, 1, 1);
    `);

    const insertDelivery = db.prepare(
      `INSERT INTO reminder_deliveries(
         id, profile_id, reminder_id, device_id, channel, state,
         created_at, updated_at, revision
       ) VALUES (?, 'delivery-owner-a', 'delivery-reminder-a', ?, 'desktop', 'pending', 1, 1, 1)`
    );
    assert.throws(
      () => insertDelivery.run('delivery-cross-owner', 'delivery-device-b'),
      /FOREIGN KEY constraint failed/i
    );
    insertDelivery.run('delivery-first', 'delivery-device-a');
    assert.throws(() => insertDelivery.run('delivery-duplicate', 'delivery-device-a'), /UNIQUE constraint failed/i);

    const indexes = Object.fromEntries(
      db
        .prepare('PRAGMA index_list(reminder_deliveries)')
        .all()
        .map(index => [
          index.name,
          db
            .prepare(`PRAGMA index_info("${index.name}")`)
            .all()
            .map(column => column.name),
        ])
    );
    assert.deepEqual(indexes.uq_reminder_deliveries_device_channel, [
      'profile_id',
      'reminder_id',
      'device_id',
      'channel',
    ]);
    assert.deepEqual(indexes.idx_reminder_deliveries_device_pending, [
      'profile_id',
      'device_id',
      'state',
      'scheduled_at',
      'attempt_count',
      'id',
    ]);
  } finally {
    db.close();
  }
});

test('Stage 3 constraints enforce job and sync idempotency, sequencing, versions, retention, and resolutions', async () => {
  const db = await migratedDatabase();
  try {
    db.exec(`
      INSERT INTO profiles(id, display_name, created_at, updated_at, revision)
      VALUES ('owner', 'Owner', 1, 1, 1);
      INSERT INTO sync_devices(id, profile_id, name, platform, state, created_at, updated_at, revision)
      VALUES ('device', 'owner', 'Device', 'android', 'active', 1, 1, 1);
    `);

    const insertJob = db.prepare(
      `INSERT INTO jobs(
         id, profile_id, kind, state, idempotency_key, created_at, updated_at
       ) VALUES (?, 'owner', 'digest', 'queued', 'same-job', 1, 1)`
    );
    insertJob.run('job-one');
    assert.throws(() => insertJob.run('job-two'), /UNIQUE constraint failed/i);

    const insertOperation = db.prepare(
      `INSERT INTO sync_operations(
         id, profile_id, device_id, operation_key, entity_type, entity_id,
         base_revision, payload_json, state, operation_type, device_sequence,
         protocol_version, schema_version, created_at, updated_at
       ) VALUES (
         ?, 'owner', 'device', ?, 'item', 'entity', 0, '{}', 'pending',
         'upsert', ?, 1, 4, 1, 1
       )`
    );
    insertOperation.run('operation-one', 'key-one', 1);
    assert.throws(() => insertOperation.run('operation-two', 'key-two', 1), /UNIQUE constraint failed/i);
    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO sync_operations(
               id, profile_id, operation_key, entity_type, entity_id, base_revision,
               payload_json, state, operation_type, protocol_version, schema_version,
               created_at, updated_at
             ) VALUES (
               'bad-version', 'owner', 'bad-version', 'item', 'entity', 0, '{}',
               'pending', 'upsert', 0, 4, 1, 1
             )`
          )
          .run(),
      /CHECK constraint failed/i
    );
    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO sync_changes(
               id, profile_id, sequence, entity_type, entity_id, entity_revision,
               change_kind, tombstone_expires_at, created_at
             ) VALUES ('bad-retention', 'owner', 1, 'item', 'entity', 1, 'delete', -1, 1)`
          )
          .run(),
      /CHECK constraint failed/i
    );
  } finally {
    db.close();
  }
});

test('Stage 3 query and uniqueness indexes cover every planned owner-scoped access path', async () => {
  const db = await migratedDatabase();
  try {
    const requiredIndexes = {
      export_runs: ['idx_export_runs_profile_state'],
      import_runs: ['idx_import_runs_profile_state'],
      interactions: ['idx_interactions_profile_item', 'idx_interactions_profile_occurred'],
      jobs: ['idx_jobs_profile_lease', 'uq_jobs_profile_idempotency'],
      memory_scores: ['idx_memory_scores_profile_score', 'uq_memory_scores_live_item'],
      provider_configurations: [
        'idx_provider_configurations_profile_state',
        'uq_provider_configurations_live_provider',
      ],
      sync_acknowledgements: ['idx_sync_acknowledgements_profile_device', 'uq_sync_acknowledgements_operation'],
      sync_device_sequences: ['uq_sync_device_sequences_device'],
      sync_operations: ['uq_sync_operations_device_sequence'],
      sync_snapshots: ['idx_sync_snapshots_profile_device'],
    };

    for (const [table, names] of Object.entries(requiredIndexes)) {
      const actual = indexNames(db, table);
      for (const name of names) assert.equal(actual.has(name), true, name);
    }
  } finally {
    db.close();
  }
});

test('Stage 3 leaves the released migration bytes unchanged', () => {
  const migrationRoot = join(__dirname, 'migrations');
  for (const [name, expected] of Object.entries(originalMigrationChecksums)) {
    const actual = createHash('sha256')
      .update(readFileSync(join(migrationRoot, name)))
      .digest('hex');
    assert.equal(actual, expected, name);
  }
});
