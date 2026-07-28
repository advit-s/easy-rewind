'use strict';

const SAFE_ERROR_MESSAGES = Object.freeze({
  auth_required: 'Authentication is required.',
  auth_invalid: 'Authentication is invalid.',
  forbidden: 'The requested operation is forbidden.',
  not_found: 'The requested resource was not found.',
  validation_failed: 'The request is invalid.',
  conflict: 'The request conflicts with current state.',
  rate_limited: 'Too many requests were made.',
  internal_error: 'The request could not be completed.',
  api_version_unsupported: 'The requested API version is unsupported.',
  cursor_expired: 'The requested cursor has expired.',
  device_revoked: 'The device has been revoked.',
  not_implemented: 'The requested operation is not implemented.',
});

function errorCode(error) {
  if (error?.code === 'AUTH_BEARER_REQUIRED') return 'auth_required';
  if (
    typeof error?.code === 'string' &&
    (error.code.startsWith('AUTH_BEARER') ||
      error.code.startsWith('AUTH_SESSION') ||
      error.code === 'AUTH_CSRF_INVALID')
  ) {
    return 'auth_invalid';
  }
  if (error?.code === 'AUTH_DEVICE_REVOKED') return 'device_revoked';
  if (
    typeof error?.code === 'string' &&
    (error.code.includes('FORBIDDEN') || error.code === 'AUTH_OWNER_MISMATCH' || error.code === 'AUTH_OWNER_OVERRIDE')
  ) {
    return 'forbidden';
  }
  if (error?.code === 'NOT_FOUND') return 'not_found';
  if (
    error?.code === 'CONFLICT' ||
    error?.code === 'PAIRING_CHALLENGE_CONSUMED' ||
    error?.code === 'PAIRING_CHALLENGE_EXPIRED' ||
    error?.code === 'PAIRING_CONFIRMATION_REQUIRED'
  ) {
    return 'conflict';
  }
  if (error?.code === 'CURSOR_EXPIRED') return 'cursor_expired';
  if (error?.code === 'NOT_IMPLEMENTED') return 'not_implemented';
  if (error?.code === 'API_VERSION_UNSUPPORTED') return 'api_version_unsupported';
  if (error?.code === 'RATE_LIMITED') return 'rate_limited';
  if (
    error?.type === 'entity.parse.failed' ||
    error?.type === 'entity.too.large' ||
    (typeof error?.code === 'string' && (error.code.endsWith('_INVALID') || error.code.startsWith('PAIRING_')))
  ) {
    return 'validation_failed';
  }
  return 'internal_error';
}

function statusForCode(code) {
  if (code === 'auth_required' || code === 'auth_invalid') return 401;
  if (code === 'forbidden') return 403;
  if (code === 'not_found') return 404;
  if (code === 'conflict') return 409;
  if (code === 'validation_failed') return 400;
  if (code === 'rate_limited') return 429;
  if (code === 'api_version_unsupported') return 400;
  if (code === 'cursor_expired') return 409;
  if (code === 'device_revoked') return 401;
  if (code === 'not_implemented') return 501;
  return 500;
}

function createHttpError(code, statusCode) {
  const error = new Error(SAFE_ERROR_MESSAGES[code] ?? SAFE_ERROR_MESSAGES.internal_error);
  error.code = Object.hasOwn(SAFE_ERROR_MESSAGES, code) ? code : 'internal_error';
  error.statusCode = statusCode ?? statusForCode(error.code);
  return error;
}

function errorHandler(error, request, response, _next) {
  const code = Object.hasOwn(SAFE_ERROR_MESSAGES, error?.code) ? error.code : errorCode(error);
  const entityStatus = error?.type === 'entity.too.large' ? 413 : undefined;
  const requestedStatus = Number.isInteger(error?.statusCode)
    ? error.statusCode
    : (entityStatus ?? statusForCode(code));
  const status = requestedStatus >= 400 && requestedStatus <= 599 ? requestedStatus : 500;
  const requestId =
    typeof request?.requestId === 'string' &&
    request.requestId.length >= 16 &&
    request.requestId.length <= 256 &&
    /^[A-Za-z][A-Za-z0-9_-]+$/.test(request.requestId)
      ? request.requestId
      : 'request-unavailable';
  response.status(status).json({
    error: {
      code,
      message: SAFE_ERROR_MESSAGES[code],
      requestId,
      details: {},
    },
  });
}

module.exports = { createHttpError, errorHandler };
