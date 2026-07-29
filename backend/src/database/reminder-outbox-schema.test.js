'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const BetterSqlite3 = require('better-sqlite3');
const { discoverMigrations, runMigrations } = require('./migration-runner');

test('notification outbox migration adds a constrained acknowledgement timestamp and lookup index', () => {
  const migrations = discoverMigrations();
  assert.equal(migrations.at(-1).version, 5);
  assert.equal(migrations.at(-1).name, 'reminder_outbox');

  const db = new BetterSqlite3(':memory:');
  test.after(() => db.close());
  const result = runMigrations({ db, migrations, now: () => 1 });

  assert.equal(result.currentVersion, 5);
  const acknowledgement = db
    .prepare('PRAGMA table_info(reminder_deliveries)')
    .all()
    .find(column => column.name === 'acknowledged_at');
  assert.deepEqual(
    {
      defaultValue: acknowledgement?.dflt_value,
      notnull: acknowledgement?.notnull,
      type: acknowledgement?.type,
    },
    { defaultValue: null, notnull: 0, type: 'INTEGER' }
  );
  assert.equal(
    db
      .prepare('PRAGMA index_list(reminder_deliveries)')
      .all()
      .some(index => index.name === 'idx_reminder_deliveries_device_outbox'),
    true
  );

  db.exec(`
    INSERT INTO profiles(id, display_name, created_at, updated_at)
    VALUES ('profile-one', 'One', 1, 1);
    INSERT INTO sync_devices(id, profile_id, name, platform, state, created_at, updated_at)
    VALUES ('device-one', 'profile-one', 'PC', 'windows', 'active', 1, 1);
    INSERT INTO reminders(id, profile_id, state, due_at, created_at, updated_at)
    VALUES ('reminder-one', 'profile-one', 'scheduled', 1, 1, 1);
    INSERT INTO reminder_deliveries(
      id, profile_id, reminder_id, device_id, channel, state, acknowledged_at,
      created_at, updated_at
    ) VALUES (
      'delivery-one', 'profile-one', 'reminder-one', 'device-one', 'desktop',
      'delivered', 1, 1, 1
    );
  `);
  assert.throws(
    () => db.prepare("UPDATE reminder_deliveries SET acknowledged_at = -1 WHERE id = 'delivery-one'").run(),
    /CHECK constraint failed/i
  );
});
