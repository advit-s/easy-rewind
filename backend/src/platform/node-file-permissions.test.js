'use strict';

const assert = require('node:assert/strict');
const { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const test = require('node:test');

function loadNodeFilePermissions() {
  return require('./node-file-permissions');
}

function metadata({ type, mode = 0o100777, linked = false, dev = 1, ino = 1, fileId, reparse = false }) {
  return {
    mode,
    dev,
    ino,
    fileId,
    isSymbolicLink: () => linked,
    isReparsePoint: () => reparse,
    isDirectory: () => type === 'directory',
    isFile: () => type === 'file',
  };
}

function fakePosixFilesystem(entries, { applyMode = true, chmodError = null, onClose = () => {} } = {}) {
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
    async realpath(path) {
      return path;
    },
    async open(path) {
      const entry = entries.get(path);
      if (!entry) {
        const error = new Error('missing fixture');
        error.code = 'ENOENT';
        throw error;
      }
      return {
        async stat() {
          return metadata(entry);
        },
        async chmod(mode) {
          if (chmodError) throw chmodError;
          if (applyMode) entry.mode = (entry.mode & ~0o777) | mode;
        },
        async close() {
          onClose();
        },
      };
    },
  };
}

function fakePosixSecurity(filesystem) {
  return {
    async openLockedTarget(target, options) {
      assert.equal(['directory', 'file'].includes(options.kind), true);
      assert.deepEqual(Object.keys(options).sort(), ['kind', 'noFollow']);
      assert.equal(options.noFollow, true);
      return filesystem.open(target);
    },
  };
}

const selectedWindowsSid = 'S-1-5-21-1000';

function expectedWindowsAcl(kind, overrides = {}) {
  const base = {
    ownerSid: selectedWindowsSid,
    protected: true,
    entries: [
      {
        type: 'allow',
        sid: selectedWindowsSid,
        rights: ['full-control'],
        inheritance: kind === 'directory' ? ['container-inherit', 'object-inherit'] : [],
        inherited: false,
      },
    ],
  };
  return { ...base, ...overrides };
}

function fakeWindowsSecurity({ acl, fileId = 'file-id-1' }) {
  const calls = [];
  return {
    calls,
    async withLockedTarget(target, callback) {
      calls.push(['lock', target]);
      return callback({
        async getIdentity() {
          calls.push(['identity']);
          return { fileId };
        },
        async applyAcl(policy) {
          calls.push(['apply', policy]);
        },
        async readAcl() {
          calls.push(['read']);
          return acl;
        },
      });
    },
  };
}

test('Windows adapter applies and verifies a structured restrictive ACL through a locked target', async () => {
  const trustedRoot = resolve('permission-fixture');
  const file = join(trustedRoot, 'state.json');
  const entries = new Map([
    [trustedRoot, { type: 'directory', mode: 0o40700, fileId: 'root-id' }],
    [file, { type: 'file', mode: 0o100666, fileId: 'file-id-1' }],
  ]);
  const windowsSecurity = fakeWindowsSecurity({ acl: expectedWindowsAcl('file') });
  const { createNodeFilePermissions } = loadNodeFilePermissions();
  const permissions = createNodeFilePermissions({
    platform: 'win32',
    trustedRoot,
    filesystem: fakePosixFilesystem(entries),
    windowsIdentity: selectedWindowsSid,
    windowsSecurity,
    commandRunner: {
      async run() {
        return { exitCode: 0 };
      },
    },
  });

  await permissions.restrictFile(file);

  assert.deepEqual(windowsSecurity.calls, [
    ['lock', file],
    ['identity'],
    [
      'apply',
      {
        ownerSid: selectedWindowsSid,
        protected: true,
        entries: [
          {
            type: 'allow',
            sid: selectedWindowsSid,
            rights: ['full-control'],
            inheritance: [],
            inherited: false,
          },
        ],
      },
    ],
    ['read'],
    ['identity'],
  ]);
});

test('Windows adapter applies directory-only inheritance to its exact restrictive ACL', async () => {
  const trustedRoot = resolve('permission-fixture');
  const directory = join(trustedRoot, 'directory');
  const entries = new Map([
    [trustedRoot, { type: 'directory', mode: 0o40700, fileId: 'root-id' }],
    [directory, { type: 'directory', mode: 0o40700, fileId: 'directory-id' }],
  ]);
  const windowsSecurity = fakeWindowsSecurity({
    acl: expectedWindowsAcl('directory'),
    fileId: 'directory-id',
  });
  const { createNodeFilePermissions } = loadNodeFilePermissions();
  const permissions = createNodeFilePermissions({
    platform: 'win32',
    trustedRoot,
    filesystem: fakePosixFilesystem(entries),
    windowsIdentity: selectedWindowsSid,
    windowsSecurity,
  });

  await permissions.restrictDirectory(directory);

  assert.deepEqual(windowsSecurity.calls[2], ['apply', expectedWindowsAcl('directory')]);
});

test('Windows adapter rejects non-restrictive or ambiguous ACL readback', async t => {
  const trustedRoot = resolve('permission-fixture');
  const file = join(trustedRoot, 'state.json');
  const entries = new Map([
    [trustedRoot, { type: 'directory', mode: 0o40700, fileId: 'root-id' }],
    [file, { type: 'file', mode: 0o100666, fileId: 'file-id-1' }],
  ]);
  const { FilePermissionError, createNodeFilePermissions } = loadNodeFilePermissions();
  const cases = [
    [
      'Everyone allow ACE',
      expectedWindowsAcl('file', {
        entries: [
          ...expectedWindowsAcl('file').entries,
          {
            type: 'allow',
            sid: 'S-1-1-0',
            rights: ['read'],
            inheritance: [],
            inherited: false,
          },
        ],
      }),
    ],
    [
      'second-principal allow ACE',
      expectedWindowsAcl('file', {
        entries: [
          ...expectedWindowsAcl('file').entries,
          {
            type: 'allow',
            sid: 'S-1-5-21-2000',
            rights: ['read'],
            inheritance: [],
            inherited: false,
          },
        ],
      }),
    ],
    [
      'deny ACE for selected SID',
      expectedWindowsAcl('file', {
        entries: [
          ...expectedWindowsAcl('file').entries,
          {
            type: 'deny',
            sid: selectedWindowsSid,
            rights: ['write'],
            inheritance: [],
            inherited: false,
          },
        ],
      }),
    ],
    ['wrong owner', expectedWindowsAcl('file', { ownerSid: 'S-1-5-21-2000' })],
    ['inheritance enabled', expectedWindowsAcl('file', { protected: false })],
    [
      'inherited ACE',
      expectedWindowsAcl('file', {
        entries: [{ ...expectedWindowsAcl('file').entries[0], inherited: true }],
      }),
    ],
    ['missing readback', null],
    ['ambiguous readback', { ownerSid: selectedWindowsSid, protected: true }],
  ];

  for (const [label, acl] of cases) {
    await t.test(label, async () => {
      const permissions = createNodeFilePermissions({
        platform: 'win32',
        trustedRoot,
        filesystem: fakePosixFilesystem(entries),
        windowsIdentity: selectedWindowsSid,
        windowsSecurity: fakeWindowsSecurity({ acl }),
        commandRunner: {
          async run() {
            return { exitCode: 0 };
          },
        },
      });
      await assert.rejects(
        permissions.restrictFile(file),
        error => error instanceof FilePermissionError && error.code === 'FILE_PERMISSION_ACL_VERIFICATION_FAILED'
      );
    });
  }
});

test('Windows adapter rejects a nested junction ancestor before locking or applying ACLs', async () => {
  const trustedRoot = mkdtempSync(join(tmpdir(), 'easy-rewind-permission-root-'));
  const external = mkdtempSync(join(tmpdir(), 'easy-rewind-permission-external-'));
  const linkedDirectory = join(trustedRoot, 'nested');
  const target = join(linkedDirectory, 'marker.txt');
  writeFileSync(join(external, 'marker.txt'), 'keep');
  symlinkSync(external, linkedDirectory, process.platform === 'win32' ? 'junction' : 'dir');
  const windowsSecurity = fakeWindowsSecurity({ acl: expectedWindowsAcl('file') });
  const { FilePermissionError, createNodeFilePermissions } = loadNodeFilePermissions();
  const permissions = createNodeFilePermissions({
    platform: 'win32',
    trustedRoot,
    windowsIdentity: selectedWindowsSid,
    windowsSecurity,
  });

  try {
    await assert.rejects(
      permissions.restrictFile(target),
      error => error instanceof FilePermissionError && error.code === 'FILE_PERMISSION_TARGET_LINKED'
    );
    assert.deepEqual(windowsSecurity.calls, []);
    assert.equal(readFileSync(join(external, 'marker.txt'), 'utf8'), 'keep');
  } finally {
    unlinkSync(linkedDirectory);
    rmSync(trustedRoot, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  }
});

test('node adapter requires a trusted root and rejects targets outside it', async () => {
  const trustedRoot = resolve('permission-fixture');
  const outside = resolve('outside-fixture', 'state.json');
  const entries = new Map([
    [trustedRoot, { type: 'directory', mode: 0o40700, fileId: 'root-id' }],
    [outside, { type: 'file', mode: 0o100600, fileId: 'outside-id' }],
  ]);
  const windowsSecurity = fakeWindowsSecurity({
    acl: expectedWindowsAcl('file'),
    fileId: 'outside-id',
  });
  const { FilePermissionError, createNodeFilePermissions } = loadNodeFilePermissions();

  assert.throws(
    () =>
      createNodeFilePermissions({
        platform: 'win32',
        filesystem: fakePosixFilesystem(entries),
        windowsIdentity: selectedWindowsSid,
        windowsSecurity,
      }),
    error => error instanceof FilePermissionError && error.code === 'FILE_PERMISSION_TRUSTED_ROOT_REQUIRED'
  );

  const permissions = createNodeFilePermissions({
    platform: 'win32',
    trustedRoot,
    filesystem: fakePosixFilesystem(entries),
    windowsIdentity: selectedWindowsSid,
    windowsSecurity,
  });
  await assert.rejects(
    permissions.restrictFile(outside),
    error => error instanceof FilePermissionError && error.code === 'FILE_PERMISSION_TARGET_OUTSIDE_ROOT'
  );
  assert.deepEqual(windowsSecurity.calls, []);
});

test('node adapter rejects dangling and injected reparse ancestry before mutation', async t => {
  await t.test('dangling junction', async () => {
    const trustedRoot = mkdtempSync(join(tmpdir(), 'easy-rewind-permission-root-'));
    const link = join(trustedRoot, 'dangling');
    const missingTarget = join(tmpdir(), `easy-rewind-missing-${Date.now()}`);
    symlinkSync(missingTarget, link, process.platform === 'win32' ? 'junction' : 'dir');
    const windowsSecurity = fakeWindowsSecurity({ acl: expectedWindowsAcl('file') });
    const { FilePermissionError, createNodeFilePermissions } = loadNodeFilePermissions();
    const permissions = createNodeFilePermissions({
      platform: 'win32',
      trustedRoot,
      windowsIdentity: selectedWindowsSid,
      windowsSecurity,
    });

    try {
      await assert.rejects(
        permissions.restrictFile(join(link, 'state.json')),
        error => error instanceof FilePermissionError && error.code === 'FILE_PERMISSION_TARGET_LINKED'
      );
      assert.deepEqual(windowsSecurity.calls, []);
    } finally {
      unlinkSync(link);
      rmSync(trustedRoot, { recursive: true, force: true });
    }
  });

  await t.test('injected reparse component', async () => {
    const trustedRoot = resolve('permission-fixture');
    const reparseDirectory = join(trustedRoot, 'reparse');
    const file = join(reparseDirectory, 'state.json');
    const entries = new Map([
      [trustedRoot, { type: 'directory', mode: 0o40700, fileId: 'root-id' }],
      [
        reparseDirectory,
        {
          type: 'directory',
          mode: 0o40700,
          fileId: 'reparse-id',
          reparse: true,
        },
      ],
      [file, { type: 'file', mode: 0o100600, fileId: 'file-id' }],
    ]);
    const windowsSecurity = fakeWindowsSecurity({
      acl: expectedWindowsAcl('file'),
      fileId: 'file-id',
    });
    const { FilePermissionError, createNodeFilePermissions } = loadNodeFilePermissions();
    const permissions = createNodeFilePermissions({
      platform: 'win32',
      trustedRoot,
      filesystem: fakePosixFilesystem(entries),
      windowsIdentity: selectedWindowsSid,
      windowsSecurity,
    });

    await assert.rejects(
      permissions.restrictFile(file),
      error => error instanceof FilePermissionError && error.code === 'FILE_PERMISSION_TARGET_LINKED'
    );
    assert.deepEqual(windowsSecurity.calls, []);
  });
});

test('Windows adapter detects a target swap before ACL application', async () => {
  const trustedRoot = resolve('permission-fixture');
  const file = join(trustedRoot, 'state.json');
  const entries = new Map([
    [trustedRoot, { type: 'directory', mode: 0o40700, fileId: 'root-id' }],
    [file, { type: 'file', mode: 0o100600, fileId: 'original-id' }],
  ]);
  let applyCalls = 0;
  const windowsSecurity = {
    async withLockedTarget(_target, callback) {
      return callback({
        async getIdentity() {
          return { fileId: 'external-id' };
        },
        async applyAcl() {
          applyCalls += 1;
        },
        async readAcl() {
          return expectedWindowsAcl('file');
        },
      });
    },
  };
  const { FilePermissionError, createNodeFilePermissions } = loadNodeFilePermissions();
  const permissions = createNodeFilePermissions({
    platform: 'win32',
    trustedRoot,
    filesystem: fakePosixFilesystem(entries),
    windowsIdentity: selectedWindowsSid,
    windowsSecurity,
  });

  await assert.rejects(
    permissions.restrictFile(file),
    error => error instanceof FilePermissionError && error.code === 'FILE_PERMISSION_IDENTITY_CHANGED'
  );
  assert.equal(applyCalls, 0);
});

test('POSIX adapter detects a target swap before fchmod and preserves external state', async () => {
  const trustedRoot = resolve('permission-fixture');
  const file = join(trustedRoot, 'state.json');
  const original = { type: 'file', mode: 0o100666, dev: 1, ino: 10 };
  const external = { type: 'file', mode: 0o100666, dev: 1, ino: 20, sentinel: 'keep' };
  const rootEntry = { type: 'directory', mode: 0o40700, dev: 1, ino: 1 };
  let pathEntry = original;
  let closeCalls = 0;
  const filesystem = {
    async lstat(path) {
      if (path === trustedRoot) return metadata(rootEntry);
      if (path === file) return metadata(pathEntry);
      const error = new Error('missing fixture');
      error.code = 'ENOENT';
      throw error;
    },
    async realpath(path) {
      return path;
    },
    async chmod(_path, mode) {
      pathEntry = external;
      external.mode = (external.mode & ~0o777) | mode;
    },
  };
  const posixSecurity = {
    async openLockedTarget() {
      pathEntry = external;
      return {
        async stat() {
          return metadata(external);
        },
        async chmod(mode) {
          external.mode = (external.mode & ~0o777) | mode;
        },
        async close() {
          closeCalls += 1;
        },
      };
    },
  };
  const { FilePermissionError, createNodeFilePermissions } = loadNodeFilePermissions();
  const permissions = createNodeFilePermissions({
    platform: 'linux',
    trustedRoot,
    filesystem,
    posixSecurity,
  });

  await assert.rejects(
    permissions.restrictFile(file),
    error => error instanceof FilePermissionError && error.code === 'FILE_PERMISSION_IDENTITY_CHANGED'
  );
  assert.equal(external.mode & 0o777, 0o666);
  assert.equal(external.sentinel, 'keep');
  assert.equal(closeCalls, 1);
});

test('POSIX adapter applies and verifies restrictive directory and file modes', async () => {
  const trustedRoot = resolve('permission-fixture');
  const directory = join(trustedRoot, 'directory');
  const file = join(directory, 'state.json');
  const entries = new Map([
    [trustedRoot, { type: 'directory', mode: 0o40700 }],
    [directory, { type: 'directory', mode: 0o40777 }],
    [file, { type: 'file', mode: 0o100666 }],
  ]);
  const filesystem = fakePosixFilesystem(entries);
  const { createNodeFilePermissions } = loadNodeFilePermissions();
  const permissions = createNodeFilePermissions({
    platform: 'linux',
    trustedRoot,
    filesystem,
    posixSecurity: fakePosixSecurity(filesystem),
  });

  await permissions.restrictDirectory(directory);
  await permissions.restrictFile(file);

  assert.equal(entries.get(directory).mode & 0o777, 0o700);
  assert.equal(entries.get(file).mode & 0o777, 0o600);
});

test('POSIX adapter fails explicitly when a restrictive mode cannot be verified', async () => {
  const trustedRoot = resolve('permission-fixture');
  const file = join(trustedRoot, 'state.json');
  const entries = new Map([
    [trustedRoot, { type: 'directory', mode: 0o40700 }],
    [file, { type: 'file', mode: 0o100666 }],
  ]);
  let closeCalls = 0;
  const filesystem = fakePosixFilesystem(entries, {
    applyMode: false,
    onClose() {
      closeCalls += 1;
    },
  });
  const { FilePermissionError, createNodeFilePermissions } = loadNodeFilePermissions();
  const permissions = createNodeFilePermissions({
    platform: 'linux',
    trustedRoot,
    filesystem,
    posixSecurity: fakePosixSecurity(filesystem),
  });

  await assert.rejects(
    permissions.restrictFile(file),
    error => error instanceof FilePermissionError && error.code === 'FILE_PERMISSION_VERIFICATION_FAILED'
  );
  assert.equal(closeCalls, 1);
});

test('POSIX adapter closes its locked handle and sanitizes fchmod failures', async () => {
  const trustedRoot = resolve('permission-fixture');
  const file = join(trustedRoot, 'state.json');
  const sensitiveDetail = `${file}: chmod diagnostic`;
  const entries = new Map([
    [trustedRoot, { type: 'directory', mode: 0o40700 }],
    [file, { type: 'file', mode: 0o100666 }],
  ]);
  let closeCalls = 0;
  const filesystem = fakePosixFilesystem(entries, {
    chmodError: new Error(sensitiveDetail),
    onClose() {
      closeCalls += 1;
    },
  });
  const { FilePermissionError, createNodeFilePermissions } = loadNodeFilePermissions();
  const permissions = createNodeFilePermissions({
    platform: 'linux',
    trustedRoot,
    filesystem,
    posixSecurity: fakePosixSecurity(filesystem),
  });

  await assert.rejects(permissions.restrictFile(file), error => {
    assert.equal(error instanceof FilePermissionError, true);
    assert.equal(error.code, 'FILE_PERMISSION_OPERATION_FAILED');
    assert.equal(error.message.includes(file), false);
    assert.equal(error.message.includes(sensitiveDetail), false);
    return true;
  });
  assert.equal(closeCalls, 1);
});

test('Windows command-only fallback fails closed without mutating the target', async () => {
  const trustedRoot = resolve('permission-fixture');
  const file = join(trustedRoot, 'state.json');
  const entries = new Map([
    [trustedRoot, { type: 'directory', mode: 0o40700, fileId: 'root-id' }],
    [file, { type: 'file', mode: 0o100666, fileId: 'file-id-1' }],
  ]);
  const commands = [];
  const { FilePermissionError, createNodeFilePermissions } = loadNodeFilePermissions();
  const permissions = createNodeFilePermissions({
    platform: 'win32',
    trustedRoot,
    filesystem: fakePosixFilesystem(entries),
    windowsIdentity: selectedWindowsSid,
    commandRunner: {
      async run(executable, args, options) {
        commands.push({ executable, args, options });
        return { exitCode: 0 };
      },
    },
  });

  await assert.rejects(
    permissions.restrictFile(file),
    error => error instanceof FilePermissionError && error.code === 'FILE_PERMISSION_LOCK_UNAVAILABLE'
  );
  assert.deepEqual(commands, []);
  assert.equal(entries.get(file).mode & 0o777, 0o666);
});

test('Windows adapter fails explicitly for missing identity or malformed locked targets', async t => {
  const trustedRoot = resolve('permission-fixture');
  const file = join(trustedRoot, 'state.json');
  const entries = new Map([
    [trustedRoot, { type: 'directory', mode: 0o40700, fileId: 'root-id' }],
    [file, { type: 'file', mode: 0o100666, fileId: 'file-id-1' }],
  ]);
  const { FilePermissionError, createNodeFilePermissions } = loadNodeFilePermissions();

  await t.test('missing identity', async () => {
    const permissions = createNodeFilePermissions({
      platform: 'win32',
      trustedRoot,
      filesystem: fakePosixFilesystem(entries),
      windowsSecurity: fakeWindowsSecurity({ acl: expectedWindowsAcl('file') }),
    });
    await assert.rejects(
      permissions.restrictFile(file),
      error => error instanceof FilePermissionError && error.code === 'FILE_PERMISSION_WINDOWS_IDENTITY_INVALID'
    );
  });

  await t.test('malformed locked target', async () => {
    const permissions = createNodeFilePermissions({
      platform: 'win32',
      trustedRoot,
      filesystem: fakePosixFilesystem(entries),
      windowsIdentity: selectedWindowsSid,
      windowsSecurity: {
        async withLockedTarget(_target, callback) {
          return callback({});
        },
      },
    });
    await assert.rejects(
      permissions.restrictFile(file),
      error => error instanceof FilePermissionError && error.code === 'FILE_PERMISSION_LOCK_UNAVAILABLE'
    );
  });
});

test('node adapter rejects links and wrong target types before changing permissions', async t => {
  const trustedRoot = resolve('permission-fixture');
  const file = join(trustedRoot, 'state.json');
  const linked = join(trustedRoot, 'linked-state.json');
  const directory = join(trustedRoot, 'directory');
  const entries = new Map([
    [trustedRoot, { type: 'directory', mode: 0o40700 }],
    [file, { type: 'file', mode: 0o100666 }],
    [linked, { type: 'file', mode: 0o100666, linked: true }],
    [directory, { type: 'directory', mode: 0o40777 }],
  ]);
  const { FilePermissionError, createNodeFilePermissions } = loadNodeFilePermissions();
  const permissions = createNodeFilePermissions({
    platform: 'linux',
    trustedRoot,
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
  const { FilePermissionError, createNodeFilePermissions } = loadNodeFilePermissions();
  const permissions = createNodeFilePermissions({
    platform: 'win32',
    trustedRoot: parent,
    windowsIdentity: selectedWindowsSid,
    windowsSecurity: {
      async withLockedTarget() {
        throw new Error('ACL helper must not run for a link');
      },
    },
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
  const trustedRoot = resolve('personal-storage');
  const sensitivePath = join(trustedRoot, 'credential.db');
  const sensitiveOutput = 'private ACL diagnostic';
  const entries = new Map([
    [trustedRoot, { type: 'directory', mode: 0o40700, fileId: 'root-id' }],
    [sensitivePath, { type: 'file', mode: 0o100666, fileId: 'file-id-1' }],
  ]);
  const { FilePermissionError, createNodeFilePermissions } = loadNodeFilePermissions();
  const permissions = createNodeFilePermissions({
    platform: 'win32',
    trustedRoot,
    filesystem: fakePosixFilesystem(entries),
    windowsIdentity: selectedWindowsSid,
    windowsSecurity: {
      async withLockedTarget() {
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
