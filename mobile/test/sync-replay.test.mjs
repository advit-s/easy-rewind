import assert from 'node:assert/strict';
import test from 'node:test';

import { SyncCoordinator, SyncProtocolError, resolveStoredConflict } from '../src/sync/sync-coordinator.ts';
import { replayChanges } from '../src/sync/replay.ts';

const PROFILE_ID = '5e83908d-e121-4c56-b7dc-6ee3d745cc30';
const DEVICE_ID = '6ba7b810-9dad-4d1f-80b4-00c04fd430c8';

function operation(sequence, overrides = {}) {
  return {
    operationId: `operation-${String(sequence).padStart(3, '0')}`,
    deviceId: DEVICE_ID,
    entityType: 'item',
    entityId: `entity-${sequence}`,
    kind: 'upsert',
    baseRevision: 0,
    deviceSequence: sequence,
    schemaVersion: 4,
    protocolVersion: '1',
    payload: { title: `Item ${sequence}` },
    occurredAt: 1_700_000_000_000 - sequence * 100_000,
    ...overrides,
  };
}

function change(changeId, entityId, revision, payload, overrides = {}) {
  return {
    changeId,
    entityType: 'item',
    entityId,
    kind: 'upsert',
    revision,
    payload,
    changedAt: 1_600_000_000_000,
    ...overrides,
  };
}

function clone(value) {
  return structuredClone(value);
}

class MemoryRepository {
  constructor({ outbox = [], cursor = undefined, entities = [] } = {}) {
    this.outbox = clone(outbox);
    this.cursor = cursor;
    this.entities = new Map(entities.map(entity => [`${entity.entityType}:${entity.entityId}`, clone(entity)]));
    this.inbox = new Set();
    this.conflicts = new Map();
    this.events = [];
    this.failOnChangeId = undefined;
  }

  transaction(work) {
    const snapshot = clone({
      outbox: this.outbox,
      cursor: this.cursor,
      entities: [...this.entities],
      inbox: [...this.inbox],
      conflicts: [...this.conflicts],
      events: this.events,
    });
    try {
      return work();
    } catch (error) {
      this.outbox = snapshot.outbox;
      this.cursor = snapshot.cursor;
      this.entities = new Map(snapshot.entities);
      this.inbox = new Set(snapshot.inbox);
      this.conflicts = new Map(snapshot.conflicts);
      this.events = snapshot.events;
      throw error;
    }
  }

  listPendingOutbox({ profileId, deviceId, limit }) {
    assert.equal(profileId, PROFILE_ID);
    assert.equal(deviceId, DEVICE_ID);
    return this.outbox
      .filter(entry => entry.profileId === profileId && entry.operation.deviceId === deviceId)
      .sort((left, right) => left.operation.deviceSequence - right.operation.deviceSequence)
      .slice(0, limit)
      .map(entry => clone(entry.operation));
  }

  acknowledgeOutbox({ operationIds }) {
    this.events.push(`ack:${operationIds.join(',')}`);
    const accepted = new Set(operationIds);
    this.outbox = this.outbox.filter(entry => !accepted.has(entry.operation.operationId));
  }

  getCursor() {
    return this.cursor;
  }

  setCursor({ cursor }) {
    this.events.push(`cursor:${String(cursor)}`);
    this.cursor = cursor;
  }

  hasInboxChange({ changeId }) {
    return this.inbox.has(changeId);
  }

  recordInboxChange({ changeId }) {
    this.events.push(`record:${changeId}`);
    this.inbox.add(changeId);
  }

  getEntity({ entityType, entityId }) {
    return clone(this.entities.get(`${entityType}:${entityId}`) ?? null);
  }

  applyRemoteChange({ change: remote }) {
    assert.ok(this.inbox.has(remote.changeId), 'change ID must be durable before entity apply');
    this.events.push(`apply:${remote.changeId}`);
    this.entities.set(`${remote.entityType}:${remote.entityId}`, clone(remote));
    if (this.failOnChangeId === remote.changeId) {
      this.failOnChangeId = undefined;
      throw new Error('simulated interruption');
    }
  }

  replaceWithSnapshot({ entities }) {
    this.events.push('snapshot');
    this.entities = new Map(entities.map(entity => [`${entity.entityType}:${entity.entityId}`, clone(entity)]));
  }

  storeConflict(conflict) {
    this.events.push(`conflict:${conflict.conflictId}`);
    this.conflicts.set(conflict.conflictId, clone(conflict));
  }

  getConflict({ conflictId }) {
    return clone(this.conflicts.get(conflictId) ?? null);
  }

  resolveConflict({ conflictId, resolution, selected }) {
    const current = this.conflicts.get(conflictId);
    this.conflicts.set(conflictId, {
      ...current,
      resolution,
      resolvedAt: 1_900_000_000_000,
    });
    this.entities.set(`${selected.entityType}:${selected.entityId}`, clone(selected));
  }
}

test('pushes at most 100 operations in device-sequence order and deletes only acknowledged rows', async () => {
  const outbox = Array.from({ length: 105 }, (_, index) => ({
    profileId: PROFILE_ID,
    operation: operation(105 - index),
  }));
  let pushed;
  const repository = new MemoryRepository({ outbox });
  const coordinator = new SyncCoordinator({
    profileId: PROFILE_ID,
    deviceId: DEVICE_ID,
    repository,
    transport: {
      async push(request) {
        pushed = clone(request.operations);
        return {
          results: request.operations.map((entry, index) =>
            index === 99
              ? {
                  operationId: entry.operationId,
                  status: 'rejected',
                  errorCode: 'validation_failed',
                }
              : {
                  operationId: entry.operationId,
                  status: index === 98 ? 'duplicate' : 'accepted',
                  revision: 1,
                }
          ),
          serverTime: 1_800_000_000_000,
        };
      },
      async pull() {
        return { changes: [], nextCursor: null, hasMore: false, serverTime: 1 };
      },
    },
  });

  const result = await coordinator.pushOnce();

  assert.equal(pushed.length, 100);
  assert.deepEqual(
    pushed.map(entry => entry.deviceSequence),
    Array.from({ length: 100 }, (_, index) => index + 1)
  );
  assert.equal(result.acknowledged, 99);
  assert.deepEqual(
    repository.outbox.map(entry => entry.operation.deviceSequence).sort((a, b) => a - b),
    [100, 101, 102, 103, 104, 105]
  );
});

test('pull commits change IDs before apply and resumes from the last committed opaque cursor', async () => {
  const pages = new Map([
    [
      undefined,
      {
        changes: [change('c1', 'a', 1, { title: 'A' })],
        nextCursor: 'opaque-page-1',
        hasMore: true,
        serverTime: 1,
      },
    ],
    [
      'opaque-page-1',
      {
        changes: [change('c2', 'b', 1, { title: 'B' })],
        nextCursor: null,
        hasMore: false,
        serverTime: 2,
      },
    ],
  ]);
  const requested = [];
  const repository = new MemoryRepository();
  repository.failOnChangeId = 'c2';
  const coordinator = new SyncCoordinator({
    profileId: PROFILE_ID,
    deviceId: DEVICE_ID,
    repository,
    transport: {
      async push() {
        throw new Error('not used');
      },
      async pull({ cursor }) {
        requested.push(cursor);
        return clone(pages.get(cursor));
      },
    },
  });

  await assert.rejects(() => coordinator.pullAll(), /simulated interruption/);
  assert.equal(repository.cursor, 'opaque-page-1');
  assert.deepEqual(repository.events, ['record:c1', 'apply:c1', 'cursor:opaque-page-1']);

  const result = await coordinator.pullAll();

  assert.deepEqual(requested, [undefined, 'opaque-page-1', 'opaque-page-1']);
  assert.equal(result.applied, 1);
  assert.equal(repository.cursor, undefined);
  assert.deepEqual(repository.events, [
    'record:c1',
    'apply:c1',
    'cursor:opaque-page-1',
    'record:c2',
    'apply:c2',
    'cursor:undefined',
  ]);
});

test('duplicate and reordered changes converge despite clock skew and preserve tombstones', () => {
  const accepted = [
    change('c1', 'a', 1, { title: 'A' }, { changedAt: 9_000 }),
    change('c2', 'b', 1, { title: 'B' }, { changedAt: 8_000 }),
    change('c3', 'a', 2, { title: 'A2' }, { changedAt: 1 }),
    change('c4', 'b', 2, {}, { kind: 'delete', changedAt: 99_000 }),
  ];
  const left = replayChanges([accepted[2], accepted[0], accepted[1], accepted[0], accepted[3]]);
  const right = replayChanges([accepted[3], accepted[1], accepted[2], accepted[0], accepted[2]]);

  assert.deepEqual(left, right);
  assert.deepEqual(left, {
    'item:a': { kind: 'upsert', revision: 2, payload: { title: 'A2' } },
    'item:b': { kind: 'delete', revision: 2, payload: {} },
  });
});

test('equal revisions use the stable change ID rather than clocks so replicas converge', () => {
  const low = change('a-change', 'same', 4, { title: 'low' }, { changedAt: 99_000 });
  const high = change('z-change', 'same', 4, { title: 'high' }, { changedAt: 1 });

  assert.deepEqual(replayChanges([high, low]), replayChanges([low, high]));
  assert.deepEqual(replayChanges([high, low])['item:same'].payload, { title: 'high' });
});

test('stale remote edits store both variants and require an explicit conflict resolution', async () => {
  const repository = new MemoryRepository({
    entities: [
      {
        changeId: 'local',
        entityType: 'item',
        entityId: 'shared',
        kind: 'upsert',
        revision: 5,
        payload: { title: 'local unsynced' },
        changedAt: 1,
        hasPendingLocalChanges: true,
      },
    ],
  });
  const coordinator = new SyncCoordinator({
    profileId: PROFILE_ID,
    deviceId: DEVICE_ID,
    repository,
    ids: () => 'conflict-1',
    now: () => 1_800_000_000_000,
    transport: {
      async push() {
        throw new Error('not used');
      },
      async pull() {
        return {
          changes: [change('remote', 'shared', 6, { title: 'remote' })],
          nextCursor: null,
          hasMore: false,
          serverTime: 2,
        };
      },
    },
  });

  await coordinator.pullAll();

  const stored = repository.conflicts.get('conflict-1');
  assert.deepEqual(stored.localVariant.payload, { title: 'local unsynced' });
  assert.deepEqual(stored.remoteVariant.payload, { title: 'remote' });
  assert.equal(stored.status, 'unresolved');
  assert.equal(repository.entities.get('item:shared').payload.title, 'local unsynced');
  assert.throws(
    () => resolveStoredConflict({ repository, profileId: PROFILE_ID, conflictId: 'conflict-1' }),
    error => error.code === 'SYNC_RESOLUTION_REQUIRED'
  );

  resolveStoredConflict({
    repository,
    profileId: PROFILE_ID,
    conflictId: 'conflict-1',
    resolution: 'remote',
    now: () => 1_900_000_000_000,
  });
  assert.equal(repository.entities.get('item:shared').payload.title, 'remote');
});

test('cursor expiry atomically applies a snapshot and resumes incremental pull', async () => {
  const repository = new MemoryRepository({ cursor: 'expired-cursor' });
  let pulls = 0;
  const coordinator = new SyncCoordinator({
    profileId: PROFILE_ID,
    deviceId: DEVICE_ID,
    repository,
    transport: {
      async push() {
        throw new Error('not used');
      },
      async pull({ cursor }) {
        pulls += 1;
        if (cursor === 'expired-cursor') {
          throw new SyncProtocolError('cursor expired', 'cursor_expired');
        }
        return {
          changes: [change('after-snapshot', 'b', 3, { title: 'B3' })],
          nextCursor: null,
          hasMore: false,
          serverTime: 3,
        };
      },
      async fetchSnapshot() {
        return {
          entities: [change('snapshot-a', 'a', 8, { title: 'snapshot' })],
          cursor: 'snapshot-cursor',
        };
      },
    },
  });

  const result = await coordinator.pullAll();

  assert.equal(pulls, 2);
  assert.equal(result.usedSnapshot, true);
  assert.equal(repository.entities.get('item:a').payload.title, 'snapshot');
  assert.equal(repository.entities.get('item:b').payload.title, 'B3');
  assert.equal(repository.cursor, undefined);
});

test('revocation is terminal and never falls back to snapshot or deletes queued work', async () => {
  const repository = new MemoryRepository({
    outbox: [{ profileId: PROFILE_ID, operation: operation(1) }],
  });
  let snapshots = 0;
  const coordinator = new SyncCoordinator({
    profileId: PROFILE_ID,
    deviceId: DEVICE_ID,
    repository,
    transport: {
      async push() {
        throw new SyncProtocolError('revoked', 'device_revoked');
      },
      async pull() {
        throw new SyncProtocolError('revoked', 'device_revoked');
      },
      async fetchSnapshot() {
        snapshots += 1;
        throw new Error('must not run');
      },
    },
  });

  await assert.rejects(
    () => coordinator.synchronize(),
    error => {
      assert.equal(error.code, 'device_revoked');
      assert.equal(error.terminal, true);
      return true;
    }
  );
  assert.equal(repository.outbox.length, 1);
  assert.equal(snapshots, 0);
});

test('two replicas converge from the same accepted PC log', async () => {
  const log = [
    change('l1', 'a', 1, { title: 'A' }),
    change('l2', 'b', 1, { title: 'B' }),
    change('l3', 'a', 2, { title: 'A2' }),
    change('l4', 'b', 2, {}, { kind: 'delete' }),
  ];

  async function synchronize(order) {
    const repository = new MemoryRepository();
    let pageIndex = 0;
    const pages = [order.slice(0, 3), order.slice(3)];
    const coordinator = new SyncCoordinator({
      profileId: PROFILE_ID,
      deviceId: DEVICE_ID,
      repository,
      transport: {
        async push() {
          throw new Error('not used');
        },
        async pull() {
          const selected = pages[pageIndex] ?? [];
          pageIndex += 1;
          const hasMore = pageIndex < pages.length;
          return {
            changes: selected.map(index => log[index]),
            nextCursor: hasMore ? `page-${pageIndex}` : null,
            hasMore,
            serverTime: 1,
          };
        },
      },
    });
    await coordinator.pullAll();
    return replayChanges([...repository.entities.values()]);
  }

  assert.deepEqual(await synchronize([2, 0, 1, 0, 3]), await synchronize([3, 1, 2, 0, 2]));
});
