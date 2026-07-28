'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const Database = require('better-sqlite3');

const { runMigrations } = require('../../database/migration-runner');
const { createRepositoryUtils } = require('../repository-utils');
const { createContentRepository } = require('../content/content-repository');
const { createContentService } = require('../content/content-service');
const { createGraphRepository } = require('./graph-repository');
const { createGraphService } = require('./graph-service');

const OWNER = '10000000-0000-4000-8000-000000000001';
const OTHER_OWNER = '10000000-0000-4000-8000-000000000002';

function fixture() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations({ db, now: () => 1 });
  for (const [id, name] of [
    [OWNER, 'Owner'],
    [OTHER_OWNER, 'Other'],
  ]) {
    db.prepare(
      `INSERT INTO profiles(id, display_name, created_at, updated_at, revision)
       VALUES (?, ?, 1, 1, 1)`
    ).run(id, name);
  }
  let sequence = 0;
  let clock = 1_700_000_000_000;
  const repositoryUtils = createRepositoryUtils({
    db,
    ids: () => `graph-${++sequence}`,
    now: () => ++clock,
  });
  const changes = [];
  const syncRecorder = {
    recordChange(change) {
      assert.equal(db.inTransaction, true);
      changes.push(change);
    },
  };
  const content = createContentService({
    repository: createContentRepository({ db, repositoryUtils }),
    syncRecorder,
  });
  const graph = createGraphService({
    repository: createGraphRepository({ db, repositoryUtils }),
    syncRecorder,
  });
  return { changes, content, db, graph };
}

test('connections validate both owner-scoped endpoints and preserve direction', () => {
  const { content, db, graph } = fixture();
  const source = content.createItem({ profileId: OWNER, item: { kind: 'note', title: 'Source' } });
  const target = content.createItem({ profileId: OWNER, item: { kind: 'note', title: 'Target' } });
  const foreign = content.createItem({
    profileId: OTHER_OWNER,
    item: { kind: 'note', title: 'Foreign' },
  });

  assert.throws(
    () =>
      graph.createConnection({
        profileId: OWNER,
        sourceItemId: source.id,
        targetItemId: foreign.id,
        relation: 'supports',
      }),
    { code: 'NOT_FOUND' }
  );
  const connection = graph.createConnection({
    profileId: OWNER,
    sourceItemId: source.id,
    targetItemId: target.id,
    relation: 'supports',
    note: 'Directional evidence',
  });
  assert.equal(connection.sourceItemId, source.id);
  assert.equal(connection.targetItemId, target.id);
  assert.throws(
    () =>
      graph.createConnection({
        profileId: OWNER,
        sourceItemId: source.id,
        targetItemId: target.id,
        relation: 'supports',
      }),
    { code: 'CONFLICT' }
  );
  db.close();
});

test('knowledge graph and related items are owner scoped and deterministically ordered', () => {
  const { content, db, graph } = fixture();
  const center = content.createItem({ profileId: OWNER, item: { kind: 'note', title: 'Center' } });
  const alpha = content.createItem({ profileId: OWNER, item: { kind: 'note', title: 'Alpha' } });
  const beta = content.createItem({ profileId: OWNER, item: { kind: 'note', title: 'Beta' } });
  graph.createConnection({
    profileId: OWNER,
    sourceItemId: center.id,
    targetItemId: beta.id,
    relation: 'related',
  });
  graph.createConnection({
    profileId: OWNER,
    sourceItemId: alpha.id,
    targetItemId: center.id,
    relation: 'related',
  });

  assert.deepEqual(
    graph.relatedItems({ profileId: OWNER, itemId: center.id }).map(item => [item.id, item.direction]),
    [
      [alpha.id, 'incoming'],
      [beta.id, 'outgoing'],
    ]
  );
  const projection = graph.knowledgeGraph({ profileId: OWNER });
  assert.deepEqual(
    projection.nodes.map(node => node.id),
    [alpha.id, beta.id, center.id].sort()
  );
  assert.deepEqual(
    projection.edges.map(edge => edge.id),
    [...projection.edges.map(edge => edge.id)].sort()
  );
  assert.deepEqual(graph.knowledgeGraph({ profileId: OTHER_OWNER }), { nodes: [], edges: [] });
  db.close();
});

test('connection updates require authoritative revisions and deletes retain sync tombstones', () => {
  const { changes, content, db, graph } = fixture();
  const first = content.createItem({ profileId: OWNER, item: { kind: 'note', title: 'First' } });
  const second = content.createItem({ profileId: OWNER, item: { kind: 'note', title: 'Second' } });
  const connection = graph.createConnection({
    profileId: OWNER,
    sourceItemId: first.id,
    targetItemId: second.id,
    relation: 'related',
  });
  assert.throws(
    () =>
      graph.updateConnection({
        profileId: OWNER,
        id: connection.id,
        expectedRevision: 8,
        patch: { note: 'stale' },
      }),
    { code: 'CONFLICT' }
  );
  const updated = graph.updateConnection({
    profileId: OWNER,
    id: connection.id,
    expectedRevision: 1,
    patch: { note: 'updated' },
  });
  assert.equal(updated.revision, 2);
  const deleted = graph.deleteConnection({
    profileId: OWNER,
    id: connection.id,
    expectedRevision: 2,
  });
  assert.equal(deleted.revision, 3);
  assert.deepEqual(graph.knowledgeGraph({ profileId: OWNER }).edges, []);
  assert.equal(db.prepare('SELECT deleted_at IS NOT NULL FROM connections WHERE id = ?').pluck().get(connection.id), 1);
  assert.deepEqual(
    changes.filter(change => change.entityType === 'connection').map(change => change.changeKind),
    ['upsert', 'upsert', 'delete']
  );
  db.close();
});

test('connection reads and cursor pages never cross profile boundaries', () => {
  const { content, db, graph } = fixture();
  const first = content.createItem({ profileId: OWNER, item: { kind: 'note', title: 'First' } });
  const second = content.createItem({ profileId: OWNER, item: { kind: 'note', title: 'Second' } });
  const third = content.createItem({ profileId: OWNER, item: { kind: 'note', title: 'Third' } });
  const connection = graph.createConnection({
    profileId: OWNER,
    sourceItemId: first.id,
    targetItemId: second.id,
    relation: 'related',
  });
  graph.createConnection({
    profileId: OWNER,
    sourceItemId: second.id,
    targetItemId: third.id,
    relation: 'supports',
  });

  assert.equal(graph.getConnection({ profileId: OWNER, id: connection.id }).id, connection.id);
  assert.throws(() => graph.getConnection({ profileId: OTHER_OWNER, id: connection.id }), {
    code: 'NOT_FOUND',
  });
  const firstPage = graph.listConnections({ profileId: OWNER, limit: 1 });
  assert.equal(firstPage.items.length, 1);
  assert.equal(firstPage.hasMore, true);
  const secondPage = graph.listConnections({
    profileId: OWNER,
    cursor: firstPage.nextCursor,
    limit: 1,
  });
  assert.equal(secondPage.items.length, 1);
  assert.equal(secondPage.hasMore, false);
  assert.deepEqual(graph.listConnections({ profileId: OTHER_OWNER, limit: 10 }).items, []);
  db.close();
});
