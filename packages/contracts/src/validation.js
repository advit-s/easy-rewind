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

  function visit(current, depth) {
    if (depth > maxDepth) return false;
    if (current === null) return true;

    switch (typeof current) {
      case 'string':
        return true;
      case 'number':
        return Number.isFinite(current);
      case 'boolean':
        return true;
      case 'object':
        break;
      default:
        return false;
    }

    if (seen.has(current)) return false;
    seen.add(current);

    if (Array.isArray(current)) {
      const keys = Object.keys(current);
      if (keys.length !== current.length || keys.some((key, index) => key !== String(index))) {
        return false;
      }
      for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (!descriptor || !Object.hasOwn(descriptor, 'value')) return false;
        if (!visit(descriptor.value, depth + 1)) return false;
      }
    } else {
      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) return false;
      const keys = Reflect.ownKeys(current);
      if (keys.some(key => typeof key !== 'string')) return false;
      for (const key of keys) {
        if (FORBIDDEN_JSON_KEYS.has(key)) return false;
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
          return false;
        }
        if (!visit(descriptor.value, depth + 1)) return false;
      }
    }

    seen.delete(current);
    return true;
  }

  try {
    if (!visit(value, 0)) return false;
    const serialized = JSON.stringify(value);
    return typeof serialized === 'string' && serialized.length <= maxCharacters;
  } catch {
    return false;
  }
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
