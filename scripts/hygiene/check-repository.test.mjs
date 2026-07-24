import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const checker = fileURLToPath(new URL('./check-repository.mjs', import.meta.url));
const roots = [];

function fixture(files = {}) {
  const root = mkdtempSync(join(tmpdir(), 'easy-rewind-hygiene-'));
  roots.push(root);
  for (const [relativePath, value] of Object.entries(files)) {
    const path = join(root, relativePath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, value);
  }
  return root;
}

function check(root, ...args) {
  return spawnSync(process.execPath, [checker, '--root', root, ...args], {
    encoding: 'utf8',
  });
}

function git(root, ...args) {
  return spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
  });
}

function initializeRepository(root) {
  const result = git(root, 'init', '--quiet');
  assert.equal(result.status, 0, result.stderr);
}

function assertRejected(root, relativePath, ...args) {
  const result = check(root, ...args);
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    new RegExp(relativePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replaceAll('/', '[\\\\/]')),
  );
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /DO_NOT_PRINT_THIS_VALUE/);
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

test('accepts placeholder examples, runtime placeholders, and source files', () => {
  const root = fixture({
    '.env.example': 'API_KEY=replace-with-your-key\n',
    '.claude/settings.json': '{}\n',
    'backend/.env.example': 'GEMINI_API_KEY=replace-with-your-key\n',
    'backend/data/.gitkeep': '',
    'backend/server.js': 'export const ok = true;\n',
    'docs/release/stage.md': '# Release evidence\n',
  });

  const result = check(root, '--filesystem');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Repository hygiene check passed/);
});

for (const forbidden of [
  '.env',
  '.env.local',
  'backend/.env',
  'packages/web/.env.production',
  'backend/data/easy-rewind.db',
  'backend/data/easy-rewind.db-wal',
  'backend/data/easy-rewind.db-shm',
  'backend/data/cache.sqlite',
  'backend/data/cache.sqlite-wal',
  'backend/data/cache.sqlite-shm',
  'backend/data/settings.json',
  'packages/api/data/settings.json',
  'backend/.git/config',
  'packages/example/.git/config',
  'backend/node_modules/example/index.js',
  'dist/personal-export.json',
  'build/app.exe',
  'out/app/index.js',
  'release/easy-rewind.zip',
  'artifacts/package.7z',
  'logs/backend.log',
  'diagnostics/crash.txt',
  'exports/personal-export.json',
  'legacy-backup/manifest.json',
  'quarantine/manifest.json',
  'migration-work/copy.db',
  'coverage/index.html',
  'test-results/report.json',
  'playwright-report/index.html',
  'native/addon.node',
  'tmp_test.js',
]) {
  test(`filesystem mode rejects ${forbidden}`, () => {
    const root = fixture({ [forbidden]: 'DO_NOT_PRINT_THIS_VALUE' });
    assertRejected(root, forbidden, '--filesystem');
  });
}

test('detects forbidden paths when the repository root contains spaces', () => {
  const parent = fixture();
  const root = join(parent, 'repository with spaces');
  mkdirSync(join(root, 'backend'), { recursive: true });
  writeFileSync(join(root, 'backend', '.env'), 'DO_NOT_PRINT_THIS_VALUE');

  assertRejected(root, 'backend/.env', '--filesystem');
});

test('filesystem walk does not follow directory symlinks or junctions', (t) => {
  const root = fixture({ 'src/index.js': 'export {};\n' });
  const external = fixture({ 'backend/.env': 'DO_NOT_PRINT_THIS_VALUE' });
  try {
    symlinkSync(external, join(root, 'linked-external'), 'junction');
  } catch (error) {
    t.skip(`directory links are unavailable: ${error.code ?? error.message}`);
    return;
  }

  const result = check(root, '--filesystem');
  assert.equal(result.status, 0, result.stderr);
});

test('fails closed when the requested root is a directory link', (t) => {
  const target = fixture({ 'backend/.env': 'DO_NOT_PRINT_THIS_VALUE' });
  const parent = fixture();
  const linkedRoot = join(parent, 'linked-root');
  try {
    symlinkSync(target, linkedRoot, 'junction');
  } catch (error) {
    t.skip(`directory links are unavailable: ${error.code ?? error.message}`);
    return;
  }

  const result = check(linkedRoot, '--filesystem');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /symbolic|junction|reparse|link/i);
  assert.doesNotMatch(result.stderr, /backend[\\\/]\.env/);
  assert.doesNotMatch(
    `${result.stdout}${result.stderr}`,
    /DO_NOT_PRINT_THIS_VALUE/,
  );
});

test('git mode rejects tracked forbidden files even when ignored', () => {
  const root = fixture({
    '.gitignore': '*.db\n',
    'backend/data/easy-rewind.db': 'DO_NOT_PRINT_THIS_VALUE',
  });
  initializeRepository(root);
  assert.equal(git(root, 'add', '-f', 'backend/data/easy-rewind.db').status, 0);

  assertRejected(root, 'backend/data/easy-rewind.db');
});

test('git mode rejects untracked non-ignored forbidden files', () => {
  const root = fixture({ 'native/addon.node': 'DO_NOT_PRINT_THIS_VALUE' });
  initializeRepository(root);

  assertRejected(root, 'native/addon.node');
});

test('git mode rejects nested repository metadata that Git omits', () => {
  const root = fixture({
    'packages/example/.git/config': 'DO_NOT_PRINT_THIS_VALUE',
    'packages/example/index.js': 'export {};\n',
  });
  initializeRepository(root);

  assertRejected(root, 'packages/example/.git/config');
});

test('git mode rejects nested worktree Git files that Git omits', () => {
  const root = fixture({
    'packages/example/.git': 'gitdir: elsewhere\n',
    'packages/example/index.js': 'export {};\n',
  });
  initializeRepository(root);

  assertRejected(root, 'packages/example/.git');
});

test('git mode excludes ignored untracked runtime material', () => {
  const root = fixture({
    '.gitignore': 'backend/data/*\n',
    'backend/data/easy-rewind.db': 'DO_NOT_PRINT_THIS_VALUE',
  });
  initializeRepository(root);

  const result = check(root);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /DO_NOT_PRINT_THIS_VALUE/);
});

test('filesystem mode still detects ignored runtime material', () => {
  const root = fixture({
    '.gitignore': 'backend/data/*\n',
    'backend/data/easy-rewind.db': 'DO_NOT_PRINT_THIS_VALUE',
  });
  initializeRepository(root);

  assertRejected(root, 'backend/data/easy-rewind.db', '--filesystem');
});

test('fails closed when the requested root does not exist', () => {
  const parent = fixture();
  const missing = join(parent, 'missing-root');
  const result = check(missing, '--filesystem');

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /root/i);
});

test('fails closed when the requested root is not a directory', () => {
  const root = fixture({ 'not-a-directory': 'DO_NOT_PRINT_THIS_VALUE' });
  const result = check(join(root, 'not-a-directory'), '--filesystem');

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /root|directory/i);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /DO_NOT_PRINT_THIS_VALUE/);
});

test('fails closed when Git cannot inspect a repository', () => {
  const root = fixture({
    '.git': 'not-a-valid-git-directory',
    'src/index.js': 'export {};\n',
  });
  const result = check(root);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /git|repository/i);
});
