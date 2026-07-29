import assert from 'node:assert/strict';
import test from 'node:test';

import { EXTENSION_STATE_KEYS, containsCredential, createExtensionStateStore } from '../src/state-store.js';

function clone(value) {
  return structuredClone(value);
}

function createStorageArea(initial = {}) {
  let values = clone(initial);
  const calls = { get: [], remove: [], set: [] };

  return {
    calls,
    async get(keys) {
      calls.get.push(keys);
      return clone(values);
    },
    async remove(keys) {
      const removed = Array.isArray(keys) ? keys : [keys];
      calls.remove.push([...removed]);
      for (const key of removed) delete values[key];
    },
    async set(next) {
      calls.set.push(clone(next));
      values = { ...values, ...clone(next) };
    },
    snapshot() {
      return clone(values);
    },
  };
}

test('state store imports without Chrome and persists only the five frozen top-level keys', async () => {
  assert.equal(globalThis.chrome, undefined);
  assert.deepEqual(EXTENSION_STATE_KEYS, ['connection', 'privacy', 'capture', 'ui', 'sync']);
  assert.equal(Object.isFrozen(EXTENSION_STATE_KEYS), true);

  const storageArea = createStorageArea({ oldSetting: true });
  const store = createExtensionStateStore({ storageArea, now: () => 1_234 });
  const state = await store.load();

  assert.deepEqual(Object.keys(state), EXTENSION_STATE_KEYS);
  assert.deepEqual(Object.keys(storageArea.snapshot()), EXTENSION_STATE_KEYS);
  assert.deepEqual(storageArea.calls.remove, [['oldSetting']]);
  assert.equal(state.capture.enabled, false);
  assert.equal(JSON.stringify(state).includes('hostname'), false);
  assert.equal(Object.isFrozen(state), true);
});

test('migration deletes legacy provider and Gemini fields without translating their values', async () => {
  const storageArea = createStorageArea({
    connection: {
      status: 'ready',
      geminiApiKey: 'legacy-value',
      nested: { provider: 'gemini', safe: true },
    },
    privacy: { allowedHosts: [], providerSettings: { model: 'legacy-model' } },
    capture: { enabled: true, api_key: 'legacy-value' },
    ui: { activeView: 'capture' },
    sync: { cursor: 'cursor-1' },
    easy_rewind_gemini_key: 'legacy-value',
    legacyProvider: 'gemini',
  });
  const store = createExtensionStateStore({ storageArea, now: () => 2_000 });

  const state = await store.load();
  const serialized = JSON.stringify(state);

  assert.deepEqual(Object.keys(storageArea.snapshot()), EXTENSION_STATE_KEYS);
  assert.equal(serialized.includes('legacy-value'), false);
  assert.equal(serialized.toLowerCase().includes('gemini'), false);
  assert.equal(serialized.toLowerCase().includes('provider'), false);
  assert.equal(state.connection.status, 'ready');
  assert.equal(state.connection.nested.safe, true);
  assert.equal(state.capture.enabled, true);
});

test('containsCredential finds credential-shaped keys recursively and terminates on cycles', () => {
  for (const value of [
    { apiKey: 'x' },
    { api_key: 'x' },
    { nested: [{ refreshToken: 'x' }] },
    { client_secret: 'x' },
    { serviceCredential: 'x' },
    { password: 'x' },
  ]) {
    assert.equal(containsCredential(value), true);
  }
  assert.equal(containsCredential({ nested: [{ safe: true }] }), false);

  const cyclic = {};
  cyclic.self = cyclic;
  assert.equal(containsCredential(cyclic), false);
});

test('save rejects missing or extra top-level keys and recursive credentials', async () => {
  const storageArea = createStorageArea();
  const store = createExtensionStateStore({ storageArea, now: () => 3_000 });
  const valid = await store.load();

  await assert.rejects(store.save({ ...valid, extra: {} }), /invalid extension state/i);
  const { ui: _ui, ...missing } = valid;
  await assert.rejects(store.save(missing), /invalid extension state/i);
  await assert.rejects(
    store.save({ ...valid, ui: { nested: { accessToken: 'never-store' } } }),
    /invalid extension state/i
  );
  await assert.rejects(store.save({ ...valid, connection: { provider: 'gemini' } }), /invalid extension state/i);
});

test('save accepts bounded plain JSON and returns an immutable detached snapshot', async () => {
  const storageArea = createStorageArea();
  const store = createExtensionStateStore({ storageArea, now: () => 4_000 });
  const state = await store.load();
  const next = {
    ...state,
    privacy: { allowedHosts: ['example.test'], nested: { enabled: true } },
    capture: { enabled: true },
  };

  const saved = await store.save(next);
  next.privacy.allowedHosts[0] = 'changed.test';

  assert.deepEqual(saved.privacy.allowedHosts, ['example.test']);
  assert.equal(Object.isFrozen(saved.privacy), true);
  assert.equal(Object.isFrozen(saved.privacy.allowedHosts), true);
  assert.deepEqual(storageArea.snapshot().privacy.allowedHosts, ['example.test']);
});

test('state rejects pollution, accessors, cycles, excessive depth, and oversized JSON', async () => {
  const storageArea = createStorageArea();
  const store = createExtensionStateStore({ storageArea, now: () => 5_000 });
  const valid = await store.load();

  const polluted = JSON.parse('{"__proto__":{"polluted":true}}');
  const accessor = {};
  Object.defineProperty(accessor, 'value', { enumerable: true, get: () => 'unsafe' });
  const cyclic = {};
  cyclic.self = cyclic;
  let deep = {};
  for (let index = 0; index < 12; index += 1) deep = { child: deep };

  for (const unsafe of [polluted, accessor, cyclic, deep, { text: 'x'.repeat(70_000) }]) {
    await assert.rejects(
      store.save({ ...valid, ui: unsafe }),
      /invalid extension state/i,
      `expected rejection for ${Object.keys(unsafe)[0] ?? 'unsafe value'}`
    );
  }
});

test('invalid dependencies are rejected and reset restores capture-disabled defaults', async () => {
  assert.throws(() => createExtensionStateStore(), /storageArea/i);
  assert.throws(() => createExtensionStateStore({ storageArea: {}, now: () => 0 }), /storageArea/i);
  assert.throws(() => createExtensionStateStore({ storageArea: createStorageArea(), now: Date.now() }), /now/i);

  const storageArea = createStorageArea({ unknown: true });
  const store = createExtensionStateStore({ storageArea, now: () => 6_000 });
  const reset = await store.reset();

  assert.equal(reset.capture.enabled, false);
  assert.deepEqual(Object.keys(storageArea.snapshot()), EXTENSION_STATE_KEYS);
});
