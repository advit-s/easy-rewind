import {
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const repositoryRoot = resolve(import.meta.dirname, '..', '..');
const sourceBackend = join(repositoryRoot, 'backend');
const excludedCopyRoots = new Set(['node_modules', '.git', '.env', 'data']);
const forbiddenSourcePaths = [
  ['backend/data/easy-rewind.db', join(sourceBackend, 'data', 'easy-rewind.db')],
  ['backend/data/easy-rewind.db-wal', join(sourceBackend, 'data', 'easy-rewind.db-wal')],
  ['backend/data/easy-rewind.db-shm', join(sourceBackend, 'data', 'easy-rewind.db-shm')],
  ['backend/data/settings.json', join(sourceBackend, 'data', 'settings.json')],
];
const defaultChildTimeoutMs = 60_000;
const maximumChildTimeoutMs = 120_000;

class IsolationError extends Error {
  constructor(message, label) {
    super(message);
    this.label = label;
  }
}

function relativeLabel(absolutePath) {
  const label = relative(sourceBackend, absolutePath).split(sep).join('/');
  return label ? `backend/${label}` : 'backend';
}

function hashFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function snapshotSource() {
  const snapshot = new Map();
  const pending = [sourceBackend];

  while (pending.length > 0) {
    const directory = pending.pop();
    const directoryMetadata = lstatSync(directory);
    if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()) {
      throw new IsolationError('Unsafe backend entry', relativeLabel(directory));
    }
    if (directory !== sourceBackend) {
      snapshot.set(relative(sourceBackend, directory).split(sep).join('/'), {
        type: 'directory',
      });
    }

    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = join(directory, entry.name);
      const metadata = lstatSync(absolutePath);
      const label = relativeLabel(absolutePath);
      if (metadata.isSymbolicLink()) {
        throw new IsolationError('Unsafe backend entry', label);
      }
      if (metadata.isDirectory()) {
        pending.push(absolutePath);
        continue;
      }
      if (!metadata.isFile()) {
        throw new IsolationError('Unsafe backend entry', label);
      }
      snapshot.set(relative(sourceBackend, absolutePath).split(sep).join('/'), {
        type: 'file',
        size: metadata.size,
        sha256: hashFile(absolutePath),
      });
    }
  }

  return snapshot;
}

function includedInCopy(label) {
  const firstSegment = label.split('/')[0];
  return !excludedCopyRoots.has(firstSegment);
}

function copyVerifiedSource(snapshot, temporaryBackend) {
  mkdirSync(temporaryBackend);
  const entries = [...snapshot.entries()].sort(([left], [right]) => left.localeCompare(right));

  for (const [label, expected] of entries.filter(([, value]) => value.type === 'directory')) {
    if (!includedInCopy(label)) continue;
    const source = join(sourceBackend, ...label.split('/'));
    const metadata = lstatSync(source);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new IsolationError('Backend changed during copy', `backend/${label}`);
    }
    mkdirSync(join(temporaryBackend, ...label.split('/')));
  }

  for (const [label, expected] of entries.filter(([, value]) => value.type === 'file')) {
    if (!includedInCopy(label)) continue;
    const source = join(sourceBackend, ...label.split('/'));
    const metadata = lstatSync(source);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.size !== expected.size ||
      hashFile(source) !== expected.sha256
    ) {
      throw new IsolationError('Backend changed during copy', `backend/${label}`);
    }
    const destination = join(temporaryBackend, ...label.split('/'));
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(source, destination, constants.COPYFILE_EXCL);
    if (hashFile(destination) !== expected.sha256) {
      throw new IsolationError('Disposable copy verification failed', `backend/${label}`);
    }
  }
}

function sourceChanges(before, after) {
  const changes = [];
  for (const [label, expected] of before) {
    const actual = after.get(label);
    if (!actual) {
      changes.push(`removed: backend/${label}`);
    } else if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      changes.push(`modified: backend/${label}`);
    }
  }
  for (const label of after.keys()) {
    if (!before.has(label)) changes.push(`added: backend/${label}`);
  }
  return changes.sort((left, right) => left.localeCompare(right));
}

function forbiddenLabels() {
  return forbiddenSourcePaths.filter(([, path]) => existsSync(path)).map(([label]) => label);
}

function safeEnvironment(temporaryRoot, temporaryBackend, runtimeDirectory) {
  const profile = join(temporaryRoot, 'profile');
  const roaming = join(profile, 'AppData', 'Roaming');
  const local = join(profile, 'AppData', 'Local');
  const temporary = join(temporaryRoot, 'temp');
  const npmCache = join(temporaryRoot, 'npm-cache');
  for (const directory of [profile, roaming, local, temporary, npmCache]) {
    mkdirSync(directory, { recursive: true });
  }

  const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
  return {
    SystemRoot: systemRoot,
    WINDIR: systemRoot,
    ComSpec: join(systemRoot, 'System32', 'cmd.exe'),
    PATH: [dirname(process.execPath), join(systemRoot, 'System32')].join(';'),
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
    OS: 'Windows_NT',
    PROCESSOR_ARCHITECTURE: process.arch,
    NUMBER_OF_PROCESSORS: process.env.NUMBER_OF_PROCESSORS || '1',
    HOME: profile,
    USERPROFILE: profile,
    APPDATA: roaming,
    LOCALAPPDATA: local,
    TEMP: temporary,
    TMP: temporary,
    INIT_CWD: temporaryBackend,
    npm_config_cache: npmCache,
    NODE_ENV: 'test',
    NODE_PATH: join(repositoryRoot, 'node_modules'),
    DATABASE_PATH: join(runtimeDirectory, 'test.db'),
    SETTINGS_PATH: join(runtimeDirectory, 'settings.json'),
    LOG_PATH: join(runtimeDirectory, 'backend.log'),
    EXPORT_PATH: join(runtimeDirectory, 'export.json'),
    EASY_REWIND_PROFILE_USER_ID: 'legacy-safe-test-profile',
    EASY_REWIND_SCHEDULERS_ENABLED: 'false',
    EASY_REWIND_TEST_REPOSITORY_ROOT: temporaryBackend,
    ALLOWED_ORIGINS: 'http://127.0.0.1',
    GEMINI_API_KEY: '',
    GOOGLE_API_KEY: '',
    OPENAI_API_KEY: '',
    ANTHROPIC_API_KEY: '',
    SMTP_HOST: '',
    SMTP_PORT: '',
    SMTP_USER: '',
    SMTP_PASS: '',
    EMAIL_USER: '',
    EMAIL_PASS: '',
    DIGEST_API_KEY: '',
    PROVIDER_API_KEY: '',
  };
}

function childTimeoutMs() {
  const requested = Number.parseInt(process.env.EASY_REWIND_LEGACY_TEST_TIMEOUT_MS ?? '', 10);
  return Number.isInteger(requested) && requested >= 50
    ? Math.min(requested, maximumChildTimeoutMs)
    : defaultChildTimeoutMs;
}

function writeProcessDenyPreload(temporaryRoot) {
  const preload = join(temporaryRoot, 'deny-descendant-processes.cjs');
  writeFileSync(
    preload,
    `'use strict';
const childProcess = require('node:child_process');
const { syncBuiltinESMExports } = require('node:module');
const deny = () => {
  throw new Error('Legacy test descendant processes are disabled.');
};
for (const name of [
  'spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'
]) {
  Object.defineProperty(childProcess, name, {
    value: deny,
    configurable: false,
    enumerable: true,
    writable: false,
  });
}
syncBuiltinESMExports();
`,
    { encoding: 'utf8', flag: 'wx' }
  );
  return preload;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function pathVariants(path) {
  const forward = path.replaceAll('\\', '/');
  const fileUrl = pathToFileURL(path).href;
  return [
    path,
    forward,
    fileUrl,
    encodeURI(forward),
    encodeURIComponent(forward),
    encodeURI(fileUrl),
    encodeURIComponent(fileUrl),
  ].sort((left, right) => right.length - left.length);
}

function sanitizeChildOutput(output, replacements) {
  let sanitized = output ?? '';
  for (const [absolutePath, label] of replacements) {
    for (const variant of pathVariants(absolutePath)) {
      sanitized = sanitized.replace(new RegExp(escapeRegex(variant), 'gi'), label);
    }
  }
  return sanitized;
}

function writeIsolationError(error) {
  if (error instanceof IsolationError) {
    process.stderr.write(`${error.message}: ${JSON.stringify(error.label)}\n`);
  } else {
    process.stderr.write('Legacy test isolation failed.\n');
  }
}

function main() {
  let temporaryRoot;
  let result;
  let before;
  let cleanupFailed = false;

  try {
    const forbidden = forbiddenLabels();
    if (forbidden.length > 0) {
      process.stderr.write(`Forbidden repository material detected:\n${forbidden.join('\n')}\n`);
      process.exitCode = 1;
      return;
    }

    before = snapshotSource();
    temporaryRoot = mkdtempSync(join(tmpdir(), 'easy-rewind-legacy-tests-'));
    const temporaryBackend = join(temporaryRoot, 'backend');
    const runtimeDirectory = join(temporaryRoot, 'runtime');
    mkdirSync(runtimeDirectory);
    copyVerifiedSource(before, temporaryBackend);

    const replacements = [
      [temporaryBackend, '<temporary-backend>'],
      [temporaryRoot, '<temporary-root>'],
      [repositoryRoot, '<repository-root>'],
    ];
    const preload = writeProcessDenyPreload(temporaryRoot);
    result = spawnSync(
      process.execPath,
      [
        '--require',
        preload,
        '--test',
        '--test-isolation=none',
        '--test-concurrency=1',
        'test/api.test.js',
        'test/nodemailer-compatibility.test.js',
      ],
      {
        cwd: temporaryBackend,
        encoding: 'utf8',
        env: safeEnvironment(temporaryRoot, temporaryBackend, runtimeDirectory),
        // A bounded Stage 1 compatibility gate must never wait forever on legacy handles.
        timeout: childTimeoutMs(),
        killSignal: 'SIGKILL',
        windowsHide: true,
      }
    );
    process.stdout.write(sanitizeChildOutput(result.stdout, replacements));
    process.stderr.write(sanitizeChildOutput(result.stderr, replacements));
  } catch (error) {
    writeIsolationError(error);
    process.exitCode = 1;
  } finally {
    if (temporaryRoot) {
      try {
        rmSync(temporaryRoot, { recursive: true, force: true });
      } catch {
        cleanupFailed = true;
        process.stderr.write('Legacy test cleanup failed.\n');
      }
    }

    if (before) {
      try {
        const changes = sourceChanges(before, snapshotSource());
        if (changes.length > 0) {
          process.stderr.write(`Legacy tests changed the source backend:\n${changes.join('\n')}\n`);
          process.exitCode = 1;
        }
      } catch (error) {
        writeIsolationError(error);
        process.exitCode = 1;
      }
    }
  }

  if (cleanupFailed || process.exitCode === 1) return;
  if (result?.error?.code === 'ETIMEDOUT') {
    process.stderr.write('Legacy test process timed out.\n');
    process.exitCode = 1;
  } else if (result?.error) {
    process.stderr.write('Legacy test process failed to start.\n');
    process.exitCode = 1;
  } else if (result?.signal || !Number.isInteger(result?.status)) {
    process.stderr.write('Legacy test process ended unexpectedly.\n');
    process.exitCode = 1;
  } else {
    process.exitCode = result.status;
  }
}

main();
