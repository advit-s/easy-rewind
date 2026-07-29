import assert from 'node:assert/strict';
import test from 'node:test';

import { createExpoNotificationPort, createMobileReminderNotifications } from '../src/platform/expo-notifications.ts';

function createReminderHarness() {
  const rows = new Map([
    [
      'reminder-1',
      {
        id: 'reminder-1',
        profileId: 'profile-1',
        title: 'Review saved memory',
        body: 'Open the review queue.',
        dueAt: 1_800_000_060_000,
        state: 'scheduled',
        localNotificationId: null,
      },
    ],
  ]);
  const scheduled = [];
  const cancelled = [];
  const edits = [];
  const notifications = {
    async schedule(request) {
      scheduled.push(request);
      return `native-${scheduled.length}`;
    },
    async cancel(id) {
      cancelled.push(id);
    },
  };
  const reminders = {
    get(id) {
      return rows.get(id) ?? null;
    },
    edit(id, patch) {
      edits.push([id, patch]);
      const next = { ...rows.get(id), ...patch };
      rows.set(id, next);
      return next;
    },
  };
  return {
    rows,
    scheduled,
    cancelled,
    edits,
    service: createMobileReminderNotifications({ notifications, reminders }),
  };
}

test('schedules one local Android notification and stores only its local identifier', async () => {
  const harness = createReminderHarness();

  const result = await harness.service.ensureScheduled('reminder-1');
  assert.equal(result.localNotificationId, 'native-1');
  assert.deepEqual(harness.scheduled, [
    {
      id: 'android:profile-1:reminder:reminder-1',
      title: 'Review saved memory',
      body: 'Open the review queue.',
      triggerAtUtcMs: 1_800_000_060_000,
      data: { reminderId: 'reminder-1', profileId: 'profile-1' },
    },
  ]);
  assert.deepEqual(harness.edits, [['reminder-1', { localNotificationId: 'native-1' }]]);

  await harness.service.ensureScheduled('reminder-1');
  assert.equal(harness.scheduled.length, 1, 'an unchanged reminder must not create a duplicate notification');
});

test('rescheduling cancels the previous local delivery before recording its replacement', async () => {
  const harness = createReminderHarness();
  await harness.service.ensureScheduled('reminder-1');

  const result = await harness.service.reschedule('reminder-1');
  assert.deepEqual(harness.cancelled, ['native-1']);
  assert.equal(result.localNotificationId, 'native-2');
  assert.equal(harness.rows.get('reminder-1').localNotificationId, 'native-2');
});

test('cancellation is idempotent and never calls a PC delivery endpoint', async () => {
  const harness = createReminderHarness();
  await harness.service.ensureScheduled('reminder-1');

  await harness.service.cancel('reminder-1');
  await harness.service.cancel('reminder-1');

  assert.deepEqual(harness.cancelled, ['native-1']);
  assert.equal(harness.rows.get('reminder-1').localNotificationId, null);
  assert.equal(harness.rows.get('reminder-1').state, 'scheduled');
});

test('acknowledging on Android completes the domain reminder without representing PC delivery', async () => {
  const harness = createReminderHarness();
  await harness.service.ensureScheduled('reminder-1');

  const result = await harness.service.acknowledgeOnAndroid('reminder-1');

  assert.equal(result.state, 'completed');
  assert.equal(result.localNotificationId, null);
  assert.deepEqual(harness.edits.at(-1), [
    'reminder-1',
    {
      localNotificationId: null,
      state: 'completed',
    },
  ]);
  assert.equal(
    JSON.stringify(harness.edits).includes('pcDelivery'),
    false,
    'Android acknowledgement must not acknowledge a PC notification attempt'
  );
});

test('Expo notification adapter imports lazily, configures Android, and maps schedule and cancel', async () => {
  const calls = [];
  let imported = false;
  const port = createExpoNotificationPort({
    platform: 'android',
    async loadModule(specifier) {
      imported = true;
      assert.equal(specifier, 'expo-notifications');
      return {
        AndroidImportance: { HIGH: 4 },
        async getPermissionsAsync() {
          calls.push(['permissions']);
          return { granted: true };
        },
        async setNotificationChannelAsync(id, options) {
          calls.push(['channel', id, options]);
        },
        async scheduleNotificationAsync(request) {
          calls.push(['schedule', request]);
          return 'expo-native-id';
        },
        async cancelScheduledNotificationAsync(id) {
          calls.push(['cancel', id]);
        },
      };
    },
  });

  assert.equal(imported, false);
  const id = await port.schedule({
    id: 'stable-local-id',
    title: 'Reminder',
    body: 'Body',
    triggerAtUtcMs: 1_800_000_060_000,
    data: { reminderId: 'reminder-1' },
  });
  await port.cancel(id);

  assert.equal(id, 'expo-native-id');
  assert.deepEqual(calls[0], ['permissions']);
  assert.equal(calls[1][0], 'channel');
  assert.deepEqual(calls[2], [
    'schedule',
    {
      content: {
        title: 'Reminder',
        body: 'Body',
        data: { localDeliveryId: 'stable-local-id', reminderId: 'reminder-1' },
      },
      trigger: {
        type: 'date',
        date: 1_800_000_060_000,
        channelId: 'easy-rewind-reminders',
      },
    },
  ]);
  assert.deepEqual(calls[3], ['cancel', 'expo-native-id']);
});

test('Expo notification adapter fails truthfully when notification permission is unavailable', async () => {
  const port = createExpoNotificationPort({
    async loadModule() {
      return {
        AndroidImportance: { HIGH: 4 },
        async getPermissionsAsync() {
          return { granted: false };
        },
        async setNotificationChannelAsync() {},
        async scheduleNotificationAsync() {
          throw new Error('must not schedule');
        },
        async cancelScheduledNotificationAsync() {},
      };
    },
  });

  await assert.rejects(
    () =>
      port.schedule({
        title: 'Reminder',
        body: '',
        triggerAtUtcMs: 1_800_000_060_000,
      }),
    error => error.code === 'notification_permission_required'
  );
});
