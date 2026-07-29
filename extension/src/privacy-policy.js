const REQUIRED_PRIVACY_KEYS = Object.freeze([
  'captureEnabled',
  'allowedHosts',
  'blockedHosts',
  'minimumDwellMs',
  'minimumSelectionLength',
]);

const SENSITIVE_PATH_SEGMENT =
  /(?:^|\/)(?:account|auth|billing|card|checkout|health|login|medical|patient|password|payment|profile|signin|sign-in|signup|sign-up|wallet)(?:\/|$)/i;
const SENSITIVE_HOST_LABEL =
  /^(?:account|accounts|auth|billing|checkout|health|login|medical|mychart|patient|pay|payment|payments|wallet)$/i;
const SENSITIVE_FORM_SELECTOR = [
  'input[type="password"]',
  'input[autocomplete="current-password"]',
  'input[autocomplete="new-password"]',
  'input[autocomplete^="cc-"]',
  'input[name*="card" i]',
  'input[name*="cvv" i]',
  'input[name*="cvc" i]',
  'form[action*="login" i]',
  'form[action*="payment" i]',
  'form[action*="checkout" i]',
];
const EDITABLE_SELECTOR =
  'input, textarea, select, option, [contenteditable]:not([contenteditable="false"]), [role="textbox"]';

export const DEFAULT_PRIVACY_SNAPSHOT = deepFreeze({
  captureEnabled: false,
  allowedHosts: [],
  blockedHosts: [],
  minimumDwellMs: 30_000,
  minimumSelectionLength: 24,
});

function deepFreeze(value) {
  Object.freeze(value);
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object' && !Object.isFrozen(child)) deepFreeze(child);
  }
  return value;
}

function isHostRule(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 253 &&
    /^(?:\*\.)?(?:localhost|[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)$/i.test(value) &&
    !value.includes('..')
  );
}

function isHostList(value) {
  return Array.isArray(value) && value.length <= 100 && new Set(value).size === value.length && value.every(isHostRule);
}

export function isCompletePrivacySnapshot(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return (
    keys.length === REQUIRED_PRIVACY_KEYS.length &&
    REQUIRED_PRIVACY_KEYS.every(key => Object.hasOwn(value, key)) &&
    typeof value.captureEnabled === 'boolean' &&
    isHostList(value.allowedHosts) &&
    isHostList(value.blockedHosts) &&
    Number.isSafeInteger(value.minimumDwellMs) &&
    value.minimumDwellMs >= 0 &&
    value.minimumDwellMs <= 86_400_000 &&
    Number.isSafeInteger(value.minimumSelectionLength) &&
    value.minimumSelectionLength >= 0 &&
    value.minimumSelectionLength <= 10_000
  );
}

export function hostMatchesRule(hostname, rule) {
  const host = String(hostname || '')
    .toLowerCase()
    .replace(/\.$/, '');
  const candidate = String(rule || '')
    .toLowerCase()
    .replace(/\.$/, '');
  if (!host || !candidate) return false;
  if (!candidate.startsWith('*.')) return host === candidate;
  const suffix = candidate.slice(2);
  return host.length > suffix.length + 1 && host.endsWith(`.${suffix}`);
}

function matchesAnyHostRule(hostname, rules) {
  return rules.some(rule => hostMatchesRule(hostname, rule));
}

function isSensitivePage(location, document) {
  let path;
  try {
    path = decodeURIComponent(`${location.pathname || ''}/${location.search || ''}`);
  } catch {
    path = `${location.pathname || ''}/${location.search || ''}`;
  }
  if (SENSITIVE_PATH_SEGMENT.test(path)) return true;
  if (
    String(location.hostname || '')
      .split('.')
      .some(label => SENSITIVE_HOST_LABEL.test(label))
  ) {
    return true;
  }

  if (typeof document?.querySelector !== 'function') return false;
  for (const selector of SENSITIVE_FORM_SELECTOR) {
    try {
      if (document.querySelector(selector)) return true;
    } catch {
      return true;
    }
  }
  return false;
}

export function isSelectionCaptureAllowed(selection, selectionLength, minimumSelectionLength) {
  if (!selection || selection.isCollapsed === true || selectionLength < minimumSelectionLength) {
    return false;
  }
  let node = selection.anchorNode || selection.focusNode || null;
  if (node?.nodeType === 3) node = node.parentElement;
  if (typeof node?.closest !== 'function') return false;
  try {
    return node.closest(EDITABLE_SELECTOR) === null;
  } catch {
    return false;
  }
}

export function evaluateCapture({ settings, location, document, dwellMs = 0, selectionLength = 0, selection = null }) {
  if (!isCompletePrivacySnapshot(settings) || settings.captureEnabled !== true) {
    return Object.freeze({
      allowed: false,
      pageCaptureAllowed: false,
      selectionCaptureAllowed: false,
      reason: 'capture_disabled',
    });
  }

  let url;
  try {
    url = location instanceof URL ? location : new URL(String(location?.href || location));
  } catch {
    return Object.freeze({
      allowed: false,
      pageCaptureAllowed: false,
      selectionCaptureAllowed: false,
      reason: 'unsupported_page',
    });
  }

  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    return Object.freeze({
      allowed: false,
      pageCaptureAllowed: false,
      selectionCaptureAllowed: false,
      reason: 'unsupported_page',
    });
  }
  if (matchesAnyHostRule(url.hostname, settings.blockedHosts)) {
    return Object.freeze({
      allowed: false,
      pageCaptureAllowed: false,
      selectionCaptureAllowed: false,
      reason: 'blocked_host',
    });
  }
  if (settings.allowedHosts.length > 0 && !matchesAnyHostRule(url.hostname, settings.allowedHosts)) {
    return Object.freeze({
      allowed: false,
      pageCaptureAllowed: false,
      selectionCaptureAllowed: false,
      reason: 'host_not_allowed',
    });
  }
  if (isSensitivePage(url, document)) {
    return Object.freeze({
      allowed: false,
      pageCaptureAllowed: false,
      selectionCaptureAllowed: false,
      reason: 'sensitive_page',
    });
  }

  return Object.freeze({
    allowed: true,
    pageCaptureAllowed: dwellMs >= settings.minimumDwellMs,
    selectionCaptureAllowed: isSelectionCaptureAllowed(selection, selectionLength, settings.minimumSelectionLength),
    reason: 'allowed',
  });
}
