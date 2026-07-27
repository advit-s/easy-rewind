import { createSchemaValidator } from './validation.js';

const HEALTH_SCHEMA_ID = 'https://contracts.easy-rewind.invalid/schema/health.json';

export const HEALTH_STATUSES = Object.freeze(['ok', 'degraded', 'unavailable']);
export const HEALTH_MODES = Object.freeze(['production', 'standalone', 'test']);
export const COMPONENT_STATUSES = Object.freeze(['ready', 'degraded', 'unavailable', 'disabled']);

export const validateHealthResponse = createSchemaValidator(`${HEALTH_SCHEMA_ID}#/$defs/HealthResponse`);
