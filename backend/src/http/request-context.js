'use strict';

const { fail } = require('../auth/auth-error');

const requestContextKey = Symbol('easy-rewind.request-context');

function normalizeContext(context) {
  if (
    context === null ||
    typeof context !== 'object' ||
    typeof context.authenticationType !== 'string' ||
    typeof context.profileId !== 'string' ||
    context.profileId.length === 0
  ) {
    fail('AUTH_INPUT_INVALID');
  }
  const normalized = {};
  for (const key of ['authenticationType', 'credentialId', 'deviceId', 'profileId', 'sessionId']) {
    if (context[key] !== undefined) {
      if (typeof context[key] !== 'string' || context[key].length === 0) fail('AUTH_INPUT_INVALID');
      normalized[key] = context[key];
    }
  }
  return Object.freeze(normalized);
}

function setRequestContext(request, context) {
  if (request === null || typeof request !== 'object' || Object.hasOwn(request, requestContextKey)) {
    fail('AUTH_INPUT_INVALID');
  }
  Object.defineProperty(request, requestContextKey, {
    configurable: false,
    enumerable: false,
    value: normalizeContext(context),
    writable: false,
  });
  return request[requestContextKey];
}

function getRequestContext(request) {
  if (request === null || typeof request !== 'object' || !Object.hasOwn(request, requestContextKey)) {
    fail('AUTH_BEARER_REQUIRED');
  }
  return request[requestContextKey];
}

module.exports = { getRequestContext, setRequestContext };
