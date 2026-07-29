import { createApiClient } from './src/api-client.js';
import { validateExtensionMessage } from './src/message-contracts.js';
import { createSessionAuthorizationStore } from './src/session-authorization.js';
import { createExtensionStateStore } from './src/state-store.js';

const DEFAULT_API_BASE = 'http://127.0.0.1:3210';
const SYNC_ALARM = 'easy-rewind-sync';
const HEALTH_ALARM = 'easy-rewind-health';
const MAX_NOTIFICATION_TEXT = 160;

const CONTEXT_MENUS = Object.freeze([
  Object.freeze({
    id: 'easy-rewind-capture-page',
    title: 'Save page to Easy Rewind',
    contexts: ['page'],
  }),
  Object.freeze({
    id: 'easy-rewind-capture-selection',
    title: 'Save selection to Easy Rewind',
    contexts: ['selection'],
  }),
]);

function clone(value) {
  return structuredClone(value);
}

function safeError(result) {
  const candidate =
    typeof result?.error === 'string'
      ? result.error
      : typeof result?.error?.code === 'string'
        ? result.error.code
        : null;
  return candidate && candidate.length <= 128 ? candidate : 'request_failed';
}

function mapConnectionStatus(result) {
  const allowed = new Set(['ready', 'offline', 'authentication_required', 'conflict', 'incompatible', 'failed']);
  return allowed.has(result?.state) ? result.state : 'failed';
}

function responseFor(result) {
  if (result?.state === 'ready') {
    return Object.freeze({ ok: true, state: 'ready', data: result.data ?? null });
  }
  return Object.freeze({
    ok: false,
    state: mapConnectionStatus(result),
    error: safeError(result),
  });
}

function validateDependencies({ chromeApi, apiClient, authorizationStore, stateStore, now }) {
  if (!chromeApi?.runtime?.onMessage?.addListener || !chromeApi?.contextMenus?.create || !chromeApi?.alarms?.create) {
    throw new TypeError('chromeApi is missing required extension APIs.');
  }
  if (
    !apiClient ||
    typeof apiClient.health !== 'function' ||
    typeof apiClient.pull !== 'function' ||
    typeof apiClient.request !== 'function'
  ) {
    throw new TypeError('apiClient is invalid.');
  }
  if (!stateStore || typeof stateStore.load !== 'function' || typeof stateStore.save !== 'function') {
    throw new TypeError('stateStore is invalid.');
  }
  if (
    !authorizationStore ||
    typeof authorizationStore.clear !== 'function' ||
    typeof authorizationStore.set !== 'function'
  ) {
    throw new TypeError('authorizationStore is invalid.');
  }
  if (typeof now !== 'function') throw new TypeError('now must be a function.');
}

export function createBackgroundController({ chromeApi, apiClient, authorizationStore, stateStore, now }) {
  validateDependencies({ chromeApi, apiClient, authorizationStore, stateStore, now });

  let initialization;
  let state;

  function timestamp() {
    const value = now();
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('Invalid clock value.');
    return value;
  }

  async function persist(mutator) {
    const next = clone(state);
    mutator(next);
    state = await stateStore.save(next);
    return state;
  }

  async function setConnection(result) {
    await persist(next => {
      next.connection = {
        status: mapConnectionStatus(result),
        updatedAt: timestamp(),
      };
    });
  }

  function getPrivacySnapshot() {
    if (!state) throw new Error('Background is not initialized.');
    return Object.freeze({
      captureEnabled: state.capture.enabled,
      allowedHosts: [...state.privacy.allowedHosts],
      blockedHosts: [...state.privacy.blockedHosts],
      minimumDwellMs: state.privacy.minimumDwellMs,
      minimumSelectionLength: state.privacy.minimumSelectionLength,
    });
  }

  async function broadcastPrivacy() {
    if (typeof chromeApi.tabs?.query !== 'function' || typeof chromeApi.tabs?.sendMessage !== 'function') return;
    const validation = validateExtensionMessage({
      type: 'PRIVACY_CHANGED',
      payload: getPrivacySnapshot(),
    });
    if (!validation.valid) return;
    const tabs = await chromeApi.tabs.query({});
    await Promise.all(
      tabs
        .filter(tab => Number.isSafeInteger(tab?.id))
        .map(tab => chromeApi.tabs.sendMessage(tab.id, validation.message).catch(() => undefined))
    );
  }

  async function getPageSnapshot() {
    if (typeof chromeApi.tabs?.query !== 'function') {
      return Object.freeze({ ok: true, state: 'empty', page: null });
    }
    const [tab] = await chromeApi.tabs.query({ active: true, currentWindow: true });
    if (!tab || typeof tab.url !== 'string' || typeof tab.title !== 'string' || !/^https?:\/\//i.test(tab.url)) {
      return Object.freeze({ ok: true, state: 'empty', page: null });
    }
    return Object.freeze({
      ok: true,
      state: 'ready',
      page: Object.freeze({
        url: tab.url.slice(0, 2048),
        title: tab.title.slice(0, 512),
      }),
    });
  }

  async function notifyResult(kind, result) {
    if (typeof chromeApi.notifications?.create !== 'function') return;
    const ready = result?.state === 'ready';
    const title = ready ? 'Saved to Easy Rewind' : 'Easy Rewind needs attention';
    const rawMessage = ready
      ? kind === 'selection'
        ? 'Selection saved.'
        : 'Page saved.'
      : mapConnectionStatus(result).replaceAll('_', ' ');
    await chromeApi.notifications.create(`easy-rewind-${timestamp()}`, {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title,
      message: rawMessage.slice(0, MAX_NOTIFICATION_TEXT),
    });
  }

  async function checkConnection() {
    const result = await apiClient.health();
    await setConnection(result);
    return responseFor(result);
  }

  async function retrySync() {
    const result = await apiClient.pull({ cursor: state.sync.cursor });
    await persist(next => {
      next.connection = {
        status: mapConnectionStatus(result),
        updatedAt: timestamp(),
      };
      if (result?.state === 'ready' && typeof result.data?.cursor === 'string') {
        next.sync = {
          cursor: result.data.cursor,
          updatedAt: timestamp(),
        };
      }
    });
    return responseFor(result);
  }

  async function capture(type, payload) {
    const result = await apiClient.request('/api/items', {
      method: 'POST',
      body: {
        kind: type === 'CAPTURE_SELECTION' ? 'highlight' : 'bookmark',
        sourceUrl: payload.url,
        title: payload.title,
        content: payload.text,
        occurredAt: payload.occurredAt,
      },
    });
    await setConnection(result);
    await notifyResult(type === 'CAPTURE_SELECTION' ? 'selection' : 'page', result);
    return responseFor(result);
  }

  async function routeMessage(message) {
    const validated = validateExtensionMessage(message);
    if (!validated.valid) return Object.freeze({ ok: false, error: validated.error });

    const accepted = validated.message;
    switch (accepted.type) {
      case 'GET_EXTENSION_STATE':
        return Object.freeze({ ok: true, state: clone(state) });
      case 'GET_PRIVACY_SNAPSHOT':
        return Object.freeze({ ok: true, state: 'ready', data: getPrivacySnapshot() });
      case 'GET_PAGE_SNAPSHOT':
        return getPageSnapshot();
      case 'CHECK_CONNECTION':
        return checkConnection();
      case 'RETRY_SYNC':
        return retrySync();
      case 'SET_LOCAL_AUTHORIZATION':
        await authorizationStore.set(accepted.payload.connectionCode);
        return checkConnection();
      case 'CLEAR_LOCAL_AUTHORIZATION':
        await authorizationStore.clear();
        await setConnection({ state: 'authentication_required' });
        return Object.freeze({ ok: true, state: 'authentication_required' });
      case 'SET_CAPTURE_ENABLED':
        await persist(next => {
          next.capture.enabled = accepted.payload.enabled;
        });
        await broadcastPrivacy();
        return Object.freeze({ ok: true, state: 'ready' });
      case 'UPDATE_PRIVACY':
        await persist(next => {
          next.privacy = clone(accepted.payload);
        });
        await broadcastPrivacy();
        return Object.freeze({ ok: true, state: 'ready' });
      case 'CAPTURE_PAGE':
      case 'CAPTURE_SELECTION':
        return capture(accepted.type, accepted.payload);
      case 'PRIVACY_CHANGED':
        return Object.freeze({ ok: false, error: 'unsupported_direction' });
      default:
        return Object.freeze({ ok: false, error: 'invalid_message' });
    }
  }

  function handleMessage(message, _sender, sendResponse) {
    void initialize()
      .then(() => routeMessage(message))
      .then(sendResponse)
      .catch(() => sendResponse({ ok: false, error: 'background_unavailable' }));
    return true;
  }

  async function handleContextMenu(info, tab) {
    await initialize();
    if (!tab || typeof tab.url !== 'string') return;

    if (info?.menuItemId === 'easy-rewind-capture-page') {
      await capture('CAPTURE_PAGE', {
        url: tab.url,
        title: typeof tab.title === 'string' ? tab.title : '',
        text: typeof tab.title === 'string' && tab.title.length > 0 ? tab.title : tab.url,
        occurredAt: timestamp(),
      });
    } else if (
      info?.menuItemId === 'easy-rewind-capture-selection' &&
      typeof info.selectionText === 'string' &&
      info.selectionText.trim().length > 0
    ) {
      await capture('CAPTURE_SELECTION', {
        url: tab.url,
        title: typeof tab.title === 'string' ? tab.title : '',
        text: info.selectionText.trim(),
        occurredAt: timestamp(),
      });
    }
  }

  async function recreateContextMenus() {
    await chromeApi.contextMenus.removeAll?.();
    for (const menu of CONTEXT_MENUS) chromeApi.contextMenus.create(menu);
  }

  async function initialize() {
    initialization ??= (async () => {
      state = await stateStore.load();
      await recreateContextMenus();
      await chromeApi.alarms.create(SYNC_ALARM, { periodInMinutes: 5 });
      await chromeApi.alarms.create(HEALTH_ALARM, { periodInMinutes: 2 });
      await checkConnection();
      return true;
    })();
    return initialization;
  }

  async function handleAlarm(alarm) {
    await initialize();
    if (alarm?.name === SYNC_ALARM) return retrySync();
    if (alarm?.name === HEALTH_ALARM) return checkConnection();
    return undefined;
  }

  chromeApi.runtime.onMessage.addListener(handleMessage);
  chromeApi.runtime.onInstalled?.addListener(() => initialize());
  chromeApi.runtime.onStartup?.addListener(() => initialize());
  chromeApi.contextMenus.onClicked?.addListener(handleContextMenu);
  chromeApi.alarms.onAlarm?.addListener(handleAlarm);

  return Object.freeze({
    checkConnection,
    getPrivacySnapshot,
    handleAlarm,
    handleContextMenu,
    handleMessage,
    initialize,
    retrySync,
  });
}

export function bootstrapBackground({
  chromeApi = globalThis.chrome,
  fetch: fetchImpl = globalThis.fetch,
  now = Date.now,
} = {}) {
  if (!chromeApi) throw new TypeError('Chrome extension API is unavailable.');
  const stateStore = createExtensionStateStore({
    storageArea: chromeApi.storage.local,
    now,
  });
  const authorizationStore = createSessionAuthorizationStore({
    storageArea: chromeApi.storage.session,
  });
  const apiClient = createApiClient({
    baseUrl: DEFAULT_API_BASE,
    fetch: fetchImpl,
    getAuthorization: authorizationStore.getAuthorization,
    now,
  });
  const controller = createBackgroundController({
    chromeApi,
    apiClient,
    authorizationStore,
    stateStore,
    now,
  });
  void controller.initialize();
  return controller;
}

if (globalThis.chrome?.runtime?.id) {
  bootstrapBackground();
}
