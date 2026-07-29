'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { DesktopReminderOutboxError, createDesktopReminderOutboxAdapter } = require('./reminder-outbox-adapter');

function envelope(overrides = {}) {
  return {
    channel: 'desktop',
    delivery: {
      attempt_count: 0,
      channel: 'desktop',
      device_id: 'device-pc',
      id: 'delivery-one',
      profile_id: 'profile-one',
      reminder_id: 'reminder-one',
      revision: 2,
      state: 'delivering',
      ...overrides.delivery,
    },
    deviceId: 'device-pc',
    profileId: 'profile-one',
    reminder: {
      id: 'reminder-one',
      profile_id: 'profile-one',
      revision: 1,
      state: 'scheduled',
      ...overrides.reminder,
    },
    ...overrides,
  };
}

test('resolves only after validating one claimed desktop delivery envelope', async () => {
  const adapter = createDesktopReminderOutboxAdapter();
  const input = envelope();

  assert.equal(await adapter.deliver(input), undefined);
  assert.equal(Object.isFrozen(adapter), true);
  assert.deepEqual(Object.keys(adapter), ['deliver']);
  assert.equal(JSON.stringify(adapter).includes('delivery-one'), false);
});

test('rejects browser and email targets so they cannot be marked desktop-delivered', async () => {
  const adapter = createDesktopReminderOutboxAdapter();

  for (const channel of ['browser', 'email']) {
    await assert.rejects(
      adapter.deliver(
        envelope({
          channel,
          delivery: { channel },
        })
      ),
      error => error instanceof DesktopReminderOutboxError && error.code === 'DESKTOP_REMINDER_ENVELOPE_INVALID'
    );
  }
});

test('rejects malformed, cross-profile, cross-device, stale, and inconsistent envelopes with a redacted error', async () => {
  const secret = 'Bearer malformed-sensitive-value';
  const invalid = [
    undefined,
    null,
    [],
    {},
    envelope({ profileId: secret }),
    envelope({ delivery: { profile_id: 'profile-two' } }),
    envelope({ reminder: { profile_id: 'profile-two' } }),
    envelope({ deviceId: 'device-other' }),
    envelope({ delivery: { device_id: 'device-other' } }),
    envelope({ delivery: { reminder_id: 'reminder-other' } }),
    envelope({ delivery: { state: 'pending' } }),
    envelope({ delivery: { state: 'delivered' } }),
    envelope({ delivery: { revision: 0 } }),
    envelope({ reminder: { revision: 0 } }),
    envelope({ channel: 'desktop', delivery: { channel: 'browser' } }),
  ];

  for (const input of invalid) {
    await assert.rejects(createDesktopReminderOutboxAdapter().deliver(input), error => {
      assert.equal(error instanceof DesktopReminderOutboxError, true);
      assert.equal(error.code, 'DESKTOP_REMINDER_ENVELOPE_INVALID');
      assert.equal(error.message, 'The desktop reminder delivery envelope is invalid.');
      assert.equal(error.message.includes(secret), false);
      return true;
    });
  }
});

test('adapter remains Electron-independent and has no timer, storage, or mutable queue state', () => {
  assert.equal(
    Object.keys(require.cache).some(key => /node_modules[\\/]electron/.test(key)),
    false
  );
  const source = require('node:fs').readFileSync(
    require('node:path').join(__dirname, 'reminder-outbox-adapter.js'),
    'utf8'
  );
  for (const forbidden of ['electron', 'setTimeout', 'setInterval', 'localStorage', 'console.', 'require(']) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
});
