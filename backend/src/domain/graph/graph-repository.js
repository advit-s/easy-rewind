'use strict';

const { fail } = require('../domain-error');

function camelRow(row) {
  const output = {};
  for (const [key, value] of Object.entries(row)) {
    output[key.replace(/_([a-z])/g, (_match, letter) => letter.toUpperCase())] = value;
  }
  return output;
}

function requireConfiguration({ db, repositoryUtils } = {}) {
  if (
    db === null ||
    typeof db !== 'object' ||
    typeof db.prepare !== 'function' ||
    repositoryUtils === null ||
    typeof repositoryUtils !== 'object' ||
    typeof repositoryUtils.newRecord !== 'function' ||
    typeof repositoryUtils.requireById !== 'function' ||
    typeof repositoryUtils.transaction !== 'function'
  ) {
    fail('REPOSITORY_CONFIGURATION_INVALID');
  }
  return { db, repositoryUtils };
}

function relation(value) {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 256) {
    fail('REPOSITORY_INPUT_INVALID');
  }
  return value.trim();
}

function note(value) {
  if (typeof value !== 'string' || value.length > 1_000_000) fail('REPOSITORY_INPUT_INVALID');
  return value;
}

function createGraphRepository(options) {
  const { db, repositoryUtils } = requireConfiguration(options);

  function ensureItem(profileId, id) {
    return repositoryUtils.requireById({ profileId, table: 'items', id });
  }

  function insertConnection({ profileId, sourceItemId, targetItemId, relation: relationValue, note: noteValue = '' }) {
    ensureItem(profileId, sourceItemId);
    ensureItem(profileId, targetItemId);
    if (sourceItemId === targetItemId) fail('REPOSITORY_INPUT_INVALID');
    const normalizedRelation = relation(relationValue);
    if (
      db
        .prepare(
          `SELECT 1 FROM connections
           WHERE profile_id = ? AND source_item_id = ? AND target_item_id = ?
             AND relation = ? AND deleted_at IS NULL
           LIMIT 1`
        )
        .get(profileId, sourceItemId, targetItemId, normalizedRelation)
    ) {
      fail('CONFLICT');
    }
    const record = repositoryUtils.newRecord();
    db.prepare(
      `INSERT INTO connections(
         id, profile_id, source_item_id, target_item_id, relation, note,
         created_at, updated_at, revision, deleted_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, NULL)`
    ).run(
      record.id,
      profileId,
      sourceItemId,
      targetItemId,
      normalizedRelation,
      note(noteValue),
      record.createdAt,
      record.updatedAt
    );
    return camelRow(repositoryUtils.requireById({ profileId, table: 'connections', id: record.id }));
  }

  function updateConnection({ profileId, id, expectedRevision, patch }) {
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) fail('REPOSITORY_INPUT_INVALID');
    const current = repositoryUtils.requireById({ profileId, table: 'connections', id });
    const revisionValue = repositoryUtils.allocateRevision({
      profileId,
      table: 'connections',
      id,
      expectedRevision,
    });
    const updatedAt = repositoryUtils.timestamp();
    db.prepare(
      `UPDATE connections
       SET relation = ?, note = ?, updated_at = ?, revision = ?
       WHERE profile_id = ? AND id = ? AND deleted_at IS NULL`
    ).run(
      Object.hasOwn(patch, 'relation') ? relation(patch.relation) : current.relation,
      Object.hasOwn(patch, 'note') ? note(patch.note) : current.note,
      updatedAt,
      revisionValue,
      profileId,
      id
    );
    return camelRow(repositoryUtils.requireById({ profileId, table: 'connections', id }));
  }

  function getConnection({ profileId, id }) {
    return camelRow(repositoryUtils.requireById({ profileId, table: 'connections', id }));
  }

  function listConnections({ profileId, cursor, limit = 25 }) {
    const page = repositoryUtils.page({
      profileId,
      table: 'connections',
      cursor,
      limit,
    });
    return { ...page, items: page.items.map(camelRow) };
  }

  function tombstoneConnection({ profileId, id, expectedRevision }) {
    const revision = repositoryUtils.allocateRevision({
      profileId,
      table: 'connections',
      id,
      expectedRevision,
    });
    const deletedAt = repositoryUtils.timestamp();
    db.prepare(
      `UPDATE connections
       SET deleted_at = ?, updated_at = ?, revision = ?
       WHERE profile_id = ? AND id = ? AND deleted_at IS NULL`
    ).run(deletedAt, deletedAt, revision, profileId, id);
    return { id, revision, deletedAt };
  }

  function relatedItems({ profileId, itemId }) {
    ensureItem(profileId, itemId);
    return db
      .prepare(
        `SELECT items.*,
                CASE WHEN connections.source_item_id = ? THEN 'outgoing' ELSE 'incoming' END AS direction,
                connections.relation
         FROM connections
         JOIN items
           ON items.profile_id = connections.profile_id
          AND items.id = CASE
            WHEN connections.source_item_id = ? THEN connections.target_item_id
            ELSE connections.source_item_id
          END
         WHERE connections.profile_id = ?
           AND (connections.source_item_id = ? OR connections.target_item_id = ?)
           AND connections.deleted_at IS NULL
           AND items.deleted_at IS NULL
         ORDER BY items.title COLLATE NOCASE ASC, items.id ASC, connections.id ASC`
      )
      .all(itemId, itemId, profileId, itemId, itemId)
      .map(camelRow);
  }

  function knowledgeGraph({ profileId }) {
    const edges = db
      .prepare(
        `SELECT * FROM connections
         WHERE profile_id = ? AND deleted_at IS NULL
         ORDER BY id ASC`
      )
      .all(profileId)
      .map(camelRow);
    if (edges.length === 0) return { nodes: [], edges: [] };
    const itemIds = [...new Set(edges.flatMap(edge => [edge.sourceItemId, edge.targetItemId]))].sort();
    const placeholders = itemIds.map(() => '?').join(', ');
    const nodes = db
      .prepare(
        `SELECT * FROM items
         WHERE profile_id = ? AND id IN (${placeholders}) AND deleted_at IS NULL
         ORDER BY id ASC`
      )
      .all(profileId, ...itemIds)
      .map(camelRow);
    const allowed = new Set(nodes.map(node => node.id));
    return {
      nodes,
      edges: edges.filter(edge => allowed.has(edge.sourceItemId) && allowed.has(edge.targetItemId)),
    };
  }

  return Object.freeze({
    getConnection,
    insertConnection,
    knowledgeGraph,
    listConnections,
    relatedItems,
    tombstoneConnection,
    transaction: repositoryUtils.transaction,
    updateConnection,
  });
}

module.exports = { createGraphRepository };
