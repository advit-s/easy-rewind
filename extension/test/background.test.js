import assert from 'node:assert/strict';
import test from 'node:test';

import { bootstrapBackground, createBackgroundController } from '../background.js';

const VALID_AUTHORIZATION = `Bearer eri_install-1.${'A'.repeat(43)}`;

function event() {
  const listeners = [];
  return {
    addListener(listener) {
      listeners.push(listener);
    },
    dispatch(...args) {
      return Promise.all(listeners.map(listener => listener(...args)));
    },
    listeners,
  };
}

function fixture({ requestResult, healthResult, pullResult } = {}) {
  const calls = {
    menus: [],
    notifications: [],
    requests: [],
    saves: [],
    tabMessages: [],
    authorization: [],
  };
  const runtimeMessage = event();
  const installed = event();
  const startup = event();
  const contextClicked = event();
  const alarm = event();
  let storedState = {
    connection: { status: 'unknown', updatedAt: 1 },
    privacy: {
      allowedHosts: [],
      blockedHosts: [],
      minimumDwellMs: 15_000,
      minimumSelectionLength: 24,
    },
    capture: { enabled: false },
    ui: { activeView: 'capture' },
    sync: { cursor: null, updatedAt: 1 },
  };

  const chromeApi = {
    runtime: { onMessage: runtimeMessage, onInstalled: installed, onStartup: startup },
    contextMenus: {
      onClicked: contextClicked,
      async removeAll() {},
      create(options) {
        calls.menus.push(options);
      },
    },
    alarms: {
      onAlarm: alarm,
      async create() {},
    },
    notifications: {
      async create(id, options) {
        calls.notifications.push({ id, options });
      },
    },
    action: {
      async setBadgeText() {},
      async setBadgeBackgroundColor() {},
      async openPopup() {},
    },
    tabs: {
      async query(query) {
        if (query?.active) {
          return [{ id: 7, url: 'https://example.test/article', title: 'Current article' }];
        }
        return [{ id: 7 }, { id: 8 }];
      },
      async sendMessage(tabId, message) {
        calls.tabMessages.push({ tabId, message });
      },
    },
  };
  const stateStore = {
    async load() {
      return structuredClone(storedState);
    },
    async save(next) {
      storedState = structuredClone(next);
      calls.saves.push(structuredClone(next));
      return structuredClone(storedState);
    },
  };
  const apiClient = {
    async health() {
      return healthResult ?? { state: 'ready', data: { status: 'ok' } };
    },
    async pull() {
      return pullResult ?? { state: 'ready', data: { cursor: 'cursor-2', changes: [] } };
    },
    async push(payload) {
      calls.requests.push({ operation: 'push', payload });
      return { state: 'ready', data: { accepted: 1 } };
    },
    async request(path, options) {
      calls.requests.push({ operation: 'request', path, options });
      return requestResult ?? { state: 'ready', data: { id: 'item-1' } };
    },
  };
  const authorizationStore = {
    async clear() {
      calls.authorization.push({ operation: 'clear' });
    },
    async set(value) {
      calls.authorization.push({ operation: 'set', value });
    },
  };

  return {
    alarm,
    apiClient,
    authorizationStore,
    calls,
    chromeApi,
    contextClicked,
    installed,
    runtimeMessage,
    startup,
    state: () => structuredClone(storedState),
    stateStore,
  };
}

function send(controller, message, sender = {}) {
  return new Promise(resolve => {
    const asynchronous = controller.handleMessage(message, sender, resolve);
    assert.equal(asynchronous, true);
  });
}

test('initialization is idempotent and recreates the minimum context menus', async () => {
  const f = fixture();
  const controller = createBackgroundController({
    chromeApi: f.chromeApi,
    apiClient: f.apiClient,
    authorizationStore: f.authorizationStore,
    stateStore: f.stateStore,
    now: () => 100,
  });

  await Promise.all([controller.initialize(), controller.initialize(), controller.initialize()]);

  assert.deepEqual(
    f.calls.menus.map(menu => menu.id),
    ['easy-rewind-capture-page', 'easy-rewind-capture-selection']
  );
  assert.equal(f.calls.saves.length, 1);
  assert.equal(f.state().connection.status, 'ready');
});

test('unknown and malformed messages are rejected without side effects', async () => {
  const f = fixture();
  const controller = createBackgroundController({
    chromeApi: f.chromeApi,
    apiClient: f.apiClient,
    authorizationStore: f.authorizationStore,
    stateStore: f.stateStore,
    now: () => 100,
  });
  await controller.initialize();
  const saveCount = f.calls.saves.length;

  assert.deepEqual(await send(controller, { type: 'UNKNOWN', token: 'do-not-echo' }), {
    ok: false,
    error: 'invalid_message',
  });
  assert.equal(f.calls.requests.length, 0);
  assert.equal(f.calls.saves.length, saveCount);
});

test('capture routes through the API client and never reports a failed request as success', async () => {
  const failed = fixture({ requestResult: { state: 'offline', error: 'backend_unavailable' } });
  const controller = createBackgroundController({
    chromeApi: failed.chromeApi,
    apiClient: failed.apiClient,
    authorizationStore: failed.authorizationStore,
    stateStore: failed.stateStore,
    now: () => 100,
  });
  await controller.initialize();

  const response = await send(controller, {
    type: 'CAPTURE_PAGE',
    payload: {
      url: 'https://example.test/article',
      title: 'Article',
      text: 'Bounded page text.',
      occurredAt: 99,
    },
  });

  assert.deepEqual(response, { ok: false, state: 'offline', error: 'backend_unavailable' });
  assert.equal(failed.calls.requests[0].path, '/api/items');
  assert.equal(failed.state().connection.status, 'offline');
});

test('retry persists only an acknowledged cursor and exposes conflict state', async () => {
  const conflict = fixture({
    pullResult: { state: 'conflict', error: 'sync_conflict', data: { cursor: 'unacknowledged' } },
  });
  const controller = createBackgroundController({
    chromeApi: conflict.chromeApi,
    apiClient: conflict.apiClient,
    authorizationStore: conflict.authorizationStore,
    stateStore: conflict.stateStore,
    now: () => 200,
  });
  await controller.initialize();

  assert.deepEqual(await send(controller, { type: 'RETRY_SYNC' }), {
    ok: false,
    state: 'conflict',
    error: 'sync_conflict',
  });
  assert.equal(conflict.state().sync.cursor, null);
  assert.equal(conflict.state().connection.status, 'conflict');
});

test('privacy changes are persisted and broadcast to content scripts', async () => {
  const f = fixture();
  const controller = createBackgroundController({
    chromeApi: f.chromeApi,
    apiClient: f.apiClient,
    authorizationStore: f.authorizationStore,
    stateStore: f.stateStore,
    now: () => 300,
  });
  await controller.initialize();

  const response = await send(controller, { type: 'SET_CAPTURE_ENABLED', payload: { enabled: true } });

  assert.deepEqual(response, { ok: true, state: 'ready' });
  assert.equal(f.state().capture.enabled, true);
  assert.deepEqual(f.calls.tabMessages, [
    {
      tabId: 7,
      message: {
        type: 'PRIVACY_CHANGED',
        payload: {
          captureEnabled: true,
          allowedHosts: [],
          blockedHosts: [],
          minimumDwellMs: 15_000,
          minimumSelectionLength: 24,
        },
      },
    },
    {
      tabId: 8,
      message: {
        type: 'PRIVACY_CHANGED',
        payload: {
          captureEnabled: true,
          allowedHosts: [],
          blockedHosts: [],
          minimumDwellMs: 15_000,
          minimumSelectionLength: 24,
        },
      },
    },
  ]);
  assert.deepEqual(controller.getPrivacySnapshot(), {
    captureEnabled: true,
    allowedHosts: [],
    blockedHosts: [],
    minimumDwellMs: 15_000,
    minimumSelectionLength: 24,
  });
});

test('page snapshot is read only from the active tab and is never persisted', async () => {
  const f = fixture();
  const controller = createBackgroundController({
    chromeApi: f.chromeApi,
    apiClient: f.apiClient,
    authorizationStore: f.authorizationStore,
    stateStore: f.stateStore,
    now: () => 350,
  });
  await controller.initialize();
  const saveCount = f.calls.saves.length;

  assert.deepEqual(await send(controller, { type: 'GET_PAGE_SNAPSHOT' }), {
    ok: true,
    state: 'ready',
    page: { url: 'https://example.test/article', title: 'Current article' },
  });
  assert.equal(f.calls.saves.length, saveCount);
});

test('context menu capture opens the popup without storing page content', async () => {
  const f = fixture();
  const controller = createBackgroundController({
    chromeApi: f.chromeApi,
    apiClient: f.apiClient,
    authorizationStore: f.authorizationStore,
    stateStore: f.stateStore,
    now: () => 400,
  });
  await controller.initialize();

  await controller.handleContextMenu(
    { menuItemId: 'easy-rewind-capture-selection', selectionText: 'selected words' },
    { id: 8, url: 'https://example.test/', title: 'Example' }
  );

  assert.equal(f.calls.requests.length, 1);
  assert.equal(f.calls.requests[0].path, '/api/items');
  assert.deepEqual(Object.keys(f.state()), ['connection', 'privacy', 'capture', 'ui', 'sync']);
});

test('desktop authorization messages use only the session store and never echo or persist the code', async () => {
  const f = fixture();
  const controller = createBackgroundController({
    chromeApi: f.chromeApi,
    apiClient: f.apiClient,
    authorizationStore: f.authorizationStore,
    stateStore: f.stateStore,
    now: () => 500,
  });
  await controller.initialize();

  const connected = await send(controller, {
    type: 'SET_LOCAL_AUTHORIZATION',
    payload: { connectionCode: VALID_AUTHORIZATION },
  });
  const disconnected = await send(controller, { type: 'CLEAR_LOCAL_AUTHORIZATION' });

  assert.deepEqual(f.calls.authorization, [{ operation: 'set', value: VALID_AUTHORIZATION }, { operation: 'clear' }]);
  assert.deepEqual(connected, { ok: true, state: 'ready', data: { status: 'ok' } });
  assert.deepEqual(disconnected, { ok: true, state: 'authentication_required' });
  assert.equal(JSON.stringify({ connected, disconnected, state: f.state() }).includes(VALID_AUTHORIZATION), false);
  assert.equal(f.state().connection.status, 'authentication_required');
});

test('production bootstrap authenticates the API client from chrome session storage only', async () => {
  const f = fixture();
  const requests = [];
  const localValues = {};
  const chromeApi = {
    ...f.chromeApi,
    storage: {
      local: {
        async get(keys) {
          const selected = keys === null ? Object.keys(localValues) : keys;
          return Object.fromEntries(
            selected.filter(key => Object.hasOwn(localValues, key)).map(key => [key, localValues[key]])
          );
        },
        async remove(keys) {
          for (const key of Array.isArray(keys) ? keys : [keys]) delete localValues[key];
        },
        async set(next) {
          Object.assign(localValues, structuredClone(next));
        },
      },
      session: {
        async get(key) {
          return key === 'localInstallAuthorization' ? { [key]: VALID_AUTHORIZATION } : {};
        },
        async remove() {},
        async set() {
          throw new Error('bootstrap must not rewrite authorization');
        },
      },
      sync: {
        async get() {
          throw new Error('sync storage must not be read');
        },
      },
    },
  };

  const controller = bootstrapBackground({
    chromeApi,
    async fetch(url, options) {
      requests.push({ url, authorization: options.headers.get('authorization') });
      return new Response(JSON.stringify({ status: 'ok' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
    now: () => 600,
  });
  await controller.initialize();

  assert.equal(requests.length > 0, true);
  assert.deepEqual(requests[0], {
    url: 'http://127.0.0.1:3210/v1/health',
    authorization: VALID_AUTHORIZATION,
  });
  assert.equal(JSON.stringify(localValues).includes(VALID_AUTHORIZATION), false);
});
