const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const CREDENTIAL_KEY = /(?:api[_-]?key|token|secret|credential|password)/i;
const LEGACY_PROVIDER_KEY = /(?:gemini|provider)/i;
const MAX_STATE_CHARACTERS = 65_536;
const MAX_STATE_DEPTH = 8;

export const EXTENSION_STATE_KEYS = Object.freeze(['connection', 'privacy', 'capture', 'ui', 'sync']);

const STATE_KEY_SET = new Set(EXTENSION_STATE_KEYS);

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

function cloneJson(value, { stripLegacy = false } = {}) {
  const seen = new Set();

  function visit(current, depth) {
    if (depth > MAX_STATE_DEPTH) throw new TypeError('Invalid extension state.');
    if (current === null || typeof current === 'string' || typeof current === 'boolean') {
      return current;
    }
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) throw new TypeError('Invalid extension state.');
      return current;
    }
    if (typeof current !== 'object' || seen.has(current)) {
      throw new TypeError('Invalid extension state.');
    }

    seen.add(current);
    let cloned;

    if (Array.isArray(current)) {
      const keys = Reflect.ownKeys(current);
      const length = current.length;
      if (
        !Number.isSafeInteger(length) ||
        keys.length !== length + 1 ||
        keys.some(
          key =>
            typeof key !== 'string' ||
            (key !== 'length' &&
              (!/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= length || String(Number(key)) !== key))
        )
      ) {
        throw new TypeError('Invalid extension state.');
      }
      cloned = [];
      for (let index = 0; index < length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(current, String(index));
        if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
          throw new TypeError('Invalid extension state.');
        }
        cloned.push(visit(descriptor.value, depth + 1));
      }
    } else {
      if (!isPlainObject(current)) throw new TypeError('Invalid extension state.');
      const entries = ownDataEntries(current);
      if (!entries) throw new TypeError('Invalid extension state.');
      cloned = {};
      for (const [key, item] of entries) {
        if (stripLegacy && (CREDENTIAL_KEY.test(key) || LEGACY_PROVIDER_KEY.test(key))) {
          continue;
        }
        cloned[key] = visit(item, depth + 1);
      }
    }

    seen.delete(current);
    return cloned;
  }

  const cloned = visit(value, 0);
  if (JSON.stringify(cloned).length > MAX_STATE_CHARACTERS) {
    throw new TypeError('Invalid extension state.');
  }
  return cloned;
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}

function timestamp(now) {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('now must return a non-negative safe integer.');
  }
  return value;
}

function defaults(now) {
  const updatedAt = timestamp(now);
  return {
    connection: { status: 'unknown', updatedAt },
    privacy: {
      allowedHosts: [],
      blockedHosts: [],
      minimumDwellMs: 15_000,
      minimumSelectionLength: 24,
    },
    capture: { enabled: false },
    ui: { activeView: 'capture' },
    sync: { cursor: null, updatedAt },
  };
}

function validateState(value) {
  if (!isPlainObject(value)) throw new TypeError('Invalid extension state.');
  const entries = ownDataEntries(value);
  if (
    !entries ||
    entries.length !== EXTENSION_STATE_KEYS.length ||
    entries.some(([key]) => !STATE_KEY_SET.has(key)) ||
    containsCredential(value) ||
    entries.some(([key, item]) => key !== 'connection' && containsLegacyProvider(item))
  ) {
    throw new TypeError('Invalid extension state.');
  }

  const cloned = cloneJson(value);
  if (containsLegacyProvider(cloned)) throw new TypeError('Invalid extension state.');
  for (const key of EXTENSION_STATE_KEYS) {
    if (!isPlainObject(cloned[key])) throw new TypeError('Invalid extension state.');
  }
  return cloned;
}

function containsLegacyProvider(value) {
  const seen = new Set();

  function visit(current) {
    if (current === null || typeof current !== 'object' || seen.has(current)) return false;
    seen.add(current);
    for (const key of Reflect.ownKeys(current)) {
      if (typeof key !== 'string') continue;
      if (LEGACY_PROVIDER_KEY.test(key)) return true;
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (descriptor && Object.hasOwn(descriptor, 'value') && visit(descriptor.value)) return true;
    }
    return false;
  }

  return visit(value);
}

export function containsCredential(value) {
  const seen = new Set();

  function visit(current) {
    if (current === null || typeof current !== 'object' || seen.has(current)) return false;
    seen.add(current);
    for (const key of Reflect.ownKeys(current)) {
      if (typeof key !== 'string') continue;
      if (CREDENTIAL_KEY.test(key)) return true;
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (descriptor && Object.hasOwn(descriptor, 'value') && visit(descriptor.value)) return true;
    }
    return false;
  }

  return visit(value);
}

export function createExtensionStateStore({ storageArea, now } = {}) {
  if (
    !storageArea ||
    typeof storageArea.get !== 'function' ||
    typeof storageArea.set !== 'function' ||
    typeof storageArea.remove !== 'function'
  ) {
    throw new TypeError('storageArea must provide get, set, and remove.');
  }
  if (typeof now !== 'function') throw new TypeError('now must be a function.');

  async function persistExact(state, current) {
    const unknownKeys = isPlainObject(current)
      ? Reflect.ownKeys(current).filter(key => typeof key === 'string' && !STATE_KEY_SET.has(key))
      : [];
    if (unknownKeys.length > 0) await storageArea.remove(unknownKeys);
    await storageArea.set(state);
    return deepFreeze(cloneJson(state));
  }

  async function load() {
    const fallback = defaults(now);
    const current = await storageArea.get(null);
    const migrated = {};

    for (const key of EXTENSION_STATE_KEYS) {
      try {
        migrated[key] =
          isPlainObject(current) && Object.hasOwn(current, key)
            ? cloneJson(current[key], { stripLegacy: true })
            : fallback[key];
        if (!isPlainObject(migrated[key])) migrated[key] = fallback[key];
      } catch {
        migrated[key] = fallback[key];
      }
    }

    return persistExact(validateState(migrated), current);
  }

  async function save(state) {
    const validated = validateState(state);
    const current = await storageArea.get(null);
    return persistExact(validated, current);
  }

  async function reset() {
    const current = await storageArea.get(null);
    return persistExact(defaults(now), current);
  }

  return Object.freeze({ load, reset, save });
}
