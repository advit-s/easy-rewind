'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const Database = require('better-sqlite3');

const { DomainError, createRepositoryUtils, decodeCursor, encodeCursor } = require('./repository-utils');

function createDatabase() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE profiles (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      revision INTEGER NOT NULL
    );

    CREATE TABLE items (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      title TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      revision INTEGER NOT NULL,
      deleted_at INTEGER,
      FOREIGN KEY (profile_id) REFERENCES profiles(id)
    );
  `);
  db.prepare('INSERT INTO profiles(id, created_at, updated_at, revision) VALUES (?, ?, ?, ?)').run('owner-a', 1, 1, 1);
  db.prepare('INSERT INTO profiles(id, created_at, updated_at, revision) VALUES (?, ?, ?, ?)').run('owner-b', 1, 1, 1);
  return db;
}

function insertItem(db, { id, profileId = 'owner-a', title = id, updatedAt, revision = 1, deletedAt = null }) {
  db.prepare(
    `INSERT INTO items(
       id, profile_id, title, created_at, updated_at, revision, deleted_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, profileId, title, 1, updatedAt, revision, deletedAt);
}

function createRepository(db, overrides = {}) {
  return createRepositoryUtils({
    db,
    ids: () => 'generated-id',
    now: () => 1_700_000_000_000,
    ...overrides,
  });
}

test('opaque cursors round-trip only an integer UTC timestamp and an id', () => {
  const cursor = encodeCursor({ updatedAt: 1_700_000_000_123, id: 'item-2' });

  assert.match(cursor, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(decodeCursor(cursor), {
    updatedAt: 1_700_000_000_123,
    id: 'item-2',
  });
});

test('malformed cursors fail with a stable sanitized error', () => {
  const secret = 'cursor-secret-input';

  assert.throws(
    () => decodeCursor(secret),
    error =>
      error instanceof DomainError &&
      error.code === 'CURSOR_INVALID' &&
      error.message === 'The pagination cursor is invalid.' &&
      !error.message.includes(secret)
  );
  assert.throws(
    () => encodeCursor({ updatedAt: -1, id: secret }),
    error => error instanceof DomainError && error.code === 'CURSOR_INVALID' && !error.message.includes(secret)
  );
});

test('cursor decoding rejects non-canonical and over-specified payloads', () => {
  const extraField = Buffer.from(JSON.stringify({ updatedAt: 2, id: 'item', table: 'items' })).toString('base64url');
  const padded = `${encodeCursor({ updatedAt: 2, id: 'item' })}=`;

  assert.throws(() => decodeCursor(extraField), { code: 'CURSOR_INVALID' });
  assert.throws(() => decodeCursor(padded), { code: 'CURSOR_INVALID' });
});

test('injected identifiers and integer UTC clocks are authoritative', () => {
  let idCalls = 0;
  let clockCalls = 0;
  const db = createDatabase();
  const repository = createRepository(db, {
    ids() {
      idCalls += 1;
      return `generated-${idCalls}`;
    },
    now() {
      clockCalls += 1;
      return 1_700_000_000_000 + clockCalls;
    },
  });

  assert.equal(repository.nextId(), 'generated-1');
  assert.equal(repository.timestamp(), 1_700_000_000_001);
  assert.deepEqual(repository.newRecord(), {
    id: 'generated-2',
    createdAt: 1_700_000_000_002,
    updatedAt: 1_700_000_000_002,
    revision: 1,
  });
  db.close();
});

test('invalid injected identifiers and clocks fail without exposing their values', () => {
  const identifier = ' generated secret ';
  const db = createDatabase();
  const badIdRepository = createRepository(db, { ids: () => identifier });
  const badClockRepository = createRepository(db, { now: () => 1.5 });

  assert.throws(
    () => badIdRepository.nextId(),
    error =>
      error.code === 'ID_INVALID' &&
      error.message === 'An identifier could not be allocated.' &&
      !error.message.includes(identifier)
  );
  assert.throws(() => badClockRepository.timestamp(), {
    code: 'CLOCK_INVALID',
    message: 'The current time is invalid.',
  });
  db.close();
});

test('JSON helpers round-trip canonical plain JSON', () => {
  const db = createDatabase();
  const repository = createRepository(db);
  const value = {
    z: [{ second: 2, first: 1 }],
    a: null,
    enabled: true,
  };

  const serialized = repository.serializeJson(value);

  assert.equal(serialized, '{"a":null,"enabled":true,"z":[{"first":1,"second":2}]}');
  assert.deepEqual(repository.parseJson(serialized), {
    a: null,
    enabled: true,
    z: [{ first: 1, second: 2 }],
  });
  db.close();
});

test('JSON helpers reject non-plain, lossy, dangerous, and malformed values', () => {
  const db = createDatabase();
  const repository = createRepository(db);
  const cyclic = {};
  cyclic.self = cyclic;
  const sparse = [];
  sparse[1] = 'value';

  for (const value of [new Date(0), { missing: undefined }, { infinite: Number.POSITIVE_INFINITY }, sparse, cyclic]) {
    assert.throws(() => repository.serializeJson(value), {
      code: 'JSON_INVALID',
      message: 'Stored JSON is invalid.',
    });
  }
  assert.throws(() => repository.parseJson('{"__proto__":{"polluted":true}}'), {
    code: 'JSON_INVALID',
  });
  assert.throws(() => repository.parseJson('{broken'), { code: 'JSON_INVALID' });
  db.close();
});

test('pagination is owner-scoped, stable, bounded, and excludes tombstones', () => {
  const db = createDatabase();
  insertItem(db, { id: 'item-a', updatedAt: 10 });
  insertItem(db, { id: 'item-b', updatedAt: 20 });
  insertItem(db, { id: 'item-c', updatedAt: 20 });
  insertItem(db, { id: 'item-d', updatedAt: 30 });
  insertItem(db, { id: 'deleted', updatedAt: 40, deletedAt: 40 });
  insertItem(db, { id: 'foreign', profileId: 'owner-b', updatedAt: 50 });
  const repository = createRepository(db);

  const first = repository.page({
    profileId: 'owner-a',
    table: 'items',
    cursor: undefined,
    limit: 2,
  });

  assert.deepEqual(Object.keys(first), ['items', 'nextCursor', 'hasMore']);
  assert.deepEqual(
    first.items.map(item => item.id),
    ['item-d', 'item-c']
  );
  assert.equal(first.hasMore, true);
  assert.deepEqual(decodeCursor(first.nextCursor), { updatedAt: 20, id: 'item-c' });

  const second = repository.page({
    profileId: 'owner-a',
    table: 'items',
    cursor: first.nextCursor,
    limit: 2,
  });
  assert.deepEqual(
    second.items.map(item => item.id),
    ['item-b', 'item-a']
  );
  assert.equal(second.hasMore, false);
  assert.equal(second.nextCursor, null);
  db.close();
});

test('pagination validates its maximum limit and internal table allowlist', () => {
  const db = createDatabase();
  const repository = createRepository(db);
  const tableInput = 'items WHERE profile_id = owner-secret';

  for (const limit of [0, 101, 1.5, '2']) {
    assert.throws(() => repository.page({ profileId: 'owner-a', table: 'items', limit }), {
      code: 'PAGINATION_INVALID',
    });
  }
  assert.throws(
    () => repository.page({ profileId: 'owner-a', table: tableInput, limit: 10 }),
    error => error.code === 'REPOSITORY_INPUT_INVALID' && !error.message.includes(tableInput)
  );
  db.close();
});

test('authoritative reads never return another profile row', () => {
  const db = createDatabase();
  insertItem(db, { id: 'owned', updatedAt: 10 });
  insertItem(db, { id: 'foreign', profileId: 'owner-b', updatedAt: 10 });
  const repository = createRepository(db);

  assert.equal(repository.requireById({ profileId: 'owner-a', table: 'items', id: 'owned' }).id, 'owned');
  assert.throws(
    () =>
      repository.requireById({
        profileId: 'owner-a',
        table: 'items',
        id: 'foreign',
      }),
    {
      code: 'NOT_FOUND',
      message: 'The requested resource was not found.',
    }
  );
  db.close();
});

test('revision allocation reads the owner row and detects stale writers', () => {
  const db = createDatabase();
  insertItem(db, { id: 'owned', updatedAt: 10, revision: 7 });
  insertItem(db, { id: 'foreign', profileId: 'owner-b', updatedAt: 10, revision: 9 });
  const repository = createRepository(db);

  assert.equal(
    repository.allocateRevision({
      profileId: 'owner-a',
      table: 'items',
      id: 'owned',
      expectedRevision: 7,
    }),
    8
  );
  assert.throws(
    () =>
      repository.allocateRevision({
        profileId: 'owner-a',
        table: 'items',
        id: 'owned',
        expectedRevision: 6,
      }),
    {
      code: 'CONFLICT',
      message: 'The resource has changed since it was read.',
    }
  );
  assert.throws(
    () =>
      repository.allocateRevision({
        profileId: 'owner-a',
        table: 'items',
        id: 'foreign',
        expectedRevision: 9,
      }),
    { code: 'NOT_FOUND' }
  );
  db.close();
});

test('errors never include profile, record, cursor, or table inputs', () => {
  const secret = 'very-secret-owner-value';
  const db = createDatabase();
  const repository = createRepository(db);

  for (const run of [
    () => repository.requireById({ profileId: secret, table: 'items', id: secret }),
    () =>
      repository.allocateRevision({
        profileId: secret,
        table: 'items',
        id: secret,
        expectedRevision: 1,
      }),
    () => repository.page({ profileId: secret, table: secret, cursor: secret, limit: 2 }),
  ]) {
    assert.throws(run, error => error instanceof DomainError && !error.message.includes(secret));
  }
  db.close();
});

test('transaction starts one immediate boundary when no transaction is active', () => {
  const db = createDatabase();
  const repository = createRepository(db);

  assert.throws(
    () =>
      repository.transaction(() => {
        insertItem(db, { id: 'rolled-back', updatedAt: 2 });
        throw new Error('rollback');
      }),
    /rollback/
  );
  assert.equal(db.prepare('SELECT COUNT(*) FROM items').pluck().get(), 0);
  db.close();
});

test('transaction reuses an active caller boundary', () => {
  let transactionCalls = 0;
  const db = {
    inTransaction: true,
    prepare() {
      throw new Error('not used');
    },
    transaction() {
      transactionCalls += 1;
      throw new Error('must not start a nested transaction');
    },
  };
  const repository = createRepository(db);
  const marker = {};

  assert.equal(
    repository.transaction(() => marker),
    marker
  );
  assert.equal(transactionCalls, 0);
});
