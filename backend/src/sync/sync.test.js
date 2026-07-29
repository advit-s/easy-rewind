'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const BetterSqlite3 = require('better-sqlite3');

const { discoverMigrations, runMigrations } = require('../database/migration-runner');
const { createConflictService } = require('./conflict-service');
const { createEntityRegistry } = require('./entity-registry');
const { createSnapshotService } = require('./snapshot-service');
const { createSyncRepository } = require('./sync-repository');
const { createSyncService } = require('./sync-service');

const PROFILE = '00000000-0000-4000-8000-000000000001';
const DEVICE = '00000000-0000-4000-8000-000000000002';
const OTHER_DEVICE = '00000000-0000-4000-8000-000000000003';
const ITEM = '00000000-0000-4000-8000-000000000004';
const SECOND_ITEM = '00000000-0000-4000-8000-000000000005';

function fixture({ now = 1_800_000_000_000, tombstoneRetentionMs = 10_000 } = {}) {
  const db = new BetterSqlite3(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations({ db, migrations: discoverMigrations(), now: () => 1 });
  db.exec(`
    INSERT INTO profiles(id, display_name, created_at, updated_at, revision)
    VALUES ('${PROFILE}', 'Owner', 1, 1, 1);
    INSERT INTO sync_devices(id, profile_id, name, platform, state, created_at, updated_at, revision)
    VALUES
      ('${DEVICE}', '${PROFILE}', 'Phone', 'android', 'active', 1, 1, 1),
      ('${OTHER_DEVICE}', '${PROFILE}', 'Tablet', 'android', 'active', 1, 1, 1);
    CREATE TABLE synchronized_test_entities (
      profile_id TEXT NOT NULL,
      id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      deleted INTEGER NOT NULL DEFAULT 0,
      payload_json TEXT NOT NULL,
      PRIMARY KEY(profile_id, id)
    );
  `);

  let id = 10;
  let clock = now;
  const ids = () => `00000000-0000-4000-8000-${String(id++).padStart(12, '0')}`;
  const entityRegistry = createEntityRegistry({
    adapters: {
      item: {
        get({ profileId, entityId }) {
          const row = db
            .prepare(
              `SELECT revision, deleted, payload_json
               FROM synchronized_test_entities
               WHERE profile_id = ? AND id = ?`
            )
            .get(profileId, entityId);
          return row
            ? { revision: row.revision, deleted: row.deleted === 1, payload: JSON.parse(row.payload_json) }
            : null;
        },
        apply({ profileId, entityId, kind, revision, payload }) {
          db.prepare(
            `INSERT INTO synchronized_test_entities(profile_id, id, revision, deleted, payload_json)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(profile_id, id) DO UPDATE SET
               revision = excluded.revision,
               deleted = excluded.deleted,
               payload_json = excluded.payload_json`
          ).run(profileId, entityId, revision, kind === 'delete' ? 1 : 0, JSON.stringify(payload));
          return { revision, deleted: kind === 'delete', payload };
        },
        snapshot({ profileId }) {
          return db
            .prepare(
              `SELECT id, revision, deleted, payload_json
               FROM synchronized_test_entities WHERE profile_id = ? ORDER BY id`
            )
            .all(profileId)
            .map(row => ({
              entityId: row.id,
              revision: row.revision,
              kind: row.deleted ? 'delete' : 'upsert',
              payload: JSON.parse(row.payload_json),
            }));
        },
      },
    },
  });
  const repository = createSyncRepository({ db, ids, now: () => clock });
  const conflicts = createConflictService({ db, repository, entityRegistry, ids, now: () => clock });
  const snapshots = createSnapshotService({
    db,
    repository,
    entityRegistry,
    ids,
    now: () => clock,
    lifetimeMs: 60_000,
  });
  const service = createSyncService({
    db,
    entityRegistry,
    repository,
    conflicts,
    snapshots,
    now: () => clock,
    supportedSchemaVersions: [4],
    tombstoneRetentionMs,
  });

  return {
    db,
    service,
    repository,
    conflicts,
    snapshots,
    advance(milliseconds) {
      clock += milliseconds;
    },
    close() {
      db.close();
    },
  };
}

function operation(overrides = {}) {
  return {
    operationId: '10000000-0000-4000-8000-000000000001',
    deviceId: DEVICE,
    entityType: 'item',
    entityId: ITEM,
    kind: 'upsert',
    baseRevision: 0,
    deviceSequence: 1,
    schemaVersion: 4,
    protocolVersion: '1',
    payload: { title: 'Offline edit' },
    occurredAt: 1,
    ...overrides,
  };
}

test('push assigns PC revisions and sequences, persists acknowledgements, and replays idempotently', t => {
  const context = fixture();
  t.after(() => context.close());

  const first = context.service.push({
    context: { profileId: PROFILE, deviceId: DEVICE, authenticationType: 'sync_device' },
    request: { deviceId: DEVICE, operations: [operation()] },
  });
  assert.deepEqual(first.results, [
    {
      operationId: operation().operationId,
      status: 'accepted',
      revision: 1,
    },
  ]);
  assert.equal(first.serverTime, 1_800_000_000_000);

  const replay = context.service.push({
    context: { profileId: PROFILE, deviceId: DEVICE, authenticationType: 'sync_device' },
    request: { deviceId: DEVICE, operations: [operation()] },
  });
  assert.deepEqual(replay.results, [
    {
      operationId: operation().operationId,
      status: 'duplicate',
      revision: 1,
    },
  ]);
  assert.equal(context.db.prepare('SELECT count(*) FROM sync_operations').pluck().get(), 1);
  assert.equal(context.db.prepare('SELECT count(*) FROM sync_changes').pluck().get(), 1);
  assert.equal(context.db.prepare('SELECT count(*) FROM sync_acknowledgements').pluck().get(), 1);
});

test('push requires exact protocol/schema negotiation and strictly monotonic device sequences', t => {
  const context = fixture();
  t.after(() => context.close());
  const invoke = operations =>
    context.service.push({
      context: { profileId: PROFILE, deviceId: DEVICE, authenticationType: 'sync_device' },
      request: { deviceId: DEVICE, operations },
    });

  assert.throws(() => invoke([operation({ protocolVersion: '2' })]), { code: 'SYNC_PROTOCOL_UNSUPPORTED' });
  assert.throws(() => invoke([operation({ schemaVersion: 3 })]), { code: 'SYNC_SCHEMA_UNSUPPORTED' });
  assert.throws(() => invoke([operation({ deviceSequence: 2 })]), { code: 'SYNC_SEQUENCE_INVALID' });
  assert.equal(context.db.prepare('SELECT count(*) FROM sync_operations').pluck().get(), 0);

  invoke([operation()]);
  assert.throws(
    () =>
      invoke([
        operation({
          operationId: '10000000-0000-4000-8000-000000000002',
          entityId: SECOND_ITEM,
          deviceSequence: 3,
        }),
      ]),
    { code: 'SYNC_SEQUENCE_INVALID' }
  );
});

test('a rejected operation rolls back the entire push batch including entity changes', t => {
  const context = fixture();
  t.after(() => context.close());
  assert.throws(
    () =>
      context.service.push({
        context: { profileId: PROFILE, deviceId: DEVICE, authenticationType: 'sync_device' },
        request: {
          deviceId: DEVICE,
          operations: [
            operation(),
            operation({
              operationId: '10000000-0000-4000-8000-000000000002',
              entityId: SECOND_ITEM,
              deviceSequence: 3,
            }),
          ],
        },
      }),
    { code: 'SYNC_SEQUENCE_INVALID' }
  );
  assert.equal(context.db.prepare('SELECT count(*) FROM synchronized_test_entities').pluck().get(), 0);
  assert.equal(context.db.prepare('SELECT count(*) FROM sync_operations').pluck().get(), 0);
});

test('owner and authenticated device scope are immutable and revoked devices cannot sync', t => {
  const context = fixture();
  t.after(() => context.close());
  assert.throws(
    () =>
      context.service.push({
        context: { profileId: PROFILE, deviceId: OTHER_DEVICE, authenticationType: 'sync_device' },
        request: { deviceId: DEVICE, operations: [operation()] },
      }),
    { code: 'SYNC_DEVICE_FORBIDDEN' }
  );
  context.db.prepare("UPDATE sync_devices SET state = 'revoked' WHERE id = ?").run(DEVICE);
  assert.throws(
    () =>
      context.service.pull({
        context: { profileId: PROFILE, deviceId: DEVICE, authenticationType: 'sync_device' },
        request: { deviceId: DEVICE, limit: 10 },
      }),
    { code: 'AUTH_DEVICE_REVOKED' }
  );
});

test('stale revisions preserve both variants and each resolution creates a new normal change', t => {
  const context = fixture();
  t.after(() => context.close());
  const auth = { profileId: PROFILE, deviceId: DEVICE, authenticationType: 'sync_device' };
  context.service.push({ context: auth, request: { deviceId: DEVICE, operations: [operation()] } });

  const conflictResponse = context.service.push({
    context: auth,
    request: {
      deviceId: DEVICE,
      operations: [
        operation({
          operationId: '10000000-0000-4000-8000-000000000002',
          deviceSequence: 2,
          baseRevision: 0,
          payload: { title: 'Concurrent phone value' },
        }),
      ],
    },
  });
  assert.equal(conflictResponse.results[0].status, 'conflict');
  assert.equal(conflictResponse.results[0].revision, 1);
  const conflictId = conflictResponse.results[0].conflictId;
  const conflictReplay = context.service.push({
    context: auth,
    request: {
      deviceId: DEVICE,
      operations: [
        operation({
          operationId: '10000000-0000-4000-8000-000000000002',
          deviceSequence: 2,
          baseRevision: 0,
          payload: { title: 'Concurrent phone value' },
        }),
      ],
    },
  });
  assert.deepEqual(conflictReplay.results, conflictResponse.results);
  assert.equal(context.db.prepare('SELECT count(*) FROM sync_conflicts').pluck().get(), 1);

  for (const [resolution, mergedPayload] of [
    ['server', undefined],
    ['client', undefined],
    ['merged', { title: 'Owner merge' }],
  ]) {
    const independent = fixture();
    t.after(() => independent.close());
    independent.service.push({
      context: auth,
      request: { deviceId: DEVICE, operations: [operation()] },
    });
    const response = independent.service.push({
      context: auth,
      request: {
        deviceId: DEVICE,
        operations: [
          operation({
            operationId: '10000000-0000-4000-8000-000000000002',
            deviceSequence: 2,
            baseRevision: 0,
            payload: { title: 'Client' },
          }),
        ],
      },
    });
    const resolved = independent.service.resolveConflict({
      profileId: PROFILE,
      conflictId: response.results[0].conflictId,
      resolution,
      mergedPayload,
    });
    assert.equal(resolved.revision, 2);
    assert.equal(resolved.changeSequence, 2);
    assert.equal(
      independent.db
        .prepare('SELECT state FROM sync_conflicts WHERE id = ?')
        .pluck()
        .get(response.results[0].conflictId),
      `resolved_${resolution === 'server' ? 'local' : resolution === 'client' ? 'remote' : 'merged'}`
    );
  }

  assert.equal(typeof conflictId, 'string');
});

test('pull uses stable opaque cursors, advances on empty pages, and records acknowledgements', t => {
  const context = fixture();
  t.after(() => context.close());
  const auth = { profileId: PROFILE, deviceId: DEVICE, authenticationType: 'sync_device' };
  context.service.push({
    context: auth,
    request: {
      deviceId: DEVICE,
      operations: [
        operation(),
        operation({
          operationId: '10000000-0000-4000-8000-000000000002',
          entityId: SECOND_ITEM,
          deviceSequence: 2,
        }),
      ],
    },
  });

  const first = context.service.pull({
    context: auth,
    request: { deviceId: DEVICE, limit: 1 },
  });
  assert.equal(first.changes.length, 1);
  assert.equal(first.hasMore, true);
  assert.match(first.nextCursor, /^[A-Za-z0-9_-]+$/);
  const second = context.service.pull({
    context: auth,
    request: { deviceId: DEVICE, cursor: first.nextCursor, limit: 1 },
  });
  assert.equal(second.changes.length, 1);
  assert.equal(second.hasMore, false);
  assert.equal(second.nextCursor, null);

  const empty = context.service.pull({
    context: auth,
    request: { deviceId: DEVICE, cursor: context.repository.encodeCursor(2), limit: 10 },
  });
  assert.deepEqual(empty.changes, []);
  assert.equal(empty.hasMore, false);
  assert.equal(empty.nextCursor, null);
  assert.equal(
    context.db
      .prepare('SELECT last_sequence FROM sync_cursors WHERE profile_id = ? AND device_id = ?')
      .pluck()
      .get(PROFILE, DEVICE),
    2
  );
});

test('delete changes are tombstones and expired retained history requires snapshot fallback', t => {
  const context = fixture({ tombstoneRetentionMs: 5 });
  t.after(() => context.close());
  const auth = { profileId: PROFILE, deviceId: DEVICE, authenticationType: 'sync_device' };
  context.service.push({ context: auth, request: { deviceId: DEVICE, operations: [operation()] } });
  context.service.push({
    context: auth,
    request: {
      deviceId: DEVICE,
      operations: [
        operation({
          operationId: '10000000-0000-4000-8000-000000000002',
          kind: 'delete',
          payload: {},
          baseRevision: 1,
          deviceSequence: 2,
        }),
      ],
    },
  });
  const pulled = context.service.pull({ context: auth, request: { deviceId: DEVICE, limit: 10 } });
  assert.deepEqual(pulled.changes[1].payload, {});
  assert.equal(pulled.changes[1].kind, 'delete');

  context.advance(6);
  context.service.pruneRetainedHistory({ profileId: PROFILE });
  assert.throws(
    () =>
      context.service.pull({
        context: auth,
        request: { deviceId: DEVICE, cursor: context.repository.encodeCursor(1), limit: 10 },
      }),
    { code: 'CURSOR_EXPIRED' }
  );
  const snapshot = context.service.createSnapshot({ profileId: PROFILE, deviceId: DEVICE });
  assert.equal(snapshot.baseSequence, 2);
  assert.equal(snapshot.entities[0].kind, 'delete');
  assert.match(snapshot.checksum, /^[a-f0-9]{64}$/);
});

test('sync rejects oversized batches, forbidden provider credentials, and unsupported entities before writes', t => {
  const context = fixture();
  t.after(() => context.close());
  const auth = { profileId: PROFILE, deviceId: DEVICE, authenticationType: 'sync_device' };
  const operations = Array.from({ length: 101 }, (_, index) =>
    operation({
      operationId: `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      entityId: `20000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      deviceSequence: index + 1,
    })
  );
  assert.throws(() => context.service.push({ context: auth, request: { deviceId: DEVICE, operations } }), {
    code: 'SYNC_BATCH_INVALID',
  });
  assert.throws(
    () =>
      context.service.push({
        context: auth,
        request: {
          deviceId: DEVICE,
          operations: [operation({ payload: { provider: { apiKey: 'never-store-this' } } })],
        },
      }),
    { code: 'SYNC_PAYLOAD_INVALID' }
  );
  assert.throws(
    () =>
      context.service.push({
        context: auth,
        request: { deviceId: DEVICE, operations: [operation({ entityType: 'provider_configuration' })] },
      }),
    { code: 'SYNC_ENTITY_UNSUPPORTED' }
  );
  assert.equal(context.db.prepare('SELECT count(*) FROM sync_operations').pluck().get(), 0);
});
