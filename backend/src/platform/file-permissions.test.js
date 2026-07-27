'use strict';

const assert = require('node:assert/strict');
const { join, resolve, sep } = require('node:path');
const test = require('node:test');

function loadFilePermissions() {
  return require('./file-permissions');
}

test('file-permission interface validates exact absolute targets and forwards operations', async () => {
  const calls = [];
  const { createFilePermissions } = loadFilePermissions();
  const permissions = createFilePermissions({
    async restrictDirectory(path) {
      calls.push(['directory', path]);
    },
    async restrictFile(path) {
      calls.push(['file', path]);
    },
  });
  const directory = resolve('C:\\permission-fixture', 'directory');
  const file = join(directory, 'state.json');

  await permissions.restrictDirectory(directory);
  await permissions.restrictFile(file);

  assert.deepEqual(calls, [
    ['directory', directory],
    ['file', file],
  ]);
  assert.equal(Object.isFrozen(permissions), true);
});

test('file-permission interface rejects invalid adapters and ambiguous target scope', async () => {
  const { FilePermissionError, createFilePermissions } = loadFilePermissions();
  assert.throws(
    () => createFilePermissions({}),
    error => error instanceof FilePermissionError && error.code === 'FILE_PERMISSION_ADAPTER_INVALID'
  );
  const permissions = createFilePermissions({
    async restrictDirectory() {},
    async restrictFile() {},
  });

  for (const target of [
    '',
    'relative/path',
    ` ${resolve('permission-fixture')}`,
    `${resolve('.')}${sep}a${sep}..${sep}b`,
  ]) {
    await assert.rejects(
      permissions.restrictFile(target),
      error => error instanceof FilePermissionError && error.code === 'FILE_PERMISSION_TARGET_INVALID'
    );
  }
});

test('file-permission interface sanitizes unexpected adapter errors', async () => {
  const sensitivePath = resolve('private-user-path', 'credential.db');
  const { FilePermissionError, createFilePermissions } = loadFilePermissions();
  const permissions = createFilePermissions({
    async restrictDirectory() {
      throw new Error(sensitivePath);
    },
    async restrictFile() {
      throw new Error(sensitivePath);
    },
  });

  await assert.rejects(permissions.restrictFile(sensitivePath), error => {
    assert.equal(error instanceof FilePermissionError, true);
    assert.equal(error.code, 'FILE_PERMISSION_OPERATION_FAILED');
    assert.equal(error.message.includes(sensitivePath), false);
    assert.equal(Object.hasOwn(error, 'cause'), false);
    return true;
  });
});
