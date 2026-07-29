'use strict';

const assert = require('node:assert/strict');
const { mkdirSync, mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const test = require('node:test');

const PROFILE_ID = '10000000-0000-4000-8000-000000000001';
const OTHER_PROFILE_ID = '10000000-0000-4000-8000-000000000002';
const INSTALLATION_ID = 'installation-test';
const TLS_FINGERPRINT = `sha256:${'a'.repeat(64)}`;

function createMemorySecretStore() {
  const values = new Map();
  return {
    values,
    store: Object.freeze({
      async get(name) {
        return values.get(name) ?? null;
      },
      async set(name, value) {
        values.set(name, Buffer.isBuffer(value) ? Buffer.from(value) : value);
      },
      async delete(name) {
        values.delete(name);
      },
    }),
  };
}

async function createFixture() {
  const root = mkdtempSync(join(tmpdir(), 'easy-rewind-auth-'));
  const directory = join(root, 'database');
  mkdirSync(directory);
  const { openDatabase } = require('../database/open-database');
  const { discoverMigrations, runMigrations } = require('../database/migration-runner');
  const db = await openDatabase({
    path: join(directory, 'auth.sqlite3'),
    filePermissions: {
      async restrictDirectory() {},
      async restrictFile() {},
    },
  });
  runMigrations({ db, migrations: discoverMigrations(), now: () => 1_700_000_000_000 });
  const insertProfile = db.prepare(
    `INSERT INTO profiles(
       id, display_name, timezone, locale, created_at, updated_at, revision
     ) VALUES (?, ?, 'UTC', 'en', ?, ?, 1)`
  );
  insertProfile.run(PROFILE_ID, 'Primary', 1_700_000_000_000, 1_700_000_000_000);
  insertProfile.run(OTHER_PROFILE_ID, 'Other', 1_700_000_000_000, 1_700_000_000_000);

  let now = 1_700_000_000_000;
  let nextId = 0;
  const secrets = createMemorySecretStore();
  return {
    db,
    root,
    secrets,
    now: () => now,
    advance(milliseconds) {
      now += milliseconds;
    },
    generateId() {
      nextId += 1;
      return `10000000-0000-4000-8000-${String(nextId).padStart(12, '0')}`;
    },
    cleanup() {
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function createInstallService(fixture, overrides = {}) {
  const { createInstallTokenService } = require('./install-token-service');
  return createInstallTokenService({
    db: fixture.db,
    secretStore: fixture.secrets.store,
    now: fixture.now,
    generateId: fixture.generateId,
    ...overrides,
  });
}

test('install bearer uses a 256-bit secret, persists only a keyed digest, and is loopback-only', async t => {
  const fixture = await createFixture();
  t.after(() => fixture.cleanup());
  const service = await createInstallService(fixture);

  const provisioned = await service.provision({ profileId: PROFILE_ID, label: 'Desktop application' });
  assert.match(provisioned.token, /^eri_[A-Za-z0-9-]+\.[A-Za-z0-9_-]{43}$/);
  assert.equal(provisioned.tokenType, 'Bearer');

  const row = fixture.db
    .prepare('SELECT secret_ref, secret_digest, state FROM client_credentials WHERE id = ?')
    .get(provisioned.credentialId);
  assert.equal(row.state, 'active');
  assert.match(row.secret_digest, /^v1:[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(row), new RegExp(provisioned.token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(await fixture.secrets.store.get(row.secret_ref), provisioned.token);

  await assert.rejects(
    service.authenticate({ authorization: undefined, transport: 'loopback' }),
    error => error.code === 'AUTH_BEARER_REQUIRED'
  );
  await assert.rejects(
    service.authenticate({ authorization: 'Bearer invalid', transport: 'loopback' }),
    error => error.code === 'AUTH_BEARER_INVALID'
  );
  await assert.rejects(
    service.authenticate({ authorization: `Bearer ${provisioned.token}`, transport: 'lan' }),
    error => error.code === 'AUTH_TRANSPORT_FORBIDDEN'
  );

  const context = await service.authenticate({
    authorization: `Bearer ${provisioned.token}`,
    transport: 'loopback',
  });
  assert.deepEqual(context, {
    authenticationType: 'install',
    credentialId: provisioned.credentialId,
    profileId: PROFILE_ID,
  });
  assert.equal(Object.isFrozen(context), true);
});

test('rotating an install credential invalidates the old token and replaces the protected secret', async t => {
  const fixture = await createFixture();
  t.after(() => fixture.cleanup());
  const service = await createInstallService(fixture);
  const first = await service.provision({ profileId: PROFILE_ID });

  const rotated = await service.rotate({ credentialId: first.credentialId, profileId: PROFILE_ID });
  assert.notEqual(rotated.token, first.token);
  await assert.rejects(
    service.authenticate({ authorization: `Bearer ${first.token}`, transport: 'loopback' }),
    error => error.code === 'AUTH_BEARER_INVALID'
  );
  assert.equal(
    (
      await service.authenticate({
        authorization: `Bearer ${rotated.token}`,
        transport: 'loopback',
      })
    ).profileId,
    PROFILE_ID
  );
  const secretRef = fixture.db
    .prepare('SELECT secret_ref FROM client_credentials WHERE id = ?')
    .pluck()
    .get(first.credentialId);
  assert.equal(await fixture.secrets.store.get(secretRef), rotated.token);

  await assert.rejects(
    service.rotate({ credentialId: first.credentialId, profileId: OTHER_PROFILE_ID }),
    error => error.code === 'AUTH_OWNER_MISMATCH'
  );
});

test('install authorization is retrieved explicitly from the protected store without reprovisioning', async t => {
  const fixture = await createFixture();
  t.after(() => fixture.cleanup());
  const service = await createInstallService(fixture);
  const provisioned = await service.provision({ profileId: PROFILE_ID });

  assert.equal(
    await service.getAuthorization({
      credentialId: provisioned.credentialId,
      profileId: PROFILE_ID,
    }),
    `Bearer ${provisioned.token}`
  );
  assert.equal(fixture.db.prepare('SELECT COUNT(*) FROM client_credentials').pluck().get(), 1);

  const secretRef = fixture.db
    .prepare('SELECT secret_ref FROM client_credentials WHERE id = ?')
    .pluck()
    .get(provisioned.credentialId);
  await fixture.secrets.store.delete(secretRef);
  await assert.rejects(
    service.getAuthorization({
      credentialId: provisioned.credentialId,
      profileId: PROFILE_ID,
    }),
    error => error.code === 'AUTH_SECRET_STORE_FAILED' && !error.message.includes(provisioned.token)
  );
});

test('browser sessions are short-lived, loopback-bound, HttpOnly, SameSite Strict, and CSRF protected', async t => {
  const fixture = await createFixture();
  t.after(() => fixture.cleanup());
  const installService = await createInstallService(fixture);
  const install = await installService.provision({ profileId: PROFILE_ID });
  const installContext = await installService.authenticate({
    authorization: `Bearer ${install.token}`,
    transport: 'loopback',
  });
  const { createBrowserSessionService } = require('./browser-session-service');
  const sessions = await createBrowserSessionService({
    db: fixture.db,
    secretStore: fixture.secrets.store,
    now: fixture.now,
    generateId: fixture.generateId,
    ttlMs: 60_000,
  });

  const issued = await sessions.exchange({
    installContext,
    origin: 'http://127.0.0.1:3210',
  });
  assert.match(issued.sessionToken, /^ers_[A-Za-z0-9-]+\.[A-Za-z0-9_-]{43}$/);
  assert.match(issued.csrfToken, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(issued.cookie.options, {
    httpOnly: true,
    sameSite: 'strict',
    secure: false,
    path: '/',
    maxAge: 60_000,
  });
  assert.equal(
    fixture.db
      .prepare('SELECT token_hash = ?, csrf_hash = ? FROM browser_sessions WHERE id = ?')
      .pluck()
      .get(issued.sessionToken, issued.csrfToken, issued.sessionId),
    0
  );

  const safeContext = await sessions.authenticate({
    sessionToken: issued.sessionToken,
    csrfToken: undefined,
    method: 'GET',
    origin: 'http://127.0.0.1:3210',
  });
  assert.equal(safeContext.profileId, PROFILE_ID);
  await assert.rejects(
    sessions.authenticate({
      sessionToken: issued.sessionToken,
      method: 'POST',
      origin: 'http://127.0.0.1:3210',
    }),
    error => error.code === 'AUTH_CSRF_INVALID'
  );
  assert.equal(
    (
      await sessions.authenticate({
        sessionToken: issued.sessionToken,
        csrfToken: issued.csrfToken,
        method: 'POST',
        origin: 'http://127.0.0.1:3210',
      })
    ).authenticationType,
    'browser_session'
  );
  await assert.rejects(
    sessions.authenticate({
      sessionToken: issued.sessionToken,
      method: 'GET',
      origin: 'http://localhost:3210',
    }),
    error => error.code === 'AUTH_ORIGIN_FORBIDDEN'
  );

  fixture.advance(60_001);
  await assert.rejects(
    sessions.authenticate({
      sessionToken: issued.sessionToken,
      method: 'GET',
      origin: 'http://127.0.0.1:3210',
    }),
    error => error.code === 'AUTH_SESSION_EXPIRED'
  );
  assert.equal(
    fixture.db.prepare('SELECT state FROM browser_sessions WHERE id = ?').pluck().get(issued.sessionId),
    'expired'
  );
});

test('pairing requires owner confirmation, consumes a challenge once, and rejects revoked devices', async t => {
  const fixture = await createFixture();
  t.after(() => fixture.cleanup());
  const { createPairingService } = require('./pairing-service');
  const pairing = await createPairingService({
    db: fixture.db,
    secretStore: fixture.secrets.store,
    now: fixture.now,
    generateId: fixture.generateId,
    challengeTtlMs: 120_000,
  });
  const challenge = await pairing.createChallenge({
    profileId: PROFILE_ID,
    deviceName: 'Pixel test',
    platform: 'android',
    syncEndpoint: 'https://192.168.1.20:9443/v1/sync',
    tlsFingerprint: TLS_FINGERPRINT,
    installationId: INSTALLATION_ID,
  });
  assert.equal(challenge.status, 'pending_confirmation');
  assert.equal(challenge.oneUse, true);
  assert.equal(challenge.qrPayload.challengeId, challenge.challengeId);
  const { validatePairingChallengeResponse, validatePairingCredentialResponse } =
    await import('../../../packages/contracts/src/pairing.js');
  assert.equal(validatePairingChallengeResponse(challenge).valid, true);

  await assert.rejects(
    pairing.issueCredential({ challengeId: challenge.challengeId }),
    error => error.code === 'PAIRING_CONFIRMATION_REQUIRED'
  );
  await assert.rejects(
    pairing.confirm({
      challengeId: challenge.challengeId,
      profileContext: { profileId: OTHER_PROFILE_ID },
    }),
    error => error.code === 'AUTH_OWNER_MISMATCH'
  );
  await pairing.confirm({
    challengeId: challenge.challengeId,
    profileContext: { profileId: PROFILE_ID },
  });

  const issued = await pairing.issueCredential({ challengeId: challenge.challengeId });
  assert.match(issued.credential.token, /^erd_[A-Za-z0-9-]+_[A-Za-z0-9_-]{43}$/);
  assert.equal(issued.device.status, 'active');
  assert.equal(validatePairingCredentialResponse(issued).valid, true);
  await assert.rejects(
    pairing.issueCredential({ challengeId: challenge.challengeId }),
    error => error.code === 'PAIRING_CHALLENGE_CONSUMED'
  );
  fixture.advance(120_001);
  await assert.rejects(
    pairing.issueCredential({ challengeId: challenge.challengeId }),
    error => error.code === 'PAIRING_CHALLENGE_CONSUMED'
  );

  const deviceContext = await pairing.authenticateDevice({
    authorization: `Bearer ${issued.credential.token}`,
  });
  assert.equal(deviceContext.profileId, PROFILE_ID);
  assert.equal(deviceContext.deviceId, issued.device.deviceId);

  await pairing.revoke({
    deviceId: issued.device.deviceId,
    profileContext: { profileId: PROFILE_ID },
    reason: 'device_lost',
  });
  await assert.rejects(
    pairing.authenticateDevice({ authorization: `Bearer ${issued.credential.token}` }),
    error => error.code === 'AUTH_DEVICE_REVOKED'
  );
});

test('pairing challenges expire without activating their pending devices', async t => {
  const fixture = await createFixture();
  t.after(() => fixture.cleanup());
  const { createPairingService } = require('./pairing-service');
  const pairing = await createPairingService({
    db: fixture.db,
    secretStore: fixture.secrets.store,
    now: fixture.now,
    generateId: fixture.generateId,
    challengeTtlMs: 1_000,
  });
  const challenge = await pairing.createChallenge({
    profileId: PROFILE_ID,
    deviceName: 'Expired phone',
    platform: 'android',
    syncEndpoint: 'https://easy-rewind.local:443/v1/sync',
    tlsFingerprint: TLS_FINGERPRINT,
    installationId: INSTALLATION_ID,
  });
  fixture.advance(1_001);

  await assert.rejects(
    pairing.confirm({
      challengeId: challenge.challengeId,
      profileContext: { profileId: PROFILE_ID },
    }),
    error => error.code === 'PAIRING_CHALLENGE_EXPIRED'
  );
  assert.equal(
    fixture.db
      .prepare(
        `SELECT d.state
         FROM sync_devices d
         JOIN pairing_challenges c ON c.device_id = d.id
         LIMIT 1`
      )
      .pluck()
      .get(),
    'pending'
  );
});

test('authentication performs constant-time digest comparison and never stores plaintext tokens', async t => {
  const fixture = await createFixture();
  t.after(() => fixture.cleanup());
  let comparisons = 0;
  const service = await createInstallService(fixture, {
    timingSafeEqual(left, right) {
      comparisons += 1;
      return Buffer.compare(left, right) === 0;
    },
  });
  const provisioned = await service.provision({ profileId: PROFILE_ID });
  const [identifier] = provisioned.token.split('.');
  const wrongToken = `${identifier}.${'A'.repeat(43)}`;

  await assert.rejects(
    service.authenticate({ authorization: `Bearer ${wrongToken}`, transport: 'loopback' }),
    error => error.code === 'AUTH_BEARER_INVALID'
  );
  assert.equal(comparisons, 1);
  const serializedDatabaseRows = JSON.stringify(fixture.db.prepare('SELECT * FROM client_credentials').all());
  assert.equal(serializedDatabaseRows.includes(provisioned.token), false);
  assert.equal(serializedDatabaseRows.includes(provisioned.token.split('.')[1]), false);
});

test('auth middleware establishes immutable request context and rejects owner overrides', async () => {
  const { createInstallAuthMiddleware } = require('./auth-middleware');
  const { getRequestContext } = require('../http/request-context');
  const expectedContext = Object.freeze({
    authenticationType: 'install',
    credentialId: 'credential',
    profileId: PROFILE_ID,
  });
  const middleware = createInstallAuthMiddleware({
    installTokenService: {
      async authenticate() {
        return expectedContext;
      },
    },
  });

  const acceptedRequest = {
    body: {},
    headers: { authorization: 'Bearer token' },
    method: 'GET',
    params: {},
    query: {},
    socket: { remoteAddress: '127.0.0.1' },
  };
  await new Promise((resolve, reject) => {
    middleware(acceptedRequest, {}, error => (error ? reject(error) : resolve()));
  });
  assert.deepEqual(getRequestContext(acceptedRequest), expectedContext);
  assert.equal(Object.isFrozen(getRequestContext(acceptedRequest)), true);

  const rejectedRequest = {
    ...acceptedRequest,
    body: { profileId: OTHER_PROFILE_ID },
  };
  await new Promise(resolve => {
    middleware(rejectedRequest, {}, error => {
      assert.equal(error.code, 'AUTH_OWNER_OVERRIDE');
      resolve();
    });
  });
});
