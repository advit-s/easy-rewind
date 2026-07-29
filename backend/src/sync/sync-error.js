'use strict';

const MESSAGES = Object.freeze({
  SYNC_CONFIGURATION_INVALID: 'Synchronization configuration is invalid.',
  SYNC_INPUT_INVALID: 'Synchronization input is invalid.',
  SYNC_BATCH_INVALID: 'The synchronization batch is invalid.',
  SYNC_SEQUENCE_INVALID: 'The device sequence is invalid.',
  SYNC_PROTOCOL_UNSUPPORTED: 'The synchronization protocol version is unsupported.',
  SYNC_SCHEMA_UNSUPPORTED: 'The synchronization schema version is unsupported.',
  SYNC_DEVICE_FORBIDDEN: 'The synchronization device does not match the authenticated device.',
  SYNC_ENTITY_UNSUPPORTED: 'The synchronized entity type is unsupported.',
  SYNC_PAYLOAD_INVALID: 'The synchronized payload is invalid.',
  SYNC_CONFLICT_INVALID: 'The conflict resolution is invalid.',
  AUTH_DEVICE_REVOKED: 'The device has been revoked.',
  CURSOR_EXPIRED: 'The requested cursor has expired.',
  CURSOR_INVALID: 'The requested cursor is invalid.',
  NOT_FOUND: 'The requested resource was not found.',
});

class SyncError extends Error {
  constructor(code) {
    const safeCode = Object.hasOwn(MESSAGES, code) ? code : 'SYNC_INPUT_INVALID';
    super(MESSAGES[safeCode]);
    this.name = 'SyncError';
    this.code = safeCode;
  }
}

function fail(code) {
  throw new SyncError(code);
}

module.exports = { SyncError, fail };
