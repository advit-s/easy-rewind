'use strict';

const { fail } = require('./auth-error');
const { setRequestContext } = require('../http/request-context');

const OWNER_KEYS = new Set(['ownerId', 'owner_id', 'profileId', 'profile_id', 'userId', 'user_id']);

function hasOwnerKey(value, observed = new WeakSet()) {
  if (value === null || typeof value !== 'object' || observed.has(value)) return false;
  observed.add(value);
  for (const [key, nested] of Object.entries(value)) {
    if (OWNER_KEYS.has(key) || hasOwnerKey(nested, observed)) return true;
  }
  return false;
}

function rejectOwnerOverride(request) {
  const headers = request?.headers;
  if (
    hasOwnerKey(request?.body) ||
    hasOwnerKey(request?.params) ||
    hasOwnerKey(request?.query) ||
    (headers !== null &&
      typeof headers === 'object' &&
      (Object.hasOwn(headers, 'x-user-id') ||
        Object.hasOwn(headers, 'x-profile-id') ||
        Object.hasOwn(headers, 'x-owner-id')))
  ) {
    fail('AUTH_OWNER_OVERRIDE');
  }
}

function isLoopbackAddress(value) {
  if (typeof value !== 'string') return false;
  const normalized = value.toLowerCase().split('%', 1)[0];
  return normalized === '127.0.0.1' || normalized === '::1' || normalized === '::ffff:127.0.0.1';
}

function readCookie(header, name) {
  if (typeof header !== 'string') return undefined;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 1 || part.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function createInstallAuthMiddleware({ installTokenService } = {}) {
  if (
    installTokenService === null ||
    typeof installTokenService !== 'object' ||
    typeof installTokenService.authenticate !== 'function'
  ) {
    fail('AUTH_CONFIGURATION_INVALID');
  }
  return function installAuthMiddleware(request, _response, next) {
    Promise.resolve()
      .then(async () => {
        rejectOwnerOverride(request);
        const context = await installTokenService.authenticate({
          authorization: request?.headers?.authorization,
          transport: isLoopbackAddress(request?.socket?.remoteAddress) ? 'loopback' : 'external',
        });
        setRequestContext(request, context);
      })
      .then(() => next(), next);
  };
}

function createBrowserAuthMiddleware({ browserSessionService } = {}) {
  if (
    browserSessionService === null ||
    typeof browserSessionService !== 'object' ||
    typeof browserSessionService.authenticate !== 'function'
  ) {
    fail('AUTH_CONFIGURATION_INVALID');
  }
  return function browserAuthMiddleware(request, _response, next) {
    Promise.resolve()
      .then(async () => {
        rejectOwnerOverride(request);
        request.cookies ??= Object.freeze({
          easy_rewind_session: readCookie(request?.headers?.cookie, 'easy_rewind_session'),
        });
        const context = await browserSessionService.authenticate({
          csrfToken: request?.headers?.['x-csrf-token'],
          method: request?.method,
          origin: request?.headers?.origin,
          sessionToken: request?.cookies?.easy_rewind_session,
        });
        setRequestContext(request, context);
      })
      .then(() => next(), next);
  };
}

function createLocalAuthMiddleware({ installTokenService, browserSessionService } = {}) {
  const install =
    typeof installTokenService?.authenticate !== 'function'
      ? undefined
      : createInstallAuthMiddleware({ installTokenService });
  const browser =
    typeof browserSessionService?.authenticate !== 'function'
      ? undefined
      : createBrowserAuthMiddleware({ browserSessionService });
  if (install === undefined && browser === undefined) fail('AUTH_CONFIGURATION_INVALID');
  return function localAuthMiddleware(request, response, next) {
    if (typeof request?.headers?.authorization === 'string' && install !== undefined) {
      install(request, response, next);
      return;
    }
    if (browser !== undefined) {
      browser(request, response, next);
      return;
    }
    next(Object.assign(new Error('Authentication is required.'), { code: 'AUTH_BEARER_REQUIRED' }));
  };
}

function createDeviceAuthMiddleware({ pairingService } = {}) {
  if (
    pairingService === null ||
    typeof pairingService !== 'object' ||
    typeof pairingService.authenticateDevice !== 'function'
  ) {
    fail('AUTH_CONFIGURATION_INVALID');
  }
  return function deviceAuthMiddleware(request, _response, next) {
    Promise.resolve()
      .then(async () => {
        rejectOwnerOverride(request);
        const context = await pairingService.authenticateDevice({
          authorization: request?.headers?.authorization,
        });
        setRequestContext(request, context);
      })
      .then(() => next(), next);
  };
}

module.exports = {
  createBrowserAuthMiddleware,
  createDeviceAuthMiddleware,
  createInstallAuthMiddleware,
  createLocalAuthMiddleware,
  rejectOwnerOverride,
};
