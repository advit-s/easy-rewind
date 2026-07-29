'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const DESKTOP_DIRECTORY = __dirname;

function source(name) {
  return fs.readFileSync(path.join(DESKTOP_DIRECTORY, name), 'utf8');
}

function loadPreload() {
  const exposed = new Map();
  const sent = [];
  const invoked = [];
  const ipcRenderer = {
    invoke(channel, payload) {
      invoked.push({ channel, payload });
      return Promise.resolve({ data: null, state: 'ready', status: 200 });
    },
    send(channel, payload) {
      sent.push({ channel, payload });
    },
  };
  const contextBridge = {
    exposeInMainWorld(name, value) {
      exposed.set(name, value);
    },
  };
  const sandbox = {
    Object,
    URL,
    require(request) {
      if (request === 'electron') return { contextBridge, ipcRenderer };
      if (request === './main-process-controller') {
        return {
          CHANNELS: Object.freeze({
            apiRequest: 'api-call',
            hideOverlay: 'hide-overlay',
            notificationAction: 'notification-action',
            openExternal: 'open-in-browser',
          }),
        };
      }
      throw new Error(`Unexpected preload dependency: ${request}`);
    },
  };
  vm.runInNewContext(source('preload.js'), sandbox, { filename: 'desktop/preload.js' });
  return { api: exposed.get('easyRewind'), exposed, invoked, sent };
}

test('preload exposes only the frozen narrow overlay API', () => {
  const { api, exposed } = loadPreload();

  assert.deepEqual([...exposed.keys()], ['easyRewind']);
  assert.deepEqual(Object.keys(api).sort(), ['apiRequest', 'hideOverlay', 'notificationAction', 'openInBrowser']);
  assert.equal(Object.isFrozen(api), true);
  for (const method of Object.values(api)) assert.equal(typeof method, 'function');
});

test('preload maps overlay actions to the fixed main-process channels', async () => {
  const { api, invoked, sent } = loadPreload();

  api.hideOverlay();
  api.openInBrowser('https://example.test/read');
  await api.apiRequest('/api/search?q=memory', { method: 'GET' });
  await api.notificationAction({
    action: 'acknowledge',
    deliveryId: 'delivery-1',
  });

  assert.deepEqual(sent, [
    { channel: 'hide-overlay', payload: undefined },
    { channel: 'open-in-browser', payload: 'https://example.test/read' },
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(invoked)), [
    {
      channel: 'api-call',
      payload: { method: 'GET', path: '/api/search?q=memory' },
    },
    {
      channel: 'notification-action',
      payload: { action: 'acknowledge', deliveryId: 'delivery-1' },
    },
  ]);
});

test('preload derives every IPC channel from the controller contract', () => {
  const preload = source('preload.js');

  assert.doesNotMatch(preload, /ipcRenderer\.(?:send|invoke)\(['"][^'"]+/);
  assert.match(preload, /ipcRenderer\.send\(CHANNELS\.hideOverlay\)/);
});

test('preload rejects non-API paths before invoking the main process', () => {
  const { api, invoked } = loadPreload();

  assert.throws(() => api.apiRequest('https://attacker.test/api/items'), /safe API path/i);
  assert.throws(() => api.apiRequest('/health'), /safe API path/i);
  assert.equal(invoked.length, 0);
});

test('overlay document has a strict local-only content security policy', () => {
  const html = source('overlay.html');

  assert.match(html, /Content-Security-Policy[^>]+default-src 'none';[^"]+script-src 'self';[^"]+style-src 'self';/);
  assert.match(html, /<link rel="stylesheet" href="overlay\.css"\s*\/?>/);
  assert.match(html, /<script src="overlay\.js" defer><\/script>/);
  assert.doesNotMatch(html, /<style(?:\s|>)/i);
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i);
  assert.doesNotMatch(html, /\sstyle=/i);
  assert.doesNotMatch(html, /https?:\/\//i);
  assert.doesNotMatch(html, /api[-_ ]?key|api[-_ ]?base|gemini/i);
});

test('overlay renderer uses safe DOM construction and authenticated API bridge paths', () => {
  const renderer = source('overlay.js');

  assert.doesNotMatch(
    renderer,
    /\b(?:innerHTML|outerHTML|insertAdjacentHTML|eval|Function|localStorage|sessionStorage)\b/
  );
  assert.doesNotMatch(renderer, /localhost:5000|x-user-id|api[-_ ]?key|api[-_ ]?base/i);
  assert.match(renderer, /createElement/);
  assert.match(renderer, /textContent/);
  assert.match(renderer, /request\('\/api\/search/);
  assert.match(renderer, /request\('\/api\/notes/);
  assert.match(renderer, /request\('\/api\/bookmarks/);
});
