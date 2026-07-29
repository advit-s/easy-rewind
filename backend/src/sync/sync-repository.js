'use strict';

const { fail } = require('./sync-error');

function validTimestamp(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function createSyncRepository({ db, ids, now } = {}) {
  if (
    db === null ||
    typeof db !== 'object' ||
    typeof db.prepare !== 'function' ||
    typeof db.transaction !== 'function' ||
    typeof ids !== 'function' ||
    typeof now !== 'function'
  ) {
    fail('SYNC_CONFIGURATION_INVALID');
  }

  function id() {
    const value = ids();
    if (typeof value !== 'string' || value.length === 0) fail('SYNC_CONFIGURATION_INVALID');
    return value;
  }

  function timestamp() {
    const value = now();
    if (!validTimestamp(value)) fail('SYNC_CONFIGURATION_INVALID');
    return value;
  }

  function transaction(work) {
    if (db.inTransaction) return work();
    return db.transaction(work).immediate();
  }

  function requireActiveDevice({ profileId, deviceId }) {
    const row = db.prepare('SELECT state FROM sync_devices WHERE profile_id = ? AND id = ?').get(profileId, deviceId);
    if (!row) fail('SYNC_DEVICE_FORBIDDEN');
    if (row.state === 'revoked') fail('AUTH_DEVICE_REVOKED');
    if (row.state !== 'active') fail('SYNC_DEVICE_FORBIDDEN');
  }

  function deviceSequence({ profileId, deviceId }) {
    return (
      db
        .prepare('SELECT last_sequence FROM sync_device_sequences WHERE profile_id = ? AND device_id = ?')
        .pluck()
        .get(profileId, deviceId) ?? 0
    );
  }

  function setDeviceSequence({ profileId, deviceId, sequence }) {
    const at = timestamp();
    db.prepare(
      `INSERT INTO sync_device_sequences(id, profile_id, device_id, last_sequence, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(profile_id, device_id) DO UPDATE SET
         last_sequence = excluded.last_sequence,
         updated_at = excluded.updated_at`
    ).run(id(), profileId, deviceId, sequence, at, at);
  }

  function findAcknowledgement({ profileId, deviceId, operationId }) {
    const row = db
      .prepare(
        `SELECT a.state, a.authoritative_revision, a.change_sequence, a.response_json
         FROM sync_acknowledgements a
         JOIN sync_operations o ON o.id = a.operation_id AND o.profile_id = a.profile_id
         WHERE a.profile_id = ? AND a.device_id = ? AND o.operation_key = ?`
      )
      .get(profileId, deviceId, operationId);
    if (!row) return null;
    return {
      state: row.state,
      authoritativeRevision: row.authoritative_revision,
      changeSequence: row.change_sequence,
      response: JSON.parse(row.response_json),
    };
  }

  function insertOperation({ profileId, deviceId, operation, state }) {
    const at = timestamp();
    db.prepare(
      `INSERT INTO sync_operations(
         id, profile_id, device_id, operation_key, entity_type, entity_id,
         base_revision, payload_json, state, operation_type, device_sequence,
         protocol_version, schema_version, applied_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      operation.operationId,
      profileId,
      deviceId,
      operation.operationId,
      operation.entityType,
      operation.entityId,
      operation.baseRevision,
      JSON.stringify(operation.payload),
      state,
      operation.kind,
      operation.deviceSequence,
      Number(operation.protocolVersion),
      operation.schemaVersion,
      state === 'applied' ? at : null,
      at,
      at
    );
    return operation.operationId;
  }

  function nextChangeSequence(profileId) {
    return (db.prepare('SELECT max(sequence) FROM sync_changes WHERE profile_id = ?').pluck().get(profileId) ?? 0) + 1;
  }

  function recordChange({
    profileId,
    operationId = null,
    entityType,
    entityId,
    revision,
    kind,
    payload,
    tombstoneExpiresAt = null,
  }) {
    const at = timestamp();
    const sequence = nextChangeSequence(profileId);
    const changeId = id();
    db.prepare(
      `INSERT INTO sync_changes(
         id, profile_id, operation_id, sequence, entity_type, entity_id,
         entity_revision, change_kind, payload_json, created_at, tombstone_expires_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      changeId,
      profileId,
      operationId,
      sequence,
      entityType,
      entityId,
      revision,
      kind,
      JSON.stringify(payload),
      at,
      tombstoneExpiresAt
    );
    return { changeId, sequence, changedAt: at };
  }

  function acknowledgeOperation({
    profileId,
    deviceId,
    operationId,
    state,
    authoritativeRevision,
    changeSequence,
    response,
  }) {
    const at = timestamp();
    db.prepare(
      `INSERT INTO sync_acknowledgements(
         id, profile_id, device_id, operation_id, state, authoritative_revision,
         change_sequence, response_json, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id(),
      profileId,
      deviceId,
      operationId,
      state,
      authoritativeRevision,
      changeSequence,
      JSON.stringify(response),
      at,
      at
    );
  }

  function encodeCursor(sequence) {
    if (!Number.isSafeInteger(sequence) || sequence < 0) fail('CURSOR_INVALID');
    return Buffer.from(JSON.stringify({ sequence, version: 1 }), 'utf8').toString('base64url');
  }

  function decodeCursor(cursor) {
    if (cursor === undefined || cursor === null) return 0;
    if (typeof cursor !== 'string' || cursor.length === 0 || cursor.length > 512) fail('CURSOR_INVALID');
    try {
      const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
      if (
        parsed === null ||
        typeof parsed !== 'object' ||
        parsed.version !== 1 ||
        !Number.isSafeInteger(parsed.sequence) ||
        parsed.sequence < 0 ||
        Object.keys(parsed).length !== 2
      ) {
        fail('CURSOR_INVALID');
      }
      return parsed.sequence;
    } catch (error) {
      if (error?.code === 'CURSOR_INVALID') throw error;
      fail('CURSOR_INVALID');
    }
  }

  function pullChanges({ profileId, after, limit }) {
    const rows = db
      .prepare(
        `SELECT id, sequence, entity_type, entity_id, entity_revision,
                change_kind, payload_json, created_at
         FROM sync_changes
         WHERE profile_id = ? AND sequence > ?
         ORDER BY sequence
         LIMIT ?`
      )
      .all(profileId, after, limit + 1);
    const hasMore = rows.length > limit;
    return {
      rows: hasMore ? rows.slice(0, limit) : rows,
      hasMore,
    };
  }

  function latestSequence(profileId) {
    return db.prepare('SELECT max(sequence) FROM sync_changes WHERE profile_id = ?').pluck().get(profileId) ?? 0;
  }

  function assertCursorRetained({ profileId, after, at }) {
    const expired = db
      .prepare(
        `SELECT 1 FROM sync_changes
         WHERE profile_id = ? AND change_kind = 'delete'
           AND sequence > ? AND tombstone_expires_at IS NOT NULL AND tombstone_expires_at < ?
         LIMIT 1`
      )
      .get(profileId, after, at);
    if (expired) fail('CURSOR_EXPIRED');
  }

  function acknowledgeCursor({ profileId, deviceId, sequence }) {
    const peer = db
      .prepare(
        `SELECT id FROM sync_devices
         WHERE profile_id = ? AND id <> ? AND state = 'active'
         ORDER BY id LIMIT 1`
      )
      .pluck()
      .get(profileId, deviceId);
    if (!peer) return;
    const at = timestamp();
    db.prepare(
      `INSERT INTO sync_cursors(id, profile_id, device_id, peer_device_id, last_sequence, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(profile_id, device_id, peer_device_id) DO UPDATE SET
         last_sequence = max(last_sequence, excluded.last_sequence),
         updated_at = excluded.updated_at`
    ).run(id(), profileId, deviceId, peer, sequence, at, at);
  }

  return Object.freeze({
    acknowledgeCursor,
    acknowledgeOperation,
    assertCursorRetained,
    decodeCursor,
    deviceSequence,
    encodeCursor,
    findAcknowledgement,
    id,
    insertOperation,
    latestSequence,
    pullChanges,
    recordChange,
    requireActiveDevice,
    setDeviceSequence,
    timestamp,
    transaction,
  });
}

module.exports = { createSyncRepository };
