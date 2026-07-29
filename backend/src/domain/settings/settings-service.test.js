'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const Database = require('better-sqlite3');

const { runMigrations } = require('../../database/migration-runner');
const { createSettingsService, DIGEST_DEFAULTS } = require('./settings-service');

const OWNER = '10000000-0000-4000-8000-000000000001';
const OTHER_OWNER = '10000000-0000-4000-8000-000000000002';

function fixture() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations({ db, now: () => 1 });
  db.prepare(
    `INSERT INTO profiles(id, display_name, created_at, updated_at, revision)
     VALUES (?, ?, 1, 1, 1)`
  ).run(OWNER, 'Owner');
  db.prepare(
    `INSERT INTO profiles(id, display_name, created_at, updated_at, revision)
     VALUES (?, ?, 1, 1, 1)`
  ).run(OTHER_OWNER, 'Other');

  let sequence = 0;
  let clock = 1_700_000_000_000;
  const service = createSettingsService({
    db,
    ids: () => `setting-${++sequence}`,
    now: () => ++clock,
  });
  return { db, service };
}

test('upsert, get, and list are owner scoped with deterministic records', () => {
  const { db, service } = fixture();
  const dark = service.upsert({
    profileId: OWNER,
    key: 'appearance.theme',
    value: 'dark',
  });
  service.upsert({
    profileId: OWNER,
    key: 'privacy.captureEnabled',
    value: false,
  });
  service.upsert({
    profileId: OTHER_OWNER,
    key: 'appearance.theme',
    value: 'light',
  });

  assert.deepEqual(dark, {
    id: 'setting-1',
    profileId: OWNER,
    key: 'appearance.theme',
    value: 'dark',
    createdAt: 1_700_000_000_001,
    updatedAt: 1_700_000_000_001,
    revision: 1,
  });
  assert.deepEqual(service.get({ profileId: OWNER, key: 'appearance.theme' }), dark);
  assert.deepEqual(
    service.list({ profileId: OWNER }).map(setting => setting.key),
    ['appearance.theme', 'privacy.captureEnabled']
  );
  assert.equal(
    service.list({ profileId: OWNER }).some(setting => setting.value === 'light'),
    false
  );
  assert.throws(() => service.get({ profileId: OTHER_OWNER, key: 'privacy.captureEnabled' }), {
    code: 'NOT_FOUND',
  });
  db.close();
});

test('updates require the current revision and never change another owner record', () => {
  const { db, service } = fixture();
  assert.throws(
    () =>
      service.upsert({
        profileId: OWNER,
        key: 'appearance.theme',
        value: 'dark',
        expectedRevision: 1,
      }),
    { code: 'CONFLICT' }
  );
  const owner = service.upsert({
    profileId: OWNER,
    key: 'ai.model',
    value: 'gemini-2.5-flash',
  });
  const other = service.upsert({
    profileId: OTHER_OWNER,
    key: 'ai.model',
    value: 'local-model',
  });

  assert.throws(
    () =>
      service.upsert({
        profileId: OWNER,
        key: 'ai.model',
        value: 'gemini-2.5-pro',
        expectedRevision: 9,
      }),
    { code: 'CONFLICT' }
  );
  const updated = service.upsert({
    profileId: OWNER,
    key: 'ai.model',
    value: 'gemini-2.5-pro',
    expectedRevision: owner.revision,
  });

  assert.equal(updated.id, owner.id);
  assert.equal(updated.revision, 2);
  assert.equal(updated.createdAt, owner.createdAt);
  assert.equal(updated.value, 'gemini-2.5-pro');
  assert.deepEqual(service.get({ profileId: OTHER_OWNER, key: 'ai.model' }), other);
  assert.throws(
    () =>
      service.upsert({
        profileId: OWNER,
        key: 'ai.model',
        value: 'gemini-2.5-flash',
      }),
    { code: 'CONFLICT' }
  );
  db.close();
});

test('strict allowlist and value schemas reject secrets, credentials, URLs, and oversized values', () => {
  const { db, service } = fixture();
  const rejected = [
    ['gemini_api_key', 'provider-secret'],
    ['ai.apiKey', 'provider-secret'],
    ['provider.credentials', { token: 'provider-secret' }],
    ['ai.model', 'https://user:password@example.test/model'],
    ['ai.model', 'x'.repeat(129)],
    ['digest.enabled', 'true'],
    ['digest.dayOfWeek', 7],
    ['reminder.defaultLeadMinutes', -1],
    ['privacy.captureEnabled', { password: 'provider-secret' }],
  ];

  for (const [key, value] of rejected) {
    assert.throws(() => service.upsert({ profileId: OWNER, key, value }), {
      code: 'REPOSITORY_INPUT_INVALID',
    });
  }

  assert.equal(db.prepare('SELECT count(*) FROM settings').pluck().get(), 0);
  db.close();
});

test('readSettings and updateSettings expose only stable non-secret compatibility preferences', () => {
  const { db, service } = fixture();
  const first = service.updateSettings({
    profileId: OWNER,
    settings: {
      ai_model: 'gemini-2.5-flash',
      summarization_backend: 'local',
      spaced_review_enabled: true,
      review_interval_days: 4,
      embed_provider: 'gemini',
      theme: 'dark',
      capture_enabled: false,
      remote_ai_allowed: false,
    },
  });

  assert.deepEqual(first.settings, {
    ai_model: 'gemini-2.5-flash',
    capture_enabled: false,
    embed_provider: 'gemini',
    remote_ai_allowed: false,
    review_interval_days: 4,
    spaced_review_enabled: true,
    summarization_backend: 'local',
    theme: 'dark',
  });
  assert.deepEqual(Object.keys(first.revisions), [
    'ai_model',
    'capture_enabled',
    'embed_provider',
    'remote_ai_allowed',
    'review_interval_days',
    'spaced_review_enabled',
    'summarization_backend',
    'theme',
  ]);
  assert.deepEqual(service.readSettings({ profileId: OWNER }), first);

  const second = service.updateSettings({
    profileId: OWNER,
    settings: { ai_model: 'gemini-2.5-pro' },
    expectedRevisions: { ai_model: first.revisions.ai_model },
  });
  assert.equal(second.settings.ai_model, 'gemini-2.5-pro');
  assert.equal(second.revisions.ai_model, 2);
  assert.throws(
    () =>
      service.updateSettings({
        profileId: OWNER,
        settings: { api_key: 'provider-secret' },
      }),
    { code: 'REPOSITORY_INPUT_INVALID' }
  );
  assert.deepEqual(service.readSettings({ profileId: OTHER_OWNER }), {
    settings: {},
    revisions: {},
  });
  db.close();
});

test('digest helpers provide deterministic defaults and validated owner-scoped updates', () => {
  const { db, service } = fixture();
  assert.deepEqual(service.readDigestSettings({ profileId: OWNER }), {
    settings: DIGEST_DEFAULTS,
    revisions: {},
  });

  const updated = service.updateDigestSettings({
    profileId: OWNER,
    settings: {
      enabled: false,
      frequency: 'daily',
      day_of_week: 3,
      hour: 18,
      include_ai_summary: false,
      send_email: true,
    },
  });
  assert.deepEqual(updated.settings, {
    ...DIGEST_DEFAULTS,
    day_of_week: 3,
    enabled: false,
    frequency: 'daily',
    hour: 18,
    include_ai_summary: false,
    send_email: true,
  });
  assert.equal(Object.keys(updated.revisions).length, 6);
  assert.deepEqual(service.readDigestSettings({ profileId: OWNER }), updated);
  assert.deepEqual(service.readDigestSettings({ profileId: OTHER_OWNER }), {
    settings: DIGEST_DEFAULTS,
    revisions: {},
  });
  assert.throws(
    () =>
      service.updateDigestSettings({
        profileId: OWNER,
        settings: { frequency: 'whenever' },
      }),
    { code: 'REPOSITORY_INPUT_INVALID' }
  );
  db.close();
});
