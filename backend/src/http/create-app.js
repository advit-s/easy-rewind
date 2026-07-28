'use strict';

const { randomUUID } = require('node:crypto');
const { createHttpError, errorHandler } = require('./error-handler');
const { createHealthRouter } = require('./health-routes');

function createApp({
  health,
  generateRequestId = randomUUID,
  routes = [],
  jsonLimit = '100kb',
  closeHandlers = [],
} = {}) {
  if (
    typeof health !== 'function' ||
    typeof generateRequestId !== 'function' ||
    !Array.isArray(routes) ||
    !Array.isArray(closeHandlers)
  ) {
    throw new TypeError('HTTP application dependencies are invalid');
  }
  const express = require('express');
  const app = express();

  app.disable('x-powered-by');
  app.use((request, response, next) => {
    const requestId = generateRequestId();
    if (typeof requestId !== 'string' || requestId.length < 1 || requestId.length > 256) {
      next(createHttpError('internal_error'));
      return;
    }
    Object.defineProperty(request, 'requestId', {
      configurable: false,
      enumerable: false,
      value: requestId,
      writable: false,
    });
    response.setHeader('X-Request-Id', requestId);
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use(express.json({ limit: jsonLimit, strict: true, type: 'application/json' }));
  app.use(createHealthRouter({ health }));
  for (const route of routes) {
    if (
      route === null ||
      typeof route !== 'object' ||
      typeof route.path !== 'string' ||
      typeof route.router !== 'function'
    ) {
      throw new TypeError('HTTP route dependency is invalid');
    }
    app.use(route.path, route.router);
  }
  app.use((request, _response, next) => {
    next(createHttpError('not_found', 404));
  });
  app.use(errorHandler);

  let closePromise;
  app.locals.close = () => {
    if (closePromise === undefined) {
      closePromise = (async () => {
        let firstError;
        for (const close of [...closeHandlers].reverse()) {
          try {
            await close();
          } catch (error) {
            firstError ??= error;
          }
        }
        if (firstError) throw firstError;
      })();
    }
    return closePromise;
  };
  return app;
}

module.exports = { createApp };
