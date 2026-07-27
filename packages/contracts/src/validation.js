import Ajv2020 from 'ajv/dist/2020.js';
import commonSchema from '../schema/common.json' with { type: 'json' };
import errorSchema from '../schema/errors.json' with { type: 'json' };
import healthSchema from '../schema/health.json' with { type: 'json' };
import paginationSchema from '../schema/pagination.json' with { type: 'json' };
import pairingSchema from '../schema/pairing.json' with { type: 'json' };
import reminderSchema from '../schema/reminders.json' with { type: 'json' };
import syncSchema from '../schema/sync.json' with { type: 'json' };

const FORBIDDEN_JSON_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const ajv = new Ajv2020({
  allErrors: true,
  allowUnionTypes: false,
  strict: true,
  validateFormats: false,
});

for (const schema of [
  commonSchema,
  errorSchema,
  healthSchema,
  paginationSchema,
  pairingSchema,
  reminderSchema,
  syncSchema,
]) {
  ajv.addSchema(schema);
}

function invalid(message = 'Contract validation failed.') {
  return {
    valid: false,
    errors: [{ code: 'validation_failed', message }],
  };
}

function schemaErrors(errors) {
  const keywords = [...new Set((errors ?? []).map(error => error.keyword))].sort();
  return {
    valid: false,
    errors: keywords.map(keyword => ({
      code: 'validation_failed',
      message: `Contract validation failed (${keyword}).`,
    })),
  };
}

export function inspectJsonValue(value, { maxDepth = 32, maxCharacters = 262_144 } = {}) {
  const seen = new Set();
  let characters = 0;

  function visit(current, depth) {
    if (depth > maxDepth) return false;
    if (current === null) {
      characters += 4;
      return characters <= maxCharacters;
    }

    switch (typeof current) {
      case 'string':
        characters += current.length + 2;
        return characters <= maxCharacters;
      case 'number':
        if (!Number.isFinite(current)) return false;
        characters += String(current).length;
        return characters <= maxCharacters;
      case 'boolean':
        characters += current ? 4 : 5;
        return characters <= maxCharacters;
      case 'object':
        break;
      default:
        return false;
    }

    if (seen.has(current)) return false;
    seen.add(current);
    characters += 2;

    if (Array.isArray(current)) {
      for (const entry of current) {
        characters += 1;
        if (!visit(entry, depth + 1)) return false;
      }
    } else {
      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) return false;
      for (const key of Object.keys(current)) {
        if (FORBIDDEN_JSON_KEYS.has(key)) return false;
        characters += key.length + 3;
        if (!visit(current[key], depth + 1)) return false;
      }
    }

    seen.delete(current);
    return characters <= maxCharacters;
  }

  return visit(value, 0);
}

export function createSchemaValidator(schemaReference, options = {}) {
  const validate = ajv.compile({ $ref: schemaReference });

  return value => {
    if (!inspectJsonValue(value)) return invalid('Contract validation failed (unsafe_value).');
    if (options.prevalidate && options.prevalidate(value) === false) {
      return invalid('Contract validation failed (semantic_rule).');
    }
    if (!validate(value)) return schemaErrors(validate.errors);
    if (options.postvalidate && options.postvalidate(value) === false) {
      return invalid('Contract validation failed (semantic_rule).');
    }
    return { valid: true, errors: [] };
  };
}

export function invalidContract(message) {
  return invalid(message);
}
