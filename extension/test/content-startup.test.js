import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createContentController,
  requestPrivacySnapshot,
  startContentCapture,
  startContentRuntime,
} from '../content.js';

function eventTarget() {
  const listeners = new Map();
  return {
    listeners,
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    dispatch(type, event = {}) {
      for (const listener of listeners.get(type) || []) listener(event);
    },
  };
}

function environment() {
  const windowTarget = eventTarget();
  const documentTarget = eventTarget();
  const document = {
    ...documentTarget,
    hidden: false,
    title: 'Safe article',
    body: {
      cloneNode() {
        return {
          querySelectorAll() {
            return [];
          },
          textContent: 'A sufficiently long article body for capture.',
        };
      },
    },
    querySelector() {
      return null;
    },
    getSelection() {
      return null;
    },
  };
  const window = {
    ...windowTarget,
    location: new URL('https://docs.example.test/article'),
    getSelection: () => document.getSelection(),
  };
  return { window, document };
}

const enabledPrivacy = {
  captureEnabled: true,
  allowedHosts: [],
  blockedHosts: [],
  minimumDwellMs: 1_000,
  minimumSelectionLength: 8,
};

test('runtime privacy request accepts the background response envelope', async () => {
  const runtime = {
    async sendMessage(message) {
      assert.deepEqual(message, { type: 'GET_PRIVACY_SNAPSHOT' });
      return { ok: true, state: 'ready', data: enabledPrivacy };
    },
  };

  assert.deepEqual(await requestPrivacySnapshot(runtime), enabledPrivacy);
});

test('startup awaits the complete privacy snapshot before installing listeners', async () => {
  const env = environment();
  let resolveSnapshot;
  const pending = new Promise(resolve => {
    resolveSnapshot = resolve;
  });

  const startup = startContentCapture({
    ...env,
    requestPrivacySnapshot: () => pending,
  });
  await Promise.resolve();
  assert.equal(env.document.listeners.size, 0);
  assert.equal(env.window.listeners.size, 0);

  resolveSnapshot(enabledPrivacy);
  const controller = await startup;
  assert.equal(controller.active, true);
  assert.equal(env.document.listeners.has('selectionchange'), true);
  controller.dispose();
});

test('disabled or incomplete snapshots install no listeners or timers', async () => {
  const env = environment();
  let timerCount = 0;
  const controller = await startContentCapture({
    ...env,
    requestPrivacySnapshot: async () => ({ captureEnabled: true }),
    setTimeout() {
      timerCount += 1;
      return timerCount;
    },
  });

  assert.equal(controller.active, false);
  assert.equal(env.document.listeners.size, 0);
  assert.equal(env.window.listeners.size, 0);
  assert.equal(timerCount, 0);
});

test('controller never observes keypress or input events and ignores editable selections', () => {
  const env = environment();
  const sent = [];
  env.document.getSelection = () => ({
    isCollapsed: false,
    toString: () => 'typed private value',
    anchorNode: { closest: () => ({ tagName: 'TEXTAREA' }) },
  });
  const controller = createContentController({
    ...env,
    settings: enabledPrivacy,
    now: () => 2_000,
    sendMessage: message => sent.push(message),
    setTimeout: () => 1,
    clearTimeout() {},
  });

  controller.start();
  assert.equal(env.document.listeners.has('keydown'), false);
  assert.equal(env.document.listeners.has('input'), false);
  env.document.dispatch('selectionchange');
  assert.deepEqual(sent, []);
  controller.dispose();
});

test('disabling capture immediately removes every listener and timer', () => {
  const env = environment();
  const cleared = [];
  const runtime = eventTarget();
  runtime.onMessage = {
    addListener: listener => runtime.addEventListener('message', listener),
    removeListener: listener => runtime.removeEventListener('message', listener),
  };
  const controller = createContentController({
    ...env,
    runtime,
    settings: enabledPrivacy,
    setTimeout: () => 41,
    clearTimeout: id => cleared.push(id),
  });

  controller.start();
  assert.equal(controller.active, true);
  runtime.dispatch('message', {
    type: 'PRIVACY_CHANGED',
    payload: { ...enabledPrivacy, captureEnabled: false },
  });

  assert.equal(controller.active, false);
  assert.deepEqual(cleared, [41]);
  for (const listeners of env.document.listeners.values()) assert.equal(listeners.size, 0);
  for (const listeners of env.window.listeners.values()) assert.equal(listeners.size, 0);
  for (const listeners of runtime.listeners.values()) assert.equal(listeners.size, 0);
});

test('runtime privacy broadcasts can enable and disable capture without a page reload', async () => {
  const env = environment();
  const messageListeners = new Set();
  const runtime = {
    onMessage: {
      addListener(listener) {
        messageListeners.add(listener);
      },
      removeListener(listener) {
        messageListeners.delete(listener);
      },
    },
    async sendMessage() {
      return {
        ok: true,
        state: 'ready',
        data: { ...enabledPrivacy, captureEnabled: false },
      };
    },
  };

  const captureRuntime = startContentRuntime({
    ...env,
    runtime,
    now: () => 2_000,
    setTimeout: () => 1,
    clearTimeout() {},
  });
  await captureRuntime.ready;
  assert.equal(env.document.listeners.has('selectionchange'), false);

  for (const listener of [...messageListeners]) {
    listener({
      type: 'PRIVACY_CHANGED',
      payload: enabledPrivacy,
    });
  }
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(env.document.listeners.has('selectionchange'), true);

  for (const listener of [...messageListeners]) {
    listener({
      type: 'PRIVACY_CHANGED',
      payload: { ...enabledPrivacy, captureEnabled: false },
    });
  }
  assert.equal(env.document.listeners.get('selectionchange')?.size ?? 0, 0);

  captureRuntime.dispose();
  assert.equal(messageListeners.size, 0);
});
