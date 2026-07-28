'use strict';

const { createHmac, randomBytes: defaultRandomBytes, timingSafeEqual: defaultTimingSafeEqual } = require('node:crypto');
const { fail } = require('./auth-error');

const DIGEST_KEY_REF = 'auth/digest-key/v1';
const DIGEST_PATTERN = /^v1:[a-f0-9]{64}$/;
const TOKEN_PATTERNS = Object.freeze({
  eri: /^eri_([A-Za-z0-9-]{1,128})\.([A-Za-z0-9_-]{43})$/,
  ers: /^ers_([A-Za-z0-9-]{1,128})\.([A-Za-z0-9_-]{43})$/,
  erd: /^erd_([A-Za-z0-9-]{1,128})_([A-Za-z0-9_-]{43})$/,
});

function assertDependencies({ secretStore, randomBytes, timingSafeEqual }) {
  if (
    secretStore === null ||
    typeof secretStore !== 'object' ||
    typeof secretStore.get !== 'function' ||
    typeof secretStore.set !== 'function' ||
    typeof randomBytes !== 'function' ||
    typeof timingSafeEqual !== 'function'
  ) {
    fail('AUTH_CONFIGURATION_INVALID');
  }
}

function normalizeDigestKey(value) {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    const key = Buffer.from(value);
    if (key.length === 32) return key;
  }
  if (typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value)) {
    const key = Buffer.from(value, 'base64url');
    if (key.length === 32) return key;
  }
  fail('AUTH_SECRET_STORE_FAILED');
}

async function createTokenTools({
  secretStore,
  randomBytes = defaultRandomBytes,
  timingSafeEqual = defaultTimingSafeEqual,
} = {}) {
  assertDependencies({ secretStore, randomBytes, timingSafeEqual });
  let keyValue;
  try {
    keyValue = await secretStore.get(DIGEST_KEY_REF);
    if (keyValue === null) {
      const generated = Buffer.from(randomBytes(32));
      if (generated.length !== 32) fail('AUTH_CONFIGURATION_INVALID');
      await secretStore.set(DIGEST_KEY_REF, generated);
      keyValue = generated;
    }
  } catch (error) {
    if (error?.code === 'AUTH_CONFIGURATION_INVALID') throw error;
    fail('AUTH_SECRET_STORE_FAILED');
  }
  const key = normalizeDigestKey(keyValue);

  function randomSecret() {
    const bytes = Buffer.from(randomBytes(32));
    if (bytes.length !== 32) fail('AUTH_CONFIGURATION_INVALID');
    return bytes.toString('base64url');
  }

  function digest(value) {
    if (typeof value !== 'string' || value.length === 0) fail('AUTH_INPUT_INVALID');
    return `v1:${createHmac('sha256', key).update(value, 'utf8').digest('hex')}`;
  }

  function matches(value, storedDigest) {
    if (!DIGEST_PATTERN.test(storedDigest)) return false;
    const candidate = Buffer.from(digest(value), 'utf8');
    const persisted = Buffer.from(storedDigest, 'utf8');
    return timingSafeEqual(candidate, persisted);
  }

  function credentialToken(prefix, identifier) {
    if (!Object.hasOwn(TOKEN_PATTERNS, prefix) || !/^[A-Za-z0-9-]{1,128}$/.test(identifier)) {
      fail('AUTH_INPUT_INVALID');
    }
    return `${prefix}_${identifier}${prefix === 'erd' ? '_' : '.'}${randomSecret()}`;
  }

  function parseCredentialToken(value, prefix) {
    if (typeof value !== 'string' || !Object.hasOwn(TOKEN_PATTERNS, prefix)) return null;
    const match = TOKEN_PATTERNS[prefix].exec(value);
    if (match === null) return null;
    return Object.freeze({ identifier: match[1], token: value });
  }

  return Object.freeze({
    challengeToken: () => `epc_${randomSecret()}`,
    credentialToken,
    digest,
    matches,
    parseCredentialToken,
    randomSecret,
  });
}

function readBearer(authorization, tools, prefix, missingCode = 'AUTH_BEARER_REQUIRED') {
  if (authorization === undefined || authorization === null || authorization === '') fail(missingCode);
  if (typeof authorization !== 'string') fail('AUTH_BEARER_INVALID');
  const match = /^Bearer ([^\s]+)$/.exec(authorization);
  if (match === null) fail('AUTH_BEARER_INVALID');
  const parsed = tools.parseCredentialToken(match[1], prefix);
  if (parsed === null) fail('AUTH_BEARER_INVALID');
  return parsed;
}

function assertServiceDependencies({ db, now, generateId }) {
  if (
    db === null ||
    typeof db !== 'object' ||
    typeof db.prepare !== 'function' ||
    typeof db.transaction !== 'function' ||
    typeof now !== 'function' ||
    typeof generateId !== 'function'
  ) {
    fail('AUTH_CONFIGURATION_INVALID');
  }
}

function currentTime(now) {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) fail('AUTH_CONFIGURATION_INVALID');
  return value;
}

module.exports = {
  assertServiceDependencies,
  createTokenTools,
  currentTime,
  readBearer,
};
