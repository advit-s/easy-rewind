'use strict';

const { createHttpError } = require('../http/error-handler');
const { rejectOwnerOverride } = require('../auth/auth-middleware');
const { getRequestContext } = require('../http/request-context');

const PROVIDER_CREDENTIAL_KEY = /^(?:api[_-]?key|provider(?:[_-]?(?:key|token|secret|credential))|access[_-]?token)$/i;

function asyncRoute(handler) {
  return function asynchronousRoute(request, response, next) {
    Promise.resolve(handler(request, response)).catch(next);
  };
}

function authenticated(middleware) {
  return function authenticatedRoute(request, response, next) {
    try {
      rejectOwnerOverride(request);
    } catch (error) {
      next(error);
      return;
    }
    if (typeof middleware !== 'function') {
      next(createHttpError('auth_required'));
      return;
    }
    middleware(request, response, error => {
      if (error) {
        next(error);
        return;
      }
      try {
        getRequestContext(request);
        next();
      } catch (contextError) {
        next(contextError);
      }
    });
  };
}

function requireService(service, method) {
  if (service === null || typeof service !== 'object' || typeof service[method] !== 'function') {
    throw createHttpError('not_implemented');
  }
  return service[method].bind(service);
}

function requireValid(validation) {
  if (validation === null || typeof validation !== 'object' || validation.valid !== true) {
    throw createHttpError('validation_failed');
  }
}

function hasProviderCredential(value) {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(hasProviderCredential);
  return Object.entries(value).some(
    ([key, nested]) => PROVIDER_CREDENTIAL_KEY.test(key) || hasProviderCredential(nested)
  );
}

function withoutProviderCredentials(value) {
  if (Array.isArray(value)) return value.map(withoutProviderCredentials);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !PROVIDER_CREDENTIAL_KEY.test(key))
      .map(([key, nested]) => [key, withoutProviderCredentials(nested)])
  );
}

module.exports = {
  asyncRoute,
  authenticated,
  getRequestContext,
  hasProviderCredential,
  requireService,
  requireValid,
  withoutProviderCredentials,
};
