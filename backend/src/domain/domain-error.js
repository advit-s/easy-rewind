'use strict';

const DOMAIN_ERROR_MESSAGES = Object.freeze({
  REPOSITORY_CONFIGURATION_INVALID: 'Repository configuration is invalid.',
  REPOSITORY_INPUT_INVALID: 'Repository input is invalid.',
  PAGINATION_INVALID: 'Pagination input is invalid.',
  CURSOR_INVALID: 'The pagination cursor is invalid.',
  JSON_INVALID: 'Stored JSON is invalid.',
  ID_INVALID: 'An identifier could not be allocated.',
  CLOCK_INVALID: 'The current time is invalid.',
  NOT_FOUND: 'The requested resource was not found.',
  CONFLICT: 'The resource has changed since it was read.',
});

const DOMAIN_ERROR_STATUS = Object.freeze({
  REPOSITORY_CONFIGURATION_INVALID: 500,
  REPOSITORY_INPUT_INVALID: 400,
  PAGINATION_INVALID: 400,
  CURSOR_INVALID: 400,
  JSON_INVALID: 400,
  ID_INVALID: 500,
  CLOCK_INVALID: 500,
  NOT_FOUND: 404,
  CONFLICT: 409,
});

class DomainError extends Error {
  constructor(code) {
    const safeCode = Object.hasOwn(DOMAIN_ERROR_MESSAGES, code) ? code : 'REPOSITORY_INPUT_INVALID';
    super(DOMAIN_ERROR_MESSAGES[safeCode]);
    this.name = 'DomainError';
    this.code = safeCode;
    this.statusCode = DOMAIN_ERROR_STATUS[safeCode];
  }
}

function fail(code) {
  throw new DomainError(code);
}

module.exports = {
  DOMAIN_ERROR_MESSAGES,
  DomainError,
  fail,
};
