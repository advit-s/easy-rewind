import type { MobileDatabase } from './migrations.ts';

export const MOBILE_SYNC_STATES = Object.freeze([
  'local_only',
  'queued',
  'synchronized',
  'conflicted',
  'failed',
] as const);

export type MobileSyncState = (typeof MOBILE_SYNC_STATES)[number];
export type MobileEntityType = 'item' | 'reminder' | 'flashcard';
export type MobileMutationOperation = 'upsert' | 'delete';

export interface MobileRepositoryStatement {
  all<T extends object = Record<string, unknown>>(...parameters: unknown[]): T[];
  get<T extends object = Record<string, unknown>>(...parameters: unknown[]): T | undefined;
  run(...parameters: unknown[]): { changes?: number | bigint } | unknown;
}

export interface MobileRepositoryDatabase extends MobileDatabase {
  prepare(sql: string): MobileRepositoryStatement;
}

export interface MobileTransactionAdapter {
  run<T>(work: () => T): T;
}

export interface MobileMutationInput {
  entityType: MobileEntityType;
  entityId: string;
  operation: MobileMutationOperation;
  baseRevision: number;
  payload: Readonly<Record<string, unknown>>;
  apply: (context: { database: MobileRepositoryDatabase; at: number }) => void;
}

export interface MobileMutationResult {
  operationId: string;
  deviceSequence: number;
  syncState: MobileSyncState;
}

export interface MobileRepository {
  readonly database: MobileRepositoryDatabase;
  readonly profileId: string;
  readonly deviceId: string;
  generateEntityId(prefix: string): string;
  commitMutation(input: MobileMutationInput): MobileMutationResult;
  entitySyncState(entityType: MobileEntityType, entityId: string): MobileSyncState;
}

export class MobileOfflineDomainError extends Error {
  readonly code: 'CONFIGURATION_INVALID' | 'INPUT_INVALID' | 'MUTATION_FAILED';

  constructor(code: 'CONFIGURATION_INVALID' | 'INPUT_INVALID' | 'MUTATION_FAILED', message: string) {
    super(message);
    this.name = 'MobileOfflineDomainError';
    this.code = code;
  }
}

function validIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 256 &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function requireTimestamp(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new MobileOfflineDomainError('CONFIGURATION_INVALID', 'The offline clock returned an invalid timestamp.');
  }
  return value as number;
}

function rollback(database: MobileRepositoryDatabase): void {
  try {
    database.exec('ROLLBACK');
  } catch {
    // The stable public mutation error remains authoritative.
  }
}

export function createSqliteTransactionAdapter(database: MobileRepositoryDatabase): MobileTransactionAdapter {
  return Object.freeze({
    run<T>(work: () => T): T {
      database.exec('BEGIN IMMEDIATE');
      try {
        const result = work();
        database.exec('COMMIT');
        return result;
      } catch (error) {
        rollback(database);
        throw error;
      }
    },
  });
}

interface DeviceRow {
  next_sequence: unknown;
  paired_pc_id: unknown;
}

interface OutboxStateRow {
  state: unknown;
}

function canonicalJson(value: unknown, ancestors = new Set<object>()): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new MobileOfflineDomainError('INPUT_INVALID', 'Offline mutation payloads must be finite JSON values.');
    }
    return value;
  }
  if (typeof value !== 'object' || ancestors.has(value)) {
    throw new MobileOfflineDomainError('INPUT_INVALID', 'Offline mutation payloads must be plain JSON values.');
  }
  const isArray = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (!isArray && prototype !== Object.prototype && prototype !== null) {
    throw new MobileOfflineDomainError('INPUT_INVALID', 'Offline mutation payloads must be plain JSON values.');
  }
  ancestors.add(value);
  try {
    if (isArray) return value.map(entry => canonicalJson(entry, ancestors));
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) {
        throw new MobileOfflineDomainError('INPUT_INVALID', 'Offline mutation payload keys are invalid.');
      }
      result[key] = canonicalJson((value as Record<string, unknown>)[key], ancestors);
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

export interface CreateMobileRepositoryOptions {
  database: MobileRepositoryDatabase;
  profileId: string;
  deviceId: string;
  displayName: string;
  pairedPcId?: string | null;
  protocolVersion?: number;
  now?: () => number;
  generateId?: (prefix: string) => string;
  transaction?: MobileTransactionAdapter;
}

export function createMobileRepository({
  database,
  profileId,
  deviceId,
  displayName,
  pairedPcId = null,
  protocolVersion = 1,
  now = Date.now,
  generateId = prefix => `${prefix}-${globalThis.crypto.randomUUID()}`,
  transaction,
}: CreateMobileRepositoryOptions): MobileRepository {
  if (
    database === null ||
    typeof database !== 'object' ||
    typeof database.exec !== 'function' ||
    typeof database.prepare !== 'function' ||
    !validIdentifier(profileId) ||
    !validIdentifier(deviceId) ||
    !validIdentifier(displayName) ||
    (pairedPcId !== null && !validIdentifier(pairedPcId)) ||
    !Number.isSafeInteger(protocolVersion) ||
    protocolVersion < 1 ||
    typeof now !== 'function' ||
    typeof generateId !== 'function'
  ) {
    throw new MobileOfflineDomainError('CONFIGURATION_INVALID', 'The mobile repository configuration is invalid.');
  }

  const transactionAdapter = transaction ?? createSqliteTransactionAdapter(database);
  if (typeof transactionAdapter.run !== 'function') {
    throw new MobileOfflineDomainError('CONFIGURATION_INVALID', 'The mobile transaction adapter is invalid.');
  }

  function generateEntityId(prefix: string): string {
    const id = generateId(prefix);
    if (!validIdentifier(id)) {
      throw new MobileOfflineDomainError(
        'CONFIGURATION_INVALID',
        'The mobile identifier generator returned an invalid ID.'
      );
    }
    return id;
  }

  function readDevice(): DeviceRow | undefined {
    return database
      .prepare(
        `SELECT next_sequence, paired_pc_id
         FROM device_metadata
         WHERE profile_id = ? AND device_id = ?
         LIMIT 1`
      )
      .get<DeviceRow>(profileId, deviceId);
  }

  function ensureDevice(at: number): DeviceRow {
    const current = readDevice();
    if (current) return current;
    database
      .prepare(
        `INSERT INTO device_metadata(
          id, profile_id, revision, created_at, updated_at,
          device_id, display_name, next_sequence, protocol_version, paired_pc_id
        ) VALUES (?, ?, 0, ?, ?, ?, ?, 1, ?, ?)`
      )
      .run(`device:${profileId}:${deviceId}`, profileId, at, at, deviceId, displayName, protocolVersion, pairedPcId);
    return { next_sequence: 1, paired_pc_id: pairedPcId };
  }

  function entitySyncState(entityType: MobileEntityType, entityId: string): MobileSyncState {
    if (!validIdentifier(entityId)) {
      throw new MobileOfflineDomainError('INPUT_INVALID', 'The mobile entity ID is invalid.');
    }
    const conflict = database
      .prepare(
        `SELECT 1
         FROM conflicts
         WHERE profile_id = ? AND entity_type = ? AND entity_id = ? AND state = 'unresolved'
         LIMIT 1`
      )
      .get(profileId, entityType, entityId);
    if (conflict) return 'conflicted';

    const states = database
      .prepare(
        `SELECT state
         FROM outbox
         WHERE profile_id = ? AND entity_type = ? AND entity_id = ?
         ORDER BY device_sequence DESC`
      )
      .all<OutboxStateRow>(profileId, entityType, entityId)
      .map(row => row.state);
    if (states.includes('failed')) return 'failed';
    if (states.includes('queued') || states.includes('sending')) {
      return readDevice()?.paired_pc_id ? 'queued' : 'local_only';
    }
    return 'synchronized';
  }

  function commitMutation(input: MobileMutationInput): MobileMutationResult {
    if (
      input === null ||
      typeof input !== 'object' ||
      !['item', 'reminder', 'flashcard'].includes(input.entityType) ||
      !validIdentifier(input.entityId) ||
      !['upsert', 'delete'].includes(input.operation) ||
      !Number.isSafeInteger(input.baseRevision) ||
      input.baseRevision < 0 ||
      input.payload === null ||
      typeof input.payload !== 'object' ||
      Array.isArray(input.payload) ||
      typeof input.apply !== 'function'
    ) {
      throw new MobileOfflineDomainError('INPUT_INVALID', 'The offline mutation is invalid.');
    }
    const payload = input.operation === 'delete' ? {} : canonicalJson(input.payload);

    try {
      return transactionAdapter.run(() => {
        const at = requireTimestamp(now());
        const device = ensureDevice(at);
        if (!Number.isSafeInteger(device.next_sequence) || (device.next_sequence as number) < 1) {
          throw new MobileOfflineDomainError(
            'MUTATION_FAILED',
            'The offline mutation failed because the device sequence is invalid.'
          );
        }
        const deviceSequence = device.next_sequence as number;
        const operationId = `operation:${deviceId}:${deviceSequence}`;

        input.apply({ database, at });
        database
          .prepare(
            `INSERT INTO outbox(
              id, profile_id, revision, created_at, updated_at,
              device_id, device_sequence, entity_type, entity_id,
              operation, payload_json, state, attempt_count, last_error_code
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, NULL)`
          )
          .run(
            operationId,
            profileId,
            input.baseRevision,
            at,
            at,
            deviceId,
            deviceSequence,
            input.entityType,
            input.entityId,
            input.operation,
            JSON.stringify(payload)
          );
        const changed = database
          .prepare(
            `UPDATE device_metadata
             SET next_sequence = ?, updated_at = ?
             WHERE profile_id = ? AND device_id = ? AND next_sequence = ?`
          )
          .run(deviceSequence + 1, at, profileId, deviceId, deviceSequence) as { changes?: number | bigint };
        if (Number(changed.changes ?? 0) !== 1) {
          throw new MobileOfflineDomainError(
            'MUTATION_FAILED',
            'The offline mutation failed because the device sequence changed.'
          );
        }
        return {
          operationId,
          deviceSequence,
          syncState: device.paired_pc_id ? 'queued' : 'local_only',
        };
      });
    } catch (error) {
      if (error instanceof MobileOfflineDomainError && error.code !== 'MUTATION_FAILED') throw error;
      throw new MobileOfflineDomainError('MUTATION_FAILED', 'The offline mutation failed atomically.');
    }
  }

  return Object.freeze({
    database,
    profileId,
    deviceId,
    generateEntityId,
    commitMutation,
    entitySyncState,
  });
}
