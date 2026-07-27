import { createSchemaValidator, inspectJsonValue } from './validation.js';

const SYNC_SCHEMA_ID = 'https://contracts.easy-rewind.invalid/schema/sync.json';

export const MAX_SYNC_BATCH_SIZE = 100;
export const MAX_SYNC_PAYLOAD_DEPTH = 8;
export const MAX_SYNC_PAYLOAD_CHARACTERS = 32_768;
export const MAX_DEVICE_SEQUENCE = Number.MAX_SAFE_INTEGER;
export const MIN_SYNC_SCHEMA_VERSION = 1;
export const MAX_SYNC_SCHEMA_VERSION = 2_147_483_647;
export const SYNC_PROTOCOL_VERSION = '1';
export const SYNC_OPERATION_KINDS = Object.freeze(['upsert', 'delete']);
export const SYNC_ENTITY_TYPES = Object.freeze([
  'item',
  'bookmark',
  'note',
  'highlight',
  'tag',
  'reminder',
  'flashcard',
  'quiz_result',
  'research_job',
  'digest',
  'setting',
]);
export const SYNC_PUSH_STATUSES = Object.freeze(['accepted', 'duplicate', 'conflict', 'rejected']);
export const SYNC_CONFLICT_STATUSES = Object.freeze(['unresolved', 'client_wins', 'server_wins', 'merged']);

function validPayload(payload) {
  return inspectJsonValue(payload, {
    maxDepth: MAX_SYNC_PAYLOAD_DEPTH,
    maxCharacters: MAX_SYNC_PAYLOAD_CHARACTERS,
  });
}

function uniqueBy(values, key) {
  const observed = new Set();
  for (const value of values) {
    if (observed.has(value[key])) return false;
    observed.add(value[key]);
  }
  return true;
}

function validPushSequence(deviceId, operations) {
  let previousSequence = 0;
  for (const operation of operations) {
    if (
      operation?.deviceId !== deviceId ||
      !Number.isSafeInteger(operation.deviceSequence) ||
      operation.deviceSequence <= previousSequence
    ) {
      return false;
    }
    previousSequence = operation.deviceSequence;
  }
  return true;
}

export const validateSyncOperation = createSchemaValidator(`${SYNC_SCHEMA_ID}#/$defs/SyncOperation`, {
  prevalidate(value) {
    return value !== null && typeof value === 'object' && validPayload(value.payload);
  },
});

export const validateSyncPushRequest = createSchemaValidator(`${SYNC_SCHEMA_ID}#/$defs/SyncPushRequest`, {
  prevalidate(value) {
    return (
      value !== null &&
      typeof value === 'object' &&
      Array.isArray(value.operations) &&
      value.operations.every(operation => validPayload(operation?.payload)) &&
      uniqueBy(value.operations, 'operationId') &&
      validPushSequence(value.deviceId, value.operations)
    );
  },
});

export const validateSyncPushResponse = createSchemaValidator(`${SYNC_SCHEMA_ID}#/$defs/SyncPushResponse`, {
  postvalidate(value) {
    return uniqueBy(value.results, 'operationId');
  },
});

export const validateSyncPullRequest = createSchemaValidator(`${SYNC_SCHEMA_ID}#/$defs/SyncPullRequest`);

export const validateSyncPullResponse = createSchemaValidator(`${SYNC_SCHEMA_ID}#/$defs/SyncPullResponse`, {
  prevalidate(value) {
    return (
      value !== null &&
      typeof value === 'object' &&
      Array.isArray(value.changes) &&
      value.changes.every(change => validPayload(change?.payload))
    );
  },
  postvalidate(value) {
    return (
      uniqueBy(value.changes, 'changeId') && (value.hasMore ? value.nextCursor !== null : value.nextCursor === null)
    );
  },
});

export const validateSyncConflict = createSchemaValidator(`${SYNC_SCHEMA_ID}#/$defs/SyncConflict`, {
  postvalidate(value) {
    return value.status === 'unresolved' ? value.resolvedAt === null : value.resolvedAt !== null;
  },
});

export const validateSyncTombstone = createSchemaValidator(`${SYNC_SCHEMA_ID}#/$defs/SyncTombstone`);
