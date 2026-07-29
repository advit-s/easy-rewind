import assert from 'node:assert/strict';
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import test from 'node:test';
import { inspectStagingTree } from './verify-electron-native.mjs';

const script = resolve(import.meta.dirname, 'rebuild-electron-native.mjs');
const verificationScript = resolve(import.meta.dirname, 'verify-electron-native.mjs');
const repositoryRoot = resolve(import.meta.dirname, '..', '..');

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function fixture(rebuildSource) {
  const root = mkdtempSync(join(tmpdir(), 'easy-rewind-electron-rebuild-fixture-'));
  const moduleRoot = join(root, 'node_modules', 'better-sqlite3');
  mkdirSync(join(root, 'scripts', 'build'), { recursive: true });
  mkdirSync(join(moduleRoot, 'prebuilds'), { recursive: true });
  mkdirSync(join(root, 'node_modules', 'node-addon-api'), { recursive: true });
  mkdirSync(join(root, 'node_modules', '@electron', 'rebuild', 'lib'), { recursive: true });
  mkdirSync(join(root, 'node_modules', 'electron', 'dist'), { recursive: true });
  cpSync(script, join(root, 'scripts', 'build', 'rebuild-electron-native.mjs'));
  cpSync(verificationScript, join(root, 'scripts', 'build', 'verify-electron-native.mjs'));
  writeFileSync(
    join(moduleRoot, 'package.json'),
    JSON.stringify({
      name: 'better-sqlite3',
      version: '13.0.1',
      main: 'index.js',
      dependencies: { 'node-addon-api': '8.5.0' },
    })
  );
  writeFileSync(
    join(moduleRoot, 'index.js'),
    `module.exports = class Database {
      prepare() { return { get() { return { ok: 1 }; } }; }
      close() {}
    };\n`
  );
  writeFileSync(join(moduleRoot, 'prebuilds', 'win32-x64.node'), 'node-binding');
  writeFileSync(
    join(root, 'node_modules', 'node-addon-api', 'package.json'),
    JSON.stringify({ name: 'node-addon-api', version: '8.5.0' })
  );
  writeFileSync(join(root, 'node_modules', '@electron', 'rebuild', 'lib', 'cli.js'), rebuildSource);
  writeFileSync(
    join(root, 'node_modules', 'electron', 'package.json'),
    JSON.stringify({ name: 'electron', version: '43.2.0' })
  );
  copyFileSync(process.execPath, join(root, 'node_modules', 'electron', 'dist', 'electron.exe'));
  return root;
}

function stageDirectories() {
  return new Set(readdirSync(tmpdir()).filter(name => name.startsWith('easy-rewind-electron-native-')));
}

function inspectionFixture() {
  const repositoryRoot = mkdtempSync(join(tmpdir(), 'easy-rewind-electron-inspection-repository-'));
  const stagingRoot = mkdtempSync(join(tmpdir(), 'easy-rewind-electron-inspection-staging-'));
  mkdirSync(join(stagingRoot, 'node_modules', 'better-sqlite3'), { recursive: true });
  mkdirSync(join(stagingRoot, 'node_modules', 'node-addon-api'), { recursive: true });
  writeFileSync(
    join(stagingRoot, 'package.json'),
    JSON.stringify({
      name: 'easy-rewind-electron-native-staging',
      private: true,
      dependencies: { 'better-sqlite3': '13.0.1' },
    })
  );
  return { repositoryRoot, stagingRoot };
}

function run(root, environment = {}) {
  return spawnSync(process.execPath, ['scripts/build/rebuild-electron-native.mjs'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ...environment },
  });
}

test('staging inspection accepts only the expected native production closure', () => {
  const { repositoryRoot, stagingRoot } = inspectionFixture();

  try {
    assert.doesNotThrow(() => inspectStagingTree({ stagingRoot, repositoryRoot }));
    mkdirSync(join(stagingRoot, 'node_modules', 'unexpected-production-dependency'));
    assert.throws(() => inspectStagingTree({ stagingRoot, repositoryRoot }));
  } finally {
    rmSync(repositoryRoot, { recursive: true, force: true });
    rmSync(stagingRoot, { recursive: true, force: true });
  }
});

test('root and desktop manifests expose explicit native installation and verification commands', () => {
  const rootManifest = JSON.parse(readFileSync(join(repositoryRoot, 'package.json'), 'utf8'));
  const desktopManifest = JSON.parse(readFileSync(join(repositoryRoot, 'desktop', 'package.json'), 'utf8'));

  assert.equal(rootManifest.scripts['install:electron'], 'npm --workspace desktop run install:electron');
  assert.equal(
    rootManifest.scripts['rebuild:native'],
    'npm run install:electron && npm --workspace desktop run rebuild:native'
  );
  assert.equal(rootManifest.scripts['verify:native'], 'npm --workspace desktop run verify:native');
  assert.equal(rootManifest.scripts['validate:native'], 'npm --workspace desktop run validate:native');
  assert.equal(
    rootManifest.scripts['test:desktop-package'],
    'node --test scripts/validation/validate-desktop-package.test.mjs'
  );
  assert.equal(
    rootManifest.scripts['validate:desktop-package'],
    'node scripts/validation/validate-desktop-package.mjs'
  );
  assert.equal(desktopManifest.scripts['install:electron'], 'node ../node_modules/electron/install.js');
  assert.equal(desktopManifest.scripts['rebuild:native'], 'node ../scripts/build/rebuild-electron-native.mjs');
  assert.equal(
    desktopManifest.scripts['validate:native'],
    'npm run install:electron && node ../scripts/build/rebuild-electron-native.mjs --validate-only'
  );
  assert.equal(
    desktopManifest.scripts['verify:native'],
    'npm run install:electron && node --test ../scripts/build/rebuild-electron-native.test.mjs && npm run rebuild:native'
  );
  assert.equal(desktopManifest.dependencies['better-sqlite3'], '13.0.1');
  assert.equal(desktopManifest.devDependencies.electron, '43.2.0');
});

test('native dry validation checks the Electron runtime without rebuilding or staging', () => {
  const root = fixture(`
    require('node:fs').writeFileSync(process.env.EASY_REWIND_TEST_MARKER, 'rebuild-ran');
  `);
  const marker = join(root, 'rebuild-ran.txt');
  const beforeStages = stageDirectories();

  try {
    const result = spawnSync(process.execPath, ['scripts/build/rebuild-electron-native.mjs', '--validate-only'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, EASY_REWIND_TEST_MARKER: marker },
    });

    assert.notEqual(result.status, 0);
    assert.throws(() => readFileSync(marker), /ENOENT/);
    assert.match(result.stderr, /Stage: electron-runtime-check/);
    assert.deepEqual(stageDirectories(), beforeStages);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('native validation rejects an unpinned better-sqlite3 installation before rebuilding', () => {
  const root = fixture(`
    require('node:fs').writeFileSync(process.env.EASY_REWIND_TEST_MARKER, 'rebuild-ran');
  `);
  const marker = join(root, 'rebuild-ran.txt');
  const nativeManifestPath = join(root, 'node_modules', 'better-sqlite3', 'package.json');
  const nativeManifest = JSON.parse(readFileSync(nativeManifestPath, 'utf8'));
  nativeManifest.version = '13.0.0';
  writeFileSync(nativeManifestPath, JSON.stringify(nativeManifest));

  try {
    const result = run(root, { EASY_REWIND_TEST_MARKER: marker });

    assert.notEqual(result.status, 0);
    assert.throws(() => readFileSync(marker), /ENOENT/);
    assert.match(result.stderr, /Stage: installation-check/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('staging inspection rejects database, credential, and quarantine artifacts', async t => {
  for (const artifact of ['native-smoke.sqlite3', 'native-smoke.sqlite3-wal', 'credential.json', 'quarantine-copy']) {
    await t.test(artifact, () => {
      const { repositoryRoot, stagingRoot } = inspectionFixture();
      const artifactPath = join(stagingRoot, 'node_modules', 'better-sqlite3', artifact);

      try {
        writeFileSync(artifactPath, 'forbidden');
        assert.throws(() => inspectStagingTree({ stagingRoot, repositoryRoot }));
      } finally {
        rmSync(repositoryRoot, { recursive: true, force: true });
        rmSync(stagingRoot, { recursive: true, force: true });
      }
    });
  }
});

test('Electron rebuild receives the staging package root as its module directory', () => {
  const root = fixture(`
    const fs = require('node:fs');
    const path = require('node:path');
    const index = process.argv.indexOf('--module-dir');
    const moduleDirectory = process.argv[index + 1];
    const valid =
      fs.existsSync(path.join(moduleDirectory, 'package.json')) &&
      fs.existsSync(path.join(moduleDirectory, 'node_modules', 'better-sqlite3'));
    fs.writeFileSync(process.env.EASY_REWIND_TEST_MARKER, String(valid));
    const binding = path.join(
      moduleDirectory,
      valid ? 'node_modules' : '',
      'better-sqlite3',
      'prebuilds',
      'win32-x64.node'
    );
    fs.appendFileSync(binding, '-electron');
  `);
  const marker = join(root, 'module-dir-result.txt');

  try {
    run(root, { EASY_REWIND_TEST_MARKER: marker });
    assert.equal(readFileSync(marker, 'utf8'), 'true');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Electron rebuild preserves the Node binding and rejects a Node executable posing as Electron', () => {
  const root = fixture(`
    const fs = require('node:fs');
    const path = require('node:path');
    const index = process.argv.indexOf('--module-dir');
    const moduleDirectory = process.argv[index + 1];
    fs.appendFileSync(
      path.join(moduleDirectory, 'node_modules', 'better-sqlite3', 'prebuilds', 'win32-x64.node'),
      '-electron'
    );
    fs.writeFileSync(process.env.EASY_REWIND_TEST_MARKER, 'rebuilt');
  `);
  const binding = join(root, 'node_modules', 'better-sqlite3', 'prebuilds', 'win32-x64.node');
  const marker = join(root, 'rebuild-completed.txt');
  const beforeHash = sha256(binding);
  const beforeStages = stageDirectories();

  try {
    const result = run(root, { EASY_REWIND_TEST_MARKER: marker });
    assert.notEqual(result.status, 0);
    assert.equal(readFileSync(marker, 'utf8'), 'rebuilt');
    assert.equal(sha256(binding), beforeHash);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /Electron native staging rebuild failed\./);
    assert.deepEqual(stageDirectories(), beforeStages);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Electron verification remains authoritative when a N-API rebuild is byte-identical', () => {
  const root = fixture(`
    require('node:fs').writeFileSync(process.env.EASY_REWIND_TEST_MARKER, 'rebuilt');
  `);
  const marker = join(root, 'rebuild-completed.txt');

  try {
    const result = run(root, { EASY_REWIND_TEST_MARKER: marker });
    assert.notEqual(result.status, 0);
    assert.equal(readFileSync(marker, 'utf8'), 'rebuilt');
    assert.match(result.stderr, /Stage: electron-runtime-smoke/);
    assert.doesNotMatch(result.stderr, /Stage: rebuilt-binding-check/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Electron rebuild fails before rebuilding when the pinned binary is absent', () => {
  const root = fixture(`
    require('node:fs').writeFileSync(process.env.EASY_REWIND_TEST_MARKER, 'rebuild-ran');
  `);
  const marker = join(root, 'rebuild-ran.txt');
  rmSync(join(root, 'node_modules', 'electron', 'dist', 'electron.exe'));

  try {
    const result = run(root, { EASY_REWIND_TEST_MARKER: marker });
    assert.notEqual(result.status, 0);
    assert.throws(() => readFileSync(marker), /ENOENT/);
    assert.match(result.stderr, /Electron native staging rebuild failed\./);
    assert.doesNotMatch(result.stderr, new RegExp(root.replaceAll('\\', '\\\\'), 'i'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('native verification rejects runtimes that do not report the pinned Electron version', () => {
  const repositoryRoot = mkdtempSync(join(tmpdir(), 'easy-rewind-electron-verify-repository-'));
  const stagingRoot = mkdtempSync(join(tmpdir(), 'easy-rewind-electron-verify-staging-'));

  try {
    const result = spawnSync(process.execPath, [verificationScript, stagingRoot, repositoryRoot, '43.2.0'], {
      encoding: 'utf8',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });

    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /Electron native verification failed\./);
    assert.doesNotMatch(result.stderr, new RegExp(repositoryRoot.replaceAll('\\', '\\\\'), 'i'));
    assert.doesNotMatch(result.stderr, new RegExp(stagingRoot.replaceAll('\\', '\\\\'), 'i'));
  } finally {
    rmSync(repositoryRoot, { recursive: true, force: true });
    rmSync(stagingRoot, { recursive: true, force: true });
  }
});

test('Electron rebuild failure preserves the shared binding and cleans staging', () => {
  const root = fixture(`process.exitCode = 7;\n`);
  const binding = join(root, 'node_modules', 'better-sqlite3', 'prebuilds', 'win32-x64.node');
  const beforeHash = sha256(binding);
  const beforeStages = stageDirectories();

  try {
    const result = run(root);
    assert.notEqual(result.status, 0);
    assert.equal(sha256(binding), beforeHash);
    assert.match(result.stderr, /Electron native staging rebuild failed\./);
    assert.doesNotMatch(result.stderr, new RegExp(root.replaceAll('\\', '\\\\'), 'i'));
    assert.deepEqual(stageDirectories(), beforeStages);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
