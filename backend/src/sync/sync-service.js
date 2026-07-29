'use strict';

const { containsProviderCredential } = require('./entity-registry');
const { fail } = require('./sync-error');

const MAX_BATCH_SIZE = 100;

function validateContext(context, deviceId) {
  if (
    context === null ||
    typeof context !== 'object' ||
    typeof context.profileId !== 'string' ||
    typeof context.deviceId !== 'string' ||
    context.authenticationType !== 'sync_device'
  ) {
    fail('SYNC_DEVICE_FORBIDDEN');
  }
  if (context.deviceId !== deviceId) fail('SYNC_DEVICE_FORBIDDEN');
}

function validateOperation(operation, deviceId, supportedSchemaVersions) {
  if (
    operation === null ||
    typeof operation !== 'object' ||
    operation.deviceId !== deviceId ||
    typeof operation.operationId !== 'string' ||
    typeof operation.entityId !== 'string' ||
    !['upsert', 'delete'].includes(operation.kind) ||
    !Number.isSafeInteger(operation.baseRevision) ||
    operation.baseRevision < 0 ||
    !Number.isSafeInteger(operation.deviceSequence) ||
    operation.deviceSequence < 1
  ) {
    fail('SYNC_INPUT_INVALID');
  }
  if (operation.protocolVersion !== '1') fail('SYNC_PROTOCOL_UNSUPPORTED');
  if (!supportedSchemaVersions.has(operation.schemaVersion)) fail('SYNC_SCHEMA_UNSUPPORTED');
  if (operation.kind === 'delete' && Object.keys(operation.payload ?? {}).length !== 0) {
    fail('SYNC_PAYLOAD_INVALID');
  }
  if (containsProviderCredential(operation.payload)) fail('SYNC_PAYLOAD_INVALID');
}

function replayChanges(changes) {
  const records = new Map();
  const observed = new Set();
  for (const change of changes) {
    if (observed.has(change.changeId)) continue;
    observed.add(change.changeId);
    const key = `${change.entityType}:${change.entityId}`;
    const current = records.get(key);
    if (
      !current ||
      change.revision > current.revision ||
      (change.revision === current.revision && change.changeId > current.changeId)
    ) {
      records.set(key, { ...change });
    }
  }
  return Object.fromEntries(
    [...records.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, change]) => [
        key,
        {
          kind: change.kind,
          revision: change.revision,
          payload: change.payload,
        },
      ])
  );
}

function createSyncService({
  db,
  entityRegistry,
  repository,
  conflicts,
  snapshots,
  now,
  supportedSchemaVersions = [4],
  tombstoneRetentionMs = 30 * 24 * 60 * 60 * 1000,
} = {}) {
  if (
    db === null ||
    typeof db !== 'object' ||
    entityRegistry === null ||
    typeof entityRegistry !== 'object' ||
    repository === null ||
    typeof repository !== 'object' ||
    conflicts === null ||
    typeof conflicts !== 'object' ||
    snapshots === null ||
    typeof snapshots !== 'object' ||
    typeof now !== 'function' ||
    !Array.isArray(supportedSchemaVersions) ||
    supportedSchemaVersions.length === 0 ||
    !Number.isSafeInteger(tombstoneRetentionMs) ||
    tombstoneRetentionMs < 1
  ) {
    fail('SYNC_CONFIGURATION_INVALID');
  }
  const schemas = new Set(supportedSchemaVersions);

  function push({ context, request } = {}) {
    if (
      request === null ||
      typeof request !== 'object' ||
      typeof request.deviceId !== 'string' ||
      !Array.isArray(request.operations) ||
      request.operations.length < 1 ||
      request.operations.length > MAX_BATCH_SIZE
    ) {
      fail('SYNC_BATCH_INVALID');
    }
    validateContext(context, request.deviceId);
    repository.requireActiveDevice({ profileId: context.profileId, deviceId: context.deviceId });
    const seen = new Set();
    for (const operation of request.operations) {
      validateOperation(operation, request.deviceId, schemas);
      if (seen.has(operation.operationId)) fail('SYNC_BATCH_INVALID');
      seen.add(operation.operationId);
      if (!entityRegistry.supports(operation.entityType)) fail('SYNC_ENTITY_UNSUPPORTED');
      entityRegistry.validatePayload(operation.payload);
    }

    const results = repository.transaction(() => {
      let expectedSequence = repository.deviceSequence({
        profileId: context.profileId,
        deviceId: context.deviceId,
      });
      const accepted = [];
      for (const operation of request.operations) {
        const replay = repository.findAcknowledgement({
          profileId: context.profileId,
          deviceId: context.deviceId,
          operationId: operation.operationId,
        });
        if (replay) {
          accepted.push(
            replay.state === 'applied'
              ? {
                  operationId: replay.response.operationId,
                  status: 'duplicate',
                  revision: replay.authoritativeRevision,
                }
              : replay.response
          );
          continue;
        }
        if (operation.deviceSequence !== expectedSequence + 1) fail('SYNC_SEQUENCE_INVALID');
        expectedSequence = operation.deviceSequence;

        const local = entityRegistry.get({
          profileId: context.profileId,
          entityType: operation.entityType,
          entityId: operation.entityId,
        });
        const currentRevision = local?.revision ?? 0;
        if (operation.baseRevision !== currentRevision) {
          if (!local) fail('SYNC_SEQUENCE_INVALID');
          repository.insertOperation({
            profileId: context.profileId,
            deviceId: context.deviceId,
            operation,
            state: 'rejected',
          });
          const conflictId = conflicts.create({ profileId: context.profileId, operation, local });
          const result = {
            operationId: operation.operationId,
            status: 'conflict',
            revision: local.revision,
            conflictId,
          };
          repository.acknowledgeOperation({
            profileId: context.profileId,
            deviceId: context.deviceId,
            operationId: operation.operationId,
            state: 'conflict',
            authoritativeRevision: local.revision,
            changeSequence: null,
            response: result,
          });
          accepted.push(result);
          continue;
        }

        const revision = currentRevision + 1;
        repository.insertOperation({
          profileId: context.profileId,
          deviceId: context.deviceId,
          operation,
          state: 'applied',
        });
        entityRegistry.apply({
          profileId: context.profileId,
          entityType: operation.entityType,
          entityId: operation.entityId,
          kind: operation.kind,
          revision,
          payload: operation.payload,
        });
        const change = repository.recordChange({
          profileId: context.profileId,
          operationId: operation.operationId,
          entityType: operation.entityType,
          entityId: operation.entityId,
          revision,
          kind: operation.kind,
          payload: operation.payload,
          tombstoneExpiresAt: operation.kind === 'delete' ? now() + tombstoneRetentionMs : null,
        });
        const result = { operationId: operation.operationId, status: 'accepted', revision };
        repository.acknowledgeOperation({
          profileId: context.profileId,
          deviceId: context.deviceId,
          operationId: operation.operationId,
          state: 'applied',
          authoritativeRevision: revision,
          changeSequence: change.sequence,
          response: result,
        });
        accepted.push(result);
      }
      repository.setDeviceSequence({
        profileId: context.profileId,
        deviceId: context.deviceId,
        sequence: expectedSequence,
      });
      return accepted;
    });
    return { results, serverTime: now() };
  }

  function pull({ context, request } = {}) {
    if (
      request === null ||
      typeof request !== 'object' ||
      typeof request.deviceId !== 'string' ||
      (request.limit !== undefined &&
        (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > MAX_BATCH_SIZE))
    ) {
      fail('SYNC_INPUT_INVALID');
    }
    validateContext(context, request.deviceId);
    repository.requireActiveDevice({ profileId: context.profileId, deviceId: context.deviceId });
    const after = repository.decodeCursor(request.cursor);
    repository.assertCursorRetained({ profileId: context.profileId, after, at: now() });
    const limit = request.limit ?? 100;
    const page = repository.pullChanges({ profileId: context.profileId, after, limit });
    const lastSequence = page.rows.at(-1)?.sequence ?? repository.latestSequence(context.profileId);
    repository.acknowledgeCursor({
      profileId: context.profileId,
      deviceId: context.deviceId,
      sequence: lastSequence,
    });
    return {
      changes: page.rows.map(row => ({
        changeId: row.id,
        entityType: row.entity_type,
        entityId: row.entity_id,
        kind: row.change_kind,
        revision: row.entity_revision,
        payload: JSON.parse(row.payload_json ?? '{}'),
        changedAt: row.created_at,
      })),
      nextCursor: page.hasMore ? repository.encodeCursor(lastSequence) : null,
      hasMore: page.hasMore,
      serverTime: now(),
    };
  }

  function acknowledge({ profileId, deviceId, sequence }) {
    repository.requireActiveDevice({ profileId, deviceId });
    if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence > repository.latestSequence(profileId)) {
      fail('SYNC_INPUT_INVALID');
    }
    repository.acknowledgeCursor({ profileId, deviceId, sequence });
    return { acknowledgedSequence: sequence };
  }

  function pruneRetainedHistory({ profileId }) {
    const expired = db
      .prepare(
        `SELECT count(*) FROM sync_changes
         WHERE profile_id = ? AND change_kind = 'delete'
           AND tombstone_expires_at IS NOT NULL AND tombstone_expires_at < ?`
      )
      .pluck()
      .get(profileId, now());
    return { expiredTombstones: expired };
  }

  return Object.freeze({
    acknowledge,
    createSnapshot: input => snapshots.create(input),
    consumeSnapshot: input => snapshots.consume(input),
    listConflicts: input => conflicts.list(input),
    pruneRetainedHistory,
    pull,
    push,
    resolveConflict: input => conflicts.resolve(input),
  });
}

module.exports = { createSyncService, replayChanges };
