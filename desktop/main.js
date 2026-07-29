'use strict';

const { createEmbeddedBackendLifecycle } = require('./backend-lifecycle');
const {
  DESKTOP_LOCAL_API_BASE_URL,
  LOCAL_API_MAX_RESPONSE_BYTES,
  createLocalApiClient,
} = require('./local-api-client');
const { createMainProcessController } = require('./main-process-controller');
const { createDesktopReminderOutboxAdapter } = require('./reminder-outbox-adapter');
const { resolveDesktopResourcePaths } = require('./resource-paths');
const { createWindowsPlatformAdapters } = require('./windows-platform-adapters');

const DESKTOP_DASHBOARD_URL = `${DESKTOP_LOCAL_API_BASE_URL}/dashboard`;
const REMINDER_OUTBOX_POLL_INTERVAL_MS = 30_000;
const REMINDER_OUTBOX_PATH = '/api/reminder-deliveries?channel=desktop&limit=25';
const OVERLAY_SHORTCUTS = Object.freeze(['Ctrl+Shift+Space', 'Alt+Shift+E']);
const SAFE_IDENTIFIER = /^[A-Za-z0-9._~-]{1,256}$/;

class DesktopStartupError extends Error {
  constructor() {
    super('Easy Rewind could not start safely.');
    this.name = 'DesktopStartupError';
    this.code = 'DESKTOP_START_FAILED';
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object';
}

function stableOutboxDelivery(value) {
  if (!isObject(value) || !isObject(value.delivery) || !isObject(value.reminder)) {
    return false;
  }
  const delivery = value.delivery;
  const reminder = value.reminder;
  return (
    typeof delivery.id === 'string' &&
    SAFE_IDENTIFIER.test(delivery.id) &&
    delivery.state === 'delivered' &&
    typeof reminder.id === 'string' &&
    SAFE_IDENTIFIER.test(reminder.id) &&
    Number.isSafeInteger(reminder.revision) &&
    reminder.revision >= 1 &&
    typeof reminder.title === 'string' &&
    reminder.title.length >= 1 &&
    reminder.title.length <= 128 &&
    !/[\u0000-\u001f\u007f]/.test(reminder.title) &&
    typeof reminder.body === 'string' &&
    reminder.body.length <= 1024 &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(reminder.body)
  );
}

function createElectronHttpRequest({ net } = {}) {
  if (!isObject(net) || typeof net.request !== 'function') {
    throw new TypeError('Electron net adapter is unavailable');
  }

  return function electronHttpRequest(options = {}) {
    if (
      !isObject(options) ||
      typeof options.url !== 'string' ||
      typeof options.method !== 'string' ||
      !isObject(options.headers) ||
      !Number.isSafeInteger(options.maxResponseBytes) ||
      options.maxResponseBytes < 1 ||
      options.maxResponseBytes > LOCAL_API_MAX_RESPONSE_BYTES ||
      !isObject(options.signal)
    ) {
      return Promise.reject(new TypeError('Electron request options are invalid'));
    }

    let parsed;
    try {
      parsed = new URL(options.url);
    } catch {
      return Promise.reject(new TypeError('Electron request URL is invalid'));
    }
    if (
      parsed.origin !== DESKTOP_LOCAL_API_BASE_URL ||
      parsed.username !== '' ||
      parsed.password !== '' ||
      parsed.hash !== ''
    ) {
      return Promise.reject(new TypeError('Electron request URL is invalid'));
    }
    if (options.body !== undefined && Buffer.byteLength(options.body, 'utf8') > 1024 * 1024) {
      return Promise.reject(new RangeError('Electron request body is too large'));
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      let request;

      const finish = callback => value => {
        if (settled) return;
        settled = true;
        options.signal.removeEventListener?.('abort', onAbort);
        callback(value);
      };
      const fail = finish(() => reject(new Error('Electron local request failed')));
      const succeed = finish(resolve);
      const onAbort = () => {
        try {
          request?.abort();
        } catch {
          // The stable failure below is the only observable result.
        }
        fail();
      };

      if (options.signal.aborted) {
        onAbort();
        return;
      }

      try {
        request = net.request({
          method: options.method,
          redirect: 'error',
          url: parsed.toString(),
        });
        if (
          !isObject(request) ||
          typeof request.on !== 'function' ||
          typeof request.setHeader !== 'function' ||
          typeof request.end !== 'function'
        ) {
          fail();
          return;
        }

        options.signal.addEventListener?.('abort', onAbort, { once: true });
        request.on('redirect', event => {
          event?.preventDefault?.();
          try {
            request.abort?.();
          } catch {
            // The stable failure below is the only observable result.
          }
          fail();
        });
        request.on('error', fail);
        request.on('response', response => {
          if (
            !isObject(response) ||
            typeof response.on !== 'function' ||
            !Number.isInteger(response.statusCode) ||
            !isObject(response.headers)
          ) {
            fail();
            return;
          }
          const chunks = [];
          let size = 0;
          response.on('data', value => {
            if (settled) return;
            const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
            size += chunk.byteLength;
            if (size > options.maxResponseBytes) {
              try {
                request.abort?.();
              } catch {
                // The stable failure below is the only observable result.
              }
              fail();
              return;
            }
            chunks.push(chunk);
          });
          response.on('error', fail);
          response.on('end', () => {
            if (settled) return;
            succeed({
              body: Buffer.concat(chunks, size),
              headers: response.headers,
              statusCode: response.statusCode,
            });
          });
        });

        for (const [name, value] of Object.entries(options.headers)) {
          request.setHeader(name, value);
        }
        if (options.body !== undefined) {
          if (typeof request.write !== 'function') {
            fail();
            return;
          }
          request.write(options.body);
        }
        request.end();
      } catch {
        fail();
      }
    });
  };
}

function assertElectron(electron) {
  if (
    !isObject(electron) ||
    !isObject(electron.app) ||
    typeof electron.app.requestSingleInstanceLock !== 'function' ||
    typeof electron.app.whenReady !== 'function' ||
    typeof electron.app.on !== 'function' ||
    typeof electron.app.removeListener !== 'function' ||
    typeof electron.app.quit !== 'function' ||
    typeof electron.BrowserWindow !== 'function' ||
    typeof electron.Tray !== 'function' ||
    typeof electron.Notification !== 'function' ||
    (typeof electron.Menu !== 'object' && typeof electron.Menu !== 'function') ||
    typeof electron.Menu.buildFromTemplate !== 'function' ||
    !isObject(electron.nativeImage) ||
    typeof electron.nativeImage.createFromPath !== 'function' ||
    !isObject(electron.globalShortcut) ||
    typeof electron.globalShortcut.register !== 'function' ||
    typeof electron.globalShortcut.unregisterAll !== 'function' ||
    !isObject(electron.ipcMain) ||
    !isObject(electron.shell) ||
    typeof electron.shell.openExternal !== 'function'
  ) {
    throw new TypeError('Electron main-process dependencies are invalid');
  }
}

function createDesktopMain(configuration = {}) {
  if (!isObject(configuration)) throw new TypeError('Desktop main configuration is invalid');
  const electron = configuration.electron;
  assertElectron(electron);

  const processLike = configuration.processLike ?? process;
  const desktopDirectory = configuration.desktopDirectory ?? __dirname;
  const fileSystem = configuration.fileSystem;
  const resolveResourcePaths = configuration.resolveResourcePaths ?? resolveDesktopResourcePaths;
  const platformFactory = configuration.createPlatformAdapters ?? (options => createWindowsPlatformAdapters(options));
  const backendFactory = configuration.createBackendLifecycle ?? createEmbeddedBackendLifecycle;
  const localClientFactory = configuration.createLocalClient ?? createLocalApiClient;
  const controllerFactory = configuration.createController ?? createMainProcessController;
  const reminderOutboxFactory = configuration.createReminderOutboxAdapter ?? createDesktopReminderOutboxAdapter;
  const httpRequest =
    configuration.httpRequest ??
    createElectronHttpRequest({
      net: electron.net,
    });

  for (const factory of [
    resolveResourcePaths,
    platformFactory,
    backendFactory,
    localClientFactory,
    controllerFactory,
    reminderOutboxFactory,
    httpRequest,
  ]) {
    if (typeof factory !== 'function') {
      throw new TypeError('Desktop main factories are invalid');
    }
  }

  let backendLifecycle;
  let controller;
  let overlayWindow;
  let resourcePaths;
  let runPromise;
  let stopPromise;
  let tray;
  let lifecycleState = 'created';
  let allowQuit = false;
  let quitRequested = false;
  let listenersRegistered = false;

  function hideOverlay() {
    if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.hide();
  }

  function createOverlayWindow() {
    if (lifecycleState !== 'running' || controller === undefined) return undefined;
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.show();
      overlayWindow.focus();
      return overlayWindow;
    }

    overlayWindow = new electron.BrowserWindow({
      alwaysOnTop: true,
      backgroundColor: '#0f0f1a',
      frame: false,
      height: 580,
      resizable: false,
      show: false,
      skipTaskbar: true,
      transparent: true,
      webPreferences: {
        allowRunningInsecureContent: false,
        contextIsolation: true,
        nodeIntegration: false,
        preload: resourcePaths.preloadPath,
        sandbox: true,
        webSecurity: true,
        webviewTag: false,
      },
      width: 420,
    });
    controller.configureWindow(overlayWindow);
    void Promise.resolve(overlayWindow.loadFile(resourcePaths.overlayPath)).catch(() => {
      overlayWindow?.close();
    });
    overlayWindow.once('ready-to-show', () => {
      if (overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.show();
        overlayWindow.focus();
      }
    });
    overlayWindow.on('blur', hideOverlay);
    overlayWindow.once('closed', () => {
      overlayWindow = undefined;
    });
    return overlayWindow;
  }

  function toggleOverlay() {
    if (overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isVisible()) {
      overlayWindow.hide();
      return;
    }
    createOverlayWindow();
  }

  function openDashboard() {
    return Promise.resolve()
      .then(() => electron.shell.openExternal(DESKTOP_DASHBOARD_URL))
      .catch(() => undefined);
  }

  function trayIcon() {
    const icon = electron.nativeImage.createFromPath(resourcePaths.iconPath);
    if (icon && typeof icon.isEmpty === 'function' && !icon.isEmpty()) return icon;
    if (typeof electron.nativeImage.createFromBuffer !== 'function') return icon;
    const size = 16;
    const pixels = Buffer.alloc(size * size * 4);
    for (let offset = 0; offset < pixels.length; offset += 4) {
      pixels[offset] = 124;
      pixels[offset + 1] = 58;
      pixels[offset + 2] = 237;
      pixels[offset + 3] = 255;
    }
    return electron.nativeImage.createFromBuffer(pixels, {
      height: size,
      width: size,
    });
  }

  function createTray() {
    tray = new electron.Tray(trayIcon());
    tray.setToolTip('Easy Rewind');
    tray.setContextMenu(
      electron.Menu.buildFromTemplate([
        {
          click: createOverlayWindow,
          label: 'Quick Search & Capture',
        },
        { type: 'separator' },
        {
          click: openDashboard,
          label: 'Open Dashboard',
        },
        { type: 'separator' },
        {
          click: () => electron.app.quit(),
          label: 'Quit Easy Rewind',
        },
      ])
    );
    tray.on('double-click', createOverlayWindow);
  }

  function removeAppListeners() {
    if (!listenersRegistered) return;
    electron.app.removeListener('before-quit', onBeforeQuit);
    electron.app.removeListener('second-instance', createOverlayWindow);
    electron.app.removeListener('window-all-closed', keepTrayApplicationRunning);
    listenersRegistered = false;
  }

  function stop() {
    if (stopPromise !== undefined) return stopPromise;
    stopPromise = Promise.resolve()
      .then(() => {
        removeAppListeners();
        electron.globalShortcut.unregisterAll();
        controller?.stop();
        if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.close();
        overlayWindow = undefined;
        if (tray !== undefined) {
          tray.destroy();
          tray = undefined;
        }
      })
      .then(() => backendLifecycle?.stop())
      .catch(() => undefined)
      .finally(() => {
        lifecycleState = 'stopped';
      });
    return stopPromise;
  }

  function onBeforeQuit(event) {
    if (allowQuit) return;
    event?.preventDefault?.();
    if (quitRequested) return;
    quitRequested = true;
    void stop().finally(() => {
      allowQuit = true;
      electron.app.quit();
    });
  }

  function keepTrayApplicationRunning() {}

  function registerAppListeners() {
    if (listenersRegistered) return;
    electron.app.on('before-quit', onBeforeQuit);
    electron.app.on('second-instance', createOverlayWindow);
    electron.app.on('window-all-closed', keepTrayApplicationRunning);
    listenersRegistered = true;
  }

  function registerShortcuts() {
    for (const accelerator of OVERLAY_SHORTCUTS) {
      electron.globalShortcut.register(accelerator, toggleOverlay);
    }
  }

  function startReadyApplication() {
    resourcePaths = resolveResourcePaths({
      desktopDirectory,
      electronApp: electron.app,
      fileSystem,
      processLike,
    });
    const platformAdapters = platformFactory({
      localAppData: processLike.env?.LOCALAPPDATA,
      safeStorage: electron.safeStorage,
    });
    const reminderNotifier = reminderOutboxFactory();
    if (!isObject(platformAdapters) || !isObject(reminderNotifier) || typeof reminderNotifier.deliver !== 'function') {
      throw new TypeError('Desktop platform adapters are invalid');
    }
    const embeddedPlatformAdapters = {
      ...platformAdapters,
      reminderNotifier,
    };
    backendLifecycle = backendFactory({
      desktopDirectory,
      electronApp: electron.app,
      fileSystem,
      platformAdapters: embeddedPlatformAdapters,
      processLike,
      resolveResourcePaths,
    });
    if (
      !isObject(backendLifecycle) ||
      typeof backendLifecycle.start !== 'function' ||
      typeof backendLifecycle.stop !== 'function' ||
      typeof backendLifecycle.getInstallAuthorization !== 'function'
    ) {
      throw new TypeError('Embedded backend lifecycle is invalid');
    }
    return Promise.resolve()
      .then(() => backendLifecycle.start())
      .then(() => {
        const localApiClient = localClientFactory({
          baseUrl: DESKTOP_LOCAL_API_BASE_URL,
          getAuthorization: () => backendLifecycle.getInstallAuthorization(),
          httpRequest,
        });
        async function pollNotifications() {
          let result;
          try {
            result = await localApiClient.request(REMINDER_OUTBOX_PATH, {
              method: 'GET',
            });
          } catch {
            return;
          }
          const deliveries = result?.data?.deliveries;
          if (
            result?.state !== 'ready' ||
            result.status !== 200 ||
            !Array.isArray(deliveries) ||
            deliveries.length > 25
          ) {
            return;
          }
          for (const delivery of deliveries) {
            if (!stableOutboxDelivery(delivery)) continue;
            try {
              await controller.deliverNotification(delivery);
            } catch {
              // Presentation failures remain retryable in the durable outbox.
            }
          }
        }
        controller = controllerFactory({
          createNotification: options =>
            new electron.Notification({
              ...options,
              icon: resourcePaths.iconPath,
            }),
          hideOverlay,
          ipcMain: electron.ipcMain,
          localApiClient,
          pollIntervalMs: REMINDER_OUTBOX_POLL_INTERVAL_MS,
          pollNotifications,
          shell: electron.shell,
        });
        if (
          !isObject(controller) ||
          typeof controller.start !== 'function' ||
          typeof controller.stop !== 'function' ||
          typeof controller.configureWindow !== 'function'
        ) {
          throw new TypeError('Main-process controller is invalid');
        }
        controller.start();
        void pollNotifications();
        registerShortcuts();
        createTray();
        lifecycleState = 'running';
        return application;
      });
  }

  function run() {
    if (runPromise !== undefined) return runPromise;
    runPromise = Promise.resolve().then(async () => {
      if (!electron.app.requestSingleInstanceLock()) {
        lifecycleState = 'stopped';
        allowQuit = true;
        electron.app.quit();
        return application;
      }

      lifecycleState = 'starting';
      registerAppListeners();
      try {
        await electron.app.whenReady();
        return await startReadyApplication();
      } catch {
        await stop();
        allowQuit = true;
        electron.app.quit();
        throw new DesktopStartupError();
      }
    });
    return runPromise;
  }

  const application = Object.freeze({
    createOverlayWindow,
    run,
    state: () => lifecycleState,
    stop,
  });
  return application;
}

function bootstrap() {
  const electron = require('electron');
  const application = createDesktopMain({ electron });
  void application.run().catch(() => {
    process.exitCode = 1;
  });
}

module.exports = {
  DESKTOP_DASHBOARD_URL,
  DesktopStartupError,
  bootstrap,
  createDesktopMain,
  createElectronHttpRequest,
};
