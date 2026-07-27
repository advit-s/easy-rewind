'use strict';

const SECRET_STORE_ERROR_MESSAGES = Object.freeze({
  SECRET_STORE_ADAPTER_INVALID: 'The protected secret-store adapter is invalid.',
  SECRET_STORE_NAME_INVALID: 'The secret name is invalid.',
  SECRET_STORE_VALUE_INVALID: 'The secret value is invalid.',
  SECRET_STORE_OPERATION_FAILED: 'The protected secret-store operation failed.',
});

const secretNamePattern = /^[a-z0-9][a-z0-9._:/-]{0,127}$/i;

class SecretStoreError extends Error {
  constructor(code) {
    super(SECRET_STORE_ERROR_MESSAGES[code]);
    this.name = 'SecretStoreError';
    this.code = code;
  }
}

function fail(code) {
  throw new SecretStoreError(code);
}

function normalizeSecretName(value) {
  if (typeof value !== 'string') fail('SECRET_STORE_NAME_INVALID');
  const normalized = value.trim();
  const segments = normalized.split('/');
  if (
    !secretNamePattern.test(normalized) ||
    segments.some(segment => segment === '' || segment === '.' || segment === '..')
  ) {
    fail('SECRET_STORE_NAME_INVALID');
  }
  return normalized;
}

function normalizeSecretValue(value, { allowNull = false } = {}) {
  if (allowNull && (value === null || value === undefined)) return null;
  if (typeof value === 'string' && value.length > 0) return value;
  if (value instanceof Uint8Array && value.byteLength > 0) return Uint8Array.from(value);
  fail('SECRET_STORE_VALUE_INVALID');
}

function validateAdapter(adapter) {
  if (
    adapter === null ||
    typeof adapter !== 'object' ||
    typeof adapter.get !== 'function' ||
    typeof adapter.set !== 'function' ||
    typeof adapter.delete !== 'function'
  ) {
    fail('SECRET_STORE_ADAPTER_INVALID');
  }
}

function sanitizeOperationError(error) {
  if (error instanceof SecretStoreError) throw error;
  fail('SECRET_STORE_OPERATION_FAILED');
}

function createSecretStore(adapter) {
  validateAdapter(adapter);

  return Object.freeze({
    async get(name) {
      const normalizedName = normalizeSecretName(name);
      try {
        const value = await adapter.get(normalizedName);
        return normalizeSecretValue(value, { allowNull: true });
      } catch (error) {
        return sanitizeOperationError(error);
      }
    },
    async set(name, value) {
      const normalizedName = normalizeSecretName(name);
      const normalizedValue = normalizeSecretValue(value);
      try {
        await adapter.set(normalizedName, normalizedValue);
      } catch (error) {
        sanitizeOperationError(error);
      }
    },
    async delete(name) {
      const normalizedName = normalizeSecretName(name);
      try {
        await adapter.delete(normalizedName);
      } catch (error) {
        sanitizeOperationError(error);
      }
    },
  });
}

module.exports = {
  SECRET_STORE_ERROR_MESSAGES,
  SecretStoreError,
  createSecretStore,
};
