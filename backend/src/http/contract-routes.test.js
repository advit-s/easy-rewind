'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const supertest = require('supertest');

const { setRequestContext } = require('./request-context');
const { createApp } = require('./create-app');

const PROFILE_ID = '10000000-0000-4000-8000-000000000001';
const DEVICE_ID = '20000000-0000-4000-8000-000000000001';
const HEALTH = Object.freeze({
  status: 'ok',
  version: '2.0.0',
  schemaVersion: 3,
  apiVersion: '1',
  mode: 'test',
  components: {
    database: { status: 'ready' },
    applicationApi: { status: 'ready' },
    scheduler: { status: 'disabled' },
    lanSync: { status: 'disabled' },
  },
});

function establish(context) {
  return (request, _response, next) => {
    setRequestContext(request, context);
    next();
  };
}

const installContext = Object.freeze({
  authenticationType: 'install',
  credentialId: 'credential_abcdefghijkl',
  profileId: PROFILE_ID,
});
const localContext = Object.freeze({
  authenticationType: 'browser_session',
  credentialId: 'credential_abcdefghijkl',
  profileId: PROFILE_ID,
  sessionId: 'session_abcdefghijklmnop',
});
const deviceContext = Object.freeze({
  authenticationType: 'device',
  credentialId: 'credential_abcdefghijkl',
  deviceId: DEVICE_ID,
  profileId: PROFILE_ID,
});

function appWith(routeDependencies = {}, options = {}) {
  return createApp({
    health: async () => HEALTH,
    generateRequestId: () => 'request_contract_routes_0001',
    routeDependencies: {
      installAuthMiddleware: establish(installContext),
      localAuthMiddleware: establish(localContext),
      deviceAuthMiddleware: establish(deviceContext),
      ...routeDependencies,
    },
    ...options,
  });
}

test('health and common errors conform to frozen contracts and expose safe headers', async () => {
  const { validateErrorResponse } = await import('../../../packages/contracts/src/errors.js');
  const { validateHealthResponse } = await import('../../../packages/contracts/src/health.js');
  const app = appWith();

  const health = await supertest(app).get('/v1/health').expect(200);
  assert.equal(validateHealthResponse(health.body).valid, true);
  assert.equal(health.headers['cache-control'], 'no-store');
  assert.equal(health.headers['x-content-type-options'], 'nosniff');
  assert.equal(health.headers['x-frame-options'], 'DENY');
  assert.equal(health.headers['referrer-policy'], 'no-referrer');
  assert.equal(health.headers['x-request-id'], 'request_contract_routes_0001');

  const missing = await supertest(app).get('/v1/missing').expect(404);
  assert.equal(validateErrorResponse(missing.body).valid, true);
  assert.equal(missing.body.error.code, 'not_found');
  assert.deepEqual(missing.body.error.details, {});

  const unsafeRequestId = await supertest(
    createApp({
      health: async () => HEALTH,
      generateRequestId: () => 'unsafe/request-id',
    })
  )
    .get('/v1/missing')
    .expect(404);
  assert.equal(validateErrorResponse(unsafeRequestId.body).valid, true);
  assert.equal(unsafeRequestId.body.error.requestId, 'request-unavailable');
});

test('unsupported API versions return the stable contract error', async () => {
  const { validateErrorResponse } = await import('../../../packages/contracts/src/errors.js');
  const response = await supertest(appWith()).get('/v2/health').expect(400);

  assert.equal(response.body.error.code, 'api_version_unsupported');
  assert.equal(validateErrorResponse(response.body).valid, true);
});

test('the application accepts only exact loopback browser origins', async () => {
  await supertest(appWith()).get('/v1/health').set('Origin', 'http://127.0.0.1:3210').expect(200);
  await supertest(appWith()).get('/v1/health').set('Origin', 'http://localhost:3210').expect(200);

  const rejected = await supertest(appWith()).get('/v1/health').set('Origin', 'https://attacker.example').expect(403);
  assert.equal(rejected.body.error.code, 'forbidden');
  assert.equal(rejected.headers['access-control-allow-origin'], undefined);
});

test('JSON mutations enforce content type and bounded request bodies with safe errors', async () => {
  const { validateErrorResponse } = await import('../../../packages/contracts/src/errors.js');
  const app = appWith({}, { jsonLimit: 64 });

  const media = await supertest(app)
    .post('/v1/sync/push')
    .set('Content-Type', 'text/plain')
    .send('not-json')
    .expect(415);
  assert.equal(media.body.error.code, 'validation_failed');
  assert.equal(validateErrorResponse(media.body).valid, true);

  const large = await supertest(app)
    .post('/v1/sync/push')
    .send({ value: 'x'.repeat(128) })
    .expect(413);
  assert.equal(large.body.error.code, 'validation_failed');
  assert.equal(validateErrorResponse(large.body).valid, true);
});

test('session exchange uses install ownership and returns only protected cookie metadata', async () => {
  let invocation;
  const response = await supertest(
    appWith({
      browserSessionService: {
        async exchange(input) {
          invocation = input;
          return {
            csrfToken: 'csrf_abcdefghijklmnopqrstuvwxyz',
            expiresAt: 1_700_000_060_000,
            sessionId: 'session_abcdefghijklmnop',
            sessionToken: 'ers_session_abcdefghijklmnopqrstuvwxyz',
            cookie: {
              name: 'easy_rewind_session',
              value: 'ers_session_abcdefghijklmnopqrstuvwxyz',
              options: {
                httpOnly: true,
                sameSite: 'strict',
                secure: false,
                path: '/',
                maxAge: 60_000,
              },
            },
          };
        },
      },
    })
  )
    .post('/v1/session')
    .set('Origin', 'http://127.0.0.1:3210')
    .expect(204);

  assert.deepEqual(invocation, {
    installContext,
    origin: 'http://127.0.0.1:3210',
  });
  assert.match(response.headers['set-cookie'][0], /^easy_rewind_session=/);
  assert.match(response.headers['set-cookie'][0], /HttpOnly/);
  assert.equal(response.headers['x-csrf-token'], 'csrf_abcdefghijklmnopqrstuvwxyz');
  assert.equal(response.text, '');
  assert.equal(JSON.stringify(response.headers).includes('ers_session_abcdefghijklmnopqrstuvwxyz'), true);
});

test('session exchange composition does not require browser authentication capability', () => {
  assert.doesNotThrow(() =>
    createApp({
      health: async () => HEALTH,
      routeDependencies: {
        installAuthMiddleware: establish(installContext),
        browserSessionService: {
          async exchange() {
            throw new Error('not called');
          },
        },
      },
    })
  );
});

test('partial pairing services do not require device-auth capability during route composition', () => {
  assert.doesNotThrow(() =>
    createApp({
      health: async () => HEALTH,
      routeDependencies: {
        localAuthMiddleware: establish(localContext),
        pairingService: {
          async createChallenge() {
            throw new Error('not called');
          },
        },
      },
    })
  );
});

test('pairing routes validate frozen requests and pass authenticated ownership to services', async () => {
  const challenge = {
    challengeId: 'challenge_abcdefghijklmnop',
    expiresAt: 1_700_000_120_000,
    status: 'pending_confirmation',
    oneUse: true,
    qrPayload: {
      protocolVersion: '1',
      syncEndpoint: 'https://192.168.1.20:9443/v1/sync',
      tlsFingerprint: `sha256:${'a'.repeat(64)}`,
      installationId: 'installation_abcdef',
      challengeId: 'challenge_abcdefghijklmnop',
      expiresAt: 1_700_000_120_000,
    },
  };
  let createInput;
  let confirmInput;
  const app = appWith({
    pairingConfiguration: {
      syncEndpoint: 'https://192.168.1.20:9443/v1/sync',
      tlsFingerprint: `sha256:${'a'.repeat(64)}`,
      installationId: 'installation_abcdef',
    },
    pairingService: {
      async createChallenge(input) {
        createInput = input;
        return challenge;
      },
      async confirm(input) {
        confirmInput = input;
      },
      async issueCredential() {
        throw new Error('not used');
      },
      async revoke() {
        throw new Error('not used');
      },
    },
  });
  const { validatePairingChallengeResponse } = await import('../../../packages/contracts/src/pairing.js');

  const invalid = await supertest(app)
    .post('/v1/pairing/challenges')
    .send({ deviceName: '', platform: 'android' })
    .expect(400);
  assert.equal(invalid.body.error.code, 'validation_failed');

  const created = await supertest(app)
    .post('/v1/pairing/challenges')
    .send({ deviceName: 'Pixel', platform: 'android' })
    .expect(201);
  assert.equal(validatePairingChallengeResponse(created.body).valid, true);
  assert.equal(createInput.profileId, PROFILE_ID);
  assert.equal(createInput.deviceName, 'Pixel');

  await supertest(app)
    .post('/v1/pairing/confirmations')
    .send({ challengeId: challenge.challengeId, confirmed: true })
    .expect(204);
  assert.deepEqual(confirmInput, {
    challengeId: challenge.challengeId,
    profileContext: localContext,
  });
});

test('sync routes authenticate devices, validate requests, and stay explicitly unimplemented in Stage 2', async () => {
  const response = await supertest(appWith())
    .post('/v1/sync/pull')
    .send({ deviceId: DEVICE_ID, limit: 25 })
    .expect(501);

  assert.equal(response.body.error.code, 'not_implemented');
});

test('sync routes reject a body device that differs from authenticated device ownership', async () => {
  let called = false;
  const otherDeviceId = '20000000-0000-4000-8000-000000000002';
  const response = await supertest(
    appWith({
      syncService: {
        async pull() {
          called = true;
          return { changes: [], nextCursor: null, hasMore: false, serverTime: 1_700_000_000_000 };
        },
      },
    })
  )
    .post('/v1/sync/pull')
    .send({ deviceId: otherDeviceId })
    .expect(403);

  assert.equal(response.body.error.code, 'forbidden');
  assert.equal(called, false);
});

test('sync push rejects provider credentials inside otherwise contract-valid settings payloads', async () => {
  let called = false;
  const operationId = '30000000-0000-4000-8000-000000000001';
  const entityId = '40000000-0000-4000-8000-000000000001';
  const response = await supertest(
    appWith({
      syncService: {
        async push() {
          called = true;
          return {
            results: [{ operationId, status: 'accepted', revision: 1 }],
            serverTime: 1_700_000_000_000,
          };
        },
      },
    })
  )
    .post('/v1/sync/push')
    .send({
      deviceId: DEVICE_ID,
      operations: [
        {
          operationId,
          deviceId: DEVICE_ID,
          entityType: 'setting',
          entityId,
          kind: 'upsert',
          baseRevision: 0,
          deviceSequence: 1,
          schemaVersion: 3,
          protocolVersion: '1',
          payload: { api_key: 'provider-secret' },
          occurredAt: 1_700_000_000_000,
        },
      ],
    })
    .expect(400);

  assert.equal(response.body.error.code, 'validation_failed');
  assert.equal(called, false);
});

test('missing authentication and owner override failures use stable safe contract errors', async () => {
  const { validateErrorResponse } = await import('../../../packages/contracts/src/errors.js');
  const unauthenticated = appWith({
    localAuthMiddleware(_request, _response, next) {
      next();
    },
  });

  const missing = await supertest(unauthenticated).get('/api/items').expect(401);
  assert.equal(missing.body.error.code, 'auth_required');
  assert.equal(validateErrorResponse(missing.body).valid, true);

  const override = await supertest(appWith())
    .post('/v1/sync/pull')
    .set('x-user-id', 'system')
    .send({ deviceId: DEVICE_ID })
    .expect(403);
  assert.equal(override.body.error.code, 'forbidden');
  assert.equal(JSON.stringify(override.body).includes('system'), false);
});
