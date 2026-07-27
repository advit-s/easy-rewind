'use strict';

const { execFile } = require('node:child_process');
const defaultFilesystem = require('node:fs/promises');

const { FilePermissionError, createFilePermissions, failFilePermission } = require('./file-permissions');

const windowsIdentityPattern = /^S-\d+(?:-\d+)+$/;

const defaultCommandRunner = Object.freeze({
  run(executable, args, options) {
    return new Promise((resolve, reject) => {
      execFile(executable, args, options, error => {
        if (error) reject(error);
        else resolve({ exitCode: 0 });
      });
    });
  },
});

function validateFilesystem(filesystem) {
  if (
    filesystem === null ||
    typeof filesystem !== 'object' ||
    typeof filesystem.lstat !== 'function' ||
    typeof filesystem.chmod !== 'function'
  ) {
    failFilePermission('FILE_PERMISSION_ADAPTER_INVALID');
  }
}

function validateCommandRunner(commandRunner) {
  if (commandRunner === null || typeof commandRunner !== 'object' || typeof commandRunner.run !== 'function') {
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
  if (metadata.isSymbolicLink()) failFilePermission('FILE_PERMISSION_TARGET_LINKED');

  const matches =
    kind === 'directory'
      ? typeof metadata.isDirectory === 'function' && metadata.isDirectory()
      : typeof metadata.isFile === 'function' && metadata.isFile();
  if (!matches) failFilePermission('FILE_PERMISSION_TARGET_TYPE');
}

async function safeChmod(filesystem, target, mode) {
  try {
    await filesystem.chmod(target, mode);
  } catch (error) {
    if (error instanceof FilePermissionError) throw error;
    failFilePermission('FILE_PERMISSION_OPERATION_FAILED');
  }
}

async function restrictPosix(filesystem, target, kind) {
  const mode = kind === 'directory' ? 0o700 : 0o600;
  const before = await safeLstat(filesystem, target);
  assertTargetMetadata(before, kind);
  await safeChmod(filesystem, target, mode);
  const after = await safeLstat(filesystem, target);
  assertTargetMetadata(after, kind);
  if (!Number.isInteger(after.mode) || (after.mode & 0o777) !== mode) {
    failFilePermission('FILE_PERMISSION_VERIFICATION_FAILED');
  }
}

async function restrictWindows({ commandRunner, filesystem, kind, target, windowsIdentity }) {
  if (typeof windowsIdentity !== 'string' || !windowsIdentityPattern.test(windowsIdentity)) {
    failFilePermission('FILE_PERMISSION_WINDOWS_IDENTITY_INVALID');
  }

  const mode = kind === 'directory' ? 0o700 : 0o600;
  const before = await safeLstat(filesystem, target);
  assertTargetMetadata(before, kind);
  await safeChmod(filesystem, target, mode);
  const afterMode = await safeLstat(filesystem, target);
  assertTargetMetadata(afterMode, kind);

  const grant = kind === 'directory' ? `*${windowsIdentity}:(OI)(CI)F` : `*${windowsIdentity}:F`;
  let result;
  try {
    result = await commandRunner.run('icacls.exe', [target, '/inheritance:r', '/grant:r', grant], {
      shell: false,
      windowsHide: true,
    });
  } catch {
    failFilePermission('FILE_PERMISSION_OPERATION_FAILED');
  }
  if (result === null || typeof result !== 'object' || result.exitCode !== 0) {
    failFilePermission('FILE_PERMISSION_OPERATION_FAILED');
  }

  const afterAcl = await safeLstat(filesystem, target);
  assertTargetMetadata(afterAcl, kind);
}

function createNodeFilePermissions(options = {}) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    failFilePermission('FILE_PERMISSION_ADAPTER_INVALID');
  }
  const platform = options.platform ?? process.platform;
  if (!['aix', 'darwin', 'freebsd', 'linux', 'openbsd', 'sunos', 'win32'].includes(platform)) {
    failFilePermission('FILE_PERMISSION_PLATFORM_UNSUPPORTED');
  }
  const filesystem = options.filesystem ?? defaultFilesystem;
  validateFilesystem(filesystem);
  const commandRunner = options.commandRunner ?? defaultCommandRunner;
  if (platform === 'win32') validateCommandRunner(commandRunner);

  return createFilePermissions({
    async restrictDirectory(target) {
      if (platform === 'win32') {
        await restrictWindows({
          commandRunner,
          filesystem,
          kind: 'directory',
          target,
          windowsIdentity: options.windowsIdentity,
        });
      } else {
        await restrictPosix(filesystem, target, 'directory');
      }
    },
    async restrictFile(target) {
      if (platform === 'win32') {
        await restrictWindows({
          commandRunner,
          filesystem,
          kind: 'file',
          target,
          windowsIdentity: options.windowsIdentity,
        });
      } else {
        await restrictPosix(filesystem, target, 'file');
      }
    },
  });
}

module.exports = {
  FilePermissionError,
  createNodeFilePermissions,
};
