'use strict';

const {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} = require('node:fs');
const { randomBytes } = require('node:crypto');
const { dirname, isAbsolute, join, parse, relative, resolve, sep } = require('node:path');

const segmentPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function isArtifactError(error) {
  return typeof error?.code === 'string' && error.code.startsWith('ARTIFACT_');
}

function comparablePath(value) {
  const normalized = resolve(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function samePath(left, right) {
  return comparablePath(left) === comparablePath(right);
}

function isWithin(root, candidate, allowRoot = false) {
  const child = relative(comparablePath(root), comparablePath(candidate));
  if (child === '') return allowRoot;
  return child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

function normalizeRoot(value) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.includes('\0') ||
    !isAbsolute(value) ||
    value.split(/[\\/]+/u).includes('..')
  ) {
    fail('ARTIFACT_ROOT_INVALID');
  }
  return resolve(value);
}

function validateSegment(value) {
  if (
    typeof value !== 'string' ||
    !segmentPattern.test(value) ||
    value === '.' ||
    value === '..' ||
    value.includes('/') ||
    value.includes('\\') ||
    isAbsolute(value)
  ) {
    fail('ARTIFACT_SEGMENT_INVALID');
  }
  return value;
}

function createNodeArtifactPathAdapter({ exportsRoot, backupsRoot } = {}) {
  const normalizedExportsRoot = normalizeRoot(exportsRoot);
  const normalizedBackupsRoot = normalizeRoot(backupsRoot);

  function reference(root, { profileId, id } = {}) {
    const owner = validateSegment(profileId);
    const artifactId = validateSegment(id);
    const candidate = resolve(root, owner, `${artifactId}.json`);
    if (!isWithin(root, candidate)) fail('ARTIFACT_REFERENCE_OUTSIDE_ROOT');
    return candidate;
  }

  return Object.freeze({
    exportReference(options) {
      return reference(normalizedExportsRoot, options);
    },
    backupReference(options) {
      return reference(normalizedBackupsRoot, options);
    },
  });
}

function lstatIfPresent(target) {
  try {
    return lstatSync(target);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    fail('ARTIFACT_FILESYSTEM_FAILED');
  }
}

function assertPlainDirectory(target) {
  const metadata = lstatIfPresent(target);
  if (metadata === null) return false;
  if (metadata.isSymbolicLink()) fail('ARTIFACT_REFERENCE_LINKED');
  if (!metadata.isDirectory()) fail('ARTIFACT_REFERENCE_INVALID');
  return true;
}

function assertCanonicalDirectory(target, root) {
  let canonical;
  try {
    canonical = realpathSync.native(target);
  } catch {
    fail('ARTIFACT_FILESYSTEM_FAILED');
  }
  if (!samePath(canonical, target) || !isWithin(root, canonical, true)) {
    fail('ARTIFACT_REFERENCE_LINKED');
  }
}

function ensureRoot(root) {
  const volumeRoot = parse(root).root;
  let current = volumeRoot;
  assertPlainDirectory(current);

  const components = relative(volumeRoot, root).split(sep).filter(Boolean);
  for (const component of components) {
    current = join(current, component);
    if (!assertPlainDirectory(current)) {
      try {
        mkdirSync(current, { mode: 0o700 });
      } catch {
        fail('ARTIFACT_FILESYSTEM_FAILED');
      }
      assertPlainDirectory(current);
      try {
        chmodSync(current, 0o700);
      } catch {
        fail('ARTIFACT_FILESYSTEM_FAILED');
      }
    }
    assertCanonicalDirectory(current, volumeRoot);
  }
}

function validateReference(reference, roots) {
  if (
    typeof reference !== 'string' ||
    reference.length === 0 ||
    reference.includes('\0') ||
    !isAbsolute(reference) ||
    reference.split(/[\\/]+/u).includes('..')
  ) {
    fail('ARTIFACT_REFERENCE_INVALID');
  }
  const normalized = resolve(reference);
  const root = roots.find(candidate => isWithin(candidate, normalized));
  if (root === undefined) fail('ARTIFACT_REFERENCE_OUTSIDE_ROOT');
  return { reference: normalized, root };
}

function ensureParent(root, reference, create) {
  const parent = dirname(reference);
  const components = relative(root, parent).split(sep).filter(Boolean);
  let current = root;
  assertPlainDirectory(current);
  assertCanonicalDirectory(current, root);

  for (const component of components) {
    current = join(current, component);
    if (!assertPlainDirectory(current)) {
      if (!create) return false;
      try {
        mkdirSync(current, { mode: 0o700 });
        chmodSync(current, 0o700);
      } catch {
        fail('ARTIFACT_FILESYSTEM_FAILED');
      }
      assertPlainDirectory(current);
    }
    assertCanonicalDirectory(current, root);
  }
  return true;
}

function assertPlainFile(reference, missingCode = 'ARTIFACT_NOT_FOUND') {
  const metadata = lstatIfPresent(reference);
  if (metadata === null) fail(missingCode);
  if (metadata.isSymbolicLink()) fail('ARTIFACT_REFERENCE_LINKED');
  if (!metadata.isFile()) fail('ARTIFACT_REFERENCE_INVALID');
  return metadata;
}

function assertNotAborted(signal) {
  if (signal?.aborted !== true) return;
  const error = new Error('The artifact operation was cancelled');
  error.name = 'AbortError';
  throw error;
}

function restrictSensitiveFile(filePermissions, temporaryPath) {
  let result;
  try {
    result = filePermissions.restrictFile(temporaryPath);
  } catch {
    fail('ARTIFACT_PERMISSION_FAILED');
  }
  if (result !== null && (typeof result === 'object' || typeof result === 'function') && 'then' in result) {
    Promise.resolve(result).catch(() => {});
    fail('ARTIFACT_PERMISSION_ASYNC_UNSUPPORTED');
  }
}

function createNodeArtifactStore({ exportsRoot, backupsRoot, filePermissions } = {}) {
  const roots = Object.freeze([normalizeRoot(exportsRoot), normalizeRoot(backupsRoot)]);
  if (
    filePermissions === null ||
    typeof filePermissions !== 'object' ||
    typeof filePermissions.restrictFile !== 'function'
  ) {
    fail('ARTIFACT_PERMISSION_ADAPTER_INVALID');
  }
  for (const root of roots) ensureRoot(root);

  function writeAtomic(reference, bytes, options = {}) {
    if (!Buffer.isBuffer(bytes)) fail('ARTIFACT_BYTES_INVALID');
    const normalized = validateReference(reference, roots);
    assertNotAborted(options.signal);
    ensureParent(normalized.root, normalized.reference, true);

    const existing = lstatIfPresent(normalized.reference);
    if (existing?.isSymbolicLink()) fail('ARTIFACT_REFERENCE_LINKED');
    if (existing !== null) fail('ARTIFACT_ALREADY_EXISTS');

    const temporaryPath = join(
      dirname(normalized.reference),
      `.${parse(normalized.reference).base}.${process.pid}.${randomBytes(12).toString('hex')}.tmp`
    );
    let descriptor;
    try {
      const noFollow = constants.O_NOFOLLOW ?? 0;
      descriptor = openSync(temporaryPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600);
      writeFileSync(descriptor, bytes);
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      chmodSync(temporaryPath, 0o600);
      assertPlainFile(temporaryPath, 'ARTIFACT_WRITE_FAILED');

      if (options.sensitive === true) {
        restrictSensitiveFile(filePermissions, temporaryPath);
        assertPlainFile(temporaryPath, 'ARTIFACT_WRITE_FAILED');
      }
      assertNotAborted(options.signal);
      ensureParent(normalized.root, normalized.reference, false);
      if (lstatIfPresent(normalized.reference) !== null) fail('ARTIFACT_ALREADY_EXISTS');
      linkSync(temporaryPath, normalized.reference);
      unlinkSync(temporaryPath);
      return normalized.reference;
    } catch (error) {
      if (descriptor !== undefined) {
        try {
          closeSync(descriptor);
        } catch {
          // Cleanup cannot replace the stable operation error.
        }
      }
      try {
        if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
      } catch {
        // Cleanup cannot replace the stable operation error.
      }
      if (isArtifactError(error) || error?.name === 'AbortError') throw error;
      fail('ARTIFACT_WRITE_FAILED');
    }
  }

  function read(reference) {
    const normalized = validateReference(reference, roots);
    if (!ensureParent(normalized.root, normalized.reference, false)) fail('ARTIFACT_NOT_FOUND');
    const inspected = assertPlainFile(normalized.reference);
    let canonical;
    try {
      canonical = realpathSync.native(normalized.reference);
    } catch {
      fail('ARTIFACT_READ_FAILED');
    }
    if (!samePath(canonical, normalized.reference) || !isWithin(normalized.root, canonical)) {
      fail('ARTIFACT_REFERENCE_LINKED');
    }

    let descriptor;
    try {
      const noFollow = constants.O_NOFOLLOW ?? 0;
      descriptor = openSync(normalized.reference, constants.O_RDONLY | noFollow);
      const opened = fstatSync(descriptor);
      if (opened.dev !== inspected.dev || opened.ino !== inspected.ino || !opened.isFile()) {
        fail('ARTIFACT_REFERENCE_CHANGED');
      }
      const bytes = readFileSync(descriptor);
      closeSync(descriptor);
      return bytes;
    } catch (error) {
      if (descriptor !== undefined) {
        try {
          closeSync(descriptor);
        } catch {
          // Cleanup cannot replace the stable operation error.
        }
      }
      if (isArtifactError(error)) throw error;
      fail('ARTIFACT_READ_FAILED');
    }
  }

  function remove(reference) {
    const normalized = validateReference(reference, roots);
    if (!ensureParent(normalized.root, normalized.reference, false)) return false;
    const metadata = lstatIfPresent(normalized.reference);
    if (metadata === null) return false;
    if (metadata.isSymbolicLink()) fail('ARTIFACT_REFERENCE_LINKED');
    if (!metadata.isFile()) fail('ARTIFACT_REFERENCE_INVALID');
    try {
      unlinkSync(normalized.reference);
      return true;
    } catch {
      fail('ARTIFACT_REMOVE_FAILED');
    }
  }

  return Object.freeze({ read, remove, writeAtomic });
}

module.exports = {
  createNodeArtifactPathAdapter,
  createNodeArtifactStore,
};
