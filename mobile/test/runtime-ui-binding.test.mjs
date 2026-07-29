import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { openMobileDatabase } from '../src/db/open-database.ts';
import { createMobileRuntime, mapDomainSyncState } from '../src/runtime/mobile-runtime.ts';

function memoryCredentialStore() {
  const values = new Map();
  return {
    values,
    async get(key) {
      return values.get(key) ?? null;
    },
    async set(key, value) {
      values.set(key, value);
    },
    async remove(key) {
      values.delete(key);
    },
  };
}

function databaseOpener(root) {
  return async databaseName => {
    const database = new Database(path.join(root, databaseName));
    return openMobileDatabase({
      databasePath: databaseName,
      open: () => database,
      now: () => 1_800_000_000_000,
    });
  };
}

test('runtime persists local identity and content across launches without pairing', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'easy-rewind-runtime-'));
  const credentials = memoryCredentialStore();
  const ids = ['profile-a', 'device-a', 'item-a'];
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const first = createMobileRuntime({
    credentialStore: credentials,
    openDatabase: databaseOpener(root),
    now: () => 1_800_000_000_000,
    generateId: prefix => `${prefix}-${ids.shift()}`,
  });
  const snapshots = [];
  const unsubscribe = first.subscribe(snapshot => snapshots.push(snapshot));
  await first.initialize();

  assert.equal(first.snapshot().status, 'ready');
  assert.equal(credentials.values.get('easy-rewind/mobile/profile-id'), 'profile-profile-a');
  assert.equal(credentials.values.get('easy-rewind/mobile/device-id'), 'device-device-a');

  const created = first.createContent({
    kind: 'item',
    title: 'Offline capture',
    content: 'Stored in SQLite first.',
  });
  assert.equal(created.syncState, 'local_only');
  assert.equal(first.localStatus().syncState, 'offline');
  assert.equal(first.listContent('').length, 1);
  assert.ok(snapshots.some(snapshot => snapshot.revision > 0));
  unsubscribe();
  first.dispose();

  const second = createMobileRuntime({
    credentialStore: credentials,
    openDatabase: databaseOpener(root),
    now: () => 1_800_000_000_000,
    generateId: prefix => `${prefix}-unused`,
  });
  await second.initialize();
  assert.equal(second.identity().profileId, 'profile-profile-a');
  assert.equal(second.identity().deviceId, 'device-device-a');
  assert.equal(second.listContent('Offline')[0].title, 'Offline capture');
  assert.equal(second.localStatus().pairedPcName, null);
  second.dispose();
});

test('runtime binds reminders, review ratings, conflicts, and truthful sync state', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'easy-rewind-runtime-domain-'));
  const ids = ['profile-b', 'device-b', 'reminder-b', 'flashcard-b'];
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runtime = createMobileRuntime({
    credentialStore: memoryCredentialStore(),
    openDatabase: databaseOpener(root),
    now: () => 1_800_000_000_000,
    generateId: prefix => `${prefix}-${ids.shift()}`,
  });
  await runtime.initialize();

  runtime.createReminder({
    title: 'Review local item',
    dueAt: 1_800_000_000_100,
  });
  runtime.createFlashcard({
    front: 'Question',
    back: 'Answer',
    dueAt: 1_800_000_000_000,
  });

  assert.equal(runtime.listReminders()[0].title, 'Review local item');
  const due = runtime.nextDueFlashcard();
  assert.equal(due.front, 'Question');
  const rated = runtime.rateFlashcard(due.id, 'good');
  assert.equal(rated.reviewCount, 1);
  assert.ok(rated.dueAt > 1_800_000_000_000);
  assert.deepEqual(runtime.listConflicts(), []);
  assert.deepEqual(runtime.localStatus(), {
    syncState: 'offline',
    queuedCount: 3,
    conflictCount: 0,
    pairedPcName: null,
  });
  runtime.dispose();
});

test('domain states map to truthful UI states without implying cloud or pairing', () => {
  assert.deepEqual(['local_only', 'queued', 'synchronized', 'conflicted', 'failed'].map(mapDomainSyncState), [
    'offline',
    'queued',
    'synchronized',
    'conflicted',
    'retry',
  ]);
});
