import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const checker = fileURLToPath(new URL('./check-repository.mjs', import.meta.url));
const repositoryGitignore = fileURLToPath(new URL('../../.gitignore', import.meta.url));
const repositoryPrettierignore = fileURLToPath(new URL('../../.prettierignore', import.meta.url));
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
    new RegExp(relativePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replaceAll('/', '[\\\\/]'))
  );
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /DO_NOT_PRINT_THIS_VALUE/);
}

function createDirectoryLinkOrSkip(t, target, link) {
  try {
    symlinkSync(target, link, 'junction');
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && ['EACCES', 'EINVAL', 'ENOSYS', 'ENOTSUP', 'EPERM'].includes(error.code)) {
      t.skip('Directory links are unavailable in this environment.');
      return false;
    }
    const code = error && typeof error === 'object' && typeof error.code === 'string' ? error.code : 'UNKNOWN';
    throw new Error(`Unexpected directory-link setup failure (${code}).`);
  }
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
    'scripts/build/rebuild-electron-native.mjs': 'export {};\n',
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

test('filesystem walk does not follow directory symlinks or junctions', t => {
  const root = fixture({ 'src/index.js': 'export {};\n' });
  const external = fixture({ 'backend/.env': 'DO_NOT_PRINT_THIS_VALUE' });
  if (!createDirectoryLinkOrSkip(t, external, join(root, 'linked-external'))) return;

  const result = check(root, '--filesystem');
  assert.equal(result.status, 0, result.stderr);
});

test('filesystem mode rejects a forbidden path that is a directory link', t => {
  const root = fixture({ 'src/index.js': 'export {};\n' });
  const external = fixture({ 'note.txt': 'DO_NOT_PRINT_THIS_VALUE' });
  if (!createDirectoryLinkOrSkip(t, external, join(root, 'logs'))) return;

  assertRejected(root, 'logs', '--filesystem');
});

test('fails closed when the requested root is a directory link', t => {
  const target = fixture({ 'backend/.env': 'DO_NOT_PRINT_THIS_VALUE' });
  const parent = fixture();
  const linkedRoot = join(parent, 'linked-root');
  if (!createDirectoryLinkOrSkip(t, target, linkedRoot)) return;

  const result = check(linkedRoot, '--filesystem');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /symbolic|junction|reparse|link/i);
  assert.doesNotMatch(result.stderr, /backend[\\\/]\.env/);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /DO_NOT_PRINT_THIS_VALUE/);
});

test('fails closed when an ancestor of the requested root is a directory link', t => {
  const target = fixture({
    'repository/src/index.js': 'DO_NOT_PRINT_THIS_VALUE',
  });
  const parent = fixture();
  const linkedAncestor = join(parent, 'linked-ancestor');
  if (!createDirectoryLinkOrSkip(t, target, linkedAncestor)) return;

  const result = check(join(linkedAncestor, 'repository'), '--filesystem');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ancestor|symbolic|junction|reparse|link/i);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /DO_NOT_PRINT_THIS_VALUE|src[\\\/]index\.js/);
});

test('fails closed when root Git metadata is a directory link', t => {
  const metadataOwner = fixture();
  initializeRepository(metadataOwner);
  const root = fixture({ 'src/index.js': 'DO_NOT_PRINT_THIS_VALUE' });
  if (!createDirectoryLinkOrSkip(t, join(metadataOwner, '.git'), join(root, '.git'))) {
    return;
  }

  const result = check(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /\.git|symbolic|junction|reparse|link/i);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /DO_NOT_PRINT_THIS_VALUE|src[\\\/]index\.js/);
});

test('allows a normal root Git directory', () => {
  const root = fixture({ 'src/index.js': 'export {};\n' });
  initializeRepository(root);

  const result = check(root);
  assert.equal(result.status, 0, result.stderr);
});

test('allows a normal Git worktree metadata file', () => {
  const container = fixture();
  const root = join(container, 'worktree');
  const metadata = join(container, 'metadata');
  const initialized = git(container, 'init', '--quiet', `--separate-git-dir=${metadata}`, root);
  assert.equal(initialized.status, 0, initialized.stderr);
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src/index.js'), 'export {};\n');

  const result = check(root);
  assert.equal(result.status, 0, result.stderr);
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

test('git mode rejects tracked forbidden files deleted from the working tree', () => {
  const root = fixture({
    'backend/data/easy-rewind.db': 'DO_NOT_PRINT_THIS_VALUE',
  });
  initializeRepository(root);
  assert.equal(git(root, 'add', 'backend/data/easy-rewind.db').status, 0);
  rmSync(join(root, 'backend/data/easy-rewind.db'));

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

test('git mode finds nested Git metadata below docs release evidence', () => {
  const root = fixture({
    'docs/release/nested/.git/config': 'DO_NOT_PRINT_THIS_VALUE',
    'docs/release/nested/evidence.md': '# Evidence\n',
  });
  initializeRepository(root);

  assertRejected(root, 'docs/release/nested/.git/config');
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

test('ignore rules preserve release evidence while excluding root release output', () => {
  const root = fixture({
    '.gitignore': readFileSync(repositoryGitignore, 'utf8'),
    'docs/release/new-evidence.md': '# Evidence\n',
    'release/artifact.zip': 'DO_NOT_PRINT_THIS_VALUE',
  });
  initializeRepository(root);

  assert.equal(git(root, 'check-ignore', '--quiet', 'docs/release/new-evidence.md').status, 1);
  assert.equal(git(root, 'check-ignore', '--quiet', 'release/artifact.zip').status, 0);
  const prettierignore = readFileSync(repositoryPrettierignore, 'utf8');
  assert.match(prettierignore, /^\/release\/?$/m);
  assert.doesNotMatch(prettierignore, /^release\/?$/m);
});

test('filesystem mode still detects ignored runtime material', () => {
  const root = fixture({
    '.gitignore': 'backend/data/*\n',
    'backend/data/easy-rewind.db': 'DO_NOT_PRINT_THIS_VALUE',
  });
  initializeRepository(root);

  assertRejected(root, 'backend/data/easy-rewind.db', '--filesystem');
});

for (const generated of [
  'packages/output/tool.EXE',
  'packages/output/setup.MsI',
  'packages/output/app.APPX',
  'packages/output/bundle.ZIP',
  'packages/output/archive.7Z',
  'packages/output/source.TAR',
  'packages/output/source.TAR.GZ',
  'packages/output/updates.BLOCKMAP',
  'packages/output/addon.OBJ',
  'packages/output/debug.PDB',
  'packages/output/scratch.TMP',
]) {
  test(`git mode rejects tracked generated suffix ${generated}`, () => {
    const root = fixture({ [generated]: 'DO_NOT_PRINT_THIS_VALUE' });
    initializeRepository(root);
    assert.equal(git(root, 'add', generated).status, 0);

    assertRejected(root, generated);
  });
}

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
