'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const { CHANNELS } = require('./main-process-controller');

const METHODS = new Set(['DELETE', 'GET', 'PATCH', 'POST', 'PUT']);

function apiPath(value) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 4096 ||
    !value.startsWith('/api/') ||
    value.startsWith('//') ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new TypeError('Request path must be a safe API path.');
  }
  const parsed = new URL(value, 'http://127.0.0.1/');
  if (parsed.origin !== 'http://127.0.0.1' || !parsed.pathname.startsWith('/api/') || parsed.hash !== '') {
    throw new TypeError('Request path must be a safe API path.');
  }
  return `${parsed.pathname}${parsed.search}`;
}

function requestOptions(value) {
  if (value === undefined) return { method: 'GET' };
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Request options are invalid.');
  }
  const method = String(value.method ?? 'GET').toUpperCase();
  if (!METHODS.has(method)) throw new TypeError('Request method is unsupported.');
  return value.body === undefined ? { method } : { body: value.body, method };
}

const overlayApi = Object.freeze({
  apiRequest(path, options) {
    return ipcRenderer.invoke(CHANNELS.apiRequest, {
      ...requestOptions(options),
      path: apiPath(path),
    });
  },
  hideOverlay() {
    ipcRenderer.send(CHANNELS.hideOverlay);
  },
  notificationAction(action) {
    return ipcRenderer.invoke(CHANNELS.notificationAction, action);
  },
  openInBrowser(url) {
    ipcRenderer.send(CHANNELS.openExternal, url);
  },
});

contextBridge.exposeInMainWorld('easyRewind', overlayApi);
