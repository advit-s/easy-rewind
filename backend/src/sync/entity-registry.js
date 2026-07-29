'use strict';

const { fail } = require('./sync-error');

const SYNC_ENTITY_TYPES = Object.freeze([
  'item',
  'bookmark',
  'note',
  'highlight',
  'tag',
  'item_tag',
  'connection',
  'reminder',
  'flashcard',
  'quiz_result',
  'research_job',
  'digest',
  'setting',
]);
const PROVIDER_CREDENTIAL_KEY =
  /^(?:api[_-]?key|provider(?:[_-]?(?:key|token|secret|credential))|access[_-]?token|secret[_-]?ref)$/i;

function containsProviderCredential(value, ancestors = new Set()) {
  if (value === null || typeof value !== 'object') return false;
  if (ancestors.has(value)) return true;
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.some(entry => containsProviderCredential(entry, ancestors));
    return Object.entries(value).some(
      ([key, nested]) => PROVIDER_CREDENTIAL_KEY.test(key) || containsProviderCredential(nested, ancestors)
    );
  } finally {
    ancestors.delete(value);
  }
}

function validAdapter(adapter) {
  return (
    adapter !== null &&
    typeof adapter === 'object' &&
    typeof adapter.get === 'function' &&
    typeof adapter.apply === 'function' &&
    typeof adapter.snapshot === 'function'
  );
}

function createEntityRegistry({ adapters } = {}) {
  if (adapters === null || typeof adapters !== 'object' || Array.isArray(adapters)) {
    fail('SYNC_CONFIGURATION_INVALID');
  }
  const registered = new Map();
  for (const [type, adapter] of Object.entries(adapters)) {
    if (!SYNC_ENTITY_TYPES.includes(type) || !validAdapter(adapter)) fail('SYNC_CONFIGURATION_INVALID');
    registered.set(type, adapter);
  }

  function requireAdapter(entityType) {
    const adapter = registered.get(entityType);
    if (!adapter) fail('SYNC_ENTITY_UNSUPPORTED');
    return adapter;
  }

  function validatePayload(payload) {
    if (
      payload === null ||
      typeof payload !== 'object' ||
      Array.isArray(payload) ||
      containsProviderCredential(payload)
    ) {
      fail('SYNC_PAYLOAD_INVALID');
    }
    let encoded;
    try {
      encoded = JSON.stringify(payload);
    } catch {
      fail('SYNC_PAYLOAD_INVALID');
    }
    if (typeof encoded !== 'string' || encoded.length > 32_768) fail('SYNC_PAYLOAD_INVALID');
    return payload;
  }

  return Object.freeze({
    get(input) {
      return requireAdapter(input?.entityType).get(input);
    },
    apply(input) {
      validatePayload(input?.payload);
      return requireAdapter(input?.entityType).apply(input);
    },
    snapshot({ profileId }) {
      const entities = [];
      for (const [entityType, adapter] of [...registered.entries()].sort(([left], [right]) =>
        left.localeCompare(right)
      )) {
        for (const entity of adapter.snapshot({ profileId })) {
          entities.push({ entityType, ...entity });
        }
      }
      return entities;
    },
    supports(entityType) {
      return registered.has(entityType);
    },
    validatePayload,
  });
}

module.exports = {
  SYNC_ENTITY_TYPES,
  containsProviderCredential,
  createEntityRegistry,
};
