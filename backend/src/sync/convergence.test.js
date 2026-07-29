'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { replayChanges } = require('./sync-service');

test('replicas converge from duplicate, reordered, interrupted, and clock-skewed deliveries', () => {
  const accepted = [
    { changeId: 'c1', entityType: 'item', entityId: 'a', kind: 'upsert', revision: 1, payload: { title: 'A' } },
    { changeId: 'c2', entityType: 'item', entityId: 'b', kind: 'upsert', revision: 1, payload: { title: 'B' } },
    { changeId: 'c3', entityType: 'item', entityId: 'a', kind: 'upsert', revision: 2, payload: { title: 'A2' } },
    { changeId: 'c4', entityType: 'item', entityId: 'b', kind: 'delete', revision: 2, payload: {} },
  ];
  const left = replayChanges([accepted[2], accepted[0], accepted[1], accepted[0], accepted[3]]);
  const right = replayChanges([accepted[3], accepted[1], accepted[2], accepted[0], accepted[2]]);
  assert.deepEqual(left, right);
  assert.deepEqual(left, {
    'item:a': { kind: 'upsert', revision: 2, payload: { title: 'A2' } },
    'item:b': { kind: 'delete', revision: 2, payload: {} },
  });
});

test('authoritative revision wins regardless of client timestamps or delivery order', () => {
  const histories = [
    [
      { changeId: 'new', entityType: 'note', entityId: 'n', kind: 'upsert', revision: 3, payload: { body: 'new' } },
      { changeId: 'old', entityType: 'note', entityId: 'n', kind: 'delete', revision: 2, payload: {} },
    ],
    [
      { changeId: 'old', entityType: 'note', entityId: 'n', kind: 'delete', revision: 2, payload: {} },
      { changeId: 'new', entityType: 'note', entityId: 'n', kind: 'upsert', revision: 3, payload: { body: 'new' } },
    ],
  ];
  assert.deepEqual(replayChanges(histories[0]), replayChanges(histories[1]));
});
