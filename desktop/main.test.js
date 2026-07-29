'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { DESKTOP_DASHBOARD_URL, createDesktopMain, createElectronHttpRequest } = require('./main');

test('Electron uses a dedicated executable bootstrap while main stays import-safe', () => {
  const bootstrapSource = readFileSync(path.join(__dirname, 'bootstrap.js'), 'utf8');
  assert.match(bootstrapSource, /require\(['"]\.\/main['"]\)\.bootstrap\(\)/u);
  const mainSource = readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  assert.equal(mainSource.includes('if (require.main === module) bootstrap();'), false);
});

class FakeApp extends EventEmitter {
  constructor({ lock = true } = {}) {
    super();
    this.isPackaged = false;
    this.lock = lock;
    this.lockCalls = 0;
    this.quitCalls = 0;
    this.readyCalls = 0;
  }

  getPath(name) {
    assert.equal(name, 'userData');
    return 'C:\\Users\\fixture\\AppData\\Roaming\\easy-rewind';
  }

  quit() {
    this.quitCalls += 1;
  }

  requestSingleInstanceLock() {
    this.lockCalls += 1;
    return this.lock;
  }

  whenReady() {
    this.readyCalls += 1;
    return Promise.resolve();
  }
}

class FakeWebContents extends EventEmitter {
  constructor(id) {
    super();
    this.id = id;
    this.session = new EventEmitter();
  }

  isDestroyed() {
    return false;
  }
}

function fixture({ lock = true, localRequest, startError } = {}) {
  const app = new FakeApp({ lock });
  const browserWindows = [];
  const configuredWindows = [];
  const controllerConfigurations = [];
  const lifecycleCalls = { authorization: 0, start: 0, stop: 0 };
  const localClientConfigurations = [];
  const localApiCalls = [];
  const deliveredNotifications = [];
  const openedUrls = [];
  const registeredShortcuts = new Map();
  const resourcePaths = Object.freeze({
    backendModuleRoot: 'C:\\repo\\backend',
    dashboardDirectory: 'C:\\repo\\frontend',
    iconPath: 'C:\\repo\\desktop\\tray-icon.svg',
    overlayPath: 'C:\\repo\\desktop\\overlay.html',
    preloadPath: 'C:\\repo\\desktop\\preload.js',
  });
  const trayInstances = [];
  const menuTemplates = [];
  const notificationInstances = [];
  const reminderNotifier = Object.freeze({ deliver: async () => {} });
  let reminderAdapterFactoryCalls = 0;
  let controllerStartCalls = 0;
  let controllerStopCalls = 0;
  let lifecycleFactoryCalls = 0;
  let platformFactoryCalls = 0;
  let resolverCalls = 0;
  let unregisterCalls = 0;

  class BrowserWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.webContents = new FakeWebContents(browserWindows.length + 1);
      this.destroyed = false;
      this.visible = false;
      this.focusCalls = 0;
      this.hideCalls = 0;
      this.showCalls = 0;
      browserWindows.push(this);
    }

    close() {
      this.destroyed = true;
    }

    focus() {
      this.focusCalls += 1;
    }

    hide() {
      this.hideCalls += 1;
      this.visible = false;
    }

    isDestroyed() {
      return this.destroyed;
    }

    isVisible() {
      return this.visible;
    }

    loadFile(file) {
      this.loadedFile = file;
      return Promise.resolve();
    }

    show() {
      this.showCalls += 1;
      this.visible = true;
    }
  }

  class Tray extends EventEmitter {
    constructor(icon) {
      super();
      this.icon = icon;
      trayInstances.push(this);
    }

    destroy() {
      this.destroyCalls = (this.destroyCalls ?? 0) + 1;
    }

    setContextMenu(menu) {
      this.menu = menu;
    }

    setToolTip(value) {
      this.toolTip = value;
    }
  }

  class Notification extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      notificationInstances.push(this);
    }

    show() {}
  }

  class Menu {
    static buildFromTemplate(template) {
      menuTemplates.push(template);
      return template;
    }
  }

  const lifecycle = {
    getInstallAuthorization() {
      lifecycleCalls.authorization += 1;
      return Promise.resolve('Bearer protected-install-token');
    },
    start() {
      lifecycleCalls.start += 1;
      return startError === undefined ? Promise.resolve() : Promise.reject(startError);
    },
    state() {
      return lifecycleCalls.start > lifecycleCalls.stop ? 'running' : 'stopped';
    },
    stop() {
      lifecycleCalls.stop += 1;
      return Promise.resolve();
    },
  };

  const controller = Object.freeze({
    configureWindow(window) {
      configuredWindows.push(window);
    },
    deliverNotification(value) {
      deliveredNotifications.push(value);
      return Promise.resolve({ state: 'ready' });
    },
    start() {
      controllerStartCalls += 1;
    },
    state() {
      return controllerStartCalls > controllerStopCalls ? 'running' : 'stopped';
    },
    stop() {
      controllerStopCalls += 1;
    },
  });

  const electron = {
    app,
    BrowserWindow,
    globalShortcut: {
      register(accelerator, callback) {
        registeredShortcuts.set(accelerator, callback);
        return true;
      },
      unregisterAll() {
        unregisterCalls += 1;
      },
    },
    ipcMain: new EventEmitter(),
    Menu,
    nativeImage: {
      createFromBuffer(buffer, options) {
        return { buffer, options, isEmpty: () => false };
      },
      createFromPath(iconPath) {
        return { iconPath, isEmpty: () => false };
      },
    },
    Notification,
    safeStorage: {},
    shell: {
      async openExternal(url) {
        openedUrls.push(url);
      },
    },
    Tray,
  };

  const application = createDesktopMain({
    createBackendLifecycle(options) {
      lifecycleFactoryCalls += 1;
      assert.equal(options.electronApp, app);
      assert.deepEqual(options.platformAdapters, { protected: true, reminderNotifier });
      return lifecycle;
    },
    createController(configuration) {
      controllerConfigurations.push(configuration);
      return controller;
    },
    createLocalClient(configuration) {
      localClientConfigurations.push(configuration);
      return {
        async request(path, options) {
          localApiCalls.push([path, options]);
          return localRequest === undefined
            ? { data: { deliveries: [] }, state: 'ready', status: 200 }
            : localRequest(path, options);
        },
      };
    },
    createPlatformAdapters() {
      platformFactoryCalls += 1;
      return { protected: true };
    },
    createReminderOutboxAdapter() {
      reminderAdapterFactoryCalls += 1;
      return reminderNotifier;
    },
    desktopDirectory: 'C:\\repo\\desktop',
    electron,
    fileSystem: {},
    httpRequest: async () => {},
    processLike: { argv: [], env: {}, resourcesPath: 'C:\\resources' },
    resolveResourcePaths(options) {
      resolverCalls += 1;
      assert.equal(options.desktopDirectory, 'C:\\repo\\desktop');
      return resourcePaths;
    },
  });

  return {
    app,
    application,
    browserWindows,
    configuredWindows,
    controllerConfigurations,
    controllerStartCalls: () => controllerStartCalls,
    controllerStopCalls: () => controllerStopCalls,
    lifecycleCalls,
    lifecycleFactoryCalls: () => lifecycleFactoryCalls,
    localClientConfigurations,
    localApiCalls,
    menuTemplates,
    notificationInstances,
    openedUrls,
    platformFactoryCalls: () => platformFactoryCalls,
    registeredShortcuts,
    deliveredNotifications,
    reminderAdapterFactoryCalls: () => reminderAdapterFactoryCalls,
    resolverCalls: () => resolverCalls,
    resourcePaths,
    trayInstances,
    unregisterCalls: () => unregisterCalls,
  };
}

test('main source uses only the embedded lifecycle, authenticated client, controller, and resource resolver', () => {
  const source = readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  for (const required of [
    "require('./backend-lifecycle')",
    "require('./local-api-client')",
    "require('./main-process-controller')",
    "require('./reminder-outbox-adapter')",
    "require('./resource-paths')",
  ]) {
    assert.match(source, new RegExp(required.replace(/[().]/g, '\\$&')));
  }
  for (const forbidden of [
    "require('node:http')",
    "require('http')",
    'fetch(',
    'x-user-id',
    'apiBase',
    'apiKey',
    '/api/session',
    'Math.random',
    'desktop-settings',
  ]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
});

test('single-instance denial quits before resources, backend, controller, or ready work', async () => {
  const context = fixture({ lock: false });

  await context.application.run();

  assert.equal(context.app.lockCalls, 1);
  assert.equal(context.app.quitCalls, 1);
  assert.equal(context.app.readyCalls, 0);
  assert.equal(context.resolverCalls(), 0);
  assert.equal(context.platformFactoryCalls(), 0);
  assert.equal(context.lifecycleFactoryCalls(), 0);
  assert.equal(context.controllerStartCalls(), 0);
});

test('run is idempotent and composes one ready embedded backend and authenticated controller', async () => {
  const context = fixture();

  const firstRun = context.application.run();
  const secondRun = context.application.run();
  assert.equal(firstRun, secondRun);
  await firstRun;

  assert.equal(context.app.lockCalls, 1);
  assert.equal(context.app.readyCalls, 1);
  assert.equal(context.resolverCalls(), 1);
  assert.equal(context.platformFactoryCalls(), 1);
  assert.equal(context.reminderAdapterFactoryCalls(), 1);
  assert.equal(context.lifecycleFactoryCalls(), 1);
  assert.equal(context.lifecycleCalls.start, 1);
  assert.equal(context.controllerStartCalls(), 1);
  assert.equal(context.controllerConfigurations.length, 1);
  assert.equal(context.localClientConfigurations.length, 1);
  assert.equal(context.localClientConfigurations[0].baseUrl, 'http://127.0.0.1:3210');
  assert.equal(await context.localClientConfigurations[0].getAuthorization(), 'Bearer protected-install-token');
  assert.equal(context.lifecycleCalls.authorization, 1);
  assert.equal(context.app.listenerCount('second-instance'), 1);
});

test('controller polls the authenticated desktop outbox after start and presents every stable delivery', async () => {
  const stableDeliveries = [
    {
      delivery: { id: 'delivery-one', state: 'delivered' },
      reminder: {
        body: 'Review chapter one',
        id: 'reminder-one',
        revision: 2,
        title: 'Study',
      },
    },
    {
      delivery: { id: 'delivery-two', state: 'delivered' },
      reminder: {
        body: '',
        id: 'reminder-two',
        revision: 5,
        title: 'Recall',
      },
    },
  ];
  const context = fixture({
    localRequest: async () => ({
      data: { deliveries: stableDeliveries },
      state: 'ready',
      status: 200,
    }),
  });

  await context.application.run();
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(context.localApiCalls, [['/api/reminder-deliveries?channel=desktop&limit=25', { method: 'GET' }]]);
  assert.deepEqual(context.deliveredNotifications, stableDeliveries);
  assert.equal(typeof context.controllerConfigurations[0].pollNotifications, 'function');
  assert.equal(context.controllerConfigurations[0].pollIntervalMs, 30_000);
});

test('outbox poll ignores failed or malformed responses without mutation or presentation', async () => {
  const responses = [
    { error: { code: 'backend_offline' }, state: 'offline', status: null },
    { data: { deliveries: 'not-an-array' }, state: 'ready', status: 200 },
    {
      data: {
        deliveries: [
          {
            delivery: { id: 'delivery-pending', state: 'pending' },
            reminder: { id: 'reminder-one', revision: 1, title: 'Private', body: '' },
          },
          {
            delivery: { id: 'delivery-two', state: 'delivered' },
            reminder: { id: '../unsafe', revision: 1, title: 'Private', body: '' },
          },
        ],
      },
      state: 'ready',
      status: 200,
    },
  ];
  let index = 0;
  const context = fixture({
    localRequest: async () => responses[index++],
  });
  await context.application.run();
  await new Promise(resolve => setImmediate(resolve));

  await context.controllerConfigurations[0].pollNotifications();
  await context.controllerConfigurations[0].pollNotifications();

  assert.equal(context.deliveredNotifications.length, 0);
  assert.deepEqual(
    context.localApiCalls.map(call => call[0]),
    Array(3).fill('/api/reminder-deliveries?channel=desktop&limit=25')
  );
  assert.equal(
    context.localApiCalls.every(call => call[1].method === 'GET'),
    true
  );
});

test('overlay creation is reusable, resource-resolved, controller-owned, and securely configured', async () => {
  const context = fixture();
  await context.application.run();

  context.app.emit('second-instance');
  assert.equal(context.browserWindows.length, 1);
  const overlay = context.browserWindows[0];
  assert.equal(overlay.loadedFile, context.resourcePaths.overlayPath);
  assert.deepEqual(context.configuredWindows, [overlay]);
  assert.equal(overlay.options.webPreferences.preload, context.resourcePaths.preloadPath);
  assert.equal(overlay.options.webPreferences.contextIsolation, true);
  assert.equal(overlay.options.webPreferences.nodeIntegration, false);
  assert.equal(overlay.options.webPreferences.sandbox, true);
  assert.equal(overlay.options.webPreferences.webSecurity, true);
  assert.equal(overlay.options.webPreferences.webviewTag, false);

  context.app.emit('second-instance');
  assert.equal(context.browserWindows.length, 1);
  assert.equal(overlay.showCalls, 1);
  assert.equal(overlay.focusCalls, 1);

  overlay.destroyed = true;
  context.registeredShortcuts.get('Ctrl+Shift+Space')();
  assert.equal(context.browserWindows.length, 2);
  assert.equal(context.configuredWindows.length, 2);
});

test('tray opens only the fixed loopback dashboard and controller hide callback owns overlay visibility', async () => {
  const context = fixture();
  await context.application.run();
  assert.equal(context.trayInstances.length, 1);
  assert.equal(context.trayInstances[0].icon.iconPath, context.resourcePaths.iconPath);

  const dashboardItem = context.menuTemplates[0].find(item => item.label === 'Open Dashboard');
  assert.ok(dashboardItem);
  await dashboardItem.click();
  assert.deepEqual(context.openedUrls, [DESKTOP_DASHBOARD_URL]);

  context.app.emit('second-instance');
  const overlay = context.browserWindows[0];
  overlay.show();
  context.controllerConfigurations[0].hideOverlay();
  assert.equal(overlay.hideCalls, 1);

  const notification = context.controllerConfigurations[0].createNotification({
    body: 'Review',
    silent: false,
    title: 'Reminder',
  });
  assert.equal(notification.options.icon, context.resourcePaths.iconPath);
});

test('startup failure is redacted, disposes partial state, and quits without creating UI', async () => {
  const context = fixture({
    startError: new Error('Bearer startup-sensitive-value'),
  });

  await assert.rejects(context.application.run(), {
    name: 'DesktopStartupError',
    code: 'DESKTOP_START_FAILED',
    message: 'Easy Rewind could not start safely.',
  });

  assert.equal(context.controllerStartCalls(), 0);
  assert.equal(context.lifecycleCalls.stop, 1);
  assert.equal(context.app.quitCalls, 1);
  assert.equal(context.browserWindows.length, 0);
  assert.equal(context.trayInstances.length, 0);
});

test('before-quit and direct stop share one idempotent cleanup operation', async () => {
  const context = fixture();
  await context.application.run();
  context.app.emit('second-instance');

  let prevented = false;
  context.app.emit('before-quit', {
    preventDefault() {
      prevented = true;
    },
  });
  const firstStop = context.application.stop();
  const secondStop = context.application.stop();
  assert.equal(firstStop, secondStop);
  await firstStop;
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(prevented, true);
  assert.equal(context.controllerStopCalls(), 1);
  assert.equal(context.lifecycleCalls.stop, 1);
  assert.equal(context.unregisterCalls(), 1);
  assert.equal(context.trayInstances[0].destroyCalls, 1);
  assert.equal(context.browserWindows[0].destroyed, true);
  assert.equal(context.app.quitCalls, 1);
});

test('Electron net adapter sends bounded requests without node:http or fetch', async () => {
  const requests = [];
  const net = {
    request(options) {
      const request = new EventEmitter();
      request.headers = {};
      request.options = options;
      request.setHeader = (name, value) => {
        request.headers[name] = value;
      };
      request.write = body => {
        request.body = body;
      };
      request.abort = () => {
        request.aborted = true;
      };
      request.end = () => {
        const response = new EventEmitter();
        response.headers = {
          'content-length': ['11'],
          'content-type': ['application/json'],
        };
        response.statusCode = 200;
        request.emit('response', response);
        response.emit('data', Buffer.from('{"ok":true}'));
        response.emit('end');
      };
      requests.push(request);
      return request;
    },
  };
  const request = createElectronHttpRequest({ net });
  const signal = new AbortController();

  const response = await request({
    body: '{"title":"Study"}',
    headers: { authorization: 'Bearer protected' },
    maxResponseBytes: 1024,
    method: 'POST',
    signal: signal.signal,
    url: 'http://127.0.0.1:3210/api/items',
  });

  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].options, {
    method: 'POST',
    redirect: 'error',
    url: 'http://127.0.0.1:3210/api/items',
  });
  assert.deepEqual(requests[0].headers, { authorization: 'Bearer protected' });
  assert.equal(requests[0].body, '{"title":"Study"}');
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, Buffer.from('{"ok":true}'));
});
