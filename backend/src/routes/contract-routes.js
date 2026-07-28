'use strict';

const { createHttpError } = require('../http/error-handler');
const {
  createDeviceAuthMiddleware,
  createInstallAuthMiddleware,
  createLocalAuthMiddleware,
} = require('../auth/auth-middleware');
const {
  asyncRoute,
  authenticated,
  getRequestContext,
  hasProviderCredential,
  requireService,
  requireValid,
} = require('./route-utils');

let contractsPromise;

function loadContracts() {
  contractsPromise ??= Promise.all([
    import('../../../packages/contracts/src/pairing.js'),
    import('../../../packages/contracts/src/sync.js'),
  ]).then(([pairing, sync]) => ({ pairing, sync }));
  return contractsPromise;
}

function sessionHandler(browserSessionService) {
  return asyncRoute(async (request, response) => {
    const exchange = requireService(browserSessionService, 'exchange');
    const issued = await exchange({
      installContext: getRequestContext(request),
      origin: request.headers.origin,
    });
    if (
      issued === null ||
      typeof issued !== 'object' ||
      issued.cookie === null ||
      typeof issued.cookie !== 'object' ||
      typeof issued.cookie.name !== 'string' ||
      typeof issued.cookie.value !== 'string' ||
      issued.cookie.options === null ||
      typeof issued.cookie.options !== 'object' ||
      typeof issued.csrfToken !== 'string'
    ) {
      throw createHttpError('internal_error');
    }
    response.cookie(issued.cookie.name, issued.cookie.value, issued.cookie.options);
    response.setHeader('X-CSRF-Token', issued.csrfToken);
    response.status(204).end();
  });
}

function createContractRouter(dependencies = {}) {
  if (dependencies === null || typeof dependencies !== 'object') {
    throw new TypeError('Contract route dependencies are invalid');
  }
  const express = require('express');
  const router = express.Router();
  const canInstallAuthenticate = typeof dependencies.installTokenService?.authenticate === 'function';
  const canBrowserAuthenticate = typeof dependencies.browserSessionService?.authenticate === 'function';
  const installAuth =
    typeof dependencies.installAuthMiddleware === 'function'
      ? dependencies.installAuthMiddleware
      : canInstallAuthenticate
        ? createInstallAuthMiddleware(dependencies)
        : undefined;
  const localAuth =
    typeof dependencies.localAuthMiddleware === 'function'
      ? dependencies.localAuthMiddleware
      : typeof dependencies.browserAuthMiddleware === 'function'
        ? dependencies.browserAuthMiddleware
        : canInstallAuthenticate || canBrowserAuthenticate
          ? createLocalAuthMiddleware(dependencies)
          : undefined;
  const deviceAuth =
    typeof dependencies.deviceAuthMiddleware === 'function'
      ? dependencies.deviceAuthMiddleware
      : typeof dependencies.pairingService?.authenticateDevice === 'function'
        ? createDeviceAuthMiddleware(dependencies)
        : undefined;
  const exchangeSession = sessionHandler(dependencies.browserSessionService);

  router.post('/v1/session', authenticated(installAuth), exchangeSession);
  router.post('/api/session', authenticated(installAuth), exchangeSession);

  router.post(
    '/v1/pairing/challenges',
    authenticated(localAuth),
    asyncRoute(async (request, response) => {
      const { pairing } = await loadContracts();
      requireValid(pairing.validatePairingChallengeRequest(request.body));
      const createChallenge = requireService(dependencies.pairingService, 'createChallenge');
      const result = await createChallenge({
        ...request.body,
        ...dependencies.pairingConfiguration,
        profileId: getRequestContext(request).profileId,
      });
      requireValid(pairing.validatePairingChallengeResponse(result));
      response.status(201).json(result);
    })
  );

  router.post(
    '/v1/pairing/confirmations',
    authenticated(localAuth),
    asyncRoute(async (request, response) => {
      const { pairing } = await loadContracts();
      requireValid(pairing.validatePairingConfirmationRequest(request.body));
      const confirm = requireService(dependencies.pairingService, 'confirm');
      await confirm({
        challengeId: request.body.challengeId,
        profileContext: getRequestContext(request),
      });
      response.status(204).end();
    })
  );

  router.post(
    '/v1/pairing/credentials',
    authenticated(localAuth),
    asyncRoute(async (request, response) => {
      const { pairing } = await loadContracts();
      requireValid(pairing.validatePairingCredentialIssueRequest(request.body));
      const issueCredential = requireService(dependencies.pairingService, 'issueCredential');
      const result = await issueCredential({
        challengeId: request.body.challengeId,
        profileContext: getRequestContext(request),
      });
      requireValid(pairing.validatePairingCredentialResponse(result));
      response.status(201).json(result);
    })
  );

  router.post(
    '/v1/pairing/revocations',
    authenticated(localAuth),
    asyncRoute(async (request, response) => {
      const { pairing } = await loadContracts();
      requireValid(pairing.validatePairingRevokeRequest(request.body));
      const revoke = requireService(dependencies.pairingService, 'revoke');
      const revoked = await revoke({
        deviceId: request.body.deviceId,
        profileContext: getRequestContext(request),
        reason: request.body.reason,
      });
      const result = { ...revoked, status: 'revoked' };
      requireValid(pairing.validatePairingRevokeResponse(result));
      response.status(200).json(result);
    })
  );

  for (const [path, method, validatorName] of [
    ['/v1/sync/push', 'push', 'validateSyncPushRequest'],
    ['/v1/sync/pull', 'pull', 'validateSyncPullRequest'],
  ]) {
    router.post(
      path,
      authenticated(deviceAuth),
      asyncRoute(async (request, response) => {
        const { sync } = await loadContracts();
        requireValid(sync[validatorName](request.body));
        if (hasProviderCredential(request.body)) throw createHttpError('validation_failed');
        const context = getRequestContext(request);
        if (context.deviceId !== request.body.deviceId) throw createHttpError('forbidden');
        const execute = requireService(dependencies.syncService, method);
        const result = await execute({
          context,
          request: request.body,
        });
        const responseValidator = method === 'push' ? sync.validateSyncPushResponse : sync.validateSyncPullResponse;
        requireValid(responseValidator(result));
        response.status(200).json(result);
      })
    );
  }

  return router;
}

module.exports = { createContractRouter };
