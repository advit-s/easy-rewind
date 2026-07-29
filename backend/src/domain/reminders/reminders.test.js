'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');

const BetterSqlite3 = require('better-sqlite3');
const { DomainError, createRepositoryUtils } = require('../repository-utils');
const { createReminderRepository } = require('./reminder-repository');
const { createReminderService } = require('./reminder-service');
const { createReminderWorker } = require('./reminder-worker');

const START = Date.UTC(2026, 6, 28, 12);

function fixture() {
  const db = new BetterSqlite3(':memory:');
  db.pragma('foreign_keys = ON');
  for (const migration of [
    '001_core.sql',
    '002_auth_and_devices.sql',
    '003_jobs_and_sync.sql',
    '004_stage3.sql',
    '005_reminder_outbox.sql',
  ]) {
    db.exec(readFileSync(join(__dirname, '..', '..', 'database', 'migrations', migration), 'utf8'));
  }
  db.prepare('INSERT INTO profiles(id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)').run(
    'profile-one',
    'One',
    START,
    START
  );
  db.prepare('INSERT INTO profiles(id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)').run(
    'profile-two',
    'Two',
    START,
    START
  );
  for (const [id, profileId, platform] of [
    ['device-pc', 'profile-one', 'windows'],
    ['device-phone', 'profile-one', 'android'],
    ['device-other', 'profile-two', 'android'],
  ]) {
    db.prepare(
      `INSERT INTO sync_devices(
         id, profile_id, name, platform, state, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'active', ?, ?)`
    ).run(id, profileId, id, platform, START, START);
  }

  let currentTime = START;
  let sequence = 0;
  const changes = [];
  const jobs = [];
  const repositoryUtils = createRepositoryUtils({
    db,
    ids: () => `reminder-${String((sequence += 1)).padStart(3, '0')}`,
    now: () => currentTime,
  });
  const repository = createReminderRepository({ db, repositoryUtils });
  const service = createReminderService({
    repository,
    jobs: {
      enqueue(job) {
        if (!jobs.some(existing => existing.idempotencyKey === job.idempotencyKey)) jobs.push(job);
      },
    },
    syncRecorder: {
      recordChange(change) {
        changes.push(change);
      },
    },
    now: () => currentTime,
    ids: () => `repeat-${String((sequence += 1)).padStart(3, '0')}`,
  });

  return {
    changes,
    db,
    jobs,
    repository,
    service,
    setTime(value) {
      currentTime = value;
    },
  };
}

const TARGETS = Object.freeze([
  { deviceId: 'device-pc', channel: 'desktop' },
  { deviceId: 'device-phone', channel: 'browser' },
]);

test('creation is owner scoped and creates one durable row per target device', t => {
  const context = fixture();
  t.after(() => context.db.close());

  const reminder = context.service.createReminder({
    profileId: 'profile-one',
    dueAt: START + 1_000,
    targets: TARGETS,
  });

  assert.equal(reminder.profile_id, 'profile-one');
  assert.deepEqual(
    context.repository
      .listDeliveries({ profileId: 'profile-one', reminderId: reminder.id })
      .map(delivery => [delivery.device_id, delivery.channel, delivery.state]),
    [
      ['device-pc', 'desktop', 'pending'],
      ['device-phone', 'browser', 'pending'],
    ]
  );
  assert.equal(context.jobs.length, 2);
  assert.equal(new Set(context.jobs.map(job => job.idempotencyKey)).size, 2);
  assert.equal(context.changes.length, 1);

  assert.throws(
    () =>
      context.service.createReminder({
        profileId: 'profile-one',
        dueAt: START + 1_000,
        targets: [{ deviceId: 'device-other', channel: 'browser' }],
      }),
    error => error instanceof DomainError && error.code === 'NOT_FOUND'
  );
  assert.equal(
    context.db.prepare('SELECT COUNT(*) AS count FROM reminders WHERE profile_id = ?').get('profile-one').count,
    1
  );
});

test('delivery creation is idempotent for the same reminder, device, and channel', t => {
  const context = fixture();
  t.after(() => context.db.close());
  const reminder = context.service.createReminder({
    profileId: 'profile-one',
    dueAt: START,
    targets: [TARGETS[0]],
  });

  const first = context.repository.createDelivery({
    profileId: 'profile-one',
    reminderId: reminder.id,
    ...TARGETS[0],
    scheduledAt: START,
  });
  const second = context.repository.createDelivery({
    profileId: 'profile-one',
    reminderId: reminder.id,
    ...TARGETS[0],
    scheduledAt: START,
  });

  assert.equal(first.id, second.id);
  assert.equal(
    context.db.prepare('SELECT COUNT(*) AS count FROM reminder_deliveries WHERE reminder_id = ?').get(reminder.id)
      .count,
    1
  );
});

test('snooze reschedules every pending target exactly once and stale repeats cannot duplicate', t => {
  const context = fixture();
  t.after(() => context.db.close());
  const original = context.service.createReminder({
    profileId: 'profile-one',
    dueAt: START,
    targets: TARGETS,
  });
  const snoozeUntil = START + 60_000;

  const snoozed = context.service.transitionReminder({
    profileId: 'profile-one',
    id: original.id,
    expectedRevision: 1,
    action: 'snoozed',
    snoozeUntil,
  });
  assert.equal(snoozed.due_at, snoozeUntil);
  assert.equal(snoozed.state, 'snoozed');
  assert.deepEqual(
    context.repository
      .listDeliveries({ profileId: 'profile-one', reminderId: original.id })
      .map(delivery => delivery.scheduled_at),
    [snoozeUntil, snoozeUntil]
  );

  const repeated = context.service.repeatReminder({
    profileId: 'profile-one',
    id: original.id,
    expectedRevision: 2,
    nextDueAt: START + 86_400_000,
  });
  assert.equal(repeated.state, 'scheduled');
  assert.equal(repeated.due_at, START + 86_400_000);
  assert.equal(context.repository.listDeliveries({ profileId: 'profile-one', reminderId: repeated.id }).length, 2);
  assert.throws(
    () =>
      context.service.repeatReminder({
        profileId: 'profile-one',
        id: original.id,
        expectedRevision: 2,
        nextDueAt: START + 86_400_000,
      }),
    error => error instanceof DomainError && error.code === 'CONFLICT'
  );
  assert.equal(context.db.prepare('SELECT COUNT(*) AS count FROM reminders').get().count, 2);
});

test('desktop outbox lists only delivered unacknowledged rows for the authenticated profile and device', t => {
  const context = fixture();
  t.after(() => context.db.close());
  context.db
    .prepare(
      `INSERT INTO items(
         id, profile_id, kind, title, url, excerpt, body, created_at, updated_at
       ) VALUES (?, ?, 'article', ?, ?, ?, ?, ?, ?)`
    )
    .run(
      'item-one',
      'profile-one',
      'Outbox title',
      'https://example.test/notes',
      'Review the durable reminder outbox.',
      'Full private item body.',
      START,
      START
    );
  const firstReminder = context.service.createReminder({
    profileId: 'profile-one',
    itemId: 'item-one',
    dueAt: START,
    targets: [
      { deviceId: 'device-pc', channel: 'desktop' },
      { deviceId: 'device-pc', channel: 'browser' },
      { deviceId: 'device-phone', channel: 'desktop' },
    ],
  });
  const secondReminder = context.service.createReminder({
    profileId: 'profile-one',
    dueAt: START + 1,
    targets: [{ deviceId: 'device-pc', channel: 'desktop' }],
  });
  const otherReminder = context.service.createReminder({
    profileId: 'profile-two',
    dueAt: START,
    targets: [{ deviceId: 'device-other', channel: 'desktop' }],
  });
  for (const [profileId, reminderId] of [
    ['profile-one', firstReminder.id],
    ['profile-one', secondReminder.id],
    ['profile-two', otherReminder.id],
  ]) {
    for (const delivery of context.repository.listDeliveries({ profileId, reminderId })) {
      context.repository.markDelivered({ profileId, id: delivery.id, attemptedAt: START });
    }
  }

  const firstPage = context.service.listDeliveryOutbox({
    profileId: 'profile-one',
    deviceId: 'device-pc',
    channel: 'desktop',
    limit: 1,
  });
  assert.equal(firstPage.items.length, 1);
  assert.equal(firstPage.hasMore, true);
  assert.equal(typeof firstPage.nextCursor, 'string');
  assert.deepEqual(firstPage.items[0], {
    delivery: {
      acknowledgedAt: null,
      channel: 'desktop',
      deliveredAt: START,
      id: firstPage.items[0].delivery.id,
      scheduledAt: START + 1,
      state: 'delivered',
    },
    item: null,
    reminder: {
      body: '',
      dueAt: START + 1,
      id: secondReminder.id,
      revision: 1,
      state: 'scheduled',
      title: 'Easy Rewind reminder',
    },
  });

  const secondPage = context.service.listDeliveryOutbox({
    profileId: 'profile-one',
    deviceId: 'device-pc',
    channel: 'desktop',
    cursor: firstPage.nextCursor,
    limit: 10,
  });
  assert.equal(secondPage.hasMore, false);
  assert.equal(secondPage.nextCursor, null);
  assert.equal(secondPage.items.length, 1);
  assert.deepEqual(secondPage.items[0].item, {
    excerpt: 'Review the durable reminder outbox.',
    id: 'item-one',
    kind: 'article',
    title: 'Outbox title',
    url: 'https://example.test/notes',
  });
  assert.deepEqual(
    {
      body: secondPage.items[0].reminder.body,
      title: secondPage.items[0].reminder.title,
    },
    {
      body: 'Review the durable reminder outbox.',
      title: 'Outbox title',
    }
  );
});

test('acknowledgement is device scoped, durable, idempotent, and does not transition the reminder', t => {
  const context = fixture();
  t.after(() => context.db.close());
  const reminder = context.service.createReminder({
    profileId: 'profile-one',
    dueAt: START,
    targets: TARGETS,
  });
  const deliveries = context.repository.listDeliveries({
    profileId: 'profile-one',
    reminderId: reminder.id,
  });
  const phoneDelivery = deliveries.find(delivery => delivery.device_id === 'device-phone');
  const pcDelivery = deliveries.find(delivery => delivery.device_id === 'device-pc');

  context.repository.markDelivered({
    profileId: 'profile-one',
    id: phoneDelivery.id,
    attemptedAt: START,
  });
  const acknowledged = context.service.acknowledgeDelivery({
    profileId: 'profile-one',
    deviceId: 'device-phone',
    deliveryId: phoneDelivery.id,
  });

  assert.equal(acknowledged.id, phoneDelivery.id);
  assert.equal(acknowledged.state, 'delivered');
  assert.equal(acknowledged.acknowledged_at, START);
  const firstRevision = acknowledged.revision;
  context.setTime(START + 60_000);
  const repeated = context.service.acknowledgeDelivery({
    profileId: 'profile-one',
    deviceId: 'device-phone',
    deliveryId: phoneDelivery.id,
  });
  assert.equal(repeated.acknowledged_at, START);
  assert.equal(repeated.revision, firstRevision);
  assert.equal(context.repository.findReminder('profile-one', reminder.id).state, 'scheduled');
  assert.equal(
    context.service.listDeliveryOutbox({
      profileId: 'profile-one',
      deviceId: 'device-phone',
      channel: 'browser',
      limit: 10,
    }).items.length,
    0
  );
  assert.equal(context.repository.getDelivery('profile-one', pcDelivery.id).state, 'pending');
  assert.throws(
    () =>
      context.service.acknowledgeDelivery({
        profileId: 'profile-one',
        deviceId: 'device-pc',
        deliveryId: phoneDelivery.id,
      }),
    error => error instanceof DomainError && error.code === 'NOT_FOUND'
  );
});

test('worker retries real failed attempts within a bound and fails only after exhaustion', async t => {
  const context = fixture();
  t.after(() => context.db.close());
  const reminder = context.service.createReminder({
    profileId: 'profile-one',
    dueAt: START,
    targets: [TARGETS[0]],
  });
  let attempts = 0;
  const worker = createReminderWorker({
    repository: context.repository,
    notifier: {
      async deliver() {
        attempts += 1;
        throw new Error('device offline: private detail');
      },
    },
    leases: {
      async withLease(_key, work) {
        return work();
      },
    },
    now: () => START,
    maxAttempts: 2,
  });

  await worker.runOnce({ profileId: 'profile-one' });
  let delivery = context.repository.listDeliveries({ profileId: 'profile-one', reminderId: reminder.id })[0];
  assert.equal(attempts, 1);
  assert.equal(delivery.attempt_count, 1);
  assert.equal(delivery.state, 'pending');
  assert.equal(context.repository.findReminder('profile-one', reminder.id).state, 'scheduled');

  await worker.runOnce({ profileId: 'profile-one' });
  delivery = context.repository.getDelivery('profile-one', delivery.id);
  assert.equal(attempts, 2);
  assert.equal(delivery.attempt_count, 2);
  assert.equal(delivery.state, 'failed');
  assert.equal(delivery.error_code, 'NOTIFICATION_FAILED');
  assert.equal(context.repository.findReminder('profile-one', reminder.id).state, 'failed');

  await worker.runOnce({ profileId: 'profile-one' });
  assert.equal(attempts, 2);
});

test('restart recovery requeues an interrupted claim without inventing an attempt', async t => {
  const context = fixture();
  t.after(() => context.db.close());
  const reminder = context.service.createReminder({
    profileId: 'profile-one',
    dueAt: START,
    targets: [TARGETS[0]],
  });
  const delivery = context.repository.listDeliveries({ profileId: 'profile-one', reminderId: reminder.id })[0];
  context.repository.claimDelivery({
    profileId: 'profile-one',
    id: delivery.id,
    expectedRevision: delivery.revision,
  });

  const delivered = [];
  const worker = createReminderWorker({
    repository: context.repository,
    notifier: {
      async deliver(input) {
        delivered.push(input.delivery.id);
      },
    },
    leases: {
      async withLease(_key, work) {
        return work();
      },
    },
    now: () => START,
    maxAttempts: 3,
  });

  await worker.start({ profileId: 'profile-one' });
  const recovered = context.repository.getDelivery('profile-one', delivery.id);
  assert.deepEqual(delivered, [delivery.id]);
  assert.equal(recovered.attempt_count, 1);
  assert.equal(recovered.state, 'delivered');
  assert.equal(recovered.delivered_at, START);
});
