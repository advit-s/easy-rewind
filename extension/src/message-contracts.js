import { isValidLocalAuthorization } from './session-authorization.js';

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const CREDENTIAL_KEY = /(?:api[_-]?key|token|secret|credential|password)/i;
const OWNER_KEYS = new Set([
  'account',
  'accountid',
  'deviceid',
  'owner',
  'ownerid',
  'profile',
  'profileid',
  'user',
  'userid',
]);
const MAX_MESSAGE_DEPTH = 8;
const MAX_MESSAGE_CHARACTERS = 196_608;

export const MESSAGE_LIMITS = Object.freeze({
  maxHosts: 100,
  maxHostLength: 253,
  maxUrlLength: 2_048,
  maxTitleLength: 512,
  maxPageTextLength: 131_072,
  maxSelectionTextLength: 32_768,
  maxDwellMs: 86_400_000,
  maxSelectionLength: 10_000,
  maxConnectionCodeLength: 192,
});

export const EXTENSION_MESSAGE_TYPES = Object.freeze([
  'GET_EXTENSION_STATE',
  'GET_PRIVACY_SNAPSHOT',
  'GET_PAGE_SNAPSHOT',
  'CHECK_CONNECTION',
  'RETRY_SYNC',
  'SET_LOCAL_AUTHORIZATION',
  'CLEAR_LOCAL_AUTHORIZATION',
  'SET_CAPTURE_ENABLED',
  'UPDATE_PRIVACY',
  'CAPTURE_PAGE',
  'CAPTURE_SELECTION',
  'PRIVACY_CHANGED',
]);

const MESSAGE_TYPE_SET = new Set(EXTENSION_MESSAGE_TYPES);
const INVALID_MESSAGE = Object.freeze({
  valid: false,
  error: 'invalid_message',
});

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function ownDataEntries(value) {
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== 'string')) return null;
  const entries = [];
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      !descriptor ||
      descriptor.enumerable !== true ||
      !Object.hasOwn(descriptor, 'value') ||
      DANGEROUS_KEYS.has(key)
    ) {
      return null;
    }
    entries.push([key, descriptor.value]);
  }
  return entries;
}

function cloneJson(value) {
  const seen = new Set();

  function visit(current, depth) {
    if (depth > MAX_MESSAGE_DEPTH) throw new TypeError('Invalid message.');
    if (current === null || typeof current === 'string' || typeof current === 'boolean') {
      return current;
    }
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) throw new TypeError('Invalid message.');
      return current;
    }
    if (typeof current !== 'object' || seen.has(current)) {
      throw new TypeError('Invalid message.');
    }

    seen.add(current);
    let cloned;

    if (Array.isArray(current)) {
      const keys = Reflect.ownKeys(current);
      if (
        keys.length !== current.length + 1 ||
        keys.some(
          key =>
            typeof key !== 'string' ||
            (key !== 'length' &&
              (!/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= current.length || String(Number(key)) !== key))
        )
      ) {
        throw new TypeError('Invalid message.');
      }
      cloned = [];
      for (let index = 0; index < current.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(current, String(index));
        if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
          throw new TypeError('Invalid message.');
        }
        cloned.push(visit(descriptor.value, depth + 1));
      }
    } else {
      if (!isPlainObject(current)) throw new TypeError('Invalid message.');
      const entries = ownDataEntries(current);
      if (!entries) throw new TypeError('Invalid message.');
      cloned = {};
      for (const [key, item] of entries) cloned[key] = visit(item, depth + 1);
    }

    seen.delete(current);
    return cloned;
  }

  const cloned = visit(value, 0);
  if (JSON.stringify(cloned).length > MAX_MESSAGE_CHARACTERS) {
    throw new TypeError('Invalid message.');
  }
  return cloned;
}

function hasForbiddenField(value) {
  const seen = new Set();

  function visit(current) {
    if (current === null || typeof current !== 'object' || seen.has(current)) return false;
    seen.add(current);
    for (const key of Reflect.ownKeys(current)) {
      if (typeof key !== 'string') continue;
      const normalized = key.replace(/[_-]/g, '').toLowerCase();
      if (CREDENTIAL_KEY.test(key) || OWNER_KEYS.has(normalized)) return true;
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (descriptor && Object.hasOwn(descriptor, 'value') && visit(descriptor.value)) return true;
    }
    return false;
  }

  return visit(value);
}

function hasExactKeys(value, expected) {
  if (!isPlainObject(value)) return false;
  const entries = ownDataEntries(value);
  if (!entries || entries.length !== expected.length) return false;
  return expected.every(key => Object.hasOwn(value, key));
}

function boundedString(value, maximum, { allowEmpty = true } = {}) {
  return typeof value === 'string' && value.length <= maximum && (allowEmpty || value.length > 0);
}

function validUrl(value) {
  if (!boundedString(value, MESSAGE_LIMITS.maxUrlLength, { allowEmpty: false })) return false;
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.username === '' && url.password === '';
  } catch {
    return false;
  }
}

function validHosts(value) {
  return (
    Array.isArray(value) &&
    value.length <= MESSAGE_LIMITS.maxHosts &&
    new Set(value).size === value.length &&
    value.every(
      host =>
        boundedString(host, MESSAGE_LIMITS.maxHostLength, { allowEmpty: false }) &&
        /^(?:\*\.)?(?:localhost|[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)$/i.test(host) &&
        !host.includes('..')
    )
  );
}

function safeInteger(value, maximum = Number.MAX_SAFE_INTEGER) {
  return Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}

function validPrivacyPayload(payload, includeCaptureEnabled) {
  const keys = includeCaptureEnabled
    ? ['captureEnabled', 'allowedHosts', 'blockedHosts', 'minimumDwellMs', 'minimumSelectionLength']
    : ['allowedHosts', 'blockedHosts', 'minimumDwellMs', 'minimumSelectionLength'];
  return (
    hasExactKeys(payload, keys) &&
    (!includeCaptureEnabled || typeof payload.captureEnabled === 'boolean') &&
    validHosts(payload.allowedHosts) &&
    validHosts(payload.blockedHosts) &&
    safeInteger(payload.minimumDwellMs, MESSAGE_LIMITS.maxDwellMs) &&
    safeInteger(payload.minimumSelectionLength, MESSAGE_LIMITS.maxSelectionLength)
  );
}

function validCapturePayload(payload, maximumTextLength) {
  return (
    hasExactKeys(payload, ['url', 'title', 'text', 'occurredAt']) &&
    validUrl(payload.url) &&
    boundedString(payload.title, MESSAGE_LIMITS.maxTitleLength) &&
    boundedString(payload.text, maximumTextLength, { allowEmpty: false }) &&
    safeInteger(payload.occurredAt)
  );
}

function matchesSchema(message) {
  switch (message.type) {
    case 'GET_EXTENSION_STATE':
    case 'GET_PRIVACY_SNAPSHOT':
    case 'GET_PAGE_SNAPSHOT':
    case 'CHECK_CONNECTION':
    case 'RETRY_SYNC':
    case 'CLEAR_LOCAL_AUTHORIZATION':
      return hasExactKeys(message, ['type']);
    case 'SET_LOCAL_AUTHORIZATION':
      return (
        hasExactKeys(message, ['type', 'payload']) &&
        hasExactKeys(message.payload, ['connectionCode']) &&
        boundedString(message.payload.connectionCode, MESSAGE_LIMITS.maxConnectionCodeLength, {
          allowEmpty: false,
        }) &&
        isValidLocalAuthorization(message.payload.connectionCode)
      );
    case 'SET_CAPTURE_ENABLED':
      return (
        hasExactKeys(message, ['type', 'payload']) &&
        hasExactKeys(message.payload, ['enabled']) &&
        typeof message.payload.enabled === 'boolean'
      );
    case 'UPDATE_PRIVACY':
      return hasExactKeys(message, ['type', 'payload']) && validPrivacyPayload(message.payload, false);
    case 'CAPTURE_PAGE':
      return (
        hasExactKeys(message, ['type', 'payload']) &&
        validCapturePayload(message.payload, MESSAGE_LIMITS.maxPageTextLength)
      );
    case 'CAPTURE_SELECTION':
      return (
        hasExactKeys(message, ['type', 'payload']) &&
        validCapturePayload(message.payload, MESSAGE_LIMITS.maxSelectionTextLength)
      );
    case 'PRIVACY_CHANGED':
      return hasExactKeys(message, ['type', 'payload']) && validPrivacyPayload(message.payload, true);
    default:
      return false;
  }
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}

export function validateExtensionMessage(message) {
  try {
    if (
      !isPlainObject(message) ||
      !Object.hasOwn(message, 'type') ||
      typeof message.type !== 'string' ||
      !MESSAGE_TYPE_SET.has(message.type) ||
      hasForbiddenField(message)
    ) {
      return INVALID_MESSAGE;
    }
    const cloned = cloneJson(message);
    if (!matchesSchema(cloned)) return INVALID_MESSAGE;
    return Object.freeze({ valid: true, message: deepFreeze(cloned) });
  } catch {
    return INVALID_MESSAGE;
  }
}
