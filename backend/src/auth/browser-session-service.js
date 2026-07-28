'use strict';

const { randomUUID } = require('node:crypto');
const { fail } = require('./auth-error');
const { assertServiceDependencies, createTokenTools, currentTime } = require('./token-crypto');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function normalizeLoopbackOrigin(value) {
  if (typeof value !== 'string') fail('AUTH_ORIGIN_FORBIDDEN');
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail('AUTH_ORIGIN_FORBIDDEN');
  }
  const host = parsed.hostname.toLowerCase();
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(host) ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    fail('AUTH_ORIGIN_FORBIDDEN');
  }
  return parsed.origin;
}

async function createBrowserSessionService({
  db,
  secretStore,
  now = Date.now,
  generateId = randomUUID,
  randomBytes,
  timingSafeEqual,
  ttlMs = 15 * 60 * 1000,
} = {}) {
  assertServiceDependencies({ db, now, generateId });
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 24 * 60 * 60 * 1000) {
    fail('AUTH_CONFIGURATION_INVALID');
  }
  const tools = await createTokenTools({ secretStore, randomBytes, timingSafeEqual });
  const insertSession = db.prepare(
    `INSERT INTO browser_sessions(
       id, profile_id, credential_id, origin, token_hash, csrf_hash, state,
       expires_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`
  );
  const findSession = db.prepare(
    `SELECT id, profile_id, credential_id, origin, token_hash, csrf_hash, state, expires_at
     FROM browser_sessions WHERE id = ?`
  );
  const touchSession = db.prepare(
    `UPDATE browser_sessions SET last_seen_at = ?, updated_at = ?
     WHERE id = ? AND state = 'active'`
  );
  const expireSession = db.prepare(
    `UPDATE browser_sessions SET state = 'expired', updated_at = ?
     WHERE id = ? AND state = 'active'`
  );
  const revokeSession = db.prepare(
    `UPDATE browser_sessions
     SET state = 'revoked', revoked_at = ?, updated_at = ?
     WHERE id = ? AND profile_id = ? AND state = 'active'`
  );

  async function exchange({ installContext, origin } = {}) {
    if (
      installContext === null ||
      typeof installContext !== 'object' ||
      installContext.authenticationType !== 'install' ||
      typeof installContext.profileId !== 'string' ||
      typeof installContext.credentialId !== 'string'
    ) {
      fail('AUTH_BEARER_INVALID');
    }
    const credential = db
      .prepare(
        `SELECT 1 FROM client_credentials
         WHERE id = ? AND profile_id = ? AND kind = 'application_api' AND state = 'active'`
      )
      .get(installContext.credentialId, installContext.profileId);
    if (credential === undefined) fail('AUTH_BEARER_INVALID');
    const normalizedOrigin = normalizeLoopbackOrigin(origin);
    const timestamp = currentTime(now);
    const expiresAt = timestamp + ttlMs;
    if (!Number.isSafeInteger(expiresAt)) fail('AUTH_CONFIGURATION_INVALID');
    const sessionId = generateId();
    const sessionToken = tools.credentialToken('ers', sessionId);
    const csrfToken = tools.randomSecret();
    insertSession.run(
      sessionId,
      installContext.profileId,
      installContext.credentialId,
      normalizedOrigin,
      tools.digest(sessionToken),
      tools.digest(csrfToken),
      expiresAt,
      timestamp,
      timestamp
    );
    return Object.freeze({
      csrfToken,
      expiresAt,
      sessionId,
      sessionToken,
      cookie: Object.freeze({
        name: 'easy_rewind_session',
        value: sessionToken,
        options: Object.freeze({
          httpOnly: true,
          sameSite: 'strict',
          secure: normalizedOrigin.startsWith('https:'),
          path: '/',
          maxAge: ttlMs,
        }),
      }),
    });
  }

  async function authenticate({ sessionToken, csrfToken, method, origin } = {}) {
    const parsed = tools.parseCredentialToken(sessionToken, 'ers');
    if (parsed === null) fail('AUTH_SESSION_INVALID');
    const row = findSession.get(parsed.identifier);
    if (row === undefined || row.state !== 'active' || !tools.matches(parsed.token, row.token_hash)) {
      fail('AUTH_SESSION_INVALID');
    }
    const timestamp = currentTime(now);
    if (timestamp >= row.expires_at) {
      expireSession.run(timestamp, row.id);
      fail('AUTH_SESSION_EXPIRED');
    }
    if (normalizeLoopbackOrigin(origin) !== row.origin) fail('AUTH_ORIGIN_FORBIDDEN');
    const normalizedMethod = typeof method === 'string' ? method.toUpperCase() : '';
    if (!SAFE_METHODS.has(normalizedMethod)) {
      if (typeof csrfToken !== 'string' || !tools.matches(csrfToken, row.csrf_hash)) {
        fail('AUTH_CSRF_INVALID');
      }
    }
    touchSession.run(timestamp, timestamp, row.id);
    return Object.freeze({
      authenticationType: 'browser_session',
      credentialId: row.credential_id,
      profileId: row.profile_id,
      sessionId: row.id,
    });
  }

  async function revoke({ sessionId, profileContext } = {}) {
    if (
      typeof sessionId !== 'string' ||
      profileContext === null ||
      typeof profileContext !== 'object' ||
      typeof profileContext.profileId !== 'string'
    ) {
      fail('AUTH_INPUT_INVALID');
    }
    const timestamp = currentTime(now);
    const result = revokeSession.run(timestamp, timestamp, sessionId, profileContext.profileId);
    if (result.changes !== 1) fail('AUTH_OWNER_MISMATCH');
    return Object.freeze({ revokedAt: timestamp, sessionId });
  }

  return Object.freeze({ authenticate, exchange, revoke });
}

module.exports = { createBrowserSessionService };
