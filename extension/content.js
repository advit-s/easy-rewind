import { validateExtensionMessage } from './src/message-contracts.js';
import { evaluateCapture, isCompletePrivacySnapshot, isSelectionCaptureAllowed } from './src/privacy-policy.js';

const MAX_PAGE_TEXT_LENGTH = 131_072;
const MAX_SELECTION_TEXT_LENGTH = 32_768;

function inertController() {
  return Object.freeze({
    active: false,
    start() {},
    dispose() {},
  });
}

function runtimeSend(runtime, message) {
  if (!runtime?.sendMessage) return Promise.resolve(undefined);
  try {
    const result = runtime.sendMessage(message);
    return result && typeof result.then === 'function' ? result : Promise.resolve(result);
  } catch {
    return Promise.resolve(undefined);
  }
}

export async function requestPrivacySnapshot(runtime) {
  const request = validateExtensionMessage({ type: 'GET_PRIVACY_SNAPSHOT' });
  if (!request.valid) return null;
  const response = await runtimeSend(runtime, request.message);
  const snapshot =
    response?.ok === true && response?.state === 'ready' && isCompletePrivacySnapshot(response.data)
      ? response.data
      : response;
  return isCompletePrivacySnapshot(snapshot) ? snapshot : null;
}

function safePageText(document) {
  const clone = document?.body?.cloneNode?.(true);
  if (!clone) return '';
  const removals = clone.querySelectorAll?.(
    'script, style, nav, footer, header, iframe, svg, noscript, form, input, textarea, select, option, button, [contenteditable], [role="textbox"], [role="navigation"], [role="banner"], [role="contentinfo"]'
  );
  removals?.forEach(element => element.remove());
  return String(clone.textContent || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_PAGE_TEXT_LENGTH);
}

function selectedText(window, document) {
  const selection = window?.getSelection?.() || document?.getSelection?.();
  if (!selection || selection.isCollapsed) return { selection, text: '' };
  return {
    selection,
    text: String(selection.toString?.() || '')
      .trim()
      .slice(0, MAX_SELECTION_TEXT_LENGTH),
  };
}

export function createContentController({
  window,
  document,
  runtime,
  settings,
  now = Date.now,
  sendMessage = message => runtimeSend(runtime, message),
  setTimeout: setTimeoutFn = globalThis.setTimeout,
  clearTimeout: clearTimeoutFn = globalThis.clearTimeout,
  observePrivacy = true,
}) {
  if (!isCompletePrivacySnapshot(settings)) return inertController();

  const listenerDisposers = [];
  const timerIds = new Set();
  const startedAt = now();
  let active = false;
  let pageCaptured = false;

  function addDomListener(target, type, listener, options) {
    target?.addEventListener?.(type, listener, options);
    listenerDisposers.push(() => target?.removeEventListener?.(type, listener, options));
  }

  function sendValidated(message) {
    if (!active) return;
    const result = validateExtensionMessage(message);
    if (result.valid) void sendMessage(result.message);
  }

  function currentDecision(selection = null, length = 0) {
    return evaluateCapture({
      settings,
      location: window.location,
      document,
      dwellMs: Math.max(0, now() - startedAt),
      selection,
      selectionLength: length,
    });
  }

  function capturePage() {
    if (pageCaptured || !active) return;
    const decision = currentDecision();
    if (!decision.pageCaptureAllowed) return;
    const text = safePageText(document);
    if (!text) return;
    pageCaptured = true;
    sendValidated({
      type: 'CAPTURE_PAGE',
      payload: {
        url: window.location.href,
        title: String(document.title || 'Untitled Page').slice(0, 512),
        text,
        occurredAt: now(),
      },
    });
  }

  function captureSelection() {
    if (!active) return;
    const { selection, text } = selectedText(window, document);
    if (
      !isSelectionCaptureAllowed(selection, text.length, settings.minimumSelectionLength) ||
      !currentDecision(selection, text.length).selectionCaptureAllowed
    ) {
      return;
    }
    sendValidated({
      type: 'CAPTURE_SELECTION',
      payload: {
        url: window.location.href,
        title: String(document.title || 'Untitled Page').slice(0, 512),
        text,
        occurredAt: now(),
      },
    });
  }

  function dispose() {
    if (!active && listenerDisposers.length === 0 && timerIds.size === 0) return;
    active = false;
    for (const remove of listenerDisposers.splice(0)) remove();
    for (const timerId of timerIds) clearTimeoutFn(timerId);
    timerIds.clear();
  }

  function onPrivacyMessage(message) {
    const result = validateExtensionMessage(message);
    if (result.valid && result.message.type === 'PRIVACY_CHANGED' && result.message.payload.captureEnabled === false) {
      dispose();
    }
  }

  function start() {
    if (active || settings.captureEnabled !== true) return;
    const initial = currentDecision();
    if (!initial.allowed) return;
    active = true;

    addDomListener(document, 'selectionchange', captureSelection);
    addDomListener(window, 'beforeunload', capturePage);
    if (observePrivacy && runtime?.onMessage?.addListener) {
      runtime.onMessage.addListener(onPrivacyMessage);
      listenerDisposers.push(() => runtime.onMessage.removeListener?.(onPrivacyMessage));
    }

    const timerId = setTimeoutFn(() => {
      timerIds.delete(timerId);
      capturePage();
    }, settings.minimumDwellMs);
    timerIds.add(timerId);
  }

  return {
    get active() {
      return active;
    },
    start,
    dispose,
  };
}

export async function startContentCapture({
  window,
  document,
  runtime,
  requestPrivacySnapshot: loadPrivacy = () => requestPrivacySnapshot(runtime),
  ...controllerDependencies
}) {
  const settings = await loadPrivacy();
  if (!isCompletePrivacySnapshot(settings)) return inertController();
  const decision = evaluateCapture({ settings, location: window.location, document });
  if (!decision.allowed) return inertController();
  const controller = createContentController({
    window,
    document,
    runtime,
    settings,
    ...controllerDependencies,
  });
  controller.start();
  return controller;
}

export function startContentRuntime({
  window,
  document,
  runtime,
  loadPrivacy = () => requestPrivacySnapshot(runtime),
  ...controllerDependencies
}) {
  if (!runtime?.onMessage?.addListener || !runtime?.onMessage?.removeListener) {
    throw new TypeError('A runtime message event is required.');
  }

  let controller = inertController();
  let disposed = false;

  function apply(settings) {
    if (disposed || !isCompletePrivacySnapshot(settings)) return controller;
    controller.dispose();
    const decision = evaluateCapture({ settings, location: window.location, document });
    if (!decision.allowed) {
      controller = inertController();
      return controller;
    }
    controller = createContentController({
      window,
      document,
      runtime,
      settings,
      ...controllerDependencies,
      observePrivacy: false,
    });
    controller.start();
    return controller;
  }

  function onMessage(message) {
    const validation = validateExtensionMessage(message);
    if (validation.valid && validation.message.type === 'PRIVACY_CHANGED') {
      apply(validation.message.payload);
    }
  }

  runtime.onMessage.addListener(onMessage);
  const ready = Promise.resolve()
    .then(loadPrivacy)
    .then(apply)
    .catch(() => controller);

  function dispose() {
    if (disposed) return;
    disposed = true;
    controller.dispose();
    runtime.onMessage.removeListener(onMessage);
  }

  return Object.freeze({
    get active() {
      return controller.active;
    },
    dispose,
    ready,
  });
}

if (typeof window !== 'undefined' && typeof document !== 'undefined' && globalThis.chrome?.runtime) {
  startContentRuntime({
    window,
    document,
    runtime: globalThis.chrome.runtime,
  });
}
