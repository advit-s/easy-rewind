'use strict';

const { randomUUID } = require('node:crypto');

const CODES = Object.freeze({
  AUTH_BOOTSTRAP_CONFIGURATION_INVALID: 'Authentication bootstrap configuration is invalid.',
  AUTH_BOOTSTRAP_NOT_READY: 'Authentication bootstrap has not completed.',
});

class AuthBootstrapError extends Error {
  constructor(code) {
    super(CODES[code]);
    this.name = 'AuthBootstrapError';
    this.code = code;
  }
}

function fail(code) {
  throw new AuthBootstrapError(code);
}

function validateDependencies({ db, generateId, installTokenService, now, secretStore }) {
  if (
    db === null ||
    typeof db !== 'object' ||
    typeof db.exec !== 'function' ||
    typeof db.prepare !== 'function' ||
    typeof generateId !== 'function' ||
    installTokenService === null ||
    typeof installTokenService !== 'object' ||
    typeof installTokenService.getAuthorization !== 'function' ||
    typeof installTokenService.provision !== 'function' ||
    typeof now !== 'function' ||
    secretStore === null ||
    typeof secretStore !== 'object' ||
    typeof secretStore.delete !== 'function'
  ) {
    fail('AUTH_BOOTSTRAP_CONFIGURATION_INVALID');
  }
}

function validateGeneratedId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9-]{1,128}$/.test(value)) {
    fail('AUTH_BOOTSTRAP_CONFIGURATION_INVALID');
  }
  return value;
}

function validateTimestamp(value) {
  if (!Number.isSafeInteger(value) || value < 0) fail('AUTH_BOOTSTRAP_CONFIGURATION_INVALID');
  return value;
}

function createAuthBootstrap({ db, generateId = randomUUID, installTokenService, now = Date.now, secretStore } = {}) {
  validateDependencies({ db, generateId, installTokenService, now, secretStore });
  const findActiveCredential = db.prepare(
    `SELECT c.id AS credential_id, c.profile_id
     FROM client_credentials c
     JOIN profiles p ON p.id = c.profile_id
     WHERE c.kind = 'application_api'
       AND c.state = 'active'
       AND p.deleted_at IS NULL
     ORDER BY p.created_at ASC, p.id ASC, c.created_at ASC, c.id ASC
     LIMIT 1`
  );
  const findCanonicalProfile = db.prepare(
    `SELECT id
     FROM profiles
     WHERE deleted_at IS NULL
     ORDER BY created_at ASC, id ASC
     LIMIT 1`
  );
  const insertProfile = db.prepare(
    `INSERT INTO profiles(
       id, display_name, timezone, locale, created_at, updated_at, revision
     ) VALUES (?, 'Easy Rewind', 'UTC', 'en', ?, ?, 1)`
  );

  let initialized;
  let initializePromise;

  async function performInitialize() {
    let provisioned;
    let transactionOpen = false;
    try {
      db.exec('BEGIN IMMEDIATE');
      transactionOpen = true;
      const existingCredential = findActiveCredential.get();
      if (existingCredential !== undefined) {
        await installTokenService.getAuthorization({
          credentialId: existingCredential.credential_id,
          profileId: existingCredential.profile_id,
        });
        db.exec('COMMIT');
        transactionOpen = false;
        return Object.freeze({
          createdProfile: false,
          credentialId: existingCredential.credential_id,
          profileId: existingCredential.profile_id,
          provisionedCredential: false,
        });
      }

      let profile = findCanonicalProfile.get();
      let createdProfile = false;
      if (profile === undefined) {
        const profileId = validateGeneratedId(generateId());
        const timestamp = validateTimestamp(now());
        insertProfile.run(profileId, timestamp, timestamp);
        profile = { id: profileId };
        createdProfile = true;
      }
      provisioned = await installTokenService.provision({
        label: 'Easy Rewind local application',
        profileId: profile.id,
      });
      db.exec('COMMIT');
      transactionOpen = false;
      return Object.freeze({
        createdProfile,
        credentialId: provisioned.credentialId,
        profileId: profile.id,
        provisionedCredential: true,
      });
    } catch (error) {
      if (transactionOpen) {
        try {
          db.exec('ROLLBACK');
        } catch {
          // Preserve the authoritative bootstrap failure.
        }
      }
      const credentialId = provisioned?.credentialId ?? error?.credentialId;
      if (typeof credentialId === 'string' && /^[A-Za-z0-9-]{1,128}$/.test(credentialId)) {
        try {
          await secretStore.delete(`auth/install-token/${credentialId}`);
        } catch {
          // Preserve the authoritative bootstrap failure without exposing store details.
        }
      }
      throw error;
    }
  }

  function initialize() {
    if (initialized !== undefined) return Promise.resolve(initialized);
    if (initializePromise !== undefined) return initializePromise;
    initializePromise = performInitialize()
      .then(result => {
        initialized = result;
        return result;
      })
      .finally(() => {
        initializePromise = undefined;
      });
    return initializePromise;
  }

  async function getAuthorization() {
    if (initialized === undefined) fail('AUTH_BOOTSTRAP_NOT_READY');
    return installTokenService.getAuthorization({
      credentialId: initialized.credentialId,
      profileId: initialized.profileId,
    });
  }

  return Object.freeze({ getAuthorization, initialize });
}

module.exports = {
  AuthBootstrapError,
  createAuthBootstrap,
};
