'use strict';

const { isAbsolute, resolve } = require('node:path');

const FILE_PERMISSION_ERROR_MESSAGES = Object.freeze({
  FILE_PERMISSION_ADAPTER_INVALID: 'The restrictive file-permission adapter is invalid.',
  FILE_PERMISSION_TARGET_INVALID: 'The permission target must be one exact absolute path.',
  FILE_PERMISSION_TARGET_LINKED: 'Permission targets must not be links or reparse points.',
  FILE_PERMISSION_TARGET_TYPE: 'The permission target type does not match the requested operation.',
  FILE_PERMISSION_PLATFORM_UNSUPPORTED: 'Restrictive permissions are not supported on this platform.',
  FILE_PERMISSION_WINDOWS_IDENTITY_INVALID: 'A valid Windows security identity is required.',
  FILE_PERMISSION_OPERATION_FAILED: 'The restrictive file-permission operation failed.',
  FILE_PERMISSION_VERIFICATION_FAILED: 'Restrictive file permissions could not be verified.',
});

class FilePermissionError extends Error {
  constructor(code) {
    super(FILE_PERMISSION_ERROR_MESSAGES[code]);
    this.name = 'FilePermissionError';
    this.code = code;
  }
}

function failFilePermission(code) {
  throw new FilePermissionError(code);
}

function normalizePermissionTarget(value) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.trim() !== value ||
    !isAbsolute(value) ||
    resolve(value) !== value
  ) {
    failFilePermission('FILE_PERMISSION_TARGET_INVALID');
  }
  return value;
}

function validateAdapter(adapter) {
  if (
    adapter === null ||
    typeof adapter !== 'object' ||
    typeof adapter.restrictDirectory !== 'function' ||
    typeof adapter.restrictFile !== 'function'
  ) {
    failFilePermission('FILE_PERMISSION_ADAPTER_INVALID');
  }
}

async function invokeAdapter(operation, target) {
  try {
    await operation(target);
  } catch (error) {
    if (error instanceof FilePermissionError) throw error;
    failFilePermission('FILE_PERMISSION_OPERATION_FAILED');
  }
}

function createFilePermissions(adapter) {
  validateAdapter(adapter);

  return Object.freeze({
    async restrictDirectory(target) {
      const normalizedTarget = normalizePermissionTarget(target);
      await invokeAdapter(adapter.restrictDirectory.bind(adapter), normalizedTarget);
    },
    async restrictFile(target) {
      const normalizedTarget = normalizePermissionTarget(target);
      await invokeAdapter(adapter.restrictFile.bind(adapter), normalizedTarget);
    },
  });
}

module.exports = {
  FILE_PERMISSION_ERROR_MESSAGES,
  FilePermissionError,
  createFilePermissions,
  failFilePermission,
  normalizePermissionTarget,
};
