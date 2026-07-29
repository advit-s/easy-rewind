'use strict';

const CHANNELS = Object.freeze({
  apiRequest: 'api-call',
  hideOverlay: 'hide-overlay',
  notificationAction: 'notification-action',
  openExternal: 'open-in-browser',
});

const MAIN_PROCESS_MAX_PAYLOAD_BYTES = 64 * 1024;
const MAIN_PROCESS_MAX_RESPONSE_BYTES = 1024 * 1024;
const MAIN_PROCESS_REQUEST_TIMEOUT_MS = 12_000;
const SAFE_METHODS = new Set(['DELETE', 'GET', 'PATCH', 'POST', 'PUT']);
const CREDENTIAL_QUERY_NAME = /(?:api[_-]?key|authorization|credential|password|secret|token)/i;
const SAFE_ID = /^[A-Za-z0-9._~-]{1,256}$/;

const SAFE_ERRORS = Object.freeze({
  authentication_required: Object.freeze({
    code: 'authentication_required',
    message: 'Authenticate the desktop application again.',
    state: 'authentication_required',
  }),
  backend_incompatible: Object.freeze({
    code: 'backend_incompatible',
    message: 'Update Easy Rewind before continuing.',
    state: 'incompatible',
  }),
  backend_offline: Object.freeze({
    code: 'backend_offline',
    message: 'The local backend is unavailable.',
    state: 'offline',
  }),
  delivery_not_confirmed: Object.freeze({
    code: 'delivery_not_confirmed',
    message: 'The backend has not confirmed this notification delivery.',
    state: 'failed',
  }),
  invalid_request: Object.freeze({
    code: 'invalid_request',
    message: 'The desktop request was invalid.',
    state: 'failed',
  }),
  request_aborted: Object.freeze({
    code: 'request_aborted',
    message: 'The request was cancelled.',
    state: 'failed',
  }),
  request_failed: Object.freeze({
    code: 'request_failed',
    message: 'The desktop request failed.',
    state: 'failed',
  }),
  request_timeout: Object.freeze({
    code: 'request_timeout',
    message: 'The local backend did not respond in time.',
    state: 'offline',
  }),
  sync_conflict: Object.freeze({
    code: 'sync_conflict',
    message: 'The local backend reported a conflict.',
    state: 'conflict',
  }),
  unauthorized_sender: Object.freeze({
    code: 'unauthorized_sender',
    message: 'The desktop request was not authorized.',
    state: 'failed',
  }),
});

function failed(errorName, status = null) {
  const error = SAFE_ERRORS[errorName] ?? SAFE_ERRORS.request_failed;
  return {
    error: { code: error.code, message: error.message },
    state: error.state,
    status,
  };
}

function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(value, allowed) {
  return Object.keys(value).every(key => allowed.has(key));
}

function jsonClone(value) {
  const active = new Set();

  function visit(candidate) {
    if (candidate === null || typeof candidate === 'string' || typeof candidate === 'boolean') {
      return candidate;
    }
    if (typeof candidate === 'number') {
      if (!Number.isFinite(candidate)) throw new TypeError('JSON number must be finite');
      return candidate;
    }
    if (typeof candidate !== 'object' || active.has(candidate)) {
      throw new TypeError('Value must be bounded JSON');
    }

    active.add(candidate);
    let normalized;
    if (Array.isArray(candidate)) {
      normalized = candidate.map(visit);
    } else {
      if (!isRecord(candidate)) throw new TypeError('Value must be a plain JSON record');
      normalized = {};
      for (const [key, entry] of Object.entries(candidate)) {
        if (key === '__proto__' || key === 'constructor' || key === 'prototype' || /[\u0000-\u001f\u007f]/.test(key)) {
          throw new TypeError('JSON property name is unsafe');
        }
        normalized[key] = visit(entry);
      }
    }
    active.delete(candidate);
    return normalized;
  }

  return visit(value);
}

function byteLength(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function apiPath(value) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 4096 ||
    !value.startsWith('/api/') ||
    value.startsWith('//') ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new TypeError('API path is invalid');
  }

  let parsed;
  try {
    parsed = new URL(value, 'http://127.0.0.1/');
  } catch {
    throw new TypeError('API path is invalid');
  }
  if (parsed.origin !== 'http://127.0.0.1' || !parsed.pathname.startsWith('/api/') || parsed.hash !== '') {
    throw new TypeError('API path is invalid');
  }
  for (const name of parsed.searchParams.keys()) {
    if (CREDENTIAL_QUERY_NAME.test(name)) throw new TypeError('API path is invalid');
  }
  return `${parsed.pathname}${parsed.search}`;
}

function apiRequest(value) {
  if (!isRecord(value) || !hasOnlyKeys(value, new Set(['body', 'headers', 'method', 'path']))) {
    throw new TypeError('API request is invalid');
  }
  if (typeof value.method !== 'string' || !SAFE_METHODS.has(value.method)) {
    throw new TypeError('API method is invalid');
  }
  const request = {
    method: value.method,
    path: apiPath(value.path),
  };
  if (value.body !== undefined) request.body = jsonClone(value.body);
  if (byteLength(request) > MAIN_PROCESS_MAX_PAYLOAD_BYTES) {
    throw new RangeError('API request is too large');
  }
  const options = { method: request.method };
  if ('body' in request) options.body = request.body;
  return { options, path: request.path };
}

function safeExternalUrl(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError('External URL is invalid');
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError('External URL is invalid');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username !== '' ||
    url.password !== '' ||
    url.hostname === ''
  ) {
    throw new TypeError('External URL is invalid');
  }
  for (const name of url.searchParams.keys()) {
    if (CREDENTIAL_QUERY_NAME.test(name)) throw new TypeError('External URL is invalid');
  }
  return url.toString();
}

function text(value, maximum, fallback = '') {
  if (value === undefined && fallback !== undefined) return fallback;
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximum ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  ) {
    throw new TypeError('Notification text is invalid');
  }
  return value;
}

function identifier(value) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) {
    throw new TypeError('Identifier is invalid');
  }
  return value;
}

function notificationInput(value) {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, new Set(['delivery', 'reminder'])) ||
    !isRecord(value.delivery) ||
    !isRecord(value.reminder)
  ) {
    throw new TypeError('Notification is invalid');
  }
  const deliveryId = identifier(value.delivery.id);
  const reminderId = identifier(value.reminder.id);
  const revision = value.reminder.revision;
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new TypeError('Reminder revision is invalid');
  }
  return {
    body: value.reminder.body === '' ? '' : text(value.reminder.body, 1024, ''),
    confirmed: value.delivery.state === 'delivered',
    deliveryId,
    reminderId,
    revision,
    title: text(value.reminder.title, 128),
  };
}

function notificationAction(value) {
  if (!isRecord(value) || !hasOnlyKeys(value, new Set(['action', 'deliveryId', 'expectedRevision', 'reminderId']))) {
    throw new TypeError('Notification action is invalid');
  }
  if (value.action === 'acknowledge') {
    return { action: value.action, deliveryId: identifier(value.deliveryId) };
  }
  if (value.action === 'dismiss' && Number.isSafeInteger(value.expectedRevision) && value.expectedRevision >= 1) {
    return {
      action: value.action,
      deliveryId: identifier(value.deliveryId),
      expectedRevision: value.expectedRevision,
      reminderId: identifier(value.reminderId),
    };
  }
  throw new TypeError('Notification action is invalid');
}

function normalizeClientResult(value) {
  if (!isRecord(value)) return failed('request_failed');
  if (value.state === 'ready' && Number.isInteger(value.status) && value.status >= 200 && value.status < 300) {
    try {
      const result = {
        data: jsonClone(value.data),
        state: 'ready',
        status: value.status,
      };
      if (byteLength(result) > MAIN_PROCESS_MAX_RESPONSE_BYTES) return failed('request_failed');
      return result;
    } catch {
      return failed('request_failed');
    }
  }
  const errorCode = value.error?.code;
  if (typeof errorCode !== 'string' || !(errorCode in SAFE_ERRORS)) {
    return failed('request_failed');
  }
  const status =
    value.status === null || (Number.isInteger(value.status) && value.status >= 100 && value.status <= 599)
      ? value.status
      : null;
  return failed(errorCode, status);
}

function assertConfiguration(configuration) {
  const ipcMain = configuration?.ipcMain;
  const localApiClient = configuration?.localApiClient;
  const shell = configuration?.shell;
  if (
    !isRecord(configuration) ||
    ipcMain === null ||
    typeof ipcMain !== 'object' ||
    typeof ipcMain.handle !== 'function' ||
    typeof ipcMain.removeHandler !== 'function' ||
    typeof ipcMain.on !== 'function' ||
    typeof ipcMain.removeListener !== 'function' ||
    localApiClient === null ||
    typeof localApiClient !== 'object' ||
    typeof localApiClient.request !== 'function' ||
    shell === null ||
    typeof shell !== 'object' ||
    typeof shell.openExternal !== 'function' ||
    typeof configuration.createNotification !== 'function'
  ) {
    throw new TypeError('Main-process controller dependencies are invalid');
  }
}

function createMainProcessController(configuration) {
  assertConfiguration(configuration);
  const ipcMain = configuration.ipcMain;
  const localApiClient = configuration.localApiClient;
  const shell = configuration.shell;
  const createNotification = configuration.createNotification;
  const hideOverlay = configuration.hideOverlay;
  const setIntervalFn = configuration.setIntervalFn ?? setInterval;
  const clearIntervalFn = configuration.clearIntervalFn ?? clearInterval;
  const setTimeoutFn = configuration.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = configuration.clearTimeoutFn ?? clearTimeout;
  const pollNotifications = configuration.pollNotifications;
  const pollIntervalMs = configuration.pollIntervalMs ?? 30_000;
  const requestTimeoutMs = configuration.requestTimeoutMs ?? MAIN_PROCESS_REQUEST_TIMEOUT_MS;

  if (
    typeof setIntervalFn !== 'function' ||
    typeof clearIntervalFn !== 'function' ||
    typeof setTimeoutFn !== 'function' ||
    typeof clearTimeoutFn !== 'function' ||
    (pollNotifications !== undefined && typeof pollNotifications !== 'function') ||
    (hideOverlay !== undefined && typeof hideOverlay !== 'function') ||
    !Number.isSafeInteger(pollIntervalMs) ||
    pollIntervalMs < 1_000 ||
    pollIntervalMs > 86_400_000 ||
    !Number.isSafeInteger(requestTimeoutMs) ||
    requestTimeoutMs < 1 ||
    requestTimeoutMs > 60_000
  ) {
    throw new TypeError('Main-process controller timing configuration is invalid');
  }

  const trustedWebContents = new Set();
  const windows = new Map();
  const sessions = new Set();
  const activeNotifications = new Map();
  let lifecycleState = 'created';
  let pollTimer;

  function trusted(event) {
    const sender = event?.sender;
    return (
      sender !== null &&
      typeof sender === 'object' &&
      trustedWebContents.has(sender) &&
      (typeof sender.isDestroyed !== 'function' || !sender.isDestroyed())
    );
  }

  async function requestClient(path, options) {
    let timeout;
    const timedOut = new Promise(resolve => {
      timeout = setTimeoutFn(() => resolve(failed('request_timeout')), requestTimeoutMs);
    });
    try {
      const result = await Promise.race([
        Promise.resolve()
          .then(() => localApiClient.request(path, options))
          .then(normalizeClientResult)
          .catch(() => failed('request_failed')),
        timedOut,
      ]);
      return result;
    } finally {
      clearTimeoutFn(timeout);
    }
  }

  async function handleApiRequest(event, payload) {
    if (!trusted(event)) return failed('unauthorized_sender');
    let request;
    try {
      request = apiRequest(payload);
    } catch {
      return failed('invalid_request');
    }
    return requestClient(request.path, request.options);
  }

  async function actOnNotification(action) {
    if (action.action === 'acknowledge') {
      return requestClient(`/api/reminder-deliveries/${encodeURIComponent(action.deliveryId)}/acknowledge`, {
        method: 'POST',
      });
    }
    return requestClient(`/api/reminders/${encodeURIComponent(action.reminderId)}`, {
      body: {
        action: 'cancelled',
        expectedRevision: action.expectedRevision,
      },
      method: 'PATCH',
    });
  }

  async function handleNotificationAction(event, payload) {
    if (!trusted(event)) return failed('unauthorized_sender');
    let action;
    try {
      action = notificationAction(payload);
    } catch {
      return failed('invalid_request');
    }
    return actOnNotification(action);
  }

  function handleOpenExternal(event, value) {
    if (!trusted(event)) return;
    let url;
    try {
      url = safeExternalUrl(value);
    } catch {
      return;
    }
    Promise.resolve()
      .then(() => shell.openExternal(url))
      .catch(() => undefined);
  }

  function handleHideOverlay(event) {
    if (!trusted(event) || hideOverlay === undefined) return;
    try {
      hideOverlay();
    } catch {
      // Renderer actions never expose host errors.
    }
  }

  const denyWindowOpen = () => ({ action: 'deny' });
  const denyPermissionCheck = () => false;
  const denyPermissionRequest = (_webContents, _permission, callback) => callback(false);
  const prevent = event => event?.preventDefault?.();

  function hardenWindow(window) {
    const webContents = window?.webContents;
    if (
      webContents === null ||
      typeof webContents !== 'object' ||
      typeof webContents.on !== 'function' ||
      typeof webContents.removeListener !== 'function' ||
      typeof webContents.setWindowOpenHandler !== 'function' ||
      webContents.session === null ||
      typeof webContents.session !== 'object' ||
      typeof webContents.session.on !== 'function' ||
      typeof webContents.session.removeListener !== 'function' ||
      typeof webContents.session.setPermissionCheckHandler !== 'function' ||
      typeof webContents.session.setPermissionRequestHandler !== 'function'
    ) {
      throw new TypeError('BrowserWindow is invalid');
    }
    if (windows.has(webContents)) return;

    const session = webContents.session;
    webContents.setWindowOpenHandler(denyWindowOpen);
    webContents.on('will-navigate', prevent);
    webContents.on('will-attach-webview', prevent);
    if (!sessions.has(session)) {
      session.setPermissionCheckHandler(denyPermissionCheck);
      session.setPermissionRequestHandler(denyPermissionRequest);
      session.on('will-download', prevent);
      sessions.add(session);
    }
    trustedWebContents.add(webContents);
    windows.set(webContents, { session });
  }

  function configureWindow(window) {
    if (lifecycleState !== 'running') {
      throw new Error('Main-process controller is not running');
    }
    hardenWindow(window);
    return controller;
  }

  async function deliverNotification(value) {
    if (lifecycleState !== 'running') return failed('request_failed');
    let input;
    try {
      input = notificationInput(value);
    } catch {
      return failed('invalid_request');
    }
    if (!input.confirmed) return failed('delivery_not_confirmed');
    if (activeNotifications.has(input.deliveryId)) {
      return { deduplicated: true, state: 'ready' };
    }

    let notification;
    let record;
    try {
      notification = createNotification({
        body: input.body,
        silent: false,
        title: input.title,
      });
      if (
        notification === null ||
        typeof notification !== 'object' ||
        typeof notification.once !== 'function' ||
        typeof notification.removeListener !== 'function' ||
        typeof notification.show !== 'function'
      ) {
        return failed('request_failed');
      }
      const dispose = () => {
        notification.removeListener('click', onClick);
        notification.removeListener('close', onClose);
        if (activeNotifications.get(input.deliveryId) === record) {
          activeNotifications.delete(input.deliveryId);
        }
      };
      const onClick = () => {
        dispose();
        void actOnNotification({
          action: 'acknowledge',
          deliveryId: input.deliveryId,
        });
      };
      const onClose = () => {
        dispose();
      };
      record = { notification, onClick, onClose };
      activeNotifications.set(input.deliveryId, record);
      notification.once('click', onClick);
      notification.once('close', onClose);
      notification.show();
      return { state: 'ready' };
    } catch {
      if (record !== undefined) {
        notification.removeListener('click', record.onClick);
        notification.removeListener('close', record.onClose);
        activeNotifications.delete(input.deliveryId);
      }
      return failed('request_failed');
    }
  }

  function start() {
    if (lifecycleState === 'running') return controller;
    ipcMain.handle(CHANNELS.apiRequest, handleApiRequest);
    ipcMain.handle(CHANNELS.notificationAction, handleNotificationAction);
    ipcMain.on(CHANNELS.hideOverlay, handleHideOverlay);
    ipcMain.on(CHANNELS.openExternal, handleOpenExternal);
    if (pollNotifications !== undefined) {
      pollTimer = setIntervalFn(() => {
        Promise.resolve()
          .then(() => pollNotifications())
          .catch(() => undefined);
      }, pollIntervalMs);
    }
    lifecycleState = 'running';
    return controller;
  }

  function stop() {
    if (lifecycleState === 'stopped') return controller;
    ipcMain.removeHandler(CHANNELS.apiRequest);
    ipcMain.removeHandler(CHANNELS.notificationAction);
    ipcMain.removeListener(CHANNELS.hideOverlay, handleHideOverlay);
    ipcMain.removeListener(CHANNELS.openExternal, handleOpenExternal);
    if (pollTimer !== undefined) {
      clearIntervalFn(pollTimer);
      pollTimer = undefined;
    }
    for (const webContents of windows.keys()) {
      webContents.removeListener('will-navigate', prevent);
      webContents.removeListener('will-attach-webview', prevent);
      webContents.setWindowOpenHandler(denyWindowOpen);
    }
    windows.clear();
    trustedWebContents.clear();
    for (const session of sessions) {
      session.removeListener('will-download', prevent);
      session.setPermissionCheckHandler(null);
      session.setPermissionRequestHandler(null);
    }
    sessions.clear();
    for (const record of activeNotifications.values()) {
      record.notification.removeListener('click', record.onClick);
      record.notification.removeListener('close', record.onClose);
    }
    activeNotifications.clear();
    lifecycleState = 'stopped';
    return controller;
  }

  const controller = Object.freeze({
    configureWindow,
    deliverNotification,
    start,
    state: () => lifecycleState,
    stop,
  });
  return controller;
}

module.exports = {
  CHANNELS,
  MAIN_PROCESS_MAX_PAYLOAD_BYTES,
  MAIN_PROCESS_MAX_RESPONSE_BYTES,
  MAIN_PROCESS_REQUEST_TIMEOUT_MS,
  createMainProcessController,
};
