import {
  MAX_SYNC_BATCH_SIZE,
  assertPullResponse,
  assertPushResponse,
  assertSyncOperation,
  type PinnedSyncTransport,
  type SyncChange,
  type SyncOperation,
  type SyncPushResult,
  type SyncVariant,
} from './protocol.ts';
import { remoteChangeWins } from './replay.ts';

export { type PinnedSyncTransport } from './protocol.ts';

type MaybePendingEntity = SyncChange & { hasPendingLocalChanges?: boolean };

export interface StoredSyncConflict {
  conflictId: string;
  profileId: string;
  entityType: SyncChange['entityType'];
  entityId: string;
  localVariant: SyncVariant;
  remoteVariant: SyncVariant;
  status: 'unresolved' | 'local_wins' | 'remote_wins' | 'merged';
  detectedAt: number;
  resolvedAt: number | null;
}

export interface MobileSyncRepository {
  transaction<T>(work: () => T): T;
  listPendingOutbox(input: { profileId: string; deviceId: string; limit: number }): SyncOperation[];
  acknowledgeOutbox(input: { profileId: string; deviceId: string; operationIds: string[] }): void;
  getCursor(input: { profileId: string; deviceId: string }): string | null | undefined;
  setCursor(input: { profileId: string; deviceId: string; cursor: string | undefined }): void;
  hasInboxChange(input: { profileId: string; changeId: string }): boolean;
  recordInboxChange(input: { profileId: string; changeId: string; receivedAt: number }): void;
  getEntity(input: {
    profileId: string;
    entityType: SyncChange['entityType'];
    entityId: string;
  }): MaybePendingEntity | null;
  applyRemoteChange(input: { profileId: string; change: SyncChange }): void;
  replaceWithSnapshot(input: { profileId: string; entities: SyncChange[] }): void;
  storeConflict(conflict: StoredSyncConflict): void;
  getConflict(input: { profileId: string; conflictId: string }): StoredSyncConflict | null;
  resolveConflict(input: {
    profileId: string;
    conflictId: string;
    resolution: Exclude<StoredSyncConflict['status'], 'unresolved'>;
    selected: SyncVariant;
    resolvedAt: number;
  }): void;
}

export class SyncProtocolError extends Error {
  readonly code: string;
  readonly terminal: boolean;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'SyncProtocolError';
    this.code = code;
    this.terminal = code === 'device_revoked' || code === 'tls_fingerprint_mismatch';
  }
}

function defaultId(): string {
  return globalThis.crypto.randomUUID();
}

function asVariant(change: MaybePendingEntity | SyncChange): SyncVariant {
  return {
    entityType: change.entityType,
    entityId: change.entityId,
    kind: change.kind,
    revision: change.revision,
    payload: structuredClone(change.payload),
    changeId: change.changeId,
    changedAt: change.changedAt,
  };
}

function operationVariant(operation: SyncOperation, revision: number): SyncVariant {
  return {
    entityType: operation.entityType,
    entityId: operation.entityId,
    kind: operation.kind,
    revision,
    payload: structuredClone(operation.payload),
    changedAt: operation.occurredAt,
  };
}

function normalizeError(error: unknown): never {
  if (error instanceof SyncProtocolError) throw error;
  if (error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    throw new SyncProtocolError(error instanceof Error ? error.message : 'Sync request failed.', error.code);
  }
  throw error;
}

function conflictForPush(
  profileId: string,
  operation: SyncOperation,
  result: Extract<SyncPushResult, { status: 'conflict' }>,
  at: number
): StoredSyncConflict {
  return {
    conflictId: result.conflictId,
    profileId,
    entityType: operation.entityType,
    entityId: operation.entityId,
    localVariant: operationVariant(operation, Math.max(1, operation.baseRevision + 1)),
    remoteVariant:
      result.authoritativeVariant ??
      ({
        entityType: operation.entityType,
        entityId: operation.entityId,
        kind: operation.kind,
        revision: result.revision,
        payload: {},
      } satisfies SyncVariant),
    status: 'unresolved',
    detectedAt: at,
    resolvedAt: null,
  };
}

export function resolveStoredConflict({
  repository,
  profileId,
  conflictId,
  resolution,
  merged,
  now = Date.now,
}: {
  repository: MobileSyncRepository;
  profileId: string;
  conflictId: string;
  resolution?: 'local' | 'remote' | 'merged';
  merged?: SyncVariant;
  now?: () => number;
}): void {
  if (resolution === undefined) {
    throw new SyncProtocolError('An explicit conflict resolution is required.', 'SYNC_RESOLUTION_REQUIRED');
  }
  const conflict = repository.getConflict({ profileId, conflictId });
  if (conflict === null || conflict.status !== 'unresolved') {
    throw new SyncProtocolError('The conflict is not open.', 'SYNC_CONFLICT_NOT_FOUND');
  }
  if (resolution === 'merged' && merged === undefined) {
    throw new SyncProtocolError('A merged variant is required.', 'SYNC_MERGED_VARIANT_REQUIRED');
  }
  const selected =
    resolution === 'local' ? conflict.localVariant : resolution === 'remote' ? conflict.remoteVariant : merged!;

  repository.transaction(() => {
    repository.resolveConflict({
      profileId,
      conflictId,
      resolution: resolution === 'local' ? 'local_wins' : resolution === 'remote' ? 'remote_wins' : 'merged',
      selected: structuredClone(selected),
      resolvedAt: now(),
    });
  });
}

export class SyncCoordinator {
  readonly #profileId: string;
  readonly #deviceId: string;
  readonly #repository: MobileSyncRepository;
  readonly #transport: PinnedSyncTransport;
  readonly #ids: () => string;
  readonly #now: () => number;

  constructor({
    profileId,
    deviceId,
    repository,
    transport,
    ids = defaultId,
    now = Date.now,
  }: {
    profileId: string;
    deviceId: string;
    repository: MobileSyncRepository;
    transport: PinnedSyncTransport;
    ids?: () => string;
    now?: () => number;
  }) {
    if (
      profileId.trim() === '' ||
      deviceId.trim() === '' ||
      typeof repository.transaction !== 'function' ||
      typeof transport.push !== 'function' ||
      typeof transport.pull !== 'function'
    ) {
      throw new TypeError('Invalid sync coordinator configuration.');
    }
    this.#profileId = profileId;
    this.#deviceId = deviceId;
    this.#repository = repository;
    this.#transport = transport;
    this.#ids = ids;
    this.#now = now;
  }

  async pushOnce(): Promise<{ pushed: number; acknowledged: number; conflicts: number }> {
    const operations = this.#repository.listPendingOutbox({
      profileId: this.#profileId,
      deviceId: this.#deviceId,
      limit: MAX_SYNC_BATCH_SIZE,
    });
    if (operations.length === 0) return { pushed: 0, acknowledged: 0, conflicts: 0 };

    operations.sort((left, right) => left.deviceSequence - right.deviceSequence);
    for (const operation of operations) assertSyncOperation(operation);
    for (let index = 1; index < operations.length; index += 1) {
      if (operations[index]!.deviceSequence <= operations[index - 1]!.deviceSequence) {
        throw new SyncProtocolError('Outbox sequences must be strictly increasing.', 'SYNC_SEQUENCE_INVALID');
      }
    }

    let response;
    try {
      response = await this.#transport.push({
        deviceId: this.#deviceId,
        operations: structuredClone(operations),
      });
    } catch (error) {
      normalizeError(error);
    }
    const requestedIds = new Set(operations.map(operation => operation.operationId));
    assertPushResponse(response, requestedIds);
    const byId = new Map(operations.map(operation => [operation.operationId, operation]));
    const acknowledged = response.results.filter(result =>
      ['accepted', 'duplicate', 'conflict'].includes(result.status)
    );
    const conflicts = response.results.filter(
      (result): result is Extract<SyncPushResult, { status: 'conflict' }> => result.status === 'conflict'
    );

    this.#repository.transaction(() => {
      for (const result of conflicts) {
        const operation = byId.get(result.operationId);
        if (operation !== undefined) {
          this.#repository.storeConflict(conflictForPush(this.#profileId, operation, result, this.#now()));
        }
      }
      this.#repository.acknowledgeOutbox({
        profileId: this.#profileId,
        deviceId: this.#deviceId,
        operationIds: acknowledged.map(result => result.operationId),
      });
    });

    return {
      pushed: operations.length,
      acknowledged: acknowledged.length,
      conflicts: conflicts.length,
    };
  }

  async pullAll(): Promise<{
    applied: number;
    duplicates: number;
    conflicts: number;
    usedSnapshot: boolean;
  }> {
    let cursor =
      this.#repository.getCursor({
        profileId: this.#profileId,
        deviceId: this.#deviceId,
      }) ?? undefined;
    let applied = 0;
    let duplicates = 0;
    let conflicts = 0;
    let usedSnapshot = false;

    for (;;) {
      let page;
      try {
        page = await this.#transport.pull({
          deviceId: this.#deviceId,
          cursor,
          limit: MAX_SYNC_BATCH_SIZE,
        });
      } catch (error) {
        if (
          error instanceof SyncProtocolError &&
          error.code === 'cursor_expired' &&
          !usedSnapshot &&
          this.#transport.fetchSnapshot !== undefined
        ) {
          const snapshot = await this.#transport.fetchSnapshot({ deviceId: this.#deviceId });
          this.#repository.transaction(() => {
            this.#repository.replaceWithSnapshot({
              profileId: this.#profileId,
              entities: structuredClone(snapshot.entities),
            });
            this.#repository.setCursor({
              profileId: this.#profileId,
              deviceId: this.#deviceId,
              cursor: snapshot.cursor ?? undefined,
            });
          });
          cursor = snapshot.cursor ?? undefined;
          usedSnapshot = true;
          continue;
        }
        normalizeError(error);
      }
      assertPullResponse(page);

      const result = this.#repository.transaction(() => {
        let pageApplied = 0;
        let pageDuplicates = 0;
        let pageConflicts = 0;

        for (const remote of page.changes) {
          if (
            this.#repository.hasInboxChange({
              profileId: this.#profileId,
              changeId: remote.changeId,
            })
          ) {
            pageDuplicates += 1;
            continue;
          }

          this.#repository.recordInboxChange({
            profileId: this.#profileId,
            changeId: remote.changeId,
            receivedAt: this.#now(),
          });
          const local = this.#repository.getEntity({
            profileId: this.#profileId,
            entityType: remote.entityType,
            entityId: remote.entityId,
          });

          if (local?.hasPendingLocalChanges === true && remoteChangeWins(local, remote)) {
            this.#repository.storeConflict({
              conflictId: this.#ids(),
              profileId: this.#profileId,
              entityType: remote.entityType,
              entityId: remote.entityId,
              localVariant: asVariant(local),
              remoteVariant: asVariant(remote),
              status: 'unresolved',
              detectedAt: this.#now(),
              resolvedAt: null,
            });
            pageConflicts += 1;
            continue;
          }

          if (remoteChangeWins(local, remote)) {
            this.#repository.applyRemoteChange({
              profileId: this.#profileId,
              change: structuredClone(remote),
            });
            pageApplied += 1;
          }
        }

        this.#repository.setCursor({
          profileId: this.#profileId,
          deviceId: this.#deviceId,
          cursor: page.nextCursor ?? undefined,
        });
        return {
          applied: pageApplied,
          duplicates: pageDuplicates,
          conflicts: pageConflicts,
        };
      });

      applied += result.applied;
      duplicates += result.duplicates;
      conflicts += result.conflicts;
      cursor = page.nextCursor ?? undefined;
      if (!page.hasMore) return { applied, duplicates, conflicts, usedSnapshot };
    }
  }

  async synchronize(): Promise<{
    push: Awaited<ReturnType<SyncCoordinator['pushOnce']>>;
    pull: Awaited<ReturnType<SyncCoordinator['pullAll']>>;
  }> {
    const push = await this.pushOnce();
    const pull = await this.pullAll();
    return { push, pull };
  }
}
