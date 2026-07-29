import assert from 'node:assert/strict';
import test from 'node:test';

import { createSessionAuthorizationStore, isValidLocalAuthorization } from '../src/session-authorization.js';

const VALID_AUTHORIZATION = `Bearer eri_install-1.${'A'.repeat(43)}`;

function storageFixture(initial = {}) {
  let values = structuredClone(initial);
  const calls = { get: [], remove: [], set: [] };
  return {
    calls,
    storageArea: {
      async get(key) {
        calls.get.push(key);
        return Object.hasOwn(values, key) ? { [key]: values[key] } : {};
      },
      async remove(key) {
        calls.remove.push(key);
        delete values[key];
      },
      async set(next) {
        calls.set.push(structuredClone(next));
        values = { ...values, ...structuredClone(next) };
      },
    },
    values: () => structuredClone(values),
  };
}

test('accepts only the canonical local-install Bearer authorization shape', () => {
  assert.equal(isValidLocalAuthorization(VALID_AUTHORIZATION), true);
  for (const value of [
    null,
    '',
    `eri_install-1.${'A'.repeat(43)}`,
    `Bearer erd_device-1.${'A'.repeat(43)}`,
    `Bearer eri_install-1.${'A'.repeat(42)}`,
    `Bearer eri_install-1.${'A'.repeat(44)}`,
    `Bearer eri_bad id.${'A'.repeat(43)}`,
    `${VALID_AUTHORIZATION}\nInjected: yes`,
  ]) {
    assert.equal(isValidLocalAuthorization(value), false);
  }
});

test('stores authorization only in the injected session storage area without echoing it', async () => {
  const fixture = storageFixture();
  const store = createSessionAuthorizationStore({ storageArea: fixture.storageArea });

  assert.equal(await store.set(VALID_AUTHORIZATION), undefined);
  assert.deepEqual(fixture.calls.set, [{ localInstallAuthorization: VALID_AUTHORIZATION }]);
  assert.equal(await store.getAuthorization(), VALID_AUTHORIZATION);
  assert.equal(JSON.stringify(store).includes(VALID_AUTHORIZATION), false);

  assert.equal(await store.clear(), undefined);
  assert.deepEqual(fixture.calls.remove, ['localInstallAuthorization']);
  assert.equal(await store.getAuthorization(), null);
});

test('purges malformed session values and never returns them', async () => {
  const fixture = storageFixture({ localInstallAuthorization: 'Bearer invalid' });
  const store = createSessionAuthorizationStore({ storageArea: fixture.storageArea });

  assert.equal(await store.getAuthorization(), null);
  assert.deepEqual(fixture.calls.remove, ['localInstallAuthorization']);
  assert.deepEqual(fixture.values(), {});
});

test('rejects invalid input with a stable non-sensitive error', async () => {
  const fixture = storageFixture();
  const store = createSessionAuthorizationStore({ storageArea: fixture.storageArea });
  const invalid = 'Bearer eri_install-1.not-the-right-length';

  await assert.rejects(store.set(invalid), error => {
    assert.equal(error.message, 'Invalid desktop connection code.');
    assert.equal(error.message.includes(invalid), false);
    return true;
  });
  assert.deepEqual(fixture.calls.set, []);
});
