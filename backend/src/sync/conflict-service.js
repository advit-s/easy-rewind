'use strict';

const { fail } = require('./sync-error');

function createConflictService({ db, repository, entityRegistry, ids, now } = {}) {
  if (
    db === null ||
    typeof db !== 'object' ||
    repository === null ||
    typeof repository !== 'object' ||
    entityRegistry === null ||
    typeof entityRegistry !== 'object' ||
    typeof ids !== 'function' ||
    typeof now !== 'function'
  ) {
    fail('SYNC_CONFIGURATION_INVALID');
  }

  function create({ profileId, operation, local }) {
    const conflictId = ids();
    const at = now();
    const localVariant = { kind: local.deleted ? 'delete' : 'upsert', payload: local.payload };
    const remoteVariant = { kind: operation.kind, payload: operation.payload };
    db.prepare(
      `INSERT INTO sync_conflicts(
         id, profile_id, entity_type, entity_id, local_revision, remote_revision,
         local_payload_json, remote_payload_json, state, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`
    ).run(
      conflictId,
      profileId,
      operation.entityType,
      operation.entityId,
      local.revision,
      Math.max(1, operation.baseRevision + 1),
      JSON.stringify(localVariant),
      JSON.stringify(remoteVariant),
      at,
      at
    );
    return conflictId;
  }

  function resolve({ profileId, conflictId, resolution, mergedPayload }) {
    if (!['server', 'client', 'merged'].includes(resolution)) fail('SYNC_CONFLICT_INVALID');
    const conflict = db
      .prepare(
        `SELECT * FROM sync_conflicts
         WHERE profile_id = ? AND id = ? AND state = 'open'`
      )
      .get(profileId, conflictId);
    if (!conflict) fail('NOT_FOUND');
    const local = JSON.parse(conflict.local_payload_json);
    const remote = JSON.parse(conflict.remote_payload_json);
    let selected;
    if (resolution === 'server') selected = local;
    if (resolution === 'client') selected = remote;
    if (resolution === 'merged') {
      entityRegistry.validatePayload(mergedPayload);
      selected = { kind: 'upsert', payload: mergedPayload };
    }
    const revision = conflict.local_revision + 1;
    return repository.transaction(() => {
      entityRegistry.apply({
        profileId,
        entityType: conflict.entity_type,
        entityId: conflict.entity_id,
        kind: selected.kind,
        revision,
        payload: selected.payload,
      });
      const change = repository.recordChange({
        profileId,
        entityType: conflict.entity_type,
        entityId: conflict.entity_id,
        revision,
        kind: selected.kind,
        payload: selected.payload,
      });
      const state =
        resolution === 'server' ? 'resolved_local' : resolution === 'client' ? 'resolved_remote' : 'resolved_merged';
      db.prepare(
        `UPDATE sync_conflicts
         SET state = ?, resolved_at = ?, updated_at = ?, resolution_change_id = ?
         WHERE profile_id = ? AND id = ? AND state = 'open'`
      ).run(state, now(), now(), change.changeId, profileId, conflictId);
      return { revision, changeSequence: change.sequence };
    });
  }

  function list({ profileId, cursor, limit = 25 }) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail('SYNC_INPUT_INVALID');
    const after = cursor === undefined ? '' : cursor;
    if (typeof after !== 'string') fail('CURSOR_INVALID');
    const rows = db
      .prepare(
        `SELECT id, entity_type, entity_id, local_revision, remote_revision,
                state, created_at, resolved_at
         FROM sync_conflicts
         WHERE profile_id = ? AND id > ?
         ORDER BY id
         LIMIT ?`
      )
      .all(profileId, after, limit + 1);
    const hasMore = rows.length > limit;
    const selected = hasMore ? rows.slice(0, limit) : rows;
    return {
      items: selected.map(row => ({
        conflictId: row.id,
        entityType: row.entity_type,
        entityId: row.entity_id,
        localRevision: row.local_revision,
        remoteRevision: row.remote_revision,
        status:
          row.state === 'open'
            ? 'unresolved'
            : row.state === 'resolved_local'
              ? 'server_wins'
              : row.state === 'resolved_remote'
                ? 'client_wins'
                : 'merged',
        detectedAt: row.created_at,
        resolvedAt: row.resolved_at,
      })),
      nextCursor: hasMore ? selected.at(-1).id : null,
      hasMore,
    };
  }

  return Object.freeze({ create, list, resolve });
}

module.exports = { createConflictService };
