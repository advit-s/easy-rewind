import assert from 'node:assert/strict';
import test from 'node:test';

import Database from 'better-sqlite3';

import { applyMobileMigrations } from '../src/db/migrations.ts';
import { createMobileRepository } from '../src/db/repository.ts';
import { createContentService } from '../src/domain/content-service.ts';
import { createFlashcardService } from '../src/domain/flashcard-service.ts';
import { createReminderService } from '../src/domain/reminder-service.ts';

function createFixture({
  profileId = 'profile-a',
  deviceId = 'android-a',
  pairedPcId = 'pc-a',
  now = 1_800_000_000_000,
} = {}) {
  const database = new Database(':memory:');
  database.pragma('foreign_keys = ON');
  applyMobileMigrations({ database, now: () => now });

  let clock = now;
  let idSequence = 0;
  const repository = createMobileRepository({
    database,
    profileId,
    deviceId,
    displayName: 'Android',
    pairedPcId,
    now: () => clock,
    generateId: prefix => `${prefix}-${++idSequence}`,
  });

  return {
    database,
    repository,
    content: createContentService({ repository }),
    reminders: createReminderService({ repository }),
    flashcards: createFlashcardService({ repository }),
    advance(milliseconds = 1) {
      clock += milliseconds;
    },
    close() {
      database.close();
    },
  };
}

function outboxRows(database, profileId = 'profile-a') {
  return database
    .prepare(
      `SELECT id, device_sequence, entity_type, entity_id, operation, payload_json, state, revision
       FROM outbox
       WHERE profile_id = ?
       ORDER BY device_sequence`
    )
    .all(profileId);
}

test('content mutations work offline and append stable monotonic outbox operations atomically', t => {
  const fixture = createFixture();
  t.after(() => fixture.close());

  const created = fixture.content.create({
    title: 'Local-first systems',
    summary: 'Works without a network',
    content: 'Queued locally.',
    url: 'https://example.test/local-first',
  });
  fixture.advance();
  const edited = fixture.content.edit(created.id, {
    title: 'Local-first systems, revised',
  });
  fixture.advance();
  const removed = fixture.content.delete(created.id);

  assert.equal(created.syncState, 'queued');
  assert.equal(created.revision, 0);
  assert.equal(edited.revision, 0, 'the client must not allocate a PC revision');
  assert.equal(edited.syncState, 'queued');
  assert.equal(removed.syncState, 'queued');
  assert.equal(fixture.content.get(created.id), null);
  assert.deepEqual(
    outboxRows(fixture.database).map(row => ({
      id: row.id,
      sequence: row.device_sequence,
      type: row.entity_type,
      entityId: row.entity_id,
      operation: row.operation,
      revision: row.revision,
    })),
    [
      {
        id: 'operation:android-a:1',
        sequence: 1,
        type: 'item',
        entityId: created.id,
        operation: 'upsert',
        revision: 0,
      },
      {
        id: 'operation:android-a:2',
        sequence: 2,
        type: 'item',
        entityId: created.id,
        operation: 'upsert',
        revision: 0,
      },
      {
        id: 'operation:android-a:3',
        sequence: 3,
        type: 'item',
        entityId: created.id,
        operation: 'delete',
        revision: 0,
      },
    ]
  );

  const tombstone = fixture.database
    .prepare(
      `SELECT entity_type, entity_id, revision, deleted_at
       FROM tombstones
       WHERE profile_id = ? AND entity_type = ? AND entity_id = ?`
    )
    .get('profile-a', 'item', created.id);
  assert.deepEqual(tombstone, {
    entity_type: 'item',
    entity_id: created.id,
    revision: 0,
    deleted_at: 1_800_000_000_002,
  });
});

test('content search is owner scoped and reports local-only state before pairing', t => {
  const local = createFixture({ pairedPcId: null });
  t.after(() => local.close());

  const privateItem = local.content.create({
    title: 'Private offline note',
    content: 'alpha',
  });

  const otherRepository = createMobileRepository({
    database: local.database,
    profileId: 'profile-b',
    deviceId: 'android-b',
    displayName: 'Other Android',
    pairedPcId: 'pc-b',
    now: () => 1_800_000_000_100,
    generateId: prefix => `other-${prefix}`,
  });
  const otherContent = createContentService({ repository: otherRepository });
  otherContent.create({ title: 'Other owner private note', content: 'alpha' });

  assert.equal(privateItem.syncState, 'local_only');
  assert.deepEqual(
    local.content.search('private').map(item => item.title),
    ['Private offline note']
  );
  assert.equal(local.content.search('does-not-exist').length, 0);
});

test('reminders create, edit, search, and delete locally without allocating revisions', t => {
  const fixture = createFixture();
  t.after(() => fixture.close());

  const created = fixture.reminders.create({
    title: 'Review queues',
    body: 'On Android',
    dueAt: 1_800_000_100_000,
  });
  fixture.advance();
  const edited = fixture.reminders.edit(created.id, {
    state: 'completed',
    body: 'Completed offline',
  });

  assert.equal(created.state, 'scheduled');
  assert.equal(edited.state, 'completed');
  assert.equal(edited.revision, 0);
  assert.deepEqual(
    fixture.reminders.search('completed').map(reminder => reminder.id),
    [created.id]
  );

  fixture.advance();
  fixture.reminders.delete(created.id);
  assert.equal(fixture.reminders.get(created.id), null);
  assert.deepEqual(
    outboxRows(fixture.database).map(row => [row.device_sequence, row.entity_type, row.operation]),
    [
      [1, 'reminder', 'upsert'],
      [2, 'reminder', 'upsert'],
      [3, 'reminder', 'delete'],
    ]
  );
});

test('flashcards create, edit, search, and delete locally with queued state', t => {
  const fixture = createFixture();
  t.after(() => fixture.close());

  const created = fixture.flashcards.create({
    front: 'What is an outbox?',
    back: 'A transactional queue.',
    dueAt: 1_800_000_200_000,
  });
  fixture.advance();
  const edited = fixture.flashcards.edit(created.id, {
    back: 'A durable transactional queue.',
    intervalDays: 3,
    reviewCount: 1,
  });

  assert.equal(created.syncState, 'queued');
  assert.equal(edited.revision, 0);
  assert.equal(edited.intervalDays, 3);
  assert.deepEqual(
    fixture.flashcards.search('durable').map(card => card.id),
    [created.id]
  );

  fixture.advance();
  fixture.flashcards.delete(created.id);
  assert.equal(fixture.flashcards.get(created.id), null);
  assert.deepEqual(
    outboxRows(fixture.database).map(row => [row.device_sequence, row.entity_type, row.operation]),
    [
      [1, 'flashcard', 'upsert'],
      [2, 'flashcard', 'upsert'],
      [3, 'flashcard', 'delete'],
    ]
  );
});

test('entity state reflects synchronized, conflicted, and failed outbox conditions', t => {
  const fixture = createFixture();
  t.after(() => fixture.close());
  const item = fixture.content.create({ title: 'State transitions' });
  const operation = outboxRows(fixture.database)[0];

  fixture.database
    .prepare(`UPDATE outbox SET state = 'acknowledged' WHERE profile_id = ? AND id = ?`)
    .run('profile-a', operation.id);
  assert.equal(fixture.content.get(item.id)?.syncState, 'synchronized');

  fixture.database
    .prepare(
      `INSERT INTO conflicts(
        id, profile_id, revision, created_at, updated_at,
        entity_type, entity_id, local_payload_json, remote_payload_json,
        base_revision, remote_revision, state, resolved_at
      ) VALUES (?, ?, 0, ?, ?, ?, ?, '{}', '{}', 0, 1, 'unresolved', NULL)`
    )
    .run('conflict-1', 'profile-a', 1_800_000_000_001, 1_800_000_000_001, 'item', item.id);
  assert.equal(fixture.content.get(item.id)?.syncState, 'conflicted');

  fixture.database.prepare(`DELETE FROM conflicts WHERE id = ?`).run('conflict-1');
  fixture.database
    .prepare(`UPDATE outbox SET state = 'failed' WHERE profile_id = ? AND id = ?`)
    .run('profile-a', operation.id);
  assert.equal(fixture.content.get(item.id)?.syncState, 'failed');
});

test('an outbox failure rolls back the entity write and device sequence together', t => {
  const fixture = createFixture();
  t.after(() => fixture.close());

  fixture.database.exec(`
    CREATE TRIGGER reject_outbox
    BEFORE INSERT ON outbox
    BEGIN
      SELECT RAISE(ABORT, 'simulated outbox failure');
    END
  `);

  assert.throws(
    () => fixture.content.create({ id: 'must-not-commit', title: 'Atomic write' }),
    /offline mutation failed/i
  );
  assert.equal(fixture.database.prepare(`SELECT COUNT(*) FROM items WHERE profile_id = ?`).pluck().get('profile-a'), 0);
  assert.equal(
    fixture.database
      .prepare(`SELECT COUNT(*) FROM device_metadata WHERE profile_id = ? AND device_id = ?`)
      .pluck()
      .get('profile-a', 'android-a'),
    0
  );
  assert.equal(fixture.database.prepare(`SELECT COUNT(*) FROM outbox`).pluck().get(), 0);
});
