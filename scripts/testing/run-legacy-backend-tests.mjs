import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const repositoryRoot = resolve(import.meta.dirname, '..', '..');
const sourceBackend = join(repositoryRoot, 'backend');
const temporaryRoot = mkdtempSync(join(tmpdir(), 'easy-rewind-legacy-tests-'));
const temporaryBackend = join(temporaryRoot, 'backend');
const runtimeDirectory = join(temporaryRoot, 'runtime');
const forbiddenSourcePaths = [
  ['backend/data/easy-rewind.db', join(sourceBackend, 'data', 'easy-rewind.db')],
  ['backend/data/easy-rewind.db-wal', join(sourceBackend, 'data', 'easy-rewind.db-wal')],
  ['backend/data/easy-rewind.db-shm', join(sourceBackend, 'data', 'easy-rewind.db-shm')],
  ['backend/data/settings.json', join(sourceBackend, 'data', 'settings.json')],
];

function includedInCopy(source) {
  const label = relative(sourceBackend, source).split(sep).join('/');
  if (label === '') return true;
  return !['node_modules', '.git', '.env', 'data'].some(
    excluded => label === excluded || label.startsWith(`${excluded}/`)
  );
}

function reportForbiddenWrites() {
  const leakedLabels = forbiddenSourcePaths
    .filter(([, absolutePath]) => existsSync(absolutePath))
    .map(([label]) => label);
  if (leakedLabels.length === 0) return false;
  process.stderr.write(`Legacy tests wrote into the repository:\n${leakedLabels.join('\n')}\n`);
  return true;
}

function pathPattern(path) {
  return path
    .split(/[\\/]/)
    .map(component => component.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[\\\\/]');
}

function sanitizeChildOutput(output) {
  return [
    [temporaryBackend, '<temporary-backend>'],
    [temporaryRoot, '<temporary-root>'],
    [repositoryRoot, '<repository-root>'],
  ].reduce(
    (sanitized, [absolutePath, label]) => sanitized.replace(new RegExp(pathPattern(absolutePath), 'gi'), label),
    output ?? ''
  );
}

try {
  if (reportForbiddenWrites()) {
    process.exitCode = 1;
  } else {
    cpSync(sourceBackend, temporaryBackend, {
      recursive: true,
      filter: includedInCopy,
    });
    mkdirSync(runtimeDirectory);

    const jest = join(repositoryRoot, 'node_modules', 'jest', 'bin', 'jest.js');
    const result = spawnSync(
      process.execPath,
      ['--experimental-vm-modules', jest, '--forceExit', '--detectOpenHandles', '--runInBand'],
      {
        cwd: temporaryBackend,
        encoding: 'utf8',
        env: {
          ...process.env,
          NODE_ENV: 'test',
          NODE_PATH: [join(repositoryRoot, 'node_modules'), process.env.NODE_PATH].filter(Boolean).join(delimiter),
          DATABASE_PATH: join(runtimeDirectory, 'test.db'),
          GEMINI_API_KEY: '',
          ALLOWED_ORIGINS: 'http://127.0.0.1:5000',
        },
        windowsHide: true,
      }
    );

    process.stdout.write(sanitizeChildOutput(result.stdout));
    process.stderr.write(sanitizeChildOutput(result.stderr));

    if (result.error) {
      process.stderr.write('Legacy test process could not be started.\n');
      process.exitCode = 1;
    } else if (reportForbiddenWrites()) {
      process.exitCode = 1;
    } else {
      process.exitCode = result.status ?? 1;
    }
  }
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
