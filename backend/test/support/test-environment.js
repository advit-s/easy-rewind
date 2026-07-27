const assert = require('node:assert/strict');
const { existsSync, lstatSync, mkdtempSync, realpathSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { isAbsolute, join, parse, relative, resolve, sep } = require('node:path');

const fixedTime = '2024-01-02T03:04:05.000Z';

function isContained(parentPath, candidatePath) {
  const candidateRelative = relative(parentPath, candidatePath);
  return (
    candidateRelative === '' ||
    (isAbsolute(candidateRelative) === false &&
      candidateRelative !== '..' &&
      candidateRelative.startsWith(`..${sep}`) === false)
  );
}

function assertUnlinkedExistingPath(targetPath) {
  const resolvedTarget = resolve(targetPath);
  const volumeRoot = parse(resolvedTarget).root;
  let current = volumeRoot;

  for (const component of relative(volumeRoot, resolvedTarget).split(sep).filter(Boolean)) {
    current = join(current, component);
    if (!existsSync(current)) break;
    assert.equal(
      lstatSync(current).isSymbolicLink(),
      false,
      'test environment paths must not traverse a symbolic link or reparse-point link'
    );
  }
}

async function createTestEnvironment(options = {}) {
  const repositoryRoot = realpathSync.native(
    resolve(options.repositoryRoot || process.env.EASY_REWIND_TEST_REPOSITORY_ROOT || join(__dirname, '..', '..', '..'))
  );
  const temporaryRoot = resolve(options.temporaryRoot || tmpdir());

  assert.equal(
    isContained(repositoryRoot, temporaryRoot),
    false,
    'test environment temporary root must be outside the repository'
  );
  assertUnlinkedExistingPath(temporaryRoot);
  const canonicalTemporaryRoot = realpathSync.native(temporaryRoot);
  assert.equal(
    isContained(repositoryRoot, canonicalTemporaryRoot),
    false,
    'test environment canonical temporary root must be outside the repository'
  );

  const root = mkdtempSync(join(canonicalTemporaryRoot, 'easy-rewind-test-'));
  const canonicalRoot = realpathSync.native(root);
  const paths = Object.freeze({
    database: resolve(root, 'database.sqlite'),
    settings: resolve(root, 'settings.json'),
    log: resolve(root, 'logs', 'backend.log'),
    export: resolve(root, 'exports', 'export.json'),
  });
  let nextId = 0;
  let cleaned = false;

  return {
    root: canonicalRoot,
    paths,
    databasePath: paths.database,
    settingsPath: paths.settings,
    logPath: paths.log,
    exportPath: paths.export,
    clock: Object.freeze({
      now: () => new Date(fixedTime),
    }),
    generateId: () => `test-id-${String((nextId += 1)).padStart(4, '0')}`,
    scheduler: Object.freeze({ enabled: false }),
    env: Object.freeze({
      DATABASE_PATH: paths.database,
      SETTINGS_PATH: paths.settings,
      LOG_PATH: paths.log,
      EXPORT_PATH: paths.export,
      EASY_REWIND_FIXED_TIME: fixedTime,
      EASY_REWIND_PROFILE_USER_ID: 'test-profile',
      EASY_REWIND_SCHEDULERS_ENABLED: 'false',
      GEMINI_API_KEY: '',
    }),
    async cleanup() {
      if (cleaned) return;
      if (!existsSync(canonicalRoot)) {
        cleaned = true;
        return;
      }
      const metadata = lstatSync(canonicalRoot);
      assert.equal(
        metadata.isDirectory() && metadata.isSymbolicLink() === false,
        true,
        'test environment cleanup refuses a linked or non-directory root'
      );
      assert.equal(
        realpathSync.native(canonicalRoot),
        canonicalRoot,
        'test environment cleanup refuses a changed canonical root'
      );
      assert.equal(
        isContained(canonicalTemporaryRoot, canonicalRoot),
        true,
        'test environment cleanup target escaped its temporary parent'
      );
      rmSync(canonicalRoot, { recursive: true, force: true });
      cleaned = true;
    },
  };
}

module.exports = { createTestEnvironment };
