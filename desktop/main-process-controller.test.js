'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const { CHANNELS, MAIN_PROCESS_MAX_PAYLOAD_BYTES, createMainProcessController } = require('./main-process-controller');

class FakeIpcMain extends EventEmitter {
  constructor() {
    super();
    this.handlers = new Map();
  }

  handle(channel, handler) {
    if (this.handlers.has(channel)) throw new Error(`duplicate handler: ${channel}`);
    this.handlers.set(channel, handler);
  }

  removeHandler(channel) {
    this.handlers.delete(channel);
  }

  invoke(channel, event, payload) {
    const handler = this.handlers.get(channel);
    if (!handler) throw new Error(`missing handler: ${channel}`);
    return handler(event, payload);
  }
}

class FakeSession extends EventEmitter {
  setPermissionCheckHandler(handler) {
    this.permissionCheckHandler = handler;
  }

  setPermissionRequestHandler(handler) {
    this.permissionRequestHandler = handler;
  }
}

class FakeWebContents extends EventEmitter {
  constructor(id) {
    super();
    this.id = id;
    this.session = new FakeSession();
  }

  setWindowOpenHandler(handler) {
    this.windowOpenHandler = handler;
  }

  isDestroyed() {
    return false;
  }
}

class FakeNotification extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.showCalls = 0;
  }

  show() {
    this.showCalls += 1;
  }
}

function fakeWindow(id = 1, session) {
  const window = { webContents: new FakeWebContents(id) };
  if (session !== undefined) window.webContents.session = session;
  return window;
}

function fixture(overrides = {}) {
  const apiCalls = [];
  const externalUrls = [];
  const notifications = [];
  const hideCalls = [];
  const timers = [];
  const clearedTimers = [];
  const ipcMain = new FakeIpcMain();
  const localApiClient = {
    async request(path, options) {
      apiCalls.push([path, options]);
      return { data: { ok: true }, state: 'ready', status: 200 };
    },
  };
  const controller = createMainProcessController({
    createNotification(options) {
      const notification = new FakeNotification(options);
      notifications.push(notification);
      return notification;
    },
    ipcMain,
    hideOverlay() {
      hideCalls.push('hide');
    },
    localApiClient,
    pollIntervalMs: 1_000,
    pollNotifications: async () => {},
    setIntervalFn(callback, delay) {
      const timer = { callback, delay, id: timers.length + 1 };
      timers.push(timer);
      return timer;
    },
    clearIntervalFn(timer) {
      clearedTimers.push(timer);
    },
    shell: {
      async openExternal(url) {
        externalUrls.push(url);
      },
    },
    ...overrides,
  });
  return {
    apiCalls,
    clearedTimers,
    controller,
    externalUrls,
    hideCalls,
    ipcMain,
    notifications,
    timers,
  };
}

function eventFor(window) {
  return { sender: window.webContents };
}

test('starts idempotently and registers each fixed IPC channel exactly once', () => {
  const context = fixture();

  assert.equal(context.controller.start(), context.controller);
  assert.equal(context.controller.start(), context.controller);
  assert.deepEqual([...context.ipcMain.handlers.keys()], [CHANNELS.apiRequest, CHANNELS.notificationAction]);
  assert.equal(context.ipcMain.listenerCount(CHANNELS.openExternal), 1);
  assert.equal(context.ipcMain.listenerCount(CHANNELS.hideOverlay), 1);
  assert.equal(context.timers.length, 1);
  assert.equal(context.timers[0].delay, 1_000);
});

test('hide-overlay accepts only the configured sender identity', () => {
  const context = fixture();
  const trusted = fakeWindow(10);
  const attacker = fakeWindow(99);
  context.controller.start();
  context.controller.configureWindow(trusted);

  context.ipcMain.emit(CHANNELS.hideOverlay, eventFor(attacker));
  context.ipcMain.emit(CHANNELS.hideOverlay, eventFor(trusted));

  assert.deepEqual(context.hideCalls, ['hide']);
});

test('repeated overlay configuration hardens each webContents exactly once', () => {
  const context = fixture();
  const first = fakeWindow(10);
  const second = fakeWindow(20);
  context.controller.start();

  context.controller.configureWindow(first);
  context.controller.configureWindow(first);
  context.controller.configureWindow(second);

  for (const window of [first, second]) {
    const { webContents } = window;
    assert.equal(webContents.listenerCount('will-navigate'), 1);
    assert.equal(webContents.listenerCount('will-attach-webview'), 1);
    assert.equal(webContents.session.listenerCount('will-download'), 1);
    assert.equal(webContents.windowOpenHandler({ url: 'https://example.test' }).action, 'deny');
    assert.equal(webContents.session.permissionCheckHandler(), false);
    let denied = null;
    webContents.session.permissionRequestHandler(webContents, 'camera', value => {
      denied = value;
    });
    assert.equal(denied, false);

    for (const channel of ['will-navigate', 'will-attach-webview']) {
      let prevented = false;
      webContents.emit(channel, {
        preventDefault() {
          prevented = true;
        },
      });
      assert.equal(prevented, true);
    }
    let downloadPrevented = false;
    webContents.session.emit('will-download', {
      preventDefault() {
        downloadPrevented = true;
      },
    });
    assert.equal(downloadPrevented, true);
  }
});

test('recreated overlays sharing one Electron session do not duplicate global session hooks', () => {
  const context = fixture();
  const sharedSession = new FakeSession();
  const first = fakeWindow(10, sharedSession);
  const second = fakeWindow(20, sharedSession);
  context.controller.start();

  context.controller.configureWindow(first);
  context.controller.configureWindow(second);

  assert.equal(sharedSession.listenerCount('will-download'), 1);
  assert.equal(typeof sharedSession.permissionCheckHandler, 'function');
  assert.equal(typeof sharedSession.permissionRequestHandler, 'function');
});

test('rejects sender mismatches and hostile IPC before touching the authenticated client', async () => {
  const context = fixture();
  const trusted = fakeWindow(10);
  const attacker = fakeWindow(99);
  context.controller.start();
  context.controller.configureWindow(trusted);

  const unauthorized = await context.ipcMain.invoke(CHANNELS.apiRequest, eventFor(attacker), {
    method: 'GET',
    path: '/api/health',
  });
  assert.deepEqual(unauthorized, {
    error: {
      code: 'unauthorized_sender',
      message: 'The desktop request was not authorized.',
    },
    state: 'failed',
    status: null,
  });

  const invalidPayloads = [
    null,
    'not-an-object',
    { path: '/api/health', method: 'get' },
    { path: '/v1/health', method: 'GET' },
    { path: '//attacker.test/api/health', method: 'GET' },
    { path: '/api/health?token=credential', method: 'GET' },
    { path: '/api/health#fragment', method: 'GET' },
    { path: '/api/health', method: 'TRACE' },
    { path: '/api/health', method: 'GET', body: () => {} },
    {
      path: '/api/items',
      method: 'POST',
      body: { text: 'x'.repeat(MAIN_PROCESS_MAX_PAYLOAD_BYTES) },
    },
  ];
  for (const payload of invalidPayloads) {
    const result = await context.ipcMain.invoke(CHANNELS.apiRequest, eventFor(trusted), payload);
    assert.equal(result.error.code, 'invalid_request');
    assert.equal(result.state, 'failed');
  }
  assert.equal(context.apiCalls.length, 0);
});

test('forwards bounded API requests only through the injected authenticated local client', async () => {
  const context = fixture();
  const trusted = fakeWindow(10);
  context.controller.start();
  context.controller.configureWindow(trusted);

  const result = await context.ipcMain.invoke(CHANNELS.apiRequest, eventFor(trusted), {
    body: { title: 'Study' },
    headers: { authorization: 'Bearer attacker', 'x-user-id': 'legacy' },
    method: 'POST',
    path: '/api/items?limit=10',
  });

  assert.deepEqual(result, { data: { ok: true }, state: 'ready', status: 200 });
  assert.deepEqual(context.apiCalls, [['/api/items?limit=10', { body: { title: 'Study' }, method: 'POST' }]]);
  assert.equal(JSON.stringify(context.apiCalls).includes('x-user-id'), false);
  assert.equal(JSON.stringify(context.apiCalls).includes('attacker'), false);
});

test('returns stable redacted errors for client rejection, timeout, and malformed results', async () => {
  const secrets = ['transport-sensitive', 'timeout-sensitive', 'malformed-sensitive'];
  const cases = [
    async () => {
      throw new Error(secrets[0]);
    },
    async () =>
      new Promise((resolve, reject) => {
        queueMicrotask(() => reject(new Error(secrets[1])));
      }),
    async () => ({ error: { code: 'unknown', message: secrets[2] }, state: 'failed', status: 500 }),
  ];

  for (const request of cases) {
    const context = fixture({ localApiClient: { request } });
    const trusted = fakeWindow(10);
    context.controller.start();
    context.controller.configureWindow(trusted);
    const result = await context.ipcMain.invoke(CHANNELS.apiRequest, eventFor(trusted), {
      method: 'GET',
      path: '/api/health',
    });
    assert.deepEqual(result, {
      error: {
        code: 'request_failed',
        message: 'The desktop request failed.',
      },
      state: 'failed',
      status: null,
    });
    assert.equal(
      secrets.some(secret => JSON.stringify(result).includes(secret)),
      false
    );
    context.controller.stop();
  }
});

test('bounds a never-settling client call with a deterministic controller timeout', async () => {
  const scheduled = [];
  const cleared = [];
  const context = fixture({
    clearTimeoutFn(timer) {
      cleared.push(timer);
    },
    localApiClient: { request: () => new Promise(() => {}) },
    requestTimeoutMs: 25,
    setTimeoutFn(callback, delay) {
      const timer = { delay };
      scheduled.push(timer);
      queueMicrotask(callback);
      return timer;
    },
  });
  const trusted = fakeWindow(10);
  context.controller.start();
  context.controller.configureWindow(trusted);

  const result = await context.ipcMain.invoke(CHANNELS.apiRequest, eventFor(trusted), {
    method: 'GET',
    path: '/api/health',
  });

  assert.deepEqual(result, {
    error: {
      code: 'request_timeout',
      message: 'The local backend did not respond in time.',
    },
    state: 'offline',
    status: null,
  });
  assert.deepEqual(
    scheduled.map(timer => timer.delay),
    [25]
  );
  assert.deepEqual(cleared, scheduled);
});

test('opens only credential-free HTTP(S) URLs after an explicit trusted IPC request', async () => {
  const context = fixture();
  const trusted = fakeWindow(10);
  const attacker = fakeWindow(99);
  context.controller.start();
  context.controller.configureWindow(trusted);

  for (const url of [
    'https://user:password@example.test/',
    'https://example.test/?api_key=secret',
    'ftp://example.test/file',
    'javascript:alert(1)',
    'https://example.test/\u0000',
  ]) {
    context.ipcMain.emit(CHANNELS.openExternal, eventFor(trusted), url);
  }
  context.ipcMain.emit(CHANNELS.openExternal, eventFor(attacker), 'https://attacker.test/');
  context.ipcMain.emit(CHANNELS.openExternal, eventFor(trusted), 'https://example.test/safe?q=notes');
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(context.externalUrls, ['https://example.test/safe?q=notes']);
});

test('shows notifications only for backend-confirmed deliveries and acts only on explicit user input', async () => {
  const context = fixture();
  const trusted = fakeWindow(10);
  context.controller.start();
  context.controller.configureWindow(trusted);

  const rejected = await context.controller.deliverNotification({
    delivery: { id: 'delivery-pending', state: 'pending' },
    reminder: { id: 'reminder-one', title: 'Pending', revision: 2 },
  });
  assert.equal(rejected.error.code, 'delivery_not_confirmed');
  assert.equal(context.notifications.length, 0);

  const shown = await context.controller.deliverNotification({
    delivery: { id: 'delivery-one', state: 'delivered' },
    reminder: { id: 'reminder-one', title: 'Review notes', body: 'Spaced repetition', revision: 2 },
  });
  assert.deepEqual(shown, { state: 'ready' });
  assert.equal(context.notifications.length, 1);
  const notification = context.notifications[0];
  assert.deepEqual(notification.options, {
    body: 'Spaced repetition',
    silent: false,
    title: 'Review notes',
  });
  assert.equal(notification.showCalls, 1);
  assert.equal(context.apiCalls.length, 0);

  notification.emit('close');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(context.apiCalls.length, 0);
  assert.equal(notification.listenerCount('click'), 0);

  await context.controller.deliverNotification({
    delivery: { id: 'delivery-two', state: 'delivered' },
    reminder: { id: 'reminder-one', title: 'Review notes', body: 'Spaced repetition', revision: 2 },
  });
  context.notifications[1].emit('click');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(context.apiCalls, [['/api/reminder-deliveries/delivery-two/acknowledge', { method: 'POST' }]]);

  await context.ipcMain.invoke(CHANNELS.notificationAction, eventFor(trusted), {
    action: 'dismiss',
    deliveryId: 'delivery-one',
    reminderId: 'reminder-one',
    expectedRevision: 2,
  });
  assert.deepEqual(context.apiCalls[1], [
    '/api/reminders/reminder-one',
    { body: { action: 'cancelled', expectedRevision: 2 }, method: 'PATCH' },
  ]);
});

test('deduplicates an active delivery notification until close or explicit acknowledgement', async () => {
  const context = fixture();
  context.controller.start();
  const value = {
    delivery: { id: 'delivery-one', state: 'delivered' },
    reminder: { id: 'reminder-one', title: 'Review', body: '', revision: 1 },
  };

  assert.deepEqual(await context.controller.deliverNotification(value), { state: 'ready' });
  assert.deepEqual(await context.controller.deliverNotification(value), {
    deduplicated: true,
    state: 'ready',
  });
  assert.equal(context.notifications.length, 1);

  context.notifications[0].emit('close');
  assert.deepEqual(await context.controller.deliverNotification(value), { state: 'ready' });
  assert.equal(context.notifications.length, 2);

  context.notifications[1].emit('click');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(context.apiCalls, [['/api/reminder-deliveries/delivery-one/acknowledge', { method: 'POST' }]]);
  assert.deepEqual(await context.controller.deliverNotification(value), { state: 'ready' });
  assert.equal(context.notifications.length, 3);
});

test('rejects hostile notification actions and sender mismatches without backend changes', async () => {
  const context = fixture();
  const trusted = fakeWindow(10);
  const attacker = fakeWindow(99);
  context.controller.start();
  context.controller.configureWindow(trusted);

  const cases = [
    [eventFor(attacker), { action: 'acknowledge', deliveryId: 'delivery-one' }],
    [eventFor(trusted), { action: 'execute', deliveryId: 'delivery-one' }],
    [eventFor(trusted), { action: 'acknowledge', deliveryId: '../credential' }],
    [
      eventFor(trusted),
      { action: 'dismiss', deliveryId: 'delivery-one', reminderId: 'reminder-one', expectedRevision: 0 },
    ],
  ];
  for (const [event, action] of cases) {
    const result = await context.ipcMain.invoke(CHANNELS.notificationAction, event, action);
    assert.equal(result.state, 'failed');
  }
  assert.equal(context.apiCalls.length, 0);
});

test('stop removes IPC, window, permission, download, notification, and timer registrations idempotently', async () => {
  const context = fixture();
  const window = fakeWindow(10);
  context.controller.start();
  context.controller.configureWindow(window);
  await context.controller.deliverNotification({
    delivery: { id: 'delivery-one', state: 'delivered' },
    reminder: { id: 'reminder-one', title: 'Review', revision: 1 },
  });
  const notification = context.notifications[0];

  assert.equal(context.controller.stop(), context.controller);
  assert.equal(context.controller.stop(), context.controller);
  assert.equal(context.ipcMain.handlers.size, 0);
  assert.equal(context.ipcMain.listenerCount(CHANNELS.openExternal), 0);
  assert.equal(context.ipcMain.listenerCount(CHANNELS.hideOverlay), 0);
  assert.equal(window.webContents.listenerCount('will-navigate'), 0);
  assert.equal(window.webContents.listenerCount('will-attach-webview'), 0);
  assert.equal(window.webContents.session.listenerCount('will-download'), 0);
  assert.equal(window.webContents.windowOpenHandler({ url: 'https://example.test' }).action, 'deny');
  assert.equal(window.webContents.session.permissionCheckHandler, null);
  assert.equal(window.webContents.session.permissionRequestHandler, null);
  assert.equal(notification.listenerCount('click'), 0);
  assert.equal(notification.listenerCount('close'), 0);
  assert.deepEqual(context.clearedTimers, context.timers);

  notification.emit('click');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(context.apiCalls.length, 0);
});

test('module stays Electron-independent and exposes only frozen public state', () => {
  assert.equal(
    Object.keys(require.cache).some(key => /node_modules[\\/]electron/.test(key)),
    false
  );
  const context = fixture();
  assert.equal(Object.isFrozen(context.controller), true);
  assert.deepEqual(Object.keys(context.controller), [
    'configureWindow',
    'deliverNotification',
    'start',
    'state',
    'stop',
  ]);
  assert.equal(Object.isFrozen(CHANNELS), true);
});
