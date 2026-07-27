import { createSchemaValidator } from './validation.js';

const PAGINATION_SCHEMA_ID = 'https://contracts.easy-rewind.invalid/schema/pagination.json';

export const MAX_PAGE_LIMIT = 100;

export const validatePaginationRequest = createSchemaValidator(`${PAGINATION_SCHEMA_ID}#/$defs/PaginationRequest`);

export const validatePaginationResponse = createSchemaValidator(`${PAGINATION_SCHEMA_ID}#/$defs/PaginationResponse`, {
  postvalidate(value) {
    return value.hasMore ? value.nextCursor !== null : value.nextCursor === null;
  },
});
