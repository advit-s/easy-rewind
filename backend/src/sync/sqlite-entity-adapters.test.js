'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const BetterSqlite3 = require('better-sqlite3');

const { discoverMigrations, runMigrations } = require('../database/migration-runner');
const { SYNC_ENTITY_TYPES, createEntityRegistry } = require('./entity-registry');
const { createSqliteEntityAdapters } = require('./sqlite-entity-adapters');

const PROFILE = '00000000-0000-4000-8000-000000000001';
const OTHER_PROFILE = '00000000-0000-4000-8000-000000000002';
const ITEM = '10000000-0000-4000-8000-000000000001';
const OTHER_ITEM = '10000000-0000-4000-8000-000000000002';
const TARGET_ITEM = '10000000-0000-4000-8000-000000000003';
const TAG = '10000000-0000-4000-8000-000000000004';
const OTHER_TAG = '10000000-0000-4000-8000-000000000005';

const ITEM_PAYLOAD = Object.freeze({
  kind: 'article',
  title: 'Canonical item',
  url: 'https://example.test/article',
  excerpt: 'An excerpt',
  body: 'The complete body',
  source: 'Example',
  publishedAt: 100,
  archivedAt: null,
});

function fixture() {
  const db = new BetterSqlite3(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations({ db, migrations: discoverMigrations(), now: () => 1 });
  db.prepare(
    `INSERT INTO profiles(id, display_name, created_at, updated_at, revision)
     VALUES (?, ?, 1, 1, 1), (?, ?, 1, 1, 1)`
  ).run(PROFILE, 'Owner', OTHER_PROFILE, 'Other owner');
  let clock = 1_800_000_000_000;
  const adapters = createSqliteEntityAdapters({ db, now: () => clock });
  return {
    adapters,
    db,
    registry: createEntityRegistry({ adapters }),
    setClock(value) {
      clock = value;
    },
    close() {
      db.close();
    },
  };
}

function apply(
  adapter,
  { profileId = PROFILE, entityId = ITEM, kind = 'upsert', revision = 1, payload = ITEM_PAYLOAD } = {}
) {
  return adapter.apply({ profileId, entityId, kind, revision, payload });
}

function payloads() {
  return {
    bookmark: { itemId: ITEM },
    connection: {
      sourceItemId: ITEM,
      targetItemId: TARGET_ITEM,
      relation: 'supports',
      note: 'Related evidence',
    },
    note: { itemId: ITEM, body: 'A note' },
    highlight: {
      itemId: ITEM,
      quote: 'Quoted text',
      prefix: 'before',
      suffix: 'after',
      color: 'yellow',
    },
    tag: { name: 'Local First', normalizedName: 'local first' },
    item_tag: { itemId: ITEM, tagId: TAG },
    reminder: { itemId: ITEM, state: 'scheduled', dueAt: 500, completedAt: null },
    flashcard: {
      itemId: ITEM,
      prompt: 'Question?',
      answer: 'Answer.',
      state: 'active',
      dueAt: 600,
      intervalDays: 0,
      easeFactor: 2.5,
    },
    quiz_result: {
      itemId: ITEM,
      quizKind: 'recall',
      score: 4,
      maxScore: 5,
      answers: { first: true },
      completedAt: 700,
    },
    research_job: {
      query: 'local-first systems',
      state: 'queued',
      result: null,
      errorCode: null,
      startedAt: null,
      finishedAt: null,
    },
    digest: {
      title: 'Weekly review',
      body: 'What changed this week.',
      periodStart: 100,
      periodEnd: 800,
    },
    setting: { key: 'appearance.theme', value: { name: 'dark', contrast: 'normal' } },
  };
}

test('factory requires a SQLite database and safe clock and registers every sync entity type', t => {
  assert.throws(() => createSqliteEntityAdapters(), { code: 'SYNC_CONFIGURATION_INVALID' });
  assert.throws(() => createSqliteEntityAdapters({ db: { prepare() {} }, now: () => 1 }), {
    code: 'SYNC_CONFIGURATION_INVALID',
  });

  const context = fixture();
  t.after(() => context.close());
  assert.deepEqual(Object.keys(context.adapters).sort(), [...SYNC_ENTITY_TYPES].sort());
  for (const adapter of Object.values(context.adapters)) {
    assert.equal(typeof adapter.get, 'function');
    assert.equal(typeof adapter.apply, 'function');
    assert.equal(typeof adapter.snapshot, 'function');
  }
});

test('item adapter owns revisions and timestamps and retains deterministic tombstones', t => {
  const context = fixture();
  t.after(() => context.close());
  const adapter = context.adapters.item;

  assert.equal(adapter.get({ profileId: PROFILE, entityId: ITEM }), null);
  assert.deepEqual(apply(adapter), {
    revision: 1,
    deleted: false,
    payload: ITEM_PAYLOAD,
  });
  const inserted = context.db.prepare('SELECT * FROM items WHERE id = ?').get(ITEM);
  assert.equal(inserted.profile_id, PROFILE);
  assert.equal(inserted.created_at, 1_800_000_000_000);
  assert.equal(inserted.updated_at, 1_800_000_000_000);
  assert.equal(inserted.revision, 1);
  assert.equal(inserted.deleted_at, null);

  context.setClock(1_800_000_000_100);
  const changedPayload = { ...ITEM_PAYLOAD, title: 'Authoritative update' };
  assert.deepEqual(apply(adapter, { revision: 2, payload: changedPayload }), {
    revision: 2,
    deleted: false,
    payload: changedPayload,
  });
  assert.throws(() => apply(adapter, { revision: 4, payload: changedPayload }), {
    code: 'SYNC_INPUT_INVALID',
  });

  context.setClock(1_800_000_000_200);
  assert.deepEqual(apply(adapter, { kind: 'delete', revision: 3, payload: {} }), {
    revision: 3,
    deleted: true,
    payload: {},
  });
  assert.deepEqual(adapter.snapshot({ profileId: PROFILE }), [
    {
      entityId: ITEM,
      revision: 3,
      kind: 'delete',
      payload: {},
    },
  ]);
  const tombstone = context.db.prepare('SELECT * FROM items WHERE id = ?').get(ITEM);
  assert.equal(tombstone.deleted_at, 1_800_000_000_200);
  assert.equal(tombstone.title, 'Authoritative update');

  context.setClock(1_800_000_000_300);
  assert.deepEqual(apply(adapter, { revision: 4, payload: ITEM_PAYLOAD }), {
    revision: 4,
    deleted: false,
    payload: ITEM_PAYLOAD,
  });
  const restored = context.db.prepare('SELECT created_at, updated_at, deleted_at FROM items WHERE id = ?').get(ITEM);
  assert.deepEqual(restored, {
    created_at: 1_800_000_000_000,
    updated_at: 1_800_000_000_300,
    deleted_at: null,
  });
});

test('all canonical entity adapters apply full records and produce stable owner-scoped snapshots', t => {
  const context = fixture();
  t.after(() => context.close());
  apply(context.adapters.item);
  apply(context.adapters.item, {
    entityId: TARGET_ITEM,
    payload: { ...ITEM_PAYLOAD, title: 'Target item' },
  });
  apply(context.adapters.tag, {
    entityId: TAG,
    payload: { name: 'Support tag', normalizedName: 'support tag' },
  });

  const samples = payloads();
  let suffix = 10;
  for (const entityType of SYNC_ENTITY_TYPES.filter(type => type !== 'item')) {
    const entityId = `20000000-0000-4000-8000-${String(suffix++).padStart(12, '0')}`;
    const result = apply(context.adapters[entityType], {
      entityId,
      payload: samples[entityType],
    });
    assert.deepEqual(result, {
      revision: 1,
      deleted: false,
      payload: samples[entityType],
    });
    assert.deepEqual(context.adapters[entityType].get({ profileId: PROFILE, entityId }), result);
  }

  const snapshot = context.registry.snapshot({ profileId: PROFILE });
  const snapshotTypes = snapshot.map(entity => entity.entityType);
  assert.deepEqual([...new Set(snapshotTypes)], [...SYNC_ENTITY_TYPES].sort());
  assert.deepEqual(snapshotTypes, [...snapshotTypes].sort());
  for (const entity of snapshot) {
    assert.equal(Object.hasOwn(entity.payload, 'id'), false);
    assert.equal(Object.hasOwn(entity.payload, 'profileId'), false);
    assert.equal(Object.hasOwn(entity.payload, 'revision'), false);
    assert.equal(Object.hasOwn(entity.payload, 'createdAt'), false);
    assert.equal(Object.hasOwn(entity.payload, 'updatedAt'), false);
    assert.equal(Object.hasOwn(entity.payload, 'deletedAt'), false);
  }
  assert.deepEqual(context.registry.snapshot({ profileId: OTHER_PROFILE }), []);
});

test('connection and item-tag adapters preserve relationships through tombstone and resurrection', t => {
  const context = fixture();
  t.after(() => context.close());
  apply(context.adapters.item);
  apply(context.adapters.item, {
    entityId: TARGET_ITEM,
    payload: { ...ITEM_PAYLOAD, title: 'Target item' },
  });
  apply(context.adapters.tag, {
    entityId: TAG,
    payload: { name: 'Support tag', normalizedName: 'support tag' },
  });

  for (const [entityType, entityId, payload] of [
    ['connection', 'connection-lifecycle', payloads().connection],
    ['item_tag', 'item-tag-lifecycle', payloads().item_tag],
  ]) {
    const adapter = context.adapters[entityType];
    assert.deepEqual(apply(adapter, { entityId, payload }), {
      revision: 1,
      deleted: false,
      payload,
    });
    assert.deepEqual(apply(adapter, { entityId, kind: 'delete', revision: 2, payload: {} }), {
      revision: 2,
      deleted: true,
      payload: {},
    });
    assert.deepEqual(adapter.snapshot({ profileId: PROFILE }), [
      { entityId, revision: 2, kind: 'delete', payload: {} },
    ]);
    assert.deepEqual(apply(adapter, { entityId, revision: 3, payload }), {
      revision: 3,
      deleted: false,
      payload,
    });
  }
});

test('payload validation requires exact complete allowlists and excludes metadata and credentials', t => {
  const context = fixture();
  t.after(() => context.close());
  const adapter = context.adapters.item;

  for (const payload of [
    { title: 'partial' },
    { ...ITEM_PAYLOAD, revision: 1 },
    { ...ITEM_PAYLOAD, profileId: PROFILE },
    { ...ITEM_PAYLOAD, unexpected: true },
    { ...ITEM_PAYLOAD, kind: 'executable' },
    { ...ITEM_PAYLOAD, publishedAt: -1 },
  ]) {
    assert.throws(() => apply(adapter, { payload }), { code: 'SYNC_PAYLOAD_INVALID' });
  }
  assert.throws(
    () =>
      apply(context.adapters.setting, {
        entityId: 'setting-secret',
        payload: { key: 'gemini.apiKey', value: 'not-secure-storage' },
      }),
    { code: 'SYNC_PAYLOAD_INVALID' }
  );
  assert.throws(
    () =>
      apply(context.adapters.setting, {
        entityId: 'setting-nested-secret',
        payload: { key: 'appearance', value: { providerToken: 'not-secure-storage' } },
      }),
    { code: 'SYNC_PAYLOAD_INVALID' }
  );
  assert.equal(context.db.prepare('SELECT count(*) FROM settings').pluck().get(), 0);
});

test('owner checks and relationship checks prevent cross-profile references without leaking SQLite details', t => {
  const context = fixture();
  t.after(() => context.close());
  apply(context.adapters.item);
  apply(context.adapters.item, {
    profileId: OTHER_PROFILE,
    entityId: OTHER_ITEM,
    payload: { ...ITEM_PAYLOAD, title: 'Other owner item' },
  });
  apply(context.adapters.tag, {
    profileId: OTHER_PROFILE,
    entityId: OTHER_TAG,
    payload: { name: 'Other tag', normalizedName: 'other tag' },
  });

  assert.equal(context.adapters.item.get({ profileId: OTHER_PROFILE, entityId: ITEM }), null);
  assert.throws(
    () =>
      apply(context.adapters.note, {
        entityId: 'cross-owner-note',
        payload: { itemId: OTHER_ITEM, body: 'Must not cross owners' },
      }),
    error => {
      assert.equal(error.code, 'SYNC_PAYLOAD_INVALID');
      assert.equal(error.message.includes('FOREIGN KEY'), false);
      assert.equal(Object.hasOwn(error, 'cause'), false);
      return true;
    }
  );
  assert.throws(
    () =>
      apply(context.adapters.item, {
        profileId: OTHER_PROFILE,
        entityId: ITEM,
        payload: ITEM_PAYLOAD,
      }),
    { code: 'SYNC_INPUT_INVALID' }
  );
  assert.throws(
    () =>
      apply(context.adapters.connection, {
        entityId: 'cross-owner-connection',
        payload: {
          sourceItemId: ITEM,
          targetItemId: OTHER_ITEM,
          relation: 'invalid-owner',
          note: '',
        },
      }),
    { code: 'SYNC_PAYLOAD_INVALID' }
  );
  assert.throws(
    () =>
      apply(context.adapters.item_tag, {
        entityId: 'cross-owner-item-tag',
        payload: { itemId: ITEM, tagId: OTHER_TAG },
      }),
    { code: 'SYNC_PAYLOAD_INVALID' }
  );
  assert.throws(() => apply(context.adapters.item, { kind: 'delete', entityId: 'missing', revision: 1, payload: {} }), {
    code: 'NOT_FOUND',
  });
});

test('constraints are converted into stable synchronization errors and leave prior records unchanged', t => {
  const context = fixture();
  t.after(() => context.close());
  apply(context.adapters.item);
  apply(context.adapters.bookmark, {
    entityId: 'bookmark-one',
    payload: { itemId: ITEM },
  });
  assert.throws(
    () =>
      apply(context.adapters.bookmark, {
        entityId: 'bookmark-two',
        payload: { itemId: ITEM },
      }),
    error => {
      assert.equal(error.code, 'SYNC_PAYLOAD_INVALID');
      assert.equal(error.message.includes('UNIQUE'), false);
      return true;
    }
  );
  assert.equal(context.db.prepare('SELECT count(*) FROM bookmarks').pluck().get(), 1);
});
