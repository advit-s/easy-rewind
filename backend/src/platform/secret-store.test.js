'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

function loadSecretStore() {
  return require('./secret-store');
}

test('secret store normalizes names and forwards asynchronous operations without logging', async () => {
  const calls = [];
  const values = new Map();
  const adapter = {
    async get(name) {
      calls.push(['get', name]);
      return values.get(name) ?? null;
    },
    async set(name, value) {
      calls.push(['set', name, value]);
      values.set(name, value);
    },
    async delete(name) {
      calls.push(['delete', name]);
      values.delete(name);
    },
    logger: {
      info() {
        throw new Error('secret store must not log');
      },
      error() {
        throw new Error('secret store must not log');
      },
    },
  };
  const { createSecretStore } = loadSecretStore();
  const store = createSecretStore(adapter);

  await store.set('  install/token  ', '  preserve-secret-whitespace  ');
  assert.equal(await store.get('install/token'), '  preserve-secret-whitespace  ');
  await store.delete(' install/token ');
  assert.equal(await store.get('install/token'), null);

  assert.deepEqual(calls, [
    ['set', 'install/token', '  preserve-secret-whitespace  '],
    ['get', 'install/token'],
    ['delete', 'install/token'],
    ['get', 'install/token'],
  ]);
  assert.equal(Object.isFrozen(store), true);
});

test('secret store copies binary values at its boundary', async () => {
  let persisted;
  const { createSecretStore } = loadSecretStore();
  const store = createSecretStore({
    async get() {
      return persisted;
    },
    async set(_name, value) {
      persisted = value;
    },
    async delete() {},
  });
  const source = Uint8Array.from([1, 2, 3]);

  await store.set('device/key', source);
  source[0] = 99;
  const firstRead = await store.get('device/key');
  firstRead[1] = 88;
  const secondRead = await store.get('device/key');

  assert.deepEqual([...secondRead], [1, 2, 3]);
  assert.notEqual(secondRead, persisted);
});

test('secret store rejects invalid adapters, names, values, and adapter results', async t => {
  const { SecretStoreError, createSecretStore } = loadSecretStore();
  assert.throws(
    () => createSecretStore({}),
    error => error instanceof SecretStoreError && error.code === 'SECRET_STORE_ADAPTER_INVALID'
  );

  const store = createSecretStore({
    async get() {
      return 123;
    },
    async set() {},
    async delete() {},
  });

  for (const name of ['', ' ', '../escape', 'name with spaces', 'x'.repeat(130)]) {
    await t.test(`invalid name ${JSON.stringify(name)}`, async () => {
      await assert.rejects(
        store.get(name),
        error => error instanceof SecretStoreError && error.code === 'SECRET_STORE_NAME_INVALID'
      );
    });
  }
  for (const value of ['', new Uint8Array(), null, 123, { secret: true }]) {
    await t.test(`invalid value ${String(value)}`, async () => {
      await assert.rejects(
        store.set('install/token', value),
        error => error instanceof SecretStoreError && error.code === 'SECRET_STORE_VALUE_INVALID'
      );
    });
  }
  await assert.rejects(
    store.get('install/token'),
    error => error instanceof SecretStoreError && error.code === 'SECRET_STORE_VALUE_INVALID'
  );
});

test('secret store sanitizes adapter failures without exposing secret names or values', async () => {
  const sensitiveName = 'private/credential-name';
  const sensitiveValue = 'credential-value-that-must-not-leak';
  const { SecretStoreError, createSecretStore } = loadSecretStore();
  const store = createSecretStore({
    async get() {
      throw new Error(`adapter failed for ${sensitiveName}`);
    },
    async set() {
      throw new Error(`adapter failed for ${sensitiveValue}`);
    },
    async delete() {
      throw new Error(`adapter failed for ${sensitiveName}`);
    },
  });

  for (const operation of [
    () => store.get(sensitiveName),
    () => store.set(sensitiveName, sensitiveValue),
    () => store.delete(sensitiveName),
  ]) {
    await assert.rejects(operation, error => {
      assert.equal(error instanceof SecretStoreError, true);
      assert.equal(error.code, 'SECRET_STORE_OPERATION_FAILED');
      assert.doesNotMatch(error.message, /private\/credential-name|credential-value-that-must-not-leak/i);
      assert.equal(Object.hasOwn(error, 'cause'), false);
      return true;
    });
  }
});
