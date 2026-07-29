'use strict';

const { fail } = require('../domain-error');
const { createRepositoryUtils } = require('../repository-utils');

const MAX_SETTING_JSON_BYTES = 16_384;

const DIGEST_DEFAULTS = Object.freeze({
  enabled: true,
  frequency: 'weekly',
  day_of_week: 0,
  hour: 9,
  include_bookmarks: true,
  include_notes: true,
  include_highlights: true,
  include_flashcards: true,
  include_quiz: true,
  include_ai_summary: true,
  send_email: false,
});

function boolean(value) {
  if (typeof value !== 'boolean') fail('REPOSITORY_INPUT_INVALID');
  return value;
}

function integer(minimum, maximum) {
  return value => {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
      fail('REPOSITORY_INPUT_INVALID');
    }
    return value;
  };
}

function oneOf(values) {
  const allowed = new Set(values);
  return value => {
    if (!allowed.has(value)) fail('REPOSITORY_INPUT_INVALID');
    return value;
  };
}

function model(value) {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 128 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
  ) {
    fail('REPOSITORY_INPUT_INVALID');
  }
  return value;
}

const SETTING_VALIDATORS = Object.freeze({
  'ai.embeddingProvider': oneOf(['auto', 'gemini', 'openai']),
  'ai.model': model,
  'ai.summarizationBackend': oneOf(['auto', 'chrome', 'local', 'gemini', 'backend']),
  'appearance.theme': oneOf(['system', 'light', 'dark']),
  'digest.dayOfWeek': integer(0, 6),
  'digest.enabled': boolean,
  'digest.frequency': oneOf(['daily', 'weekly', 'monthly']),
  'digest.hour': integer(0, 23),
  'digest.includeAiSummary': boolean,
  'digest.includeBookmarks': boolean,
  'digest.includeFlashcards': boolean,
  'digest.includeHighlights': boolean,
  'digest.includeNotes': boolean,
  'digest.includeQuiz': boolean,
  'digest.sendEmail': boolean,
  'learning.reviewIntervalDays': integer(1, 365),
  'learning.spacedReviewEnabled': boolean,
  'privacy.captureEnabled': boolean,
  'privacy.remoteAiAllowed': boolean,
  'privacy.storePageContent': boolean,
  'privacy.syncOverLan': boolean,
  'reminder.defaultLeadMinutes': integer(0, 525_600),
  'reminder.enabled': boolean,
  'reminder.notificationsEnabled': boolean,
});

const SETTING_KEYS = Object.freeze(Object.keys(SETTING_VALIDATORS).sort());

const SETTINGS_COMPATIBILITY_KEYS = Object.freeze({
  ai_model: 'ai.model',
  capture_enabled: 'privacy.captureEnabled',
  default_reminder_lead_minutes: 'reminder.defaultLeadMinutes',
  embed_provider: 'ai.embeddingProvider',
  notifications_enabled: 'reminder.notificationsEnabled',
  remote_ai_allowed: 'privacy.remoteAiAllowed',
  reminders_enabled: 'reminder.enabled',
  review_interval_days: 'learning.reviewIntervalDays',
  spaced_review_enabled: 'learning.spacedReviewEnabled',
  store_page_content: 'privacy.storePageContent',
  summarization_backend: 'ai.summarizationBackend',
  sync_over_lan: 'privacy.syncOverLan',
  theme: 'appearance.theme',
});

const DIGEST_COMPATIBILITY_KEYS = Object.freeze({
  day_of_week: 'digest.dayOfWeek',
  enabled: 'digest.enabled',
  frequency: 'digest.frequency',
  hour: 'digest.hour',
  include_ai_summary: 'digest.includeAiSummary',
  include_bookmarks: 'digest.includeBookmarks',
  include_flashcards: 'digest.includeFlashcards',
  include_highlights: 'digest.includeHighlights',
  include_notes: 'digest.includeNotes',
  include_quiz: 'digest.includeQuiz',
  send_email: 'digest.sendEmail',
});

function object(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('REPOSITORY_INPUT_INVALID');
  }
  return value;
}

function profileId(value) {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 256 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    fail('REPOSITORY_INPUT_INVALID');
  }
  return value;
}

function canonicalKey(value) {
  if (typeof value !== 'string' || !Object.hasOwn(SETTING_VALIDATORS, value)) {
    fail('REPOSITORY_INPUT_INVALID');
  }
  return value;
}

function expectedRevision(value, { creating = false } = {}) {
  if (creating) {
    if (value === undefined || value === null || value === 0) return;
    fail('CONFLICT');
  }
  if (!Number.isSafeInteger(value) || value < 1) fail('CONFLICT');
  return value;
}

function compatibilityInput(value, mapping) {
  const input = object(value);
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(mapping, key)) fail('REPOSITORY_INPUT_INVALID');
  }
  return input;
}

function createSettingsService(options = {}) {
  const input = object(options);
  const { db } = input;
  const syncRecorder = input.syncRecorder ?? Object.freeze({ recordChange() {} });
  if (syncRecorder === null || typeof syncRecorder !== 'object' || typeof syncRecorder.recordChange !== 'function') {
    fail('REPOSITORY_CONFIGURATION_INVALID');
  }
  const repository = createRepositoryUtils(input);

  function recordChange(record) {
    syncRecorder.recordChange({
      profileId: record.profileId,
      entityType: 'setting',
      entityId: record.id,
      revision: record.revision,
      changeKind: 'upsert',
      record,
    });
    return record;
  }

  function mapRow(row) {
    return {
      id: row.id,
      profileId: row.profile_id,
      key: row.key,
      value: repository.parseJson(row.value_json),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      revision: row.revision,
    };
  }

  function validateValue(key, value) {
    const validated = SETTING_VALIDATORS[key](value);
    const serialized = repository.serializeJson(validated);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_SETTING_JSON_BYTES) {
      fail('REPOSITORY_INPUT_INVALID');
    }
    return serialized;
  }

  function find(owner, key) {
    return db
      .prepare(
        `SELECT id, profile_id, key, value_json, created_at, updated_at, revision
         FROM settings
         WHERE profile_id = ? AND key = ? AND deleted_at IS NULL
         LIMIT 1`
      )
      .get(owner, key);
  }

  function get({ profileId: ownerValue, key: keyValue } = {}) {
    const owner = profileId(ownerValue);
    const key = canonicalKey(keyValue);
    const row = find(owner, key);
    if (!row) fail('NOT_FOUND');
    return mapRow(row);
  }

  function list({ profileId: ownerValue } = {}) {
    const owner = profileId(ownerValue);
    const rows = db
      .prepare(
        `SELECT id, profile_id, key, value_json, created_at, updated_at, revision
         FROM settings
         WHERE profile_id = ? AND deleted_at IS NULL
         ORDER BY key ASC, id ASC`
      )
      .all(owner);
    return rows.map(mapRow);
  }

  function upsert({ profileId: ownerValue, key: keyValue, value, expectedRevision: expected } = {}) {
    const owner = profileId(ownerValue);
    const key = canonicalKey(keyValue);
    const valueJson = validateValue(key, value);

    return repository.transaction(() => {
      const current = find(owner, key);
      if (!current) {
        expectedRevision(expected, { creating: true });
        const record = repository.newRecord();
        try {
          db.prepare(
            `INSERT INTO settings(
               id, profile_id, key, value_json, created_at, updated_at, revision, deleted_at
             ) VALUES (?, ?, ?, ?, ?, ?, 1, NULL)`
          ).run(record.id, owner, key, valueJson, record.createdAt, record.updatedAt);
        } catch (error) {
          if (error?.code === 'SQLITE_CONSTRAINT_UNIQUE') fail('CONFLICT');
          throw error;
        }
        return recordChange(get({ profileId: owner, key }));
      }

      const revision = expectedRevision(expected);
      if (revision !== current.revision || current.revision >= Number.MAX_SAFE_INTEGER) {
        fail('CONFLICT');
      }
      const updatedAt = repository.timestamp();
      const result = db
        .prepare(
          `UPDATE settings
           SET value_json = ?, updated_at = ?, revision = revision + 1
           WHERE profile_id = ? AND id = ? AND revision = ? AND deleted_at IS NULL`
        )
        .run(valueJson, updatedAt, owner, current.id, revision);
      if (result.changes !== 1) fail('CONFLICT');
      return recordChange(get({ profileId: owner, key }));
    });
  }

  function compatibilitySnapshot(ownerValue, mapping, defaults = {}) {
    const owner = profileId(ownerValue);
    const byCanonicalKey = new Map(list({ profileId: owner }).map(setting => [setting.key, setting]));
    const settings = { ...defaults };
    const revisions = {};
    for (const legacyKey of Object.keys(mapping).sort()) {
      const setting = byCanonicalKey.get(mapping[legacyKey]);
      if (setting !== undefined) {
        settings[legacyKey] = setting.value;
        revisions[legacyKey] = setting.revision;
      }
    }
    return { settings, revisions };
  }

  function compatibilityUpdate({ profileId: ownerValue, settings, expectedRevisions = {} } = {}, mapping, defaults) {
    const owner = profileId(ownerValue);
    const values = compatibilityInput(settings, mapping);
    const revisions = compatibilityInput(expectedRevisions, mapping);
    return repository.transaction(() => {
      for (const legacyKey of Object.keys(values).sort()) {
        const key = mapping[legacyKey];
        const current = find(owner, key);
        const expected =
          revisions[legacyKey] === undefined
            ? current === undefined
              ? undefined
              : current.revision
            : revisions[legacyKey];
        upsert({
          profileId: owner,
          key,
          value: values[legacyKey],
          ...(expected === undefined ? {} : { expectedRevision: expected }),
        });
      }
      return compatibilitySnapshot(owner, mapping, defaults);
    });
  }

  function readSettings({ profileId: owner } = {}) {
    return compatibilitySnapshot(owner, SETTINGS_COMPATIBILITY_KEYS);
  }

  function updateSettings(inputValue) {
    return compatibilityUpdate(inputValue, SETTINGS_COMPATIBILITY_KEYS);
  }

  function readDigestSettings({ profileId: owner } = {}) {
    return compatibilitySnapshot(owner, DIGEST_COMPATIBILITY_KEYS, DIGEST_DEFAULTS);
  }

  function updateDigestSettings(inputValue) {
    return compatibilityUpdate(inputValue, DIGEST_COMPATIBILITY_KEYS, DIGEST_DEFAULTS);
  }

  return Object.freeze({
    get,
    list,
    readDigestSettings,
    readSettings,
    updateDigestSettings,
    updateSettings,
    upsert,
  });
}

module.exports = {
  DIGEST_DEFAULTS,
  SETTING_KEYS,
  createSettingsService,
};
