import { validateExtensionMessage } from './src/message-contracts.js';
import { createTextElement, normalizeSafeWebUrl, replaceChildren } from './src/safe-dom.js';

export const POPUP_STATES = Object.freeze([
  'loading',
  'empty',
  'ready',
  'offline',
  'authentication_required',
  'retry',
  'conflict',
  'incompatible',
]);

const STATE_COPY = Object.freeze({
  loading: Object.freeze({
    eyebrow: 'Checking connection',
    title: 'Opening your rewind',
    description: 'Looking for the Easy Rewind app on this computer.',
    actions: Object.freeze([]),
  }),
  empty: Object.freeze({
    eyebrow: 'Nothing selected',
    title: 'Choose a page to remember',
    description: 'Open a regular web page, then return here when you are ready to capture it.',
    actions: Object.freeze([{ action: 'retry', label: 'Check again' }]),
  }),
  ready: Object.freeze({
    eyebrow: 'Ready on this computer',
    title: 'Your rewind is within reach',
    description: 'The desktop app is connected. Page capture remains under your control.',
    actions: Object.freeze([{ action: 'clear-local-authorization', label: 'Forget connection' }]),
  }),
  offline: Object.freeze({
    eyebrow: 'Desktop app not found',
    title: 'Your rewind is offline',
    description: 'Start Easy Rewind on this computer, then check the connection again.',
    actions: Object.freeze([{ action: 'retry', label: 'Retry connection' }]),
  }),
  authentication_required: Object.freeze({
    eyebrow: 'Connection needs approval',
    title: 'Sign in from the desktop app',
    description: 'Open Easy Rewind on this computer and approve this browser connection.',
    actions: Object.freeze([{ action: 'retry', label: 'Check approval' }]),
  }),
  retry: Object.freeze({
    eyebrow: 'Trying again',
    title: 'Reconnecting your rewind',
    description: 'Checking the local app without sending page data elsewhere.',
    actions: Object.freeze([]),
  }),
  conflict: Object.freeze({
    eyebrow: 'Sync paused safely',
    title: 'Two edits need attention',
    description: 'Open the desktop app to choose which local edit to keep, then retry.',
    actions: Object.freeze([{ action: 'retry', label: 'Retry sync' }]),
  }),
  incompatible: Object.freeze({
    eyebrow: 'Update needed',
    title: 'App versions do not match',
    description: 'Update Easy Rewind on this computer before reconnecting the extension.',
    actions: Object.freeze([{ action: 'retry', label: 'Check version' }]),
  }),
});

const STATE_SET = new Set(POPUP_STATES);

function safePage(page) {
  if (!page || typeof page !== 'object') return null;
  const url = normalizeSafeWebUrl(page.url);
  if (!url) return null;
  const title =
    typeof page.title === 'string' && page.title.trim().length > 0
      ? page.title.trim().slice(0, 512)
      : new URL(url).hostname;
  return Object.freeze({ title, url });
}

export function createPopupModel(state, { captureEnabled = false, page = null } = {}) {
  const normalizedState = STATE_SET.has(state) ? state : 'offline';
  const copy = STATE_COPY[normalizedState];
  return Object.freeze({
    state: normalizedState,
    eyebrow: copy.eyebrow,
    title: copy.title,
    description: copy.description,
    actions: copy.actions,
    captureEnabled: captureEnabled === true,
    page: safePage(page),
  });
}

function actionFromTarget(target) {
  if (!target || typeof target.closest !== 'function') return null;
  const actionNode = target.closest('[data-action]');
  const action = actionNode?.dataset?.action;
  if (typeof action !== 'string') return null;
  return { action, node: actionNode };
}

function focusAction(document, action) {
  if (!action) return false;
  const candidates = document.querySelectorAll('[data-action]');
  for (const candidate of candidates) {
    if (candidate.dataset?.action === action && typeof candidate.focus === 'function') {
      candidate.focus();
      return true;
    }
  }
  return false;
}

export function createPopupView(document) {
  if (!document || typeof document.getElementById !== 'function') {
    throw new TypeError('A popup document is required.');
  }

  const root = document.getElementById('popup-root');
  const stateCard = document.getElementById('state-card');
  const eyebrow = document.getElementById('state-eyebrow');
  const title = document.getElementById('state-title');
  const description = document.getElementById('state-description');
  const actions = document.getElementById('state-actions');
  const pageSummary = document.getElementById('page-summary');
  const pageTitle = document.getElementById('page-title');
  const pageButton = pageSummary?.querySelector('[data-action="open-page"]');
  const captureControl = document.getElementById('capture-control');
  const captureToggle = document.getElementById('capture-toggle');
  const connectionForm = document.getElementById('connection-form');
  const connectionCode = document.getElementById('desktop-connection-code');
  const liveStatus = document.getElementById('status-live');

  if (
    !root ||
    !stateCard ||
    !eyebrow ||
    !title ||
    !description ||
    !actions ||
    !pageSummary ||
    !pageTitle ||
    !pageButton ||
    !captureControl ||
    !captureToggle ||
    !connectionForm ||
    !connectionCode ||
    !liveStatus
  ) {
    throw new TypeError('Popup markup is incomplete.');
  }

  function render(model, { restoreAction = null } = {}) {
    stateCard.dataset.state = model.state;
    eyebrow.textContent = model.eyebrow;
    title.textContent = model.title;
    description.textContent = model.description;

    const actionButtons = model.actions.map(({ action, label }) => {
      const button = createTextElement(document, 'button', {
        text: label,
        className: 'action-button',
      });
      button.type = 'button';
      button.dataset.action = action;
      return button;
    });
    replaceChildren(actions, ...actionButtons);

    pageSummary.hidden = !model.page;
    pageTitle.textContent = model.page?.title ?? '';
    if (model.page) pageButton.dataset.url = model.page.url;
    else delete pageButton.dataset.url;

    captureControl.hidden = model.state !== 'ready';
    captureToggle.checked = model.captureEnabled;
    captureToggle.disabled = model.state !== 'ready';
    connectionForm.hidden = model.state !== 'authentication_required';

    if (!focusAction(document, restoreAction) && restoreAction) title.focus();
  }

  function bind(handler) {
    const onClick = event => {
      const action = actionFromTarget(event.target);
      if (!action || action.action === 'toggle-capture') return;
      handler({
        action: action.action,
        url: action.node.dataset.url,
      });
    };
    const onChange = event => {
      const action = actionFromTarget(event.target);
      if (action?.action !== 'toggle-capture') return;
      handler({ action: action.action, enabled: action.node.checked === true });
    };
    const onSubmit = event => {
      if (event.target !== connectionForm) return;
      event.preventDefault();
      const value = connectionCode.value;
      connectionCode.value = '';
      handler({ action: 'set-local-authorization', connectionCode: value });
    };
    root.addEventListener('click', onClick);
    root.addEventListener('change', onChange);
    root.addEventListener('submit', onSubmit);
    return () => {
      root.removeEventListener('click', onClick);
      root.removeEventListener('change', onChange);
      root.removeEventListener('submit', onSubmit);
    };
  }

  function getActiveAction() {
    return document.activeElement?.dataset?.action ?? null;
  }

  function setStatus(message, tone = 'neutral') {
    liveStatus.textContent = String(message);
    liveStatus.dataset.tone = tone;
  }

  function clearConnectionCode() {
    connectionCode.value = '';
  }

  return Object.freeze({ bind, clearConnectionCode, getActiveAction, render, setStatus });
}

function connectionState(response) {
  if (!response || typeof response !== 'object') return 'offline';
  const direct = response.state;
  if (typeof direct === 'string' && STATE_SET.has(direct)) return direct;
  const nested = direct?.connection?.status ?? response.connection?.status;
  if (typeof nested === 'string' && STATE_SET.has(nested)) return nested;
  return response.ok === true ? 'ready' : 'offline';
}

function captureState(response) {
  if (!response || typeof response !== 'object') return false;
  return response.captureEnabled === true || response.state?.capture?.enabled === true;
}

function pageState(response) {
  if (!response || typeof response !== 'object') return null;
  return safePage(response.page);
}

export function createPopupController({ view, sendMessage, openUrl }) {
  if (
    !view ||
    typeof view.bind !== 'function' ||
    typeof view.render !== 'function' ||
    typeof view.setStatus !== 'function'
  ) {
    throw new TypeError('A popup view is required.');
  }
  if (typeof sendMessage !== 'function' || typeof openUrl !== 'function') {
    throw new TypeError('Popup transports are required.');
  }

  let currentModel = createPopupModel('loading');
  let unbind = null;
  let disposed = false;

  function render(model, options) {
    currentModel = model;
    view.render(model, options);
  }

  async function send(type, payload) {
    const candidate = payload === undefined ? { type } : { type, payload };
    const validation = validateExtensionMessage(candidate);
    if (!validation.valid) throw new TypeError('Invalid popup message.');
    return sendMessage(validation.message);
  }

  async function refresh({ restoreAction = null } = {}) {
    render(createPopupModel('loading'), { restoreAction });
    try {
      const stateResponse = await send('GET_EXTENSION_STATE');
      const state = connectionState(stateResponse);
      if (state !== 'ready' && state !== 'empty') {
        render(createPopupModel(state, { captureEnabled: captureState(stateResponse) }), { restoreAction });
        return currentModel;
      }

      const pageResponse = await send('GET_PAGE_SNAPSHOT');
      const page = pageState(pageResponse);
      const finalState = state === 'empty' ? 'empty' : 'ready';
      render(
        createPopupModel(finalState, {
          captureEnabled: captureState(stateResponse),
          page,
        }),
        { restoreAction }
      );
      return currentModel;
    } catch {
      render(createPopupModel('offline'), { restoreAction });
      view.setStatus('Connection unavailable.', 'error');
      return currentModel;
    }
  }

  async function handleAction({ action, connectionCode, enabled, url }) {
    if (disposed) return;
    if (action === 'open-page') {
      const safeUrl = normalizeSafeWebUrl(url);
      if (safeUrl) openUrl(safeUrl);
      return;
    }

    if (action === 'retry') {
      const restoreAction = view.getActiveAction?.() ?? 'retry';
      render(createPopupModel('retry'), { restoreAction });
      try {
        const response = await send('CHECK_CONNECTION');
        const state = connectionState(response);
        if (state !== 'ready') {
          render(createPopupModel(state), { restoreAction });
          return;
        }
        await refresh({ restoreAction });
      } catch {
        render(createPopupModel('offline'), { restoreAction });
        view.setStatus('Connection unavailable.', 'error');
      }
      return;
    }

    if (action === 'set-local-authorization') {
      view.clearConnectionCode?.();
      try {
        const response = await send('SET_LOCAL_AUTHORIZATION', { connectionCode });
        if (response?.ok !== true) {
          render(createPopupModel(connectionState(response)), {
            restoreAction: 'set-local-authorization',
          });
          view.setStatus('Connection code was not accepted.', 'error');
          return;
        }
        view.setStatus('Desktop connection approved.', 'success');
        await refresh();
      } catch {
        render(createPopupModel('authentication_required'), {
          restoreAction: 'set-local-authorization',
        });
        view.setStatus('Connection code was not accepted.', 'error');
      }
      return;
    }

    if (action === 'clear-local-authorization') {
      try {
        const response = await send('CLEAR_LOCAL_AUTHORIZATION');
        const state = connectionState(response);
        render(createPopupModel(state === 'ready' ? 'authentication_required' : state), {
          restoreAction: 'set-local-authorization',
        });
        view.setStatus('Browser connection removed.', 'success');
      } catch {
        render(createPopupModel('offline'), {
          restoreAction: 'clear-local-authorization',
        });
        view.setStatus('Connection could not be removed.', 'error');
      }
      return;
    }

    if (action === 'toggle-capture' && typeof enabled === 'boolean') {
      try {
        const response = await send('SET_CAPTURE_ENABLED', { enabled });
        if (response?.ok !== true) {
          const state = connectionState(response);
          render(createPopupModel(state, { captureEnabled: !enabled }), {
            restoreAction: 'toggle-capture',
          });
          view.setStatus('Capture setting was not changed.', 'error');
          return;
        }
        render(
          createPopupModel(currentModel.state, {
            captureEnabled: enabled,
            page: currentModel.page,
          }),
          { restoreAction: 'toggle-capture' }
        );
        view.setStatus(`Page capture ${enabled ? 'enabled' : 'disabled'}.`, 'success');
      } catch {
        render(
          createPopupModel('offline', {
            captureEnabled: !enabled,
            page: currentModel.page,
          }),
          { restoreAction: 'toggle-capture' }
        );
        view.setStatus('Capture setting was not changed.', 'error');
      }
    }
  }

  async function start() {
    if (disposed) throw new Error('Popup controller is disposed.');
    if (!unbind) unbind = view.bind(handleAction);
    return refresh();
  }

  function dispose() {
    disposed = true;
    unbind?.();
    unbind = null;
  }

  return Object.freeze({ dispose, refresh, start });
}

function startBrowserPopup() {
  const runtime = globalThis.chrome?.runtime;
  if (typeof document === 'undefined' || !runtime || typeof runtime.sendMessage !== 'function') {
    return;
  }

  const controller = createPopupController({
    view: createPopupView(document),
    sendMessage: message => runtime.sendMessage(message),
    openUrl: url => globalThis.chrome.tabs.create({ url }),
  });
  controller.start();
}

startBrowserPopup();
