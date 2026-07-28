'use strict';

const { randomUUID } = require('node:crypto');
const { fail } = require('./auth-error');
const { assertServiceDependencies, createTokenTools, currentTime, readBearer } = require('./token-crypto');

function isPrivateIpv4(host) {
  const parts = host.split('.');
  if (parts.length !== 4 || parts.some(part => !/^(?:0|[1-9][0-9]{0,2})$/.test(part))) return false;
  const octets = parts.map(Number);
  if (octets.some(octet => octet > 255)) return false;
  return (
    octets[0] === 10 ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168)
  );
}

function isPrivateIpv6(host) {
  const normalized = host.replace(/^\[|\]$/g, '').toLowerCase();
  const first = normalized.split(':', 1)[0];
  if (!/^[0-9a-f]{1,4}$/.test(first)) return false;
  const value = Number.parseInt(first, 16);
  return value >= 0xfc00 && value <= 0xfdff;
}

function isLocalHostname(host) {
  return /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+local$/i.test(host);
}

function validateSyncEndpoint(value) {
  if (typeof value !== 'string' || value.length > 512) fail('PAIRING_INPUT_INVALID');
  const match = /^https:\/\/(\[[^\]]+\]|[^/:?#]+):([0-9]{1,5})(\/[^?#]*)?(\?[^#]*)?(#.*)?$/.exec(value);
  if (match === null) fail('PAIRING_INPUT_INVALID');
  const [, authorityHost, portText, path = '/', query, fragment] = match;
  const port = Number(portText);
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail('PAIRING_INPUT_INVALID');
  }
  if (
    port < 1 ||
    port > 65_535 ||
    parsed.protocol !== 'https:' ||
    path !== '/v1/sync' ||
    query !== undefined ||
    fragment !== undefined ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    (!isPrivateIpv4(authorityHost) && !isPrivateIpv6(authorityHost) && !isLocalHostname(authorityHost))
  ) {
    fail('PAIRING_INPUT_INVALID');
  }
  return value;
}

function validateProfileContext(profileContext) {
  if (
    profileContext === null ||
    typeof profileContext !== 'object' ||
    typeof profileContext.profileId !== 'string' ||
    profileContext.profileId.length === 0
  ) {
    fail('AUTH_INPUT_INVALID');
  }
}

function publicDevice(row) {
  return Object.freeze({
    deviceId: row.id,
    name: row.name,
    platform: row.platform,
    status: row.state,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
  });
}

async function createPairingService({
  db,
  secretStore,
  now = Date.now,
  generateId = randomUUID,
  randomBytes,
  timingSafeEqual,
  challengeTtlMs = 5 * 60 * 1000,
} = {}) {
  assertServiceDependencies({ db, now, generateId });
  if (!Number.isSafeInteger(challengeTtlMs) || challengeTtlMs < 1_000 || challengeTtlMs > 15 * 60 * 1000) {
    fail('AUTH_CONFIGURATION_INVALID');
  }
  const tools = await createTokenTools({ secretStore, randomBytes, timingSafeEqual });
  const findChallenge = db.prepare(
    `SELECT
       c.id, c.profile_id, c.device_id, c.challenge_digest, c.state, c.expires_at,
       d.name, d.platform, d.created_at, d.last_seen_at
     FROM pairing_challenges c
     JOIN sync_devices d ON d.id = c.device_id AND d.profile_id = c.profile_id
     WHERE c.challenge_digest = ?`
  );
  const findDeviceCredential = db.prepare(
    `SELECT
       c.id AS credential_id, c.profile_id, c.device_id, c.secret_digest,
       c.state AS credential_state, d.state AS device_state
     FROM client_credentials c
     JOIN sync_devices d ON d.id = c.device_id AND d.profile_id = c.profile_id
     WHERE c.id = ? AND c.kind = 'sync_device'`
  );

  function challengeRow(challengeId) {
    if (typeof challengeId !== 'string' || !/^epc_[A-Za-z0-9_-]{43}$/.test(challengeId)) {
      fail('PAIRING_CHALLENGE_INVALID');
    }
    const row = findChallenge.get(tools.digest(challengeId));
    if (row === undefined || !tools.matches(challengeId, row.challenge_digest)) {
      fail('PAIRING_CHALLENGE_INVALID');
    }
    return row;
  }

  function expireIfNeeded(row, timestamp) {
    if (timestamp < row.expires_at) return;
    if (row.state !== 'consumed') {
      db.prepare(
        `UPDATE pairing_challenges SET state = 'expired', updated_at = ?
         WHERE id = ? AND state <> 'consumed'`
      ).run(timestamp, row.id);
    }
    fail('PAIRING_CHALLENGE_EXPIRED');
  }

  async function createChallenge({
    profileId,
    deviceName,
    platform,
    syncEndpoint,
    tlsFingerprint,
    installationId,
  } = {}) {
    if (
      typeof profileId !== 'string' ||
      typeof deviceName !== 'string' ||
      deviceName.trim().length < 1 ||
      deviceName.trim().length > 64 ||
      platform !== 'android' ||
      typeof installationId !== 'string' ||
      installationId.length < 1 ||
      installationId.length > 128 ||
      typeof tlsFingerprint !== 'string' ||
      !/^sha256:[a-f0-9]{64}$/.test(tlsFingerprint)
    ) {
      fail('PAIRING_INPUT_INVALID');
    }
    validateSyncEndpoint(syncEndpoint);
    if (db.prepare('SELECT 1 FROM profiles WHERE id = ? AND deleted_at IS NULL').get(profileId) === undefined) {
      fail('AUTH_OWNER_MISMATCH');
    }
    const timestamp = currentTime(now);
    const expiresAt = timestamp + challengeTtlMs;
    if (!Number.isSafeInteger(expiresAt)) fail('AUTH_CONFIGURATION_INVALID');
    const deviceId = generateId();
    const internalChallengeId = generateId();
    const challengeId = tools.challengeToken();
    const insert = db.transaction(() => {
      db.prepare(
        `INSERT INTO sync_devices(
           id, profile_id, name, platform, state, created_at, updated_at, revision
         ) VALUES (?, ?, ?, ?, 'pending', ?, ?, 1)`
      ).run(deviceId, profileId, deviceName.trim(), platform, timestamp, timestamp);
      db.prepare(
        `INSERT INTO pairing_challenges(
           id, profile_id, device_id, challenge_digest, state, expires_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`
      ).run(internalChallengeId, profileId, deviceId, tools.digest(challengeId), expiresAt, timestamp, timestamp);
    });
    insert();
    return Object.freeze({
      challengeId,
      expiresAt,
      status: 'pending_confirmation',
      oneUse: true,
      qrPayload: Object.freeze({
        protocolVersion: '1',
        syncEndpoint,
        tlsFingerprint,
        installationId,
        challengeId,
        expiresAt,
      }),
    });
  }

  async function confirm({ challengeId, profileContext } = {}) {
    validateProfileContext(profileContext);
    const row = challengeRow(challengeId);
    if (row.profile_id !== profileContext.profileId) fail('AUTH_OWNER_MISMATCH');
    const timestamp = currentTime(now);
    if (row.state === 'consumed') fail('PAIRING_CHALLENGE_CONSUMED');
    expireIfNeeded(row, timestamp);
    if (row.state === 'expired') fail('PAIRING_CHALLENGE_EXPIRED');
    if (row.state === 'pending') {
      db.prepare(
        `UPDATE pairing_challenges
         SET state = 'confirmed', confirmed_at = ?, updated_at = ?
         WHERE id = ? AND state = 'pending'`
      ).run(timestamp, timestamp, row.id);
    }
    return Object.freeze({ challengeId, confirmed: true });
  }

  async function issueCredential({ challengeId } = {}) {
    const row = challengeRow(challengeId);
    const timestamp = currentTime(now);
    if (row.state === 'consumed') fail('PAIRING_CHALLENGE_CONSUMED');
    expireIfNeeded(row, timestamp);
    if (row.state === 'pending') fail('PAIRING_CONFIRMATION_REQUIRED');
    if (row.state !== 'confirmed') fail('PAIRING_CHALLENGE_INVALID');
    const credentialId = generateId();
    const token = tools.credentialToken('erd', credentialId);
    const issue = db.transaction(() => {
      const consumed = db
        .prepare(
          `UPDATE pairing_challenges
         SET state = 'consumed', consumed_at = ?, updated_at = ?
         WHERE id = ? AND state = 'confirmed' AND expires_at > ?`
        )
        .run(timestamp, timestamp, row.id, timestamp);
      if (consumed.changes !== 1) fail('PAIRING_CHALLENGE_CONSUMED');
      db.prepare(
        `UPDATE sync_devices
         SET state = 'active', paired_at = ?, updated_at = ?, revision = revision + 1
         WHERE id = ? AND profile_id = ? AND state = 'pending'`
      ).run(timestamp, timestamp, row.device_id, row.profile_id);
      db.prepare(
        `INSERT INTO client_credentials(
           id, profile_id, kind, device_id, label, secret_ref, secret_digest,
           state, created_at, updated_at
         ) VALUES (?, ?, 'sync_device', ?, ?, NULL, ?, 'active', ?, ?)`
      ).run(credentialId, row.profile_id, row.device_id, row.name, tools.digest(token), timestamp, timestamp);
    });
    issue();
    const device = db.prepare('SELECT * FROM sync_devices WHERE id = ?').get(row.device_id);
    return Object.freeze({
      device: publicDevice(device),
      credential: Object.freeze({ token, tokenType: 'Bearer', issuedAt: timestamp }),
    });
  }

  async function authenticateDevice({ authorization } = {}) {
    const parsed = readBearer(authorization, tools, 'erd');
    const row = findDeviceCredential.get(parsed.identifier);
    if (row === undefined || !tools.matches(parsed.token, row.secret_digest)) {
      fail('AUTH_BEARER_INVALID');
    }
    if (row.device_state === 'revoked' || row.credential_state === 'revoked') {
      fail('AUTH_DEVICE_REVOKED');
    }
    if (row.device_state !== 'active' || row.credential_state !== 'active') {
      fail('AUTH_BEARER_INVALID');
    }
    const timestamp = currentTime(now);
    const touch = db.transaction(() => {
      db.prepare('UPDATE client_credentials SET last_used_at = ?, updated_at = ? WHERE id = ?').run(
        timestamp,
        timestamp,
        row.credential_id
      );
      db.prepare(
        `UPDATE sync_devices
         SET last_seen_at = ?, updated_at = ?, revision = revision + 1
         WHERE id = ? AND profile_id = ?`
      ).run(timestamp, timestamp, row.device_id, row.profile_id);
    });
    touch();
    return Object.freeze({
      authenticationType: 'sync_device',
      credentialId: row.credential_id,
      deviceId: row.device_id,
      profileId: row.profile_id,
    });
  }

  async function revoke({ deviceId, profileContext, reason } = {}) {
    validateProfileContext(profileContext);
    if (typeof deviceId !== 'string' || !['user_requested', 'credential_compromised', 'device_lost'].includes(reason)) {
      fail('PAIRING_INPUT_INVALID');
    }
    const device = db.prepare('SELECT profile_id, state FROM sync_devices WHERE id = ?').get(deviceId);
    if (device === undefined || device.profile_id !== profileContext.profileId) fail('AUTH_OWNER_MISMATCH');
    const timestamp = currentTime(now);
    const revokeTransaction = db.transaction(() => {
      db.prepare(
        `UPDATE sync_devices
         SET state = 'revoked', revoked_at = ?, updated_at = ?, revision = revision + 1
         WHERE id = ? AND profile_id = ?`
      ).run(timestamp, timestamp, deviceId, profileContext.profileId);
      db.prepare(
        `UPDATE client_credentials
         SET state = 'revoked', revoked_at = ?, updated_at = ?
         WHERE device_id = ? AND profile_id = ? AND kind = 'sync_device'`
      ).run(timestamp, timestamp, deviceId, profileContext.profileId);
    });
    revokeTransaction();
    return Object.freeze({ deviceId, status: 'revoked', revokedAt: timestamp });
  }

  return Object.freeze({
    authenticateDevice,
    confirm,
    createChallenge,
    issueCredential,
    revoke,
  });
}

module.exports = { createPairingService };
