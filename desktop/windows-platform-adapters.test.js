'use strict';

const assert = require('node:assert/strict');
const { lstatSync, mkdirSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } = require('node:fs');
const { mkdtemp, readFile, readdir, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const test = require('node:test');

const {
  WindowsPlatformAdapterError,
  createDpapiProtection,
  createPowerShellAclController,
  createPowerShellAclControllerSync,
  createStandaloneWindowsPlatformAdapters,
  createWindowsPlatformAdapters,
  runPowerShellJsonSync,
} = require('./windows-platform-adapters');

function fakeAclController(events) {
  return {
    async restrict(input) {
      events.push({ ...input });
      return { verified: true };
    },
  };
}

function fakeSafeStorage() {
  return {
    decryptString(value) {
      return Buffer.from(value).subarray(4).toString('utf8').split('').reverse().join('');
    },
    encryptString(value) {
      return Buffer.concat([Buffer.from('enc:'), Buffer.from(value.split('').reverse().join(''))]);
    },
    isEncryptionAvailable() {
      return true;
    },
  };
}

function fakeDpapi() {
  return {
    async protect(value) {
      return Buffer.concat([Buffer.from('dpapi:'), Buffer.from(value)]);
    },
    async unprotect(value) {
      return Buffer.from(value).subarray(6);
    },
  };
}

function fakeSyncAclController(events) {
  return {
    restrict(input) {
      events.push({ ...input });
      return { verified: true };
    },
  };
}

test('Electron adapters keep runtime data under LOCALAPPDATA and persist only safeStorage ciphertext', async t => {
  const localAppData = await mkdtemp(join(tmpdir(), 'easy-rewind-platform-electron-'));
  t.after(() => rm(localAppData, { force: true, recursive: true }));
  const aclEvents = [];
  const adapters = createWindowsPlatformAdapters({
    aclController: fakeAclController(aclEvents),
    localAppData,
    platform: 'win32',
    safeStorage: fakeSafeStorage(),
  });

  assert.equal(adapters.storageRoot, resolve(localAppData, 'easy-rewind', 'runtime'));
  await adapters.secretStoreAdapter.set('install/token', 'plaintext-must-not-survive');
  assert.equal(await adapters.secretStoreAdapter.get('install/token'), 'plaintext-must-not-survive');

  const secretsRoot = resolve(localAppData, 'easy-rewind', 'runtime', 'secrets');
  const [secretFilename] = await readdir(secretsRoot);
  const secretPath = resolve(secretsRoot, secretFilename);
  assert.ok(secretPath.startsWith(resolve(localAppData, 'easy-rewind', 'runtime', 'secrets')));
  const stored = await readFile(secretPath);
  assert.equal(stored.includes(Buffer.from('plaintext-must-not-survive')), false);
  assert.equal(stored.subarray(0, 4).toString('utf8'), 'enc:');
  assert.equal(
    aclEvents.some(event => event.kind === 'directory'),
    true
  );
});

test('standalone adapters round-trip text and binary values through injected current-user DPAPI', async t => {
  const localAppData = await mkdtemp(join(tmpdir(), 'easy-rewind-platform-standalone-'));
  t.after(() => rm(localAppData, { force: true, recursive: true }));
  const adapters = createStandaloneWindowsPlatformAdapters({
    aclController: fakeAclController([]),
    dpapi: fakeDpapi(),
    localAppData,
    platform: 'win32',
  });

  await adapters.secretStoreAdapter.set('install/text', 'preserve whitespace ');
  assert.equal(await adapters.secretStoreAdapter.get('install/text'), 'preserve whitespace ');
  const binary = Uint8Array.from([0, 1, 2, 250, 255]);
  await adapters.secretStoreAdapter.set('install/binary', binary);
  assert.deepEqual(await adapters.secretStoreAdapter.get('install/binary'), binary);
  await adapters.secretStoreAdapter.delete('install/text');
  await adapters.secretStoreAdapter.delete('install/text');
  assert.equal(await adapters.secretStoreAdapter.get('install/text'), null);
});

test('adapter creation and operations fail closed without Windows encryption or verified ACLs', async t => {
  const localAppData = await mkdtemp(join(tmpdir(), 'easy-rewind-platform-failure-'));
  t.after(() => rm(localAppData, { force: true, recursive: true }));

  for (const create of [
    () =>
      createWindowsPlatformAdapters({
        aclController: fakeAclController([]),
        localAppData,
        platform: 'linux',
        safeStorage: fakeSafeStorage(),
      }),
    () =>
      createWindowsPlatformAdapters({
        aclController: fakeAclController([]),
        localAppData,
        platform: 'win32',
        safeStorage: { ...fakeSafeStorage(), isEncryptionAvailable: () => false },
      }),
    () =>
      createStandaloneWindowsPlatformAdapters({
        aclController: fakeAclController([]),
        localAppData: '',
        platform: 'win32',
        dpapi: fakeDpapi(),
      }),
  ]) {
    assert.throws(
      create,
      error => error instanceof WindowsPlatformAdapterError && !error.message.includes(localAppData)
    );
  }

  const adapters = createStandaloneWindowsPlatformAdapters({
    aclController: { restrict: async () => ({ verified: false, diagnostic: localAppData }) },
    dpapi: fakeDpapi(),
    localAppData,
    platform: 'win32',
  });
  await assert.rejects(
    adapters.secretStoreAdapter.set('sensitive/name', 'sensitive-value'),
    error =>
      error instanceof WindowsPlatformAdapterError &&
      !error.message.includes('sensitive/name') &&
      !error.message.includes('sensitive-value') &&
      !error.message.includes(localAppData)
  );
});

test('secret filenames do not expose logical names and repeated writes keep one protected target', async t => {
  const localAppData = await mkdtemp(join(tmpdir(), 'easy-rewind-platform-idempotent-'));
  t.after(() => rm(localAppData, { force: true, recursive: true }));
  const events = [];
  const adapters = createStandaloneWindowsPlatformAdapters({
    aclController: fakeAclController(events),
    dpapi: fakeDpapi(),
    localAppData,
    platform: 'win32',
  });

  await adapters.secretStoreAdapter.set('private/provider/key', 'first');
  await adapters.secretStoreAdapter.set('private/provider/key', 'second');
  assert.equal(await adapters.secretStoreAdapter.get('private/provider/key'), 'second');
  const files = await readdir(resolve(adapters.storageRoot, 'secrets'));
  assert.equal(files.length, 1);
  assert.equal(files[0].includes('private'), false);
  assert.equal(files[0].includes('provider'), false);
  assert.equal(
    events.filter(event => event.kind === 'file').every(event => event.target.endsWith('.tmp')),
    true
  );
});

test('permission adapter rejects paths outside its trusted runtime root before invoking ACL mutation', async t => {
  const localAppData = await mkdtemp(join(tmpdir(), 'easy-rewind-platform-boundary-'));
  t.after(() => rm(localAppData, { force: true, recursive: true }));
  const events = [];
  const adapters = createStandaloneWindowsPlatformAdapters({
    aclController: fakeAclController(events),
    dpapi: fakeDpapi(),
    localAppData,
    platform: 'win32',
  });

  await assert.rejects(
    adapters.filePermissions.restrictDirectory(localAppData),
    error => error instanceof WindowsPlatformAdapterError && error.code === 'WINDOWS_ACL_TARGET_INVALID'
  );
  assert.deepEqual(events, []);
});

test('standalone DPAPI command loads the Windows protection assembly and never embeds plaintext in its script', async () => {
  const calls = [];
  const protection = createDpapiProtection({
    async execute(options) {
      calls.push(options);
      if (!options.script.includes('Add-Type -AssemblyName System.Security')) {
        throw new Error('DPAPI assembly was not loaded');
      }
      return { value: options.input.value };
    },
  });

  const plaintext = Buffer.from('command-boundary-secret');
  const encrypted = await protection.protect(plaintext);
  assert.deepEqual(encrypted, plaintext);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].script.includes('command-boundary-secret'), false);
  assert.equal(calls[0].input.value, plaintext.toString('base64'));
});

test('ACL command reads only non-audit sections and short-circuits an already exact ACL', async () => {
  const controller = createPowerShellAclController({
    async execute(options) {
      assert.match(options.script, /AccessControlSections\]'Access, Owner, Group'/);
      assert.match(options.script, /Directory\]::GetAccessControl/);
      assert.match(options.script, /File\]::GetAccessControl/);
      assert.doesNotMatch(options.script, /Get-Acl/);
      const exactCheck = options.script.indexOf('Test-ExactCurrentUserAcl');
      const mutation = options.script.indexOf('Set-Acl');
      assert.notEqual(exactCheck, -1);
      assert.notEqual(mutation, -1);
      assert.ok(exactCheck < mutation);
      assert.match(options.script, /if \(Test-ExactCurrentUserAcl[\s\S]+?exit 0/);
      return { verified: true };
    },
  });

  assert.deepEqual(await controller.restrict({ kind: 'file', target: 'C:\\fixture\\secret.bin' }), {
    verified: true,
  });
});

test('artifact permissions synchronously restrict a runtime file and preserve its identity', async t => {
  const localAppData = await mkdtemp(join(tmpdir(), 'easy-rewind-platform-artifact-'));
  t.after(() => rm(localAppData, { force: true, recursive: true }));
  const events = [];
  const adapters = createStandaloneWindowsPlatformAdapters({
    aclController: fakeAclController([]),
    dpapi: fakeDpapi(),
    localAppData,
    platform: 'win32',
    syncAclController: fakeSyncAclController(events),
  });
  const target = resolve(adapters.storageRoot, 'exports', 'owner-one', 'export.json.tmp');
  mkdirSync(resolve(target, '..'), { recursive: true });
  writeFileSync(target, 'sensitive export');
  const identityBefore = `${String(lstatSync(target).dev)}:${String(lstatSync(target).ino)}`;

  assert.equal(adapters.artifactFilePermissions.restrictFile(target), undefined);

  assert.deepEqual(events, [{ kind: 'file', target }]);
  const identityAfter = `${String(lstatSync(target).dev)}:${String(lstatSync(target).ino)}`;
  assert.equal(identityAfter, identityBefore);
});

test('artifact permissions reject outside-root and linked targets before ACL mutation', async t => {
  const localAppData = await mkdtemp(join(tmpdir(), 'easy-rewind-platform-artifact-boundary-'));
  t.after(() => rm(localAppData, { force: true, recursive: true }));
  const events = [];
  const adapters = createStandaloneWindowsPlatformAdapters({
    aclController: fakeAclController([]),
    dpapi: fakeDpapi(),
    localAppData,
    platform: 'win32',
    syncAclController: fakeSyncAclController(events),
  });
  const outside = resolve(localAppData, 'outside');
  const outsideFile = resolve(outside, 'artifact.json');
  mkdirSync(outside, { recursive: true });
  writeFileSync(outsideFile, 'outside');

  assert.throws(
    () => adapters.artifactFilePermissions.restrictFile(outsideFile),
    error => error instanceof WindowsPlatformAdapterError && error.code === 'WINDOWS_ACL_TARGET_INVALID'
  );

  const linkedOwner = resolve(adapters.storageRoot, 'exports', 'linked-owner');
  mkdirSync(resolve(linkedOwner, '..'), { recursive: true });
  try {
    symlinkSync(outside, linkedOwner, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (error?.code === 'EPERM' || error?.code === 'EACCES') {
      t.skip('creating links is unavailable to this Windows user');
      return;
    }
    throw error;
  }
  assert.throws(
    () => adapters.artifactFilePermissions.restrictFile(resolve(linkedOwner, 'artifact.json')),
    error => error instanceof WindowsPlatformAdapterError && error.code === 'WINDOWS_ACL_TARGET_INVALID'
  );
  assert.deepEqual(events, []);
});

test('artifact permissions fail verification when ACL mutation replaces the file', async t => {
  const localAppData = await mkdtemp(join(tmpdir(), 'easy-rewind-platform-artifact-race-'));
  t.after(() => rm(localAppData, { force: true, recursive: true }));
  const adapters = createStandaloneWindowsPlatformAdapters({
    aclController: fakeAclController([]),
    dpapi: fakeDpapi(),
    localAppData,
    platform: 'win32',
    syncAclController: {
      restrict() {
        unlinkSync(target);
        writeFileSync(target, 'replacement');
        return { verified: true };
      },
    },
  });
  const target = resolve(adapters.storageRoot, 'backups', 'owner-one', 'backup.json.tmp');
  mkdirSync(resolve(target, '..'), { recursive: true });
  writeFileSync(target, 'original');

  assert.throws(
    () => adapters.artifactFilePermissions.restrictFile(target),
    error => error instanceof WindowsPlatformAdapterError && error.code === 'WINDOWS_ACL_VERIFICATION_FAILED'
  );
});

test('artifact permissions reject reparse-point metadata before ACL mutation', async t => {
  const localAppData = await mkdtemp(join(tmpdir(), 'easy-rewind-platform-artifact-reparse-'));
  t.after(() => rm(localAppData, { force: true, recursive: true }));
  const events = [];
  const adapters = createStandaloneWindowsPlatformAdapters({
    aclController: fakeAclController([]),
    dpapi: fakeDpapi(),
    localAppData,
    platform: 'win32',
    syncAclController: fakeSyncAclController(events),
    syncFilesystem: {
      lstatSync(target) {
        const metadata = lstatSync(target, { bigint: true });
        return {
          dev: metadata.dev,
          ino: metadata.ino,
          isDirectory: () => metadata.isDirectory(),
          isFile: () => metadata.isFile(),
          isReparsePoint: () => true,
          isSymbolicLink: () => metadata.isSymbolicLink(),
        };
      },
      realpathSync,
    },
  });
  const target = resolve(adapters.storageRoot, 'exports', 'owner-one', 'artifact.json.tmp');
  mkdirSync(resolve(target, '..'), { recursive: true });
  writeFileSync(target, 'artifact');

  assert.throws(
    () => adapters.artifactFilePermissions.restrictFile(target),
    error => error instanceof WindowsPlatformAdapterError && error.code === 'WINDOWS_ACL_TARGET_INVALID'
  );
  assert.deepEqual(events, []);
});

test('synchronous PowerShell runner hides its window and bounds time and output', () => {
  const calls = [];
  const result = runPowerShellJsonSync({
    executable: 'powershell.exe',
    input: { target: 'C:\\runtime\\artifact.json' },
    script: 'script-body',
    spawnSync(executable, args, options) {
      calls.push({ executable, args, options });
      return { error: undefined, signal: null, status: 0, stdout: '{"verified":true}' };
    },
  });

  assert.deepEqual(result, { verified: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.windowsHide, true);
  assert.equal(calls[0].options.timeout, 15_000);
  assert.equal(calls[0].options.maxBuffer <= 1024 * 1024, true);
  assert.equal(calls[0].options.stdio[2], 'ignore');
  assert.equal(calls[0].options.input, JSON.stringify({ target: 'C:\\runtime\\artifact.json' }));
});

test('synchronous ACL controller uses the exact current-user ACL verification script', () => {
  const controller = createPowerShellAclControllerSync({
    execute(options) {
      assert.match(options.script, /WindowsIdentity\]::GetCurrent\(\)\.User/);
      assert.match(options.script, /\$candidateRules\.Count -eq 1/);
      assert.match(options.script, /FileSystemRights\]::FullControl/);
      assert.match(options.script, /AreAccessRulesProtected/);
      return { verified: true };
    },
  });

  assert.deepEqual(controller.restrict({ kind: 'file', target: 'C:\\fixture\\artifact.json' }), {
    verified: true,
  });
});
