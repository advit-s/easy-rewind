import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { extractFile, listPackage, statFile } from '@electron/asar';

const REQUIRED_PACKAGE_ENTRIES = Object.freeze([
  'package.json',
  'desktop/bootstrap.js',
  'desktop/main.js',
  'desktop/preload.js',
  'desktop/overlay.js',
  'desktop/overlay.html',
  'desktop/overlay.css',
  'desktop/assets/tray-icon.png',
  'backend/src/lifecycle/composition-root.js',
  'backend/src/database/migrations/005_reminder_outbox.sql',
  'frontend/dashboard.html',
  'packages/contracts/schema/health.json',
]);

const FORBIDDEN_ENTRY =
  /(?:^|\/)(?:legacy-backup|quarantine|migration-work|logs?|tests?|__tests__|coverage|\.env(?:\..*)?|[^/]*\.(?:db|sqlite|sqlite3|log|pem|key|map)|[^/]*\.(?:db|sqlite|sqlite3)-(?:wal|shm|journal)|[^/]*-(?:wal|shm|journal)|[^/]*(?:settings|secrets|credentials)[^/]*\.json)(?:\/|$)/iu;

const SECRET_BYTES = Object.freeze([/AIza[0-9A-Za-z_-]{20,}/u, /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u]);

class ReleaseArtifactValidationError extends Error {
  constructor() {
    super('Release artifact validation failed.');
    this.name = 'ReleaseArtifactValidationError';
  }
}

function fail() {
  throw new ReleaseArtifactValidationError();
}

function normalizedDirectory(value) {
  if (typeof value !== 'string' || !isAbsolute(value) || resolve(value) !== value) fail();
  let canonical;
  try {
    canonical = realpathSync.native(value);
  } catch {
    fail();
  }
  if (resolve(canonical) !== canonical) fail();
  const metadata = lstatSync(canonical);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) fail();
  return canonical;
}

function regularFile(path, { executable = false } = {}) {
  let metadata;
  let bytes;
  try {
    metadata = lstatSync(path);
    bytes = readFileSync(path);
  } catch {
    fail();
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || bytes.byteLength < 1) fail();
  if (executable && (bytes.byteLength < 2 || bytes[0] !== 0x4d || bytes[1] !== 0x5a)) fail();
  return bytes;
}

function normalizeEntry(value) {
  if (typeof value !== 'string') fail();
  return value.replaceAll('\\', '/').replace(/^\/+/u, '');
}

function readPackageManifest(asarPath) {
  let value;
  try {
    value = JSON.parse(extractFile(asarPath, 'package.json').toString('utf8'));
  } catch {
    fail();
  }
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    value.name !== 'easy-rewind-desktop' ||
    value.productName !== 'Easy Rewind' ||
    value.main !== 'desktop/bootstrap.js' ||
    typeof value.version !== 'string' ||
    !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(value.version)
  ) {
    fail();
  }
  return value;
}

function inspectPackage(asarPath) {
  let packageEntries;
  try {
    packageEntries = listPackage(asarPath).map(raw => ({
      archivePath: raw.replace(/^[/\\]+/u, ''),
      path: normalizeEntry(raw),
    }));
  } catch {
    fail();
  }
  const entries = packageEntries.map(entry => entry.path);
  const entrySet = new Set(entries);
  if (REQUIRED_PACKAGE_ENTRIES.some(entry => !entrySet.has(entry))) fail();
  if (entries.some(entry => FORBIDDEN_ENTRY.test(entry))) fail();

  for (const entry of packageEntries) {
    if (!/\.(?:cjs|css|html|js|json|mjs|sql)$/iu.test(entry.path)) continue;
    let text;
    try {
      const metadata = statFile(asarPath, entry.archivePath);
      if (metadata?.files !== undefined) continue;
      text = extractFile(asarPath, entry.archivePath).toString('utf8');
    } catch {
      fail();
    }
    if (SECRET_BYTES.some(pattern => pattern.test(text))) fail();
  }
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export async function validateReleaseArtifacts({ distDirectory, writeChecksums = false } = {}) {
  const dist = normalizedDirectory(distDirectory);
  const asarPath = join(dist, 'win-unpacked', 'resources', 'app.asar');
  regularFile(asarPath);
  const manifest = readPackageManifest(asarPath);
  inspectPackage(asarPath);

  regularFile(join(dist, 'win-unpacked', 'Easy Rewind.exe'), { executable: true });
  regularFile(
    join(
      dist,
      'win-unpacked',
      'resources',
      'app.asar.unpacked',
      'node_modules',
      'better-sqlite3',
      'prebuilds',
      'win32-x64.node'
    )
  );

  const names = [
    `Easy-Rewind-UNSIGNED-Portable-${manifest.version}-x64.exe`,
    `Easy-Rewind-UNSIGNED-Setup-${manifest.version}-x64.exe`,
    `Easy-Rewind-UNSIGNED-Setup-${manifest.version}-x64.exe.blockmap`,
  ];
  const artifactBytes = new Map();
  for (const name of names) {
    artifactBytes.set(name, regularFile(join(dist, name), { executable: name.endsWith('.exe') }));
  }
  const unexpectedExecutables = readdirSync(dist).filter(
    name => name.toLowerCase().endsWith('.exe') && !names.includes(name)
  );
  if (unexpectedExecutables.length !== 0) fail();

  if (writeChecksums) {
    const contents = `${names.map(name => `${sha256(artifactBytes.get(name))}  ${name}`).join('\n')}\n`;
    writeFileSync(join(dist, 'SHA256SUMS.txt'), contents, {
      encoding: 'utf8',
      flag: 'w',
      mode: 0o600,
    });
  }

  return Object.freeze({
    artifacts: Object.freeze(names),
    packageVersion: manifest.version,
  });
}

async function main() {
  if (process.argv.length !== 3 || process.argv[2] !== '--write-checksums') fail();
  const repositoryRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
  const result = await validateReleaseArtifacts({
    distDirectory: join(repositoryRoot, 'dist'),
    writeChecksums: true,
  });
  process.stdout.write(`Release artifact validation passed (${result.artifacts.length} artifacts, SHA-256 written).\n`);
}

if (resolve(process.argv[1] ?? '') === resolve(fileURLToPath(import.meta.url))) {
  main().catch(() => {
    process.stderr.write('Release artifact validation failed.\n');
    process.exitCode = 1;
  });
}

export { ReleaseArtifactValidationError };
