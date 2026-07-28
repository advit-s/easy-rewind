'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const Database = require('better-sqlite3');

const { runMigrations } = require('../../database/migration-runner');
const { createRepositoryUtils } = require('../repository-utils');
const { createContentRepository } = require('./content-repository');
const { createContentService } = require('./content-service');

const OWNER = '10000000-0000-4000-8000-000000000001';
const OTHER_OWNER = '10000000-0000-4000-8000-000000000002';

function fixture() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations({ db, now: () => 1 });
  db.prepare(
    `INSERT INTO profiles(id, display_name, created_at, updated_at, revision)
     VALUES (?, ?, 1, 1, 1)`
  ).run(OWNER, 'Owner');
  db.prepare(
    `INSERT INTO profiles(id, display_name, created_at, updated_at, revision)
     VALUES (?, ?, 1, 1, 1)`
  ).run(OTHER_OWNER, 'Other');
  let sequence = 0;
  let clock = 1_700_000_000_000;
  const repositoryUtils = createRepositoryUtils({
    db,
    ids: () => `generated-${++sequence}`,
    now: () => ++clock,
  });
  const repository = createContentRepository({ db, repositoryUtils });
  const changes = [];
  const syncRecorder = {
    recordChange(change) {
      assert.equal(db.inTransaction, true, 'sync change must be recorded inside the mutation transaction');
      changes.push(change);
    },
  };
  const service = createContentService({ repository, syncRecorder });
  return { changes, db, service };
}

test('items normalize URLs, reject live duplicates per owner, and remain owner scoped', () => {
  const { changes, db, service } = fixture();
  const created = service.createItem({
    profileId: OWNER,
    item: {
      kind: 'webpage',
      title: 'Example',
      url: 'HTTPS://Example.COM:443/path?b=2&a=1#fragment',
      excerpt: 'First excerpt',
      body: 'alpha body',
    },
  });

  assert.equal(created.url, 'https://example.com/path?a=1&b=2');
  assert.equal(created.revision, 1);
  assert.throws(
    () =>
      service.createItem({
        profileId: OWNER,
        item: { kind: 'webpage', title: 'Duplicate', url: 'https://example.com/path?a=1&b=2' },
      }),
    { code: 'CONFLICT' }
  );
  assert.doesNotThrow(() =>
    service.createItem({
      profileId: OTHER_OWNER,
      item: { kind: 'webpage', title: 'Other owner', url: 'https://example.com/path?a=1&b=2' },
    })
  );
  assert.throws(() => service.getItem({ profileId: OTHER_OWNER, id: created.id }), { code: 'NOT_FOUND' });
  assert.deepEqual(
    changes.map(change => [change.entityType, change.changeKind, change.revision]),
    [
      ['item', 'upsert', 1],
      ['item', 'upsert', 1],
    ]
  );
  db.close();
});

test('item revisions are authoritative, FTS follows updates, and deletion is a tombstone', () => {
  const { changes, db, service } = fixture();
  const item = service.createItem({
    profileId: OWNER,
    item: { kind: 'article', title: 'Old title', body: 'old searchable phrase' },
  });

  assert.deepEqual(
    service.searchItems({ profileId: OWNER, query: '"old searchable"', limit: 10 }).map(row => row.id),
    [item.id]
  );
  assert.throws(
    () =>
      service.updateItem({
        profileId: OWNER,
        id: item.id,
        expectedRevision: 9,
        patch: { title: 'stale' },
      }),
    { code: 'CONFLICT' }
  );

  const updated = service.updateItem({
    profileId: OWNER,
    id: item.id,
    expectedRevision: 1,
    patch: { title: 'New title', body: 'new searchable phrase' },
  });
  assert.equal(updated.revision, 2);
  assert.deepEqual(service.searchItems({ profileId: OWNER, query: 'old', limit: 10 }), []);
  assert.deepEqual(
    service.searchItems({ profileId: OWNER, query: '"new searchable"', limit: 10 }).map(row => row.id),
    [item.id]
  );

  const deleted = service.deleteItem({ profileId: OWNER, id: item.id, expectedRevision: 2 });
  assert.deepEqual(deleted, { id: item.id, revision: 3, deletedAt: deleted.deletedAt });
  assert.equal(Number.isSafeInteger(deleted.deletedAt), true);
  assert.throws(() => service.getItem({ profileId: OWNER, id: item.id }), { code: 'NOT_FOUND' });
  assert.deepEqual(service.searchItems({ profileId: OWNER, query: 'new', limit: 10 }), []);
  const tombstone = db.prepare('SELECT revision, deleted_at FROM items WHERE id = ?').get(item.id);
  assert.equal(tombstone.revision, 3);
  assert.notEqual(tombstone.deleted_at, null);
  assert.deepEqual(
    changes.map(change => change.changeKind),
    ['upsert', 'upsert', 'delete']
  );
  db.close();
});

test('cursor pages exclude archived and deleted items unless archived rows are requested', () => {
  const { db, service } = fixture();
  const first = service.createItem({ profileId: OWNER, item: { kind: 'note', title: 'First' } });
  const archived = service.createItem({ profileId: OWNER, item: { kind: 'note', title: 'Archived' } });
  service.updateItem({
    profileId: OWNER,
    id: archived.id,
    expectedRevision: 1,
    patch: { archivedAt: 1_700_000_100_000 },
  });
  const newest = service.createItem({ profileId: OWNER, item: { kind: 'note', title: 'Newest' } });
  const removed = service.createItem({ profileId: OWNER, item: { kind: 'note', title: 'Removed' } });
  service.deleteItem({ profileId: OWNER, id: removed.id, expectedRevision: 1 });

  const visible = service.listItems({ profileId: OWNER, limit: 1 });
  assert.deepEqual(
    visible.items.map(item => item.id),
    [newest.id]
  );
  assert.equal(visible.hasMore, true);
  assert.deepEqual(
    service.listItems({ profileId: OWNER, limit: 1, cursor: visible.nextCursor }).items.map(item => item.id),
    [first.id]
  );
  assert.equal(
    service
      .listItems({ profileId: OWNER, limit: 10, includeArchived: true })
      .items.some(item => item.id === archived.id),
    true
  );
  db.close();
});

test('bookmarks, notes, highlights, tags, and item-tags create and tombstone with owner validation', () => {
  const { changes, db, service } = fixture();
  const item = service.createItem({ profileId: OWNER, item: { kind: 'article', title: 'Owned' } });
  const foreign = service.createItem({
    profileId: OTHER_OWNER,
    item: { kind: 'article', title: 'Foreign' },
  });
  assert.throws(() => service.createBookmark({ profileId: OWNER, itemId: foreign.id }), { code: 'NOT_FOUND' });

  const bookmark = service.createBookmark({ profileId: OWNER, itemId: item.id });
  const note = service.createNote({ profileId: OWNER, itemId: item.id, body: 'Remember this' });
  const highlight = service.createHighlight({
    profileId: OWNER,
    itemId: item.id,
    quote: 'Important',
    color: 'green',
  });
  const tag = service.createTag({ profileId: OWNER, name: '  Machine   Learning ' });
  assert.equal(tag.normalizedName, 'machine learning');
  assert.throws(() => service.createTag({ profileId: OWNER, name: 'MACHINE LEARNING' }), { code: 'CONFLICT' });
  const itemTag = service.tagItem({ profileId: OWNER, itemId: item.id, tagId: tag.id });

  for (const [entity, row] of [
    ['bookmark', bookmark],
    ['note', note],
    ['highlight', highlight],
    ['tag', tag],
    ['item_tag', itemTag],
  ]) {
    const deleted = service.deleteEntity({
      profileId: OWNER,
      entity,
      id: row.id,
      expectedRevision: 1,
    });
    assert.equal(deleted.revision, 2);
  }
  assert.equal(changes.filter(change => change.changeKind === 'delete').length, 5);
  assert.equal(db.prepare('SELECT COUNT(*) FROM bookmarks WHERE deleted_at IS NOT NULL').pluck().get(), 1);
  assert.equal(db.prepare('SELECT COUNT(*) FROM notes WHERE deleted_at IS NOT NULL').pluck().get(), 1);
  assert.equal(db.prepare('SELECT COUNT(*) FROM highlights WHERE deleted_at IS NOT NULL').pluck().get(), 1);
  assert.equal(db.prepare('SELECT COUNT(*) FROM tags WHERE deleted_at IS NOT NULL').pluck().get(), 1);
  assert.equal(db.prepare('SELECT COUNT(*) FROM item_tags WHERE deleted_at IS NOT NULL').pluck().get(), 1);
  db.close();
});

test('secondary content reads, cursor pages, and updates remain owner scoped and revision checked', () => {
  const { db, service } = fixture();
  const item = service.createItem({ profileId: OWNER, item: { kind: 'article', title: 'Owned' } });
  const otherItem = service.createItem({
    profileId: OWNER,
    item: { kind: 'article', title: 'Other owned' },
  });
  const foreignItem = service.createItem({
    profileId: OTHER_OWNER,
    item: { kind: 'article', title: 'Foreign' },
  });
  const note = service.createNote({ profileId: OWNER, itemId: item.id, body: 'Before' });
  service.createNote({ profileId: OWNER, itemId: item.id, body: 'Newest' });
  const foreignNote = service.createNote({
    profileId: OTHER_OWNER,
    itemId: foreignItem.id,
    body: 'Secret',
  });

  assert.throws(() => service.getEntity({ profileId: OWNER, entity: 'note', id: foreignNote.id }), {
    code: 'NOT_FOUND',
  });
  const firstPage = service.listEntities({ profileId: OWNER, entity: 'note', limit: 1 });
  assert.equal(firstPage.items.length, 1);
  assert.equal(firstPage.hasMore, true);
  assert.equal(
    service.listEntities({
      profileId: OWNER,
      entity: 'note',
      limit: 1,
      cursor: firstPage.nextCursor,
    }).items.length,
    1
  );
  assert.throws(
    () =>
      service.updateEntity({
        profileId: OWNER,
        entity: 'note',
        id: note.id,
        expectedRevision: 4,
        patch: { body: 'Stale' },
      }),
    { code: 'CONFLICT' }
  );
  const updatedNote = service.updateEntity({
    profileId: OWNER,
    entity: 'note',
    id: note.id,
    expectedRevision: 1,
    patch: { itemId: otherItem.id, body: 'After' },
  });
  assert.equal(updatedNote.itemId, otherItem.id);
  assert.equal(updatedNote.body, 'After');
  assert.equal(updatedNote.revision, 2);

  const tag = service.createTag({ profileId: OWNER, name: 'Before tag' });
  service.createTag({ profileId: OWNER, name: 'Existing tag' });
  assert.throws(
    () =>
      service.updateEntity({
        profileId: OWNER,
        entity: 'tag',
        id: tag.id,
        expectedRevision: 1,
        patch: { name: 'EXISTING TAG' },
      }),
    { code: 'CONFLICT' }
  );
  assert.equal(
    service.updateEntity({
      profileId: OWNER,
      entity: 'tag',
      id: tag.id,
      expectedRevision: 1,
      patch: { name: 'Changed Tag' },
    }).normalizedName,
    'changed tag'
  );
  db.close();
});
