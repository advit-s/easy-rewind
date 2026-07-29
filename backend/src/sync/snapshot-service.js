'use strict';

const { createHash } = require('node:crypto');
const { fail } = require('./sync-error');

function createSnapshotService({ db, repository, entityRegistry, ids, now, lifetimeMs = 15 * 60 * 1000 } = {}) {
  if (
    db === null ||
    typeof db !== 'object' ||
    repository === null ||
    typeof repository !== 'object' ||
    entityRegistry === null ||
    typeof entityRegistry !== 'object' ||
    typeof ids !== 'function' ||
    typeof now !== 'function' ||
    !Number.isSafeInteger(lifetimeMs) ||
    lifetimeMs < 1
  ) {
    fail('SYNC_CONFIGURATION_INVALID');
  }

  function create({ profileId, deviceId, protocolVersion = 1, schemaVersion = 4 }) {
    repository.requireActiveDevice({ profileId, deviceId });
    const entities = entityRegistry.snapshot({ profileId });
    const baseSequence = repository.latestSequence(profileId);
    const payload = JSON.stringify({ entities });
    const checksum = createHash('sha256').update(payload).digest('hex');
    const snapshotId = ids();
    const at = now();
    db.prepare(
      `INSERT INTO sync_snapshots(
         id, profile_id, device_id, protocol_version, schema_version, base_sequence,
         state, checksum, payload_json, expires_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'ready', ?, ?, ?, ?, ?)`
    ).run(
      snapshotId,
      profileId,
      deviceId,
      protocolVersion,
      schemaVersion,
      baseSequence,
      checksum,
      payload,
      at + lifetimeMs,
      at,
      at
    );
    return { snapshotId, baseSequence, checksum, entities };
  }

  function consume({ profileId, deviceId, snapshotId }) {
    return repository.transaction(() => {
      const row = db
        .prepare(
          `SELECT base_sequence, checksum, payload_json, expires_at, state
           FROM sync_snapshots WHERE profile_id = ? AND device_id = ? AND id = ?`
        )
        .get(profileId, deviceId, snapshotId);
      if (!row) fail('NOT_FOUND');
      if (row.state !== 'ready' || row.expires_at < now()) fail('CURSOR_EXPIRED');
      db.prepare(
        `UPDATE sync_snapshots SET state = 'consumed', updated_at = ?
         WHERE profile_id = ? AND device_id = ? AND id = ?`
      ).run(now(), profileId, deviceId, snapshotId);
      return {
        snapshotId,
        baseSequence: row.base_sequence,
        checksum: row.checksum,
        entities: JSON.parse(row.payload_json).entities,
      };
    });
  }

  return Object.freeze({ consume, create });
}

module.exports = { createSnapshotService };
