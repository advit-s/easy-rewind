import { existsSync, lstatSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, join, relative, resolve, sep } from 'node:path';
import process from 'node:process';

const forbiddenExact = new Set(['.env', 'backend/.env', 'tmp_test.js']);
const forbiddenSegments = new Set([
  'node_modules',
  'dist',
  'build',
  'out',
  'release',
  'artifacts',
  'logs',
  'diagnostics',
  'exports',
  'legacy-backup',
  'quarantine',
  'migration-work',
  'coverage',
  '.nyc_output',
  'test-results',
  'playwright-report',
  'tmp',
  'temp',
  'prebuilds',
]);
const forbiddenNames = new Set([
  'secrets.json',
  'credentials.json',
]);
const forbiddenSuffixes = [
  '.db',
  '.db-wal',
  '.db-shm',
  '.sqlite',
  '.sqlite-wal',
  '.sqlite-shm',
  '.log',
  '.node',
];

function normalize(path) {
  return path.split(sep).join('/').replaceAll('\\', '/');
}

function isForbidden(relativePath) {
  const normalized = normalize(relativePath).toLowerCase();
  const segments = normalized.split('/');
  const name = basename(normalized);

  if (forbiddenExact.has(normalized)) return true;
  if (name === 'settings.json' && segments.includes('data')) return true;
  if (forbiddenNames.has(name)) return true;
  if (
    segments.some(
      (segment, index) =>
        forbiddenSegments.has(segment) &&
        !(segment === 'release' && index === 1 && segments[0] === 'docs'),
    )
  ) {
    return true;
  }
  if (segments.includes('.git')) return true;
  if (name === '.env.example') return false;
  if (name === '.env' || name.startsWith('.env.')) return true;
  return forbiddenSuffixes.some((suffix) => normalized.endsWith(suffix));
}

function walk(root, directory = root) {
  const results = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (directory === root && entry.name === '.git') continue;

    const absolute = join(directory, entry.name);
    const relativePath = relative(root, absolute);
    results.push(relativePath);

    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      const metadata = lstatSync(absolute);
      if (!metadata.isSymbolicLink()) {
        results.push(...walk(root, absolute));
      }
    }
  }
  return results;
}

function parseRoot(argv) {
  const rootIndex = argv.indexOf('--root');
  if (rootIndex >= 0 && !argv[rootIndex + 1]) {
    throw new Error('Repository root argument is missing.');
  }
  return resolve(rootIndex >= 0 ? argv[rootIndex + 1] : '.');
}

function inspectGit(root) {
  const git = spawnSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
    },
  );
  if (git.error || git.status !== 0) {
    throw new Error('Git repository inspection failed.');
  }
  return git.stdout.split('\0').filter(Boolean);
}

function findNestedGitMetadata(root, directory = root) {
  const results = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    const relativePath = relative(root, absolute);
    const normalizedName = entry.name.toLowerCase();
    if (normalizedName === '.git') {
      if (directory !== root) {
        results.push(relativePath);
        if (entry.isDirectory() && !entry.isSymbolicLink()) {
          results.push(...walk(root, absolute));
        }
      }
      continue;
    }
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    if (!forbiddenSegments.has(normalizedName)) {
      results.push(...findNestedGitMetadata(root, absolute));
    }
  }
  return results;
}

function inspect(root, filesystemMode) {
  if (!existsSync(root)) {
    throw new Error('Repository root does not exist.');
  }
  if (!statSync(root).isDirectory()) {
    throw new Error('Repository root is not a directory.');
  }
  return filesystemMode || !existsSync(join(root, '.git'))
    ? walk(root)
    : [...inspectGit(root), ...findNestedGitMetadata(root)];
}

function isExistingMaterial(root, relativePath) {
  const absolute = join(root, relativePath);
  if (!existsSync(absolute)) return false;
  const metadata = lstatSync(absolute);
  return metadata.isFile() || metadata.isDirectory();
}

function main() {
  try {
    const root = parseRoot(process.argv.slice(2));
    const filesystemMode = process.argv.includes('--filesystem');
    const violations = inspect(root, filesystemMode)
      .filter(isForbidden)
      .filter((path) => isExistingMaterial(root, path))
      .map(normalize)
      .sort((left, right) => left.localeCompare(right));

    if (violations.length > 0) {
      process.stderr.write(
        `Forbidden repository material detected:\n${violations.join('\n')}\n`,
      );
      process.exitCode = 1;
      return;
    }

    process.stdout.write('Repository hygiene check passed.\n');
  } catch (error) {
    const message =
      error instanceof Error && /^(Repository root|Git repository)/.test(error.message)
        ? error.message
        : 'Repository hygiene inspection failed.';
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}

main();
