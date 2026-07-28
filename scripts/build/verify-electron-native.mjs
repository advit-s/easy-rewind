import { createRequire } from 'node:module';
import { lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const expectedNativeDependencies = Object.freeze({
  'better-sqlite3': '13.0.1',
});
const expectedStagedPackages = new Set(['better-sqlite3', 'node-addon-api']);

class NativeVerificationError extends Error {}

function fail() {
  throw new NativeVerificationError();
}

function comparable(path) {
  const normalized = resolve(path);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isInside(parent, child) {
  const childRelative = relative(parent, child);
  return (
    childRelative !== '' &&
    !isAbsolute(childRelative) &&
    childRelative !== '..' &&
    !childRelative.startsWith(`..${sep}`)
  );
}

function readManifest(path) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    fail();
  }
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) fail();
  return manifest;
}

function dependencyNames(nodeModulesRoot) {
  const names = new Set();
  for (const entry of readdirSync(nodeModulesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) fail();
    if (!entry.name.startsWith('@')) {
      names.add(entry.name);
      continue;
    }
    for (const scopedEntry of readdirSync(join(nodeModulesRoot, entry.name), {
      withFileTypes: true,
    })) {
      if (!scopedEntry.isDirectory() || scopedEntry.isSymbolicLink()) fail();
      names.add(`${entry.name}/${scopedEntry.name}`);
    }
  }
  return names;
}

function forbiddenStagingEntry(name) {
  const lower = name.toLowerCase();
  return (
    [
      '.env',
      'credentials',
      'credentials.json',
      'secrets',
      'secrets.json',
      'quarantine',
      '.quarantine',
      'migration-work',
    ].includes(lower) ||
    lower.startsWith('.env.') ||
    lower.includes('credential') ||
    lower.startsWith('quarantine') ||
    lower.startsWith('service-account') ||
    lower.endsWith('.db') ||
    lower.endsWith('.sqlite') ||
    lower.endsWith('.sqlite3') ||
    lower.endsWith('-wal') ||
    lower.endsWith('-shm') ||
    lower.endsWith('-journal') ||
    lower.endsWith('.pem') ||
    lower.endsWith('.key') ||
    lower === 'id_rsa' ||
    lower === 'id_ed25519'
  );
}

export function inspectStagingTree({ stagingRoot, repositoryRoot }) {
  if (
    typeof stagingRoot !== 'string' ||
    typeof repositoryRoot !== 'string' ||
    !isAbsolute(stagingRoot) ||
    !isAbsolute(repositoryRoot) ||
    resolve(stagingRoot) !== stagingRoot ||
    resolve(repositoryRoot) !== repositoryRoot
  ) {
    fail();
  }

  let canonicalStaging;
  let canonicalRepository;
  try {
    canonicalStaging = realpathSync.native(stagingRoot);
    canonicalRepository = realpathSync.native(repositoryRoot);
  } catch {
    fail();
  }
  if (
    comparable(canonicalStaging) === comparable(canonicalRepository) ||
    isInside(canonicalRepository, canonicalStaging)
  ) {
    fail();
  }

  const rootEntries = readdirSync(stagingRoot, { withFileTypes: true });
  if (
    rootEntries.length !== 2 ||
    !rootEntries.some(entry => entry.name === 'package.json' && entry.isFile()) ||
    !rootEntries.some(entry => entry.name === 'node_modules' && entry.isDirectory())
  ) {
    fail();
  }

  const manifest = readManifest(join(stagingRoot, 'package.json'));
  if (
    manifest.name !== 'easy-rewind-electron-native-staging' ||
    manifest.private !== true ||
    JSON.stringify(manifest.dependencies) !== JSON.stringify(expectedNativeDependencies) ||
    manifest.devDependencies !== undefined ||
    manifest.optionalDependencies !== undefined ||
    manifest.peerDependencies !== undefined
  ) {
    fail();
  }

  const nodeModulesRoot = join(stagingRoot, 'node_modules');
  const installedPackages = dependencyNames(nodeModulesRoot);
  if (
    installedPackages.size !== expectedStagedPackages.size ||
    [...installedPackages].some(name => !expectedStagedPackages.has(name))
  ) {
    fail();
  }

  const pending = [stagingRoot];
  while (pending.length > 0) {
    const directory = pending.pop();
    const metadata = lstatSync(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) fail();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (forbiddenStagingEntry(entry.name)) fail();
      const path = join(directory, entry.name);
      const entryMetadata = lstatSync(path);
      if (entryMetadata.isSymbolicLink()) fail();
      if (entryMetadata.isDirectory()) pending.push(path);
      else if (!entryMetadata.isFile()) fail();
    }
  }
}

function runDatabaseSmoke({ stagingRoot, repositoryRoot }) {
  const smokeRoot = mkdtempSync(join(tmpdir(), 'easy-rewind-electron-sqlite-smoke-'));
  const databasePath = join(smokeRoot, 'native-smoke.sqlite3');
  let database;
  try {
    const canonicalSmokeRoot = realpathSync.native(smokeRoot);
    const canonicalRepository = realpathSync.native(repositoryRoot);
    const canonicalStaging = realpathSync.native(stagingRoot);
    if (
      comparable(canonicalSmokeRoot) === comparable(canonicalRepository) ||
      comparable(canonicalSmokeRoot) === comparable(canonicalStaging) ||
      isInside(canonicalRepository, canonicalSmokeRoot) ||
      isInside(canonicalStaging, canonicalSmokeRoot)
    ) {
      fail();
    }

    const stagedRequire = createRequire(join(stagingRoot, 'package.json'));
    const Database = stagedRequire('better-sqlite3');
    const migrationRunner = stagedRequire(join(repositoryRoot, 'backend', 'src', 'database', 'migration-runner.js'));
    database = new Database(databasePath);
    database.pragma('foreign_keys = ON');
    database.pragma('journal_mode = WAL');

    const migration = migrationRunner.runMigrations({
      db: database,
      migrations: migrationRunner.discoverMigrations(),
      now: () => 1_700_000_000_000,
    });
    if (!Number.isSafeInteger(migration.currentVersion) || migration.currentVersion < 1) fail();

    database
      .prepare(
        `INSERT INTO profiles(
          id, display_name, timezone, locale, created_at, updated_at, revision, deleted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run('electron-native-smoke', 'Electron Native Smoke', 'UTC', 'en', 1, 1, 1, null);
    const row = database.prepare('SELECT display_name FROM profiles WHERE id = ?').get('electron-native-smoke');
    if (row?.display_name !== 'Electron Native Smoke') fail();

    const checkpoint = database.pragma('wal_checkpoint(TRUNCATE)', { simple: false });
    if (
      !Array.isArray(checkpoint) ||
      checkpoint.length !== 1 ||
      checkpoint[0]?.busy !== 0 ||
      checkpoint[0]?.log !== 0 ||
      checkpoint[0]?.checkpointed !== 0
    ) {
      fail();
    }
    database.close();
    database = undefined;
  } finally {
    if (database?.open) {
      try {
        database.close();
      } catch {
        // The original verification failure remains authoritative.
      }
    }
    rmSync(smokeRoot, { recursive: true, force: true });
  }
}

export function verifyElectronNative({ stagingRoot, repositoryRoot, electronVersion }) {
  if (
    typeof electronVersion !== 'string' ||
    electronVersion !== '43.2.0' ||
    process.versions.electron !== electronVersion
  ) {
    fail();
  }
  inspectStagingTree({ stagingRoot, repositoryRoot });
  runDatabaseSmoke({ stagingRoot, repositoryRoot });
  inspectStagingTree({ stagingRoot, repositoryRoot });
}

function main() {
  try {
    const [stagingRoot, repositoryRoot, electronVersion, unexpected] = process.argv.slice(2);
    if (unexpected !== undefined) fail();
    verifyElectronNative({ stagingRoot, repositoryRoot, electronVersion });
    process.stdout.write('Electron native verification passed.\n');
  } catch {
    process.stderr.write('Electron native verification failed.\n');
    process.exitCode = 1;
  }
}

const entryPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (entryPath === resolve(fileURLToPath(import.meta.url))) main();
