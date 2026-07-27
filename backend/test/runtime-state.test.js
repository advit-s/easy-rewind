const assert = require('node:assert/strict');
const { writeFileSync } = require('node:fs');
const test = require('node:test');

const { closeDb, config, getDb, getGenAI, loadSettings, resetGenAI, resetRuntimeState } = require('../routes/helpers');
const { createTestEnvironment } = require('./support/test-environment');

const runtimeEnvironmentKeys = [
  'DATABASE_PATH',
  'SETTINGS_PATH',
  'LOG_PATH',
  'EXPORT_PATH',
  'EASY_REWIND_PROFILE_USER_ID',
  'EASY_REWIND_SCHEDULERS_ENABLED',
  'GEMINI_API_KEY',
];

function captureEnvironment() {
  return Object.fromEntries(runtimeEnvironmentKeys.map(key => [key, process.env[key]]));
}

function applyEnvironment(environment, apiKey = '') {
  Object.assign(process.env, environment.env, { GEMINI_API_KEY: apiKey });
}

function restoreEnvironment(previousEnvironment) {
  for (const key of runtimeEnvironmentKeys) {
    if (previousEnvironment[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnvironment[key];
  }
}

function restoreRuntimeSingletons() {
  closeDb();
  resetGenAI();
  Object.assign(config, {
    apiKey: process.env.GEMINI_API_KEY || null,
    model: 'gemini-2.5-flash',
    apiBaseUrl: 'http://localhost:5000',
    summarizationBackend: 'auto',
    spacedReviewEnabled: true,
    reviewIntervalDays: 3,
    profileUserId: null,
    embedProvider: 'auto',
  });
  delete config.digestPrefs;
}

test('a missing settings environment does not inherit model, review interval, or AI state', async () => {
  const first = await createTestEnvironment();
  const second = await createTestEnvironment();
  const previousEnvironment = captureEnvironment();

  try {
    writeFileSync(
      first.paths.settings,
      JSON.stringify({
        apiKey: 'fixture-ai-key',
        model: 'fixture-model',
        reviewIntervalDays: 19,
        profileUserId: 'first-profile',
      })
    );
    applyEnvironment(first);
    loadSettings();
    const firstClient = getGenAI();
    assert.notEqual(firstClient, null);
    assert.equal(config.model, 'fixture-model');
    assert.equal(config.reviewIntervalDays, 19);

    applyEnvironment(second);
    loadSettings();

    assert.equal(config.model, 'gemini-2.5-flash');
    assert.equal(config.reviewIntervalDays, 3);
    assert.equal(getGenAI(), null);
  } finally {
    restoreRuntimeSingletons();
    restoreEnvironment(previousEnvironment);
    await first.cleanup();
    await second.cleanup();
  }
});

test('resetRuntimeState closes the database and clears runtime state without loading settings', async () => {
  const environment = await createTestEnvironment();
  const previousEnvironment = captureEnvironment();

  try {
    applyEnvironment(environment, 'fixture-environment-key');
    config.model = 'fixture-model';
    config.reviewIntervalDays = 23;
    const database = getDb();
    assert.equal(database.open, true);
    const firstClient = getGenAI();
    assert.notEqual(firstClient, null);

    resetRuntimeState({ loadSettings: false });

    assert.equal(database.open, false);
    assert.equal(config.model, 'gemini-2.5-flash');
    assert.equal(config.reviewIntervalDays, 3);
    assert.notEqual(getGenAI(), firstClient);
  } finally {
    restoreRuntimeSingletons();
    restoreEnvironment(previousEnvironment);
    await environment.cleanup();
  }
});
