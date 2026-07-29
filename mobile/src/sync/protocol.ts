export const SYNC_PROTOCOL_VERSION = '1' as const;
export const MAX_SYNC_BATCH_SIZE = 100 as const;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type SyncEntityType =
  | 'item'
  | 'bookmark'
  | 'note'
  | 'highlight'
  | 'tag'
  | 'reminder'
  | 'flashcard'
  | 'quiz_result'
  | 'research_job'
  | 'digest'
  | 'setting';

export type SyncKind = 'upsert' | 'delete';

export interface SyncOperation {
  operationId: string;
  deviceId: string;
  entityType: SyncEntityType;
  entityId: string;
  kind: SyncKind;
  baseRevision: number;
  deviceSequence: number;
  schemaVersion: number;
  protocolVersion: typeof SYNC_PROTOCOL_VERSION;
  payload: JsonObject;
  occurredAt: number;
}

export interface SyncChange {
  changeId: string;
  entityType: SyncEntityType;
  entityId: string;
  kind: SyncKind;
  revision: number;
  payload: JsonObject;
  changedAt: number;
}

export interface SyncVariant {
  entityType: SyncEntityType;
  entityId: string;
  kind: SyncKind;
  revision: number;
  payload: JsonObject;
  changeId?: string;
  changedAt?: number;
}

export type SyncPushResult =
  | {
      operationId: string;
      status: 'accepted' | 'duplicate';
      revision: number;
    }
  | {
      operationId: string;
      status: 'conflict';
      revision: number;
      conflictId: string;
      authoritativeVariant?: SyncVariant;
    }
  | {
      operationId: string;
      status: 'rejected';
      errorCode: 'validation_failed' | 'conflict' | 'device_revoked';
    };

export interface SyncPushResponse {
  results: SyncPushResult[];
  serverTime: number;
}

export interface SyncPullResponse {
  changes: SyncChange[];
  nextCursor: string | null;
  hasMore: boolean;
  serverTime: number;
}

export interface SyncSnapshot {
  entities: SyncChange[];
  cursor: string | null;
}

export interface PinnedSyncTransport {
  push(request: { deviceId: string; operations: SyncOperation[] }): Promise<SyncPushResponse>;
  pull(request: { deviceId: string; cursor?: string; limit: number }): Promise<SyncPullResponse>;
  fetchSnapshot?(request: { deviceId: string }): Promise<SyncSnapshot>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSafePositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

export function assertSyncOperation(value: unknown): asserts value is SyncOperation {
  if (
    !isObject(value) ||
    typeof value.operationId !== 'string' ||
    typeof value.deviceId !== 'string' ||
    typeof value.entityType !== 'string' ||
    typeof value.entityId !== 'string' ||
    !['upsert', 'delete'].includes(String(value.kind)) ||
    !Number.isSafeInteger(value.baseRevision) ||
    Number(value.baseRevision) < 0 ||
    !isSafePositiveInteger(value.deviceSequence) ||
    !isSafePositiveInteger(value.schemaVersion) ||
    value.protocolVersion !== SYNC_PROTOCOL_VERSION ||
    !isObject(value.payload) ||
    !Number.isSafeInteger(value.occurredAt)
  ) {
    throw new TypeError('Invalid sync operation.');
  }
  if (value.kind === 'delete' && Object.keys(value.payload).length !== 0) {
    throw new TypeError('Delete operations must have an empty payload.');
  }
}

export function assertSyncChange(value: unknown): asserts value is SyncChange {
  if (
    !isObject(value) ||
    typeof value.changeId !== 'string' ||
    typeof value.entityType !== 'string' ||
    typeof value.entityId !== 'string' ||
    !['upsert', 'delete'].includes(String(value.kind)) ||
    !isSafePositiveInteger(value.revision) ||
    !isObject(value.payload) ||
    !Number.isSafeInteger(value.changedAt)
  ) {
    throw new TypeError('Invalid sync change.');
  }
  if (value.kind === 'delete' && Object.keys(value.payload).length !== 0) {
    throw new TypeError('Delete changes must have an empty payload.');
  }
}

export function assertPullResponse(value: unknown): asserts value is SyncPullResponse {
  if (
    !isObject(value) ||
    !Array.isArray(value.changes) ||
    value.changes.length > MAX_SYNC_BATCH_SIZE ||
    !(typeof value.nextCursor === 'string' || value.nextCursor === null) ||
    typeof value.hasMore !== 'boolean' ||
    !Number.isSafeInteger(value.serverTime) ||
    (value.hasMore && value.nextCursor === null) ||
    (!value.hasMore && value.nextCursor !== null)
  ) {
    throw new TypeError('Invalid sync pull response.');
  }
  for (const change of value.changes) assertSyncChange(change);
  const ids = new Set(value.changes.map(change => change.changeId));
  if (ids.size !== value.changes.length) throw new TypeError('Duplicate change IDs in pull page.');
}

export function assertPushResponse(
  value: unknown,
  requestedOperationIds: ReadonlySet<string>
): asserts value is SyncPushResponse {
  if (
    !isObject(value) ||
    !Array.isArray(value.results) ||
    value.results.length > MAX_SYNC_BATCH_SIZE ||
    !Number.isSafeInteger(value.serverTime)
  ) {
    throw new TypeError('Invalid sync push response.');
  }

  const observed = new Set<string>();
  for (const result of value.results) {
    if (
      !isObject(result) ||
      typeof result.operationId !== 'string' ||
      !requestedOperationIds.has(result.operationId) ||
      observed.has(result.operationId) ||
      !['accepted', 'duplicate', 'conflict', 'rejected'].includes(String(result.status))
    ) {
      throw new TypeError('Invalid sync push result.');
    }
    observed.add(result.operationId);
  }
}
