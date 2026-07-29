'use strict';

const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { createDeviceAuthMiddleware, createLocalAuthMiddleware } = require('../auth/auth-middleware');
const { createDashboardRouter } = require('./dashboard-routes');
const { createHttpError, errorHandler } = require('./error-handler');
const { createHealthRouter } = require('./health-routes');
const { createCompatibilityRouter } = require('../routes/compatibility-routes');
const { createContentRouter } = require('../routes/content-routes');
const { createContractRouter } = require('../routes/contract-routes');
const { createImportExportRouter } = require('../routes/import-export-routes');
const { createLearningRouter } = require('../routes/learning-routes');
const { createReminderRouter } = require('../routes/reminder-routes');
const { createResearchRouter } = require('../routes/research-routes');
const { createSyncRouter } = require('../routes/sync-routes');

function mountStage3Routes(app, dependencies) {
  const localAuthMiddleware =
    dependencies.localAuthMiddleware ??
    (typeof dependencies.installTokenService?.authenticate === 'function' ||
    typeof dependencies.browserSessionService?.authenticate === 'function'
      ? createLocalAuthMiddleware(dependencies)
      : undefined);
  const deviceAuthMiddleware =
    dependencies.deviceAuthMiddleware ??
    (typeof dependencies.pairingService?.authenticateDevice === 'function'
      ? createDeviceAuthMiddleware(dependencies)
      : undefined);
  if (dependencies.contentService !== undefined || dependencies.graphService !== undefined) {
    app.use(createContentRouter({ ...dependencies, localAuthMiddleware }));
  }
  if (dependencies.learningService !== undefined) {
    app.use(
      createLearningRouter({
        learningService: dependencies.learningService,
        authMiddleware: localAuthMiddleware,
      })
    );
  }
  if (dependencies.reminderService !== undefined) {
    app.use(
      createReminderRouter({
        reminderService: dependencies.reminderService,
        authMiddleware: localAuthMiddleware,
      })
    );
  }
  if (dependencies.researchService !== undefined) {
    app.use(
      createResearchRouter({
        researchService: dependencies.researchService,
        authMiddleware: localAuthMiddleware,
      })
    );
  }
  if (dependencies.exportService !== undefined || dependencies.importService !== undefined) {
    app.use(
      createImportExportRouter({
        exportService: dependencies.exportService,
        importService: dependencies.importService,
        authMiddleware: localAuthMiddleware,
      })
    );
  }
  if (dependencies.syncService !== undefined) {
    app.use(
      createSyncRouter({
        syncService: dependencies.syncService,
        authMiddleware: deviceAuthMiddleware,
      })
    );
  }
}

function isLoopbackOrigin(value) {
  if (typeof value !== 'string' || value.length > 256) return false;
  let origin;
  try {
    origin = new URL(value);
  } catch {
    return false;
  }
  return (
    ['http:', 'https:'].includes(origin.protocol) &&
    ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname.toLowerCase()) &&
    origin.username === '' &&
    origin.password === '' &&
    origin.pathname === '/' &&
    origin.search === '' &&
    origin.hash === '' &&
    origin.origin === value
  );
}

function hasRequestBody(request) {
  if (request.headers['transfer-encoding'] !== undefined) return true;
  const contentLength = request.headers['content-length'];
  return typeof contentLength === 'string' && /^\d+$/.test(contentLength) && Number(contentLength) > 0;
}

function createApp({
  health,
  generateRequestId = randomUUID,
  routes = [],
  jsonLimit = '100kb',
  closeHandlers = [],
  routeDependencies = {},
  dashboardDirectory,
} = {}) {
  if (
    dashboardDirectory !== undefined &&
    (typeof dashboardDirectory !== 'string' ||
      dashboardDirectory.length < 1 ||
      dashboardDirectory.length > 32_768 ||
      dashboardDirectory.includes('\0') ||
      !path.isAbsolute(dashboardDirectory))
  ) {
    throw new TypeError('Dashboard directory is invalid');
  }
  if (
    typeof health !== 'function' ||
    typeof generateRequestId !== 'function' ||
    !Array.isArray(routes) ||
    !Array.isArray(closeHandlers) ||
    routeDependencies === null ||
    typeof routeDependencies !== 'object'
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
    const origin = request.headers.origin;
    if (origin !== undefined) {
      if (!isLoopbackOrigin(origin)) {
        next(createHttpError('forbidden'));
        return;
      }
      response.setHeader('Access-Control-Allow-Origin', origin);
      response.setHeader('Access-Control-Allow-Credentials', 'true');
      response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-CSRF-Token');
      response.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, PATCH, PUT, DELETE, OPTIONS');
      response.setHeader('Vary', 'Origin');
    }
    if (request.method === 'OPTIONS') {
      response.status(204).end();
      return;
    }
    if (
      ['POST', 'PATCH', 'PUT'].includes(request.method) &&
      hasRequestBody(request) &&
      !request.is('application/json')
    ) {
      next(createHttpError('validation_failed', 415));
      return;
    }
    next();
  });
  app.use(express.json({ limit: jsonLimit, strict: true, type: 'application/json' }));
  if (dashboardDirectory !== undefined) {
    app.use(createDashboardRouter({ dashboardDirectory }));
  }
  app.use(createHealthRouter({ health }));
  app.use(createContractRouter(routeDependencies));
  mountStage3Routes(app, routeDependencies);
  app.use('/api', createCompatibilityRouter({ health, ...routeDependencies }));
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
    next(
      /^\/v[2-9][0-9]*(?:\/|$)/.test(request.path)
        ? createHttpError('api_version_unsupported')
        : createHttpError('not_found', 404)
    );
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
