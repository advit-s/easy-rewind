'use strict';

const { constants } = require('node:fs');
const defaultFilesystem = require('node:fs/promises');
const { isAbsolute, relative, resolve, sep } = require('node:path');

const {
  FilePermissionError,
  createFilePermissions,
  failFilePermission,
  normalizePermissionTarget,
} = require('./file-permissions');

const windowsIdentityPattern = /^S-\d+(?:-\d+)+$/;

function validateFilesystem(filesystem) {
  if (
    filesystem === null ||
    typeof filesystem !== 'object' ||
    typeof filesystem.lstat !== 'function' ||
    typeof filesystem.realpath !== 'function'
  ) {
    failFilePermission('FILE_PERMISSION_ADAPTER_INVALID');
  }
}

function validateWindowsSecurity(windowsSecurity) {
  if (
    windowsSecurity === null ||
    typeof windowsSecurity !== 'object' ||
    typeof windowsSecurity.withLockedTarget !== 'function'
  ) {
    failFilePermission('FILE_PERMISSION_ADAPTER_INVALID');
  }
}

function validatePosixSecurity(posixSecurity) {
  if (
    posixSecurity === null ||
    typeof posixSecurity !== 'object' ||
    typeof posixSecurity.openLockedTarget !== 'function'
  ) {
    failFilePermission('FILE_PERMISSION_ADAPTER_INVALID');
  }
}

async function safeLstat(filesystem, target) {
  try {
    return await filesystem.lstat(target);
  } catch (error) {
    if (error instanceof FilePermissionError) throw error;
    failFilePermission('FILE_PERMISSION_OPERATION_FAILED');
  }
}

function assertTargetMetadata(metadata, kind) {
  if (typeof metadata?.isSymbolicLink !== 'function') {
    failFilePermission('FILE_PERMISSION_OPERATION_FAILED');
  }
  if (metadata.isSymbolicLink() || (typeof metadata.isReparsePoint === 'function' && metadata.isReparsePoint())) {
    failFilePermission('FILE_PERMISSION_TARGET_LINKED');
  }

  const matches =
    kind === 'directory'
      ? typeof metadata.isDirectory === 'function' && metadata.isDirectory()
      : typeof metadata.isFile === 'function' && metadata.isFile();
  if (!matches) failFilePermission('FILE_PERMISSION_TARGET_TYPE');
}

function comparablePath(path, platform) {
  const normalized = resolve(path);
  return platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function samePath(left, right, platform) {
  return comparablePath(left, platform) === comparablePath(right, platform);
}

function isContained(parentPath, candidatePath, platform) {
  const parent = comparablePath(parentPath, platform);
  const candidate = comparablePath(candidatePath, platform);
  const candidateRelative = relative(parent, candidate);
  return (
    candidateRelative === '' ||
    (isAbsolute(candidateRelative) === false &&
      candidateRelative !== '..' &&
      candidateRelative.startsWith(`..${sep}`) === false)
  );
}

function normalizeTrustedRoot(value) {
  if (value === undefined || value === null || value === '') {
    failFilePermission('FILE_PERMISSION_TRUSTED_ROOT_REQUIRED');
  }
  try {
    return normalizePermissionTarget(value);
  } catch {
    failFilePermission('FILE_PERMISSION_TRUSTED_ROOT_INVALID');
  }
}

async function safeRealpath(filesystem, target) {
  try {
    return await filesystem.realpath(target);
  } catch {
    failFilePermission('FILE_PERMISSION_OPERATION_FAILED');
  }
}

function metadataIdentity(metadata) {
  if (typeof metadata?.fileId === 'string' && metadata.fileId.length > 0) {
    return `file-id:${metadata.fileId}`;
  }
  const validPart = value =>
    (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) ||
    (typeof value === 'bigint' && value >= 0n);
  if (validPart(metadata?.dev) && validPart(metadata?.ino)) {
    return `device-inode:${String(metadata.dev)}:${String(metadata.ino)}`;
  }
  failFilePermission('FILE_PERMISSION_LOCK_UNAVAILABLE');
}

async function inspectTrustedTarget({ filesystem, kind, platform, target, trustedRoot }) {
  if (!isContained(trustedRoot, target, platform)) {
    failFilePermission('FILE_PERMISSION_TARGET_OUTSIDE_ROOT');
  }

  const rootMetadata = await safeLstat(filesystem, trustedRoot);
  assertTargetMetadata(rootMetadata, 'directory');
  const canonicalRoot = await safeRealpath(filesystem, trustedRoot);
  if (!samePath(canonicalRoot, trustedRoot, platform)) {
    failFilePermission('FILE_PERMISSION_TARGET_LINKED');
  }

  const targetRelative = relative(trustedRoot, target);
  let current = trustedRoot;
  let targetMetadata = rootMetadata;
  for (const component of targetRelative.split(sep).filter(Boolean)) {
    current = resolve(current, component);
    targetMetadata = await safeLstat(filesystem, current);
    if (
      targetMetadata.isSymbolicLink() ||
      (typeof targetMetadata.isReparsePoint === 'function' && targetMetadata.isReparsePoint())
    ) {
      failFilePermission('FILE_PERMISSION_TARGET_LINKED');
    }
    if (!samePath(current, target, platform)) {
      assertTargetMetadata(targetMetadata, 'directory');
    }
  }
  assertTargetMetadata(targetMetadata, kind);

  const canonicalTarget = await safeRealpath(filesystem, target);
  if (!samePath(canonicalTarget, target, platform) || !isContained(canonicalRoot, canonicalTarget, platform)) {
    failFilePermission('FILE_PERMISSION_TARGET_LINKED');
  }
  return { identity: metadataIdentity(targetMetadata) };
}

function defaultPosixSecurity(filesystem) {
  return Object.freeze({
    async openLockedTarget(target, options) {
      if (
        options?.noFollow !== true ||
        typeof filesystem.open !== 'function' ||
        typeof constants.O_NOFOLLOW !== 'number'
      ) {
        failFilePermission('FILE_PERMISSION_LOCK_UNAVAILABLE');
      }
      return filesystem.open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    },
  });
}

function validateLockedPosixTarget(lockedTarget) {
  if (
    lockedTarget === null ||
    typeof lockedTarget !== 'object' ||
    typeof lockedTarget.stat !== 'function' ||
    typeof lockedTarget.chmod !== 'function' ||
    typeof lockedTarget.close !== 'function'
  ) {
    failFilePermission('FILE_PERMISSION_LOCK_UNAVAILABLE');
  }
}

async function restrictPosix({ expectedIdentity, kind, posixSecurity, target }) {
  const mode = kind === 'directory' ? 0o700 : 0o600;
  let lockedTarget;
  try {
    lockedTarget = await posixSecurity.openLockedTarget(target, {
      kind,
      noFollow: true,
    });
  } catch (error) {
    if (error instanceof FilePermissionError) throw error;
    failFilePermission('FILE_PERMISSION_LOCK_UNAVAILABLE');
  }
  validateLockedPosixTarget(lockedTarget);

  let operationError;
  try {
    const before = await lockedTarget.stat();
    assertTargetMetadata(before, kind);
    if (metadataIdentity(before) !== expectedIdentity) {
      failFilePermission('FILE_PERMISSION_IDENTITY_CHANGED');
    }
    await lockedTarget.chmod(mode);
    const after = await lockedTarget.stat();
    assertTargetMetadata(after, kind);
    if (metadataIdentity(after) !== expectedIdentity) {
      failFilePermission('FILE_PERMISSION_IDENTITY_CHANGED');
    }
    if (!Number.isInteger(after.mode) || (after.mode & 0o777) !== mode) {
      failFilePermission('FILE_PERMISSION_VERIFICATION_FAILED');
    }
  } catch (error) {
    operationError =
      error instanceof FilePermissionError ? error : new FilePermissionError('FILE_PERMISSION_OPERATION_FAILED');
  } finally {
    try {
      await lockedTarget.close();
    } catch {
      if (!operationError) {
        operationError = new FilePermissionError('FILE_PERMISSION_OPERATION_FAILED');
      }
    }
  }
  if (operationError) throw operationError;
}

function windowsAclPolicy(windowsIdentity, kind) {
  return Object.freeze({
    ownerSid: windowsIdentity,
    protected: true,
    entries: Object.freeze([
      Object.freeze({
        type: 'allow',
        sid: windowsIdentity,
        rights: Object.freeze(['full-control']),
        inheritance: Object.freeze(kind === 'directory' ? ['container-inherit', 'object-inherit'] : []),
        inherited: false,
      }),
    ]),
  });
}

function hasExactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join('\0') === [...keys].sort().join('\0')
  );
}

function hasExactStringArray(value, expected) {
  return (
    Array.isArray(value) && value.length === expected.length && value.every((entry, index) => entry === expected[index])
  );
}

function assertRestrictiveWindowsAcl(acl, policy) {
  if (
    !hasExactKeys(acl, ['ownerSid', 'protected', 'entries']) ||
    acl.ownerSid !== policy.ownerSid ||
    acl.protected !== true ||
    !Array.isArray(acl.entries) ||
    acl.entries.length !== 1
  ) {
    failFilePermission('FILE_PERMISSION_ACL_VERIFICATION_FAILED');
  }
  const [actual] = acl.entries;
  const [expected] = policy.entries;
  if (
    !hasExactKeys(actual, ['type', 'sid', 'rights', 'inheritance', 'inherited']) ||
    actual.type !== 'allow' ||
    actual.sid !== expected.sid ||
    actual.inherited !== false ||
    !hasExactStringArray(actual.rights, expected.rights) ||
    !hasExactStringArray(actual.inheritance, expected.inheritance)
  ) {
    failFilePermission('FILE_PERMISSION_ACL_VERIFICATION_FAILED');
  }
}

function validateLockedWindowsTarget(lockedTarget) {
  if (
    lockedTarget === null ||
    typeof lockedTarget !== 'object' ||
    typeof lockedTarget.getIdentity !== 'function' ||
    typeof lockedTarget.applyAcl !== 'function' ||
    typeof lockedTarget.readAcl !== 'function'
  ) {
    failFilePermission('FILE_PERMISSION_LOCK_UNAVAILABLE');
  }
}

async function restrictWindows({ expectedIdentity, kind, target, windowsIdentity, windowsSecurity }) {
  if (typeof windowsIdentity !== 'string' || !windowsIdentityPattern.test(windowsIdentity)) {
    failFilePermission('FILE_PERMISSION_WINDOWS_IDENTITY_INVALID');
  }

  if (!windowsSecurity) failFilePermission('FILE_PERMISSION_LOCK_UNAVAILABLE');
  validateWindowsSecurity(windowsSecurity);
  const policy = windowsAclPolicy(windowsIdentity, kind);
  try {
    await windowsSecurity.withLockedTarget(target, async lockedTarget => {
      validateLockedWindowsTarget(lockedTarget);
      const identityBefore = metadataIdentity(await lockedTarget.getIdentity());
      if (identityBefore !== expectedIdentity) {
        failFilePermission('FILE_PERMISSION_IDENTITY_CHANGED');
      }
      await lockedTarget.applyAcl(policy);
      assertRestrictiveWindowsAcl(await lockedTarget.readAcl(), policy);
      const identityAfter = metadataIdentity(await lockedTarget.getIdentity());
      if (identityAfter !== expectedIdentity) {
        failFilePermission('FILE_PERMISSION_IDENTITY_CHANGED');
      }
    });
  } catch (error) {
    if (error instanceof FilePermissionError) throw error;
    failFilePermission('FILE_PERMISSION_OPERATION_FAILED');
  }
}

function createNodeFilePermissions(options = {}) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    failFilePermission('FILE_PERMISSION_ADAPTER_INVALID');
  }
  const platform = options.platform ?? process.platform;
  if (!['aix', 'darwin', 'freebsd', 'linux', 'openbsd', 'sunos', 'win32'].includes(platform)) {
    failFilePermission('FILE_PERMISSION_PLATFORM_UNSUPPORTED');
  }
  const trustedRoot = normalizeTrustedRoot(options.trustedRoot);
  const filesystem = options.filesystem ?? defaultFilesystem;
  validateFilesystem(filesystem);
  if (platform === 'win32' && options.windowsSecurity !== undefined) {
    validateWindowsSecurity(options.windowsSecurity);
  }
  const posixSecurity = options.posixSecurity ?? defaultPosixSecurity(filesystem);
  if (platform !== 'win32') validatePosixSecurity(posixSecurity);

  return createFilePermissions({
    async restrictDirectory(target) {
      const { identity } = await inspectTrustedTarget({
        filesystem,
        kind: 'directory',
        platform,
        target,
        trustedRoot,
      });
      if (platform === 'win32') {
        await restrictWindows({
          expectedIdentity: identity,
          kind: 'directory',
          target,
          windowsIdentity: options.windowsIdentity,
          windowsSecurity: options.windowsSecurity,
        });
      } else {
        await restrictPosix({
          expectedIdentity: identity,
          kind: 'directory',
          posixSecurity,
          target,
        });
      }
    },
    async restrictFile(target) {
      const { identity } = await inspectTrustedTarget({
        filesystem,
        kind: 'file',
        platform,
        target,
        trustedRoot,
      });
      if (platform === 'win32') {
        await restrictWindows({
          expectedIdentity: identity,
          kind: 'file',
          target,
          windowsIdentity: options.windowsIdentity,
          windowsSecurity: options.windowsSecurity,
        });
      } else {
        await restrictPosix({
          expectedIdentity: identity,
          kind: 'file',
          posixSecurity,
          target,
        });
      }
    },
  });
}

module.exports = {
  FilePermissionError,
  createNodeFilePermissions,
};
