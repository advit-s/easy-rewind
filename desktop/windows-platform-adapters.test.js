'use strict';

const assert = require('node:assert/strict');
const { mkdtemp, readFile, readdir, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const test = require('node:test');

const {
  WindowsPlatformAdapterError,
  createDpapiProtection,
  createPowerShellAclController,
  createStandaloneWindowsPlatformAdapters,
  createWindowsPlatformAdapters,
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
  assert.equal(events.filter(event => event.kind === 'file').every(event => event.target.endsWith('.tmp')), true);
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

test('ACL command reads only access, owner, and group sections without copying privileged audit state', async () => {
  const controller = createPowerShellAclController({
    async execute(options) {
      assert.match(options.script, /AccessControlSections\]'Access, Owner, Group'/);
      assert.match(options.script, /Directory\]::GetAccessControl/);
      assert.match(options.script, /File\]::GetAccessControl/);
      assert.doesNotMatch(options.script, /Get-Acl/);
      return { verified: true };
    },
  });

  assert.deepEqual(await controller.restrict({ kind: 'file', target: 'C:\\fixture\\secret.bin' }), {
    verified: true,
  });
});
