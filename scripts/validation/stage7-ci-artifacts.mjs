import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const forbiddenSegments = new Set([
  '.git',
  '.npm',
  '.expo',
  'coverage',
  'legacy-backup',
  'migration-work',
  'node_modules',
  'quarantine',
  'test',
  'tests',
  '__tests__',
]);

const forbiddenNames = [
  /(?:^|[/._-])(?:settings|secret|secrets|credential|credentials)(?:[._-]|$)/iu,
  /(?:^|\/)\.env(?:\.|$)/iu,
  /\.(?:db|sqlite|sqlite3)(?:-(?:wal|shm|journal))?$/iu,
  /-(?:wal|shm|journal)$/iu,
  /\.(?:key|pem|p12|pfx|log|map)$/iu,
];

const textExtensions = new Set(['.css', '.html', '.js', '.json', '.md', '.mjs', '.txt', '.xml', '.yaml', '.yml']);

const credentialPatterns = [
  /AIza[0-9A-Za-z_-]{20,}/u,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/u,
  /\bGEMINI_API_KEY\s*=\s*\S+/u,
];

class ArtifactInspectionError extends Error {
  constructor() {
    super('Artifact inspection failed.');
  }
}

function fail() {
  throw new ArtifactInspectionError();
}

function normalizedAbsolutePath(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path) fail();
  return path;
}

function isContained(root, target) {
  const fromRoot = relative(root, target);
  return fromRoot !== '' && fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot);
}

function pathExtension(path) {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot).toLowerCase();
}

function validateRelativePath(relativePath, release) {
  const segments = relativePath.split('/');
  if (
    segments.some(segment => segment.length === 0 || forbiddenSegments.has(segment.toLowerCase())) ||
    forbiddenNames.some(pattern => pattern.test(relativePath)) ||
    (release && /(?:^|[._-])UNSIGNED(?:[._-]|$)/iu.test(relativePath))
  ) {
    fail();
  }
}

function collectFiles(inputRoot, release) {
  const canonicalRoot = realpathSync.native(inputRoot);
  const rootMetadata = lstatSync(canonicalRoot);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) fail();

  const files = [];
  const pending = [{ absolutePath: canonicalRoot, relativePath: '' }];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of readdirSync(directory.absolutePath, { withFileTypes: true })) {
      const absolutePath = join(directory.absolutePath, entry.name);
      const relativePath = directory.relativePath ? `${directory.relativePath}/${entry.name}` : entry.name;
      const metadata = lstatSync(absolutePath);
      if (entry.isSymbolicLink() || metadata.isSymbolicLink()) fail();
      validateRelativePath(relativePath, release);
      if (entry.isDirectory()) {
        pending.push({ absolutePath, relativePath });
      } else if (entry.isFile()) {
        const canonicalFile = realpathSync.native(absolutePath);
        if (!isContained(canonicalRoot, canonicalFile)) fail();
        files.push({ absolutePath: canonicalFile, relativePath, size: metadata.size });
      } else {
        fail();
      }
    }
  }
  if (files.length === 0) fail();
  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath, 'en'));
}

function inspectFile(file) {
  const bytes = readFileSync(file.absolutePath);
  if (bytes.length !== file.size) fail();

  if (textExtensions.has(pathExtension(file.relativePath))) {
    const source = bytes.toString('utf8');
    if (
      source.includes('\0') ||
      credentialPatterns.some(pattern => pattern.test(source)) ||
      /sourceMappingURL\s*=/u.test(source)
    ) {
      fail();
    }
  }

  return {
    path: file.relativePath,
    size: file.size,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

export function inspectArtifacts({ inputRoot, outputRoot, release = false } = {}) {
  const input = normalizedAbsolutePath(inputRoot);
  const output = normalizedAbsolutePath(outputRoot);
  if (input === output || isContained(input, output) || isContained(output, input)) fail();
  if (lstatSync(output, { throwIfNoEntry: false })) fail();

  let inputMetadata;
  try {
    inputMetadata = lstatSync(input);
  } catch {
    fail();
  }
  if (!inputMetadata.isDirectory() || inputMetadata.isSymbolicLink()) fail();

  const files = collectFiles(input, release).map(inspectFile);
  mkdirSync(output, { recursive: false });
  const manifestPath = join(output, 'artifact-manifest.json');
  const checksumPath = join(output, 'SHA256SUMS.txt');
  const totalBytes = files.reduce((total, file) => total + file.size, 0);
  const manifest = {
    schemaVersion: 1,
    algorithm: 'SHA-256',
    release: Boolean(release),
    fileCount: files.length,
    totalBytes,
    files,
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  writeFileSync(checksumPath, `${files.map(file => `${file.sha256}  ${file.path}`).join('\n')}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  });

  if (statSync(manifestPath).size === 0 || statSync(checksumPath).size === 0) fail();
  return Object.freeze({
    manifestPath,
    checksumPath,
    fileCount: files.length,
    totalBytes,
  });
}

function parseArguments(argv) {
  let inputRoot;
  let outputRoot;
  let release = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--release') {
      release = true;
    } else if (argument === '--input' || argument === '--output') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) fail();
      if (argument === '--input') inputRoot = resolve(value);
      else outputRoot = resolve(value);
      index += 1;
    } else {
      fail();
    }
  }
  if (!inputRoot || !outputRoot) fail();
  return { inputRoot, outputRoot, release };
}

function main() {
  try {
    const result = inspectArtifacts(parseArguments(process.argv.slice(2)));
    process.stdout.write(
      `Artifact inspection passed (${result.fileCount} files, ${result.totalBytes} bytes, SHA-256 evidence generated).\n`
    );
  } catch {
    process.stderr.write('Artifact inspection failed.\n');
    process.exitCode = 1;
  }
}

if (resolve(process.argv[1] ?? '') === resolve(fileURLToPath(import.meta.url))) {
  main();
}
