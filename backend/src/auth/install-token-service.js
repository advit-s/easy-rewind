'use strict';

const { randomUUID } = require('node:crypto');
const { fail } = require('./auth-error');
const { assertServiceDependencies, createTokenTools, currentTime, readBearer } = require('./token-crypto');

function validateProfileId(profileId) {
  if (typeof profileId !== 'string' || profileId.length === 0) fail('AUTH_INPUT_INVALID');
}

async function createInstallTokenService({
  db,
  secretStore,
  now = Date.now,
  generateId = randomUUID,
  randomBytes,
  timingSafeEqual,
} = {}) {
  assertServiceDependencies({ db, now, generateId });
  const tools = await createTokenTools({ secretStore, randomBytes, timingSafeEqual });
  const findCredential = db.prepare(
    `SELECT id, profile_id, secret_ref, secret_digest, state
     FROM client_credentials
     WHERE id = ? AND kind = 'application_api'`
  );
  const insertCredential = db.prepare(
    `INSERT INTO client_credentials(
       id, profile_id, kind, label, secret_ref, secret_digest, state, created_at, updated_at
     ) VALUES (?, ?, 'application_api', ?, ?, ?, 'active', ?, ?)`
  );
  const updateCredential = db.prepare(
    `UPDATE client_credentials
     SET secret_digest = ?, updated_at = ?
     WHERE id = ? AND profile_id = ? AND kind = 'application_api' AND state = 'active'`
  );
  const touchCredential = db.prepare(
    `UPDATE client_credentials SET last_used_at = ?, updated_at = ?
     WHERE id = ? AND state = 'active'`
  );

  async function provision({ profileId, label = '' } = {}) {
    validateProfileId(profileId);
    if (typeof label !== 'string' || label.length > 128) fail('AUTH_INPUT_INVALID');
    if (db.prepare('SELECT 1 FROM profiles WHERE id = ? AND deleted_at IS NULL').get(profileId) === undefined) {
      fail('AUTH_OWNER_MISMATCH');
    }
    const credentialId = generateId();
    const token = tools.credentialToken('eri', credentialId);
    const secretRef = `auth/install-token/${credentialId}`;
    const timestamp = currentTime(now);
    try {
      await secretStore.set(secretRef, token);
      insertCredential.run(credentialId, profileId, label, secretRef, tools.digest(token), timestamp, timestamp);
    } catch (error) {
      try {
        await secretStore.delete(secretRef);
      } catch {
        // The stable protected-store failure remains authoritative.
      }
      if (error?.code?.startsWith('AUTH_')) throw error;
      fail('AUTH_SECRET_STORE_FAILED');
    }
    return Object.freeze({ credentialId, token, tokenType: 'Bearer' });
  }

  async function authenticate({ authorization, transport } = {}) {
    if (transport !== 'loopback') fail('AUTH_TRANSPORT_FORBIDDEN');
    const parsed = readBearer(authorization, tools, 'eri');
    const row = findCredential.get(parsed.identifier);
    if (row === undefined || row.state !== 'active' || !tools.matches(parsed.token, row.secret_digest)) {
      fail('AUTH_BEARER_INVALID');
    }
    const timestamp = currentTime(now);
    touchCredential.run(timestamp, timestamp, row.id);
    return Object.freeze({
      authenticationType: 'install',
      credentialId: row.id,
      profileId: row.profile_id,
    });
  }

  async function rotate({ credentialId, profileId } = {}) {
    validateProfileId(profileId);
    if (typeof credentialId !== 'string' || credentialId.length === 0) fail('AUTH_INPUT_INVALID');
    const row = findCredential.get(credentialId);
    if (row === undefined || row.profile_id !== profileId) fail('AUTH_OWNER_MISMATCH');
    if (row.state !== 'active') fail('AUTH_BEARER_INVALID');
    let previousToken;
    try {
      previousToken = await secretStore.get(row.secret_ref);
    } catch {
      fail('AUTH_SECRET_STORE_FAILED');
    }
    if (typeof previousToken !== 'string') fail('AUTH_SECRET_STORE_FAILED');
    const token = tools.credentialToken('eri', credentialId);
    const timestamp = currentTime(now);
    try {
      await secretStore.set(row.secret_ref, token);
      const result = updateCredential.run(tools.digest(token), timestamp, credentialId, profileId);
      if (result.changes !== 1) fail('AUTH_BEARER_INVALID');
    } catch (error) {
      try {
        await secretStore.set(row.secret_ref, previousToken);
      } catch {
        // Do not expose protected-store details.
      }
      if (error?.code?.startsWith('AUTH_')) throw error;
      fail('AUTH_SECRET_STORE_FAILED');
    }
    return Object.freeze({ credentialId, token, tokenType: 'Bearer' });
  }

  return Object.freeze({ authenticate, provision, rotate });
}

module.exports = { createInstallTokenService };
