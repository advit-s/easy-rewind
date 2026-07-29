'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const NOW = 1_700_000_000_000;

function createSecretStore() {
  const values = new Map();
  return {
    values,
    store: Object.freeze({
      async delete(name) {
        values.delete(name);
      },
      async get(name) {
        return values.get(name) ?? null;
      },
      async set(name, value) {
        values.set(name, value);
      },
    }),
  };
}

function createDatabase() {
  const Database = require('better-sqlite3');
  const { discoverMigrations, runMigrations } = require('../database/migration-runner');
  const db = new Database(':memory:');
  runMigrations({ db, migrations: discoverMigrations(), now: () => NOW });
  return db;
}

function createIds() {
  let value = 0;
  return () => `bootstrap-${++value}`;
}

async function createServices({ db, secrets, ids = createIds() }) {
  const { createInstallTokenService } = require('../auth/install-token-service');
  const { createAuthBootstrap } = require('./auth-bootstrap');
  const installTokenService = await createInstallTokenService({
    db,
    secretStore: secrets.store,
    now: () => NOW,
    generateId: ids,
  });
  return {
    bootstrap: createAuthBootstrap({
      db,
      generateId: ids,
      installTokenService,
      now: () => NOW,
      secretStore: secrets.store,
    }),
    installTokenService,
  };
}

test('fresh bootstrap transactionally creates one canonical profile and one install credential', async t => {
  const db = createDatabase();
  t.after(() => db.close());
  const secrets = createSecretStore();
  const { bootstrap } = await createServices({ db, secrets });

  const result = await bootstrap.initialize();

  assert.deepEqual(result, {
    createdProfile: true,
    credentialId: 'bootstrap-2',
    profileId: 'bootstrap-1',
    provisionedCredential: true,
  });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(JSON.stringify(result).includes('Bearer'), false);
  assert.deepEqual(db.prepare('SELECT id, display_name, timezone, locale, revision FROM profiles').get(), {
    display_name: 'Easy Rewind',
    id: 'bootstrap-1',
    locale: 'en',
    revision: 1,
    timezone: 'UTC',
  });
  assert.equal(db.prepare("SELECT COUNT(*) FROM client_credentials WHERE kind = 'application_api'").pluck().get(), 1);
  assert.match(await bootstrap.getAuthorization(), /^Bearer eri_bootstrap-2\./);
});

test('restart reuses the existing profile and protected credential without rotating it', async t => {
  const db = createDatabase();
  t.after(() => db.close());
  const secrets = createSecretStore();
  const ids = createIds();
  const first = await createServices({ db, secrets, ids });
  const initial = await first.bootstrap.initialize();
  const authorization = await first.bootstrap.getAuthorization();
  const second = await createServices({ db, secrets, ids });

  const restarted = await second.bootstrap.initialize();

  assert.deepEqual(restarted, {
    createdProfile: false,
    credentialId: initial.credentialId,
    profileId: initial.profileId,
    provisionedCredential: false,
  });
  assert.equal(await second.bootstrap.getAuthorization(), authorization);
  assert.equal(db.prepare('SELECT COUNT(*) FROM profiles').pluck().get(), 1);
  assert.equal(db.prepare('SELECT COUNT(*) FROM client_credentials').pluck().get(), 1);
});

test('bootstrap deterministically selects the oldest active profile when multiple profiles have no credential', async t => {
  const db = createDatabase();
  t.after(() => db.close());
  const secrets = createSecretStore();
  const insert = db.prepare(
    `INSERT INTO profiles(id, display_name, timezone, locale, created_at, updated_at, revision)
     VALUES (?, ?, 'UTC', 'en', ?, ?, 1)`
  );
  insert.run('profile-newer', 'Newer', NOW + 1, NOW + 1);
  insert.run('profile-oldest-z', 'Oldest Z', NOW, NOW);
  insert.run('profile-oldest-a', 'Oldest A', NOW, NOW);
  const { bootstrap } = await createServices({ db, secrets });

  const result = await bootstrap.initialize();

  assert.equal(result.profileId, 'profile-oldest-a');
  assert.equal(result.createdProfile, false);
  assert.equal(result.provisionedCredential, true);
  assert.equal(
    db
      .prepare("SELECT profile_id FROM client_credentials WHERE kind = 'application_api' AND state = 'active'")
      .pluck()
      .get(),
    'profile-oldest-a'
  );
});

test('missing protected secret for an existing active credential fails without rotation or duplicate provisioning', async t => {
  const db = createDatabase();
  t.after(() => db.close());
  const secrets = createSecretStore();
  const first = await createServices({ db, secrets });
  const initialized = await first.bootstrap.initialize();
  const secretRef = db
    .prepare('SELECT secret_ref FROM client_credentials WHERE id = ?')
    .pluck()
    .get(initialized.credentialId);
  await secrets.store.delete(secretRef);
  const restarted = await createServices({ db, secrets });

  await assert.rejects(restarted.bootstrap.initialize(), error => error.code === 'AUTH_SECRET_STORE_FAILED');
  assert.equal(db.prepare('SELECT COUNT(*) FROM profiles').pluck().get(), 1);
  assert.equal(db.prepare('SELECT COUNT(*) FROM client_credentials').pluck().get(), 1);
  await assert.rejects(restarted.bootstrap.getAuthorization(), error => error.code === 'AUTH_BOOTSTRAP_NOT_READY');
});

test('failed provisioning rolls back a newly created profile and cleans a partially provisioned secret', async t => {
  const db = createDatabase();
  t.after(() => db.close());
  const secrets = createSecretStore();
  const { createAuthBootstrap } = require('./auth-bootstrap');
  const bootstrap = createAuthBootstrap({
    db,
    generateId: () => 'profile-created-before-failure',
    installTokenService: {
      async getAuthorization() {
        throw new Error('not expected');
      },
      async provision() {
        await secrets.store.set('auth/install-token/partial-credential', 'sensitive-token');
        const error = new Error('simulated protected-store interruption');
        error.credentialId = 'partial-credential';
        throw error;
      },
    },
    now: () => NOW,
    secretStore: secrets.store,
  });

  await assert.rejects(bootstrap.initialize(), /simulated protected-store interruption/);

  assert.equal(db.prepare('SELECT COUNT(*) FROM profiles').pluck().get(), 0);
  assert.equal(await secrets.store.get('auth/install-token/partial-credential'), null);
});
