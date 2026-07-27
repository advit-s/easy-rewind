import { createSchemaValidator } from './validation.js';

const ERROR_SCHEMA_ID = 'https://contracts.easy-rewind.invalid/schema/errors.json';

export const ERROR_CODES = Object.freeze([
  'auth_required',
  'auth_invalid',
  'forbidden',
  'not_found',
  'validation_failed',
  'conflict',
  'rate_limited',
  'internal_error',
  'api_version_unsupported',
  'cursor_expired',
  'device_revoked',
  'not_implemented',
]);

const unsafeMessagePattern =
  /(?:localhost|(?:\d{1,3}\.){3}\d{1,3}|token\s*[=:]|password|credential|secret|api[_ -]?key)/i;

export const validateErrorResponse = createSchemaValidator(`${ERROR_SCHEMA_ID}#/$defs/ErrorResponse`, {
  postvalidate(value) {
    return !unsafeMessagePattern.test(value.error.message);
  },
});
