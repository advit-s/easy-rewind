'use strict';

const assert = require('node:assert/strict');
const { existsSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const test = require('node:test');

function loadNodeFilePermissions() {
  return require('./node-file-permissions');
}

function metadata({ type, mode = 0o100777, linked = false }) {
  return {
    mode,
    isSymbolicLink: () => linked,
    isDirectory: () => type === 'directory',
    isFile: () => type === 'file',
  };
}

function fakePosixFilesystem(entries, { applyMode = true, chmodError = null } = {}) {
  return {
    async lstat(path) {
      const entry = entries.get(path);
      if (!entry) {
        const error = new Error('missing fixture');
        error.code = 'ENOENT';
        throw error;
      }
      return metadata(entry);
    },
    async chmod(path, mode) {
      if (chmodError) throw chmodError;
      if (applyMode) entries.get(path).mode = (entries.get(path).mode & ~0o777) | mode;
    },
  };
}

test('POSIX adapter applies and verifies restrictive directory and file modes', async () => {
  const directory = resolve('permission-fixture', 'directory');
  const file = join(directory, 'state.json');
  const entries = new Map([
    [directory, { type: 'directory', mode: 0o40777 }],
    [file, { type: 'file', mode: 0o100666 }],
  ]);
  const { createNodeFilePermissions } = loadNodeFilePermissions();
  const permissions = createNodeFilePermissions({
    platform: 'linux',
    filesystem: fakePosixFilesystem(entries),
  });

  await permissions.restrictDirectory(directory);
  await permissions.restrictFile(file);

  assert.equal(entries.get(directory).mode & 0o777, 0o700);
  assert.equal(entries.get(file).mode & 0o777, 0o600);
});

test('POSIX adapter fails explicitly when a restrictive mode cannot be verified', async () => {
  const file = resolve('permission-fixture', 'state.json');
  const entries = new Map([[file, { type: 'file', mode: 0o100666 }]]);
  const { FilePermissionError, createNodeFilePermissions } = loadNodeFilePermissions();
  const permissions = createNodeFilePermissions({
    platform: 'linux',
    filesystem: fakePosixFilesystem(entries, { applyMode: false }),
  });

  await assert.rejects(
    permissions.restrictFile(file),
    error => error instanceof FilePermissionError && error.code === 'FILE_PERMISSION_VERIFICATION_FAILED'
  );
});

test('Windows adapter passes an exact target as argv and never enables a shell', async () => {
  const directory = resolve('permission-fixture', 'directory');
  const file = join(directory, 'state.json');
  const entries = new Map([
    [directory, { type: 'directory', mode: 0o40777 }],
    [file, { type: 'file', mode: 0o100666 }],
  ]);
  const commands = [];
  const { createNodeFilePermissions } = loadNodeFilePermissions();
  const permissions = createNodeFilePermissions({
    platform: 'win32',
    filesystem: fakePosixFilesystem(entries),
    windowsIdentity: 'S-1-5-21-1000',
    commandRunner: {
      async run(executable, args, options) {
        commands.push({ executable, args, options });
        return { exitCode: 0 };
      },
    },
  });

  await permissions.restrictDirectory(directory);
  await permissions.restrictFile(file);

  assert.deepEqual(commands, [
    {
      executable: 'icacls.exe',
      args: [directory, '/inheritance:r', '/grant:r', '*S-1-5-21-1000:(OI)(CI)F'],
      options: { shell: false, windowsHide: true },
    },
    {
      executable: 'icacls.exe',
      args: [file, '/inheritance:r', '/grant:r', '*S-1-5-21-1000:F'],
      options: { shell: false, windowsHide: true },
    },
  ]);
});

test('Windows adapter fails explicitly for missing identity, command failure, or malformed results', async t => {
  const file = resolve('permission-fixture', 'state.json');
  const entries = new Map([[file, { type: 'file', mode: 0o100666 }]]);
  const { FilePermissionError, createNodeFilePermissions } = loadNodeFilePermissions();

  await t.test('missing identity', async () => {
    const permissions = createNodeFilePermissions({
      platform: 'win32',
      filesystem: fakePosixFilesystem(entries),
      commandRunner: {
        async run() {
          return { exitCode: 0 };
        },
      },
    });
    await assert.rejects(
      permissions.restrictFile(file),
      error => error instanceof FilePermissionError && error.code === 'FILE_PERMISSION_WINDOWS_IDENTITY_INVALID'
    );
  });

  for (const result of [{ exitCode: 5 }, {}, null]) {
    await t.test(`command result ${JSON.stringify(result)}`, async () => {
      const permissions = createNodeFilePermissions({
        platform: 'win32',
        filesystem: fakePosixFilesystem(entries),
        windowsIdentity: 'S-1-5-21-1000',
        commandRunner: {
          async run() {
            return result;
          },
        },
      });
      await assert.rejects(
        permissions.restrictFile(file),
        error => error instanceof FilePermissionError && error.code === 'FILE_PERMISSION_OPERATION_FAILED'
      );
    });
  }
});

test('node adapter rejects links and wrong target types before changing permissions', async t => {
  const file = resolve('permission-fixture', 'state.json');
  const linked = resolve('permission-fixture', 'linked-state.json');
  const directory = resolve('permission-fixture', 'directory');
  const entries = new Map([
    [file, { type: 'file', mode: 0o100666 }],
    [linked, { type: 'file', mode: 0o100666, linked: true }],
    [directory, { type: 'directory', mode: 0o40777 }],
  ]);
  const { FilePermissionError, createNodeFilePermissions } = loadNodeFilePermissions();
  const permissions = createNodeFilePermissions({
    platform: 'linux',
    filesystem: fakePosixFilesystem(entries),
  });

  await t.test('linked file', async () => {
    await assert.rejects(
      permissions.restrictFile(linked),
      error => error instanceof FilePermissionError && error.code === 'FILE_PERMISSION_TARGET_LINKED'
    );
  });
  await t.test('directory passed as file', async () => {
    await assert.rejects(
      permissions.restrictFile(directory),
      error => error instanceof FilePermissionError && error.code === 'FILE_PERMISSION_TARGET_TYPE'
    );
  });
  await t.test('file passed as directory', async () => {
    await assert.rejects(
      permissions.restrictDirectory(file),
      error => error instanceof FilePermissionError && error.code === 'FILE_PERMISSION_TARGET_TYPE'
    );
  });
});

test('Windows junction targets are rejected without changing their contents', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'easy-rewind-permission-test-'));
  const external = mkdtempSync(join(tmpdir(), 'easy-rewind-permission-target-'));
  const link = join(parent, 'linked');
  const marker = join(external, 'marker.txt');
  writeFileSync(marker, 'keep');
  symlinkSync(external, link, process.platform === 'win32' ? 'junction' : 'dir');
  const commandRunner = {
    async run() {
      throw new Error('ACL command must not run for a link');
    },
  };
  const { FilePermissionError, createNodeFilePermissions } = loadNodeFilePermissions();
  const permissions = createNodeFilePermissions({
    platform: 'win32',
    windowsIdentity: 'S-1-5-21-1000',
    commandRunner,
  });

  try {
    await assert.rejects(
      permissions.restrictDirectory(link),
      error => error instanceof FilePermissionError && error.code === 'FILE_PERMISSION_TARGET_LINKED'
    );
    assert.equal(existsSync(marker), true);
  } finally {
    if (existsSync(link)) unlinkSync(link);
    rmSync(parent, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  }
});

test('node adapter reports failures with safe messages that omit paths and command output', async () => {
  const sensitivePath = resolve('personal-storage', 'credential.db');
  const sensitiveOutput = 'private ACL diagnostic';
  const entries = new Map([[sensitivePath, { type: 'file', mode: 0o100666 }]]);
  const { FilePermissionError, createNodeFilePermissions } = loadNodeFilePermissions();
  const permissions = createNodeFilePermissions({
    platform: 'win32',
    filesystem: fakePosixFilesystem(entries),
    windowsIdentity: 'S-1-5-21-1000',
    commandRunner: {
      async run() {
        throw new Error(`${sensitivePath}: ${sensitiveOutput}`);
      },
    },
  });

  await assert.rejects(permissions.restrictFile(sensitivePath), error => {
    assert.equal(error instanceof FilePermissionError, true);
    assert.equal(error.code, 'FILE_PERMISSION_OPERATION_FAILED');
    assert.equal(error.message.includes(sensitivePath), false);
    assert.equal(error.message.includes(sensitiveOutput), false);
    assert.equal(Object.hasOwn(error, 'cause'), false);
    return true;
  });
});
