'use strict';

const { fail } = require('./auth-error');
const { setRequestContext } = require('../http/request-context');

const OWNER_KEYS = Object.freeze(['ownerId', 'profileId', 'userId']);

function hasOwnerKey(value) {
  return value !== null && typeof value === 'object' && OWNER_KEYS.some(key => Object.hasOwn(value, key));
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
  rejectOwnerOverride,
};
