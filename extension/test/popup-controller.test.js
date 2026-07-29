import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { POPUP_STATES, createPopupController, createPopupModel } from '../popup.js';
import { validateExtensionMessage } from '../src/message-contracts.js';

const popupHtmlUrl = new URL('../popup.html', import.meta.url);
const popupScriptUrl = new URL('../popup.js', import.meta.url);
const VALID_AUTHORIZATION = `Bearer eri_install-1.${'A'.repeat(43)}`;

function createView() {
  const clearedConnectionCodes = [];
  const renders = [];
  const statuses = [];
  let actionHandler;
  let activeAction = null;
  return {
    renders,
    statuses,
    clearedConnectionCodes,
    bind(handler) {
      actionHandler = handler;
      return () => {
        actionHandler = undefined;
      };
    },
    dispatch(action, details = {}) {
      return actionHandler?.({ action, ...details });
    },
    getActiveAction() {
      return activeAction;
    },
    clearConnectionCode() {
      clearedConnectionCodes.push(true);
    },
    render(model, options = {}) {
      renders.push({ model, options });
      activeAction = options.restoreAction ?? null;
    },
    setStatus(message, tone) {
      statuses.push({ message, tone });
    },
  };
}

test('popup source has no unsafe rendering, inline handlers, network client, or provider credential UI', async () => {
  const [html, script] = await Promise.all([readFile(popupHtmlUrl, 'utf8'), readFile(popupScriptUrl, 'utf8')]);

  assert.doesNotMatch(html, /\son[a-z]+\s*=/i);
  assert.doesNotMatch(html, /javascript:|data:text\/html/i);
  assert.doesNotMatch(html, /provider|gemini|api[_ -]?key|credential/i);
  assert.doesNotMatch(script, /\.innerHTML\b|insertAdjacentHTML|document\.write/i);
  assert.doesNotMatch(script, /\bfetch\s*\(|XMLHttpRequest|\bapiCall\b/i);
  assert.doesNotMatch(script, /provider|gemini|api[_ -]?key|password|credential/i);
  assert.match(html, /<form[^>]+id="connection-form"/);
  assert.doesNotMatch(html, /<form[^>]+data-action=/);
  assert.match(html, /<label[^>]+for="desktop-connection-code"/);
  assert.match(html, /<input[^>]+id="desktop-connection-code"[^>]+type="password"/s);
  assert.match(html, /autocomplete="off"/);
  assert.match(html, /role="status"/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /<script type="module" src="popup\.js"><\/script>/);
});

test('defines a complete, explicit popup state model', () => {
  assert.deepEqual(POPUP_STATES, [
    'loading',
    'empty',
    'ready',
    'offline',
    'authentication_required',
    'retry',
    'conflict',
    'incompatible',
  ]);

  for (const state of POPUP_STATES) {
    const model = createPopupModel(state, {
      captureEnabled: false,
      page: { title: 'A <hostile> title', url: 'https://example.test/read' },
    });
    assert.equal(model.state, state);
    assert.equal(typeof model.title, 'string');
    assert.equal(model.title.length > 0, true);
    assert.equal(typeof model.description, 'string');
    assert.equal(Object.isFrozen(model), true);
  }

  assert.equal(createPopupModel('unknown').state, 'offline');
});

test('initialization sends only validated extension messages and renders backend state', async () => {
  const view = createView();
  const sent = [];
  const controller = createPopupController({
    view,
    async sendMessage(message) {
      assert.equal(validateExtensionMessage(message).valid, true);
      sent.push(message);
      if (message.type === 'GET_EXTENSION_STATE') {
        return {
          ok: true,
          state: {
            connection: { status: 'ready' },
            capture: { enabled: false },
          },
        };
      }
      return {
        ok: true,
        page: { title: '<img src=x>', url: 'https://example.test/read' },
      };
    },
    openUrl() {},
  });

  await controller.start();

  assert.deepEqual(
    sent.map(message => message.type),
    ['GET_EXTENSION_STATE', 'GET_PAGE_SNAPSHOT']
  );
  assert.equal(view.renders[0].model.state, 'loading');
  assert.equal(view.renders.at(-1).model.state, 'ready');
  assert.equal(view.renders.at(-1).model.page.title, '<img src=x>');
});

test('renders each explicit connection state without converting failures to success', async () => {
  for (const state of ['empty', 'offline', 'authentication_required', 'conflict', 'incompatible']) {
    const view = createView();
    const controller = createPopupController({
      view,
      async sendMessage(message) {
        if (message.type === 'GET_EXTENSION_STATE') {
          return { ok: state !== 'offline', state };
        }
        return { ok: true, page: null };
      },
      openUrl() {},
    });

    await controller.start();
    assert.equal(view.renders.at(-1).model.state, state);
  }

  const view = createView();
  const controller = createPopupController({
    view,
    async sendMessage() {
      throw new Error('sensitive backend detail');
    },
    openUrl() {},
  });
  await controller.start();
  assert.equal(view.renders.at(-1).model.state, 'offline');
  assert.equal(view.renders.at(-1).model.description.includes('sensitive'), false);
});

test('delegated retry and capture actions preserve focus and use validated messages', async () => {
  const view = createView();
  const sent = [];
  const controller = createPopupController({
    view,
    async sendMessage(message) {
      assert.equal(validateExtensionMessage(message).valid, true);
      sent.push(message);
      if (message.type === 'GET_EXTENSION_STATE') {
        return { ok: true, state: 'ready', captureEnabled: false };
      }
      if (message.type === 'GET_PAGE_SNAPSHOT') return { ok: true, page: null };
      return { ok: true, state: 'ready' };
    },
    openUrl() {},
  });
  await controller.start();

  await view.dispatch('retry');
  await view.dispatch('toggle-capture', { enabled: true });

  assert.equal(
    sent.some(message => message.type === 'CHECK_CONNECTION'),
    true
  );
  assert.equal(
    sent.some(message => message.type === 'SET_CAPTURE_ENABLED' && message.payload.enabled === true),
    true
  );
  assert.equal(
    view.renders.some(entry => entry.model.state === 'retry' && entry.options.restoreAction === 'retry'),
    true
  );
  assert.deepEqual(view.statuses.at(-1), {
    message: 'Page capture enabled.',
    tone: 'success',
  });
});

test('open-page action permits only safe HTTP and HTTPS destinations', async () => {
  const opened = [];
  const view = createView();
  const controller = createPopupController({
    view,
    async sendMessage(message) {
      if (message.type === 'GET_EXTENSION_STATE') return { ok: true, state: 'ready' };
      return { ok: true, page: { title: 'Page', url: 'https://example.test/read' } };
    },
    openUrl(url) {
      opened.push(url);
    },
  });
  await controller.start();

  await view.dispatch('open-page', { url: 'javascript:alert(1)' });
  await view.dispatch('open-page', { url: 'https://example.test/read' });

  assert.deepEqual(opened, ['https://example.test/read']);
});

test('desktop connection code is cleared before submission settles and is never retained in popup state', async () => {
  const view = createView();
  const sent = [];
  const controller = createPopupController({
    view,
    async sendMessage(message) {
      assert.equal(validateExtensionMessage(message).valid, true);
      sent.push(structuredClone(message));
      if (message.type === 'GET_EXTENSION_STATE') {
        return { ok: false, state: 'authentication_required' };
      }
      if (message.type === 'SET_LOCAL_AUTHORIZATION') {
        assert.equal(view.clearedConnectionCodes.length > 0, true);
        return { ok: true, state: 'ready' };
      }
      return { ok: true, page: null };
    },
    openUrl() {},
  });
  await controller.start();

  await view.dispatch('set-local-authorization', { connectionCode: VALID_AUTHORIZATION });

  assert.equal(view.clearedConnectionCodes.length > 0, true);
  assert.equal(
    sent.some(
      message => message.type === 'SET_LOCAL_AUTHORIZATION' && message.payload.connectionCode === VALID_AUTHORIZATION
    ),
    true
  );
  assert.equal(JSON.stringify(view.renders).includes(VALID_AUTHORIZATION), false);
  assert.equal(JSON.stringify(view.statuses).includes(VALID_AUTHORIZATION), false);
});

test('forget connection sends the exact clear message and returns to approval state', async () => {
  const view = createView();
  const sent = [];
  const controller = createPopupController({
    view,
    async sendMessage(message) {
      sent.push(structuredClone(message));
      if (message.type === 'GET_EXTENSION_STATE') return { ok: true, state: 'ready' };
      if (message.type === 'GET_PAGE_SNAPSHOT') return { ok: true, page: null };
      return { ok: true, state: 'authentication_required' };
    },
    openUrl() {},
  });
  await controller.start();

  await view.dispatch('clear-local-authorization');

  assert.equal(
    sent.some(message => message.type === 'CLEAR_LOCAL_AUTHORIZATION' && Object.keys(message).length === 1),
    true
  );
  assert.equal(view.renders.at(-1).model.state, 'authentication_required');
});
