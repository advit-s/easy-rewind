'use strict';

const AUTH_ERROR_MESSAGES = Object.freeze({
  AUTH_BEARER_REQUIRED: 'A bearer credential is required.',
  AUTH_BEARER_INVALID: 'The bearer credential is invalid.',
  AUTH_TRANSPORT_FORBIDDEN: 'This credential is not accepted on this transport.',
  AUTH_OWNER_MISMATCH: 'The authenticated profile does not own this resource.',
  AUTH_OWNER_OVERRIDE: 'Profile ownership must come from authenticated context.',
  AUTH_ORIGIN_FORBIDDEN: 'The browser origin is not allowed.',
  AUTH_SESSION_INVALID: 'The browser session is invalid.',
  AUTH_SESSION_EXPIRED: 'The browser session has expired.',
  AUTH_CSRF_INVALID: 'The CSRF token is invalid.',
  AUTH_DEVICE_REVOKED: 'The device credential has been revoked.',
  AUTH_INPUT_INVALID: 'Authentication input is invalid.',
  AUTH_CONFIGURATION_INVALID: 'Authentication service configuration is invalid.',
  AUTH_SECRET_STORE_FAILED: 'Protected credential storage failed.',
  PAIRING_CHALLENGE_INVALID: 'The pairing challenge is invalid.',
  PAIRING_CHALLENGE_EXPIRED: 'The pairing challenge has expired.',
  PAIRING_CONFIRMATION_REQUIRED: 'Desktop confirmation is required before pairing.',
  PAIRING_CHALLENGE_CONSUMED: 'The pairing challenge has already been consumed.',
  PAIRING_INPUT_INVALID: 'Pairing input is invalid.',
});

class AuthError extends Error {
  constructor(code) {
    super(AUTH_ERROR_MESSAGES[code] ?? AUTH_ERROR_MESSAGES.AUTH_INPUT_INVALID);
    this.name = 'AuthError';
    this.code = Object.hasOwn(AUTH_ERROR_MESSAGES, code) ? code : 'AUTH_INPUT_INVALID';
  }
}

function fail(code) {
  throw new AuthError(code);
}

module.exports = {
  AUTH_ERROR_MESSAGES,
  AuthError,
  fail,
};
