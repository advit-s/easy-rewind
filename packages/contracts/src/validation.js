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

function jsonStringCodeUnitLength(value) {
  let length = 2;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (
      codeUnit === 0x22 ||
      codeUnit === 0x5c ||
      codeUnit === 0x08 ||
      codeUnit === 0x09 ||
      codeUnit === 0x0a ||
      codeUnit === 0x0c ||
      codeUnit === 0x0d
    ) {
      length += 2;
    } else if (codeUnit <= 0x1f) {
      length += 6;
    } else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff) {
        length += 2;
        index += 1;
      } else {
        length += 6;
      }
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      length += 6;
    } else {
      length += 1;
    }
  }
  return length;
}

export function inspectJsonValue(value, { maxDepth = 32, maxCharacters = 262_144 } = {}) {
  const seen = new Set();

  function visit(current, depth) {
    if (depth > maxDepth) return -1;
    if (current === null) return 4;

    switch (typeof current) {
      case 'string':
        return jsonStringCodeUnitLength(current);
      case 'number':
        return Number.isFinite(current) ? String(current).length : -1;
      case 'boolean':
        return current ? 4 : 5;
      case 'object':
        break;
      default:
        return -1;
    }

    if (seen.has(current)) return -1;
    seen.add(current);

    if (Array.isArray(current)) {
      const keys = Reflect.ownKeys(current);
      const lengthDescriptor = Object.getOwnPropertyDescriptor(current, 'length');
      if (
        !lengthDescriptor ||
        !Object.hasOwn(lengthDescriptor, 'value') ||
        !Number.isSafeInteger(lengthDescriptor.value) ||
        lengthDescriptor.value < 0 ||
        keys.length !== lengthDescriptor.value + 1 ||
        keys.some(
          key =>
            typeof key !== 'string' ||
            (key !== 'length' &&
              (!/^(?:0|[1-9][0-9]*)$/.test(key) ||
                Number(key) >= lengthDescriptor.value ||
                String(Number(key)) !== key))
        )
      ) {
        return -1;
      }
      let length = 2 + Math.max(0, lengthDescriptor.value - 1);
      for (let index = 0; index < lengthDescriptor.value; index += 1) {
        const key = String(index);
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
          return -1;
        }
        const itemLength = visit(descriptor.value, depth + 1);
        if (itemLength < 0) return -1;
        length += itemLength;
      }
      seen.delete(current);
      return length;
    } else {
      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) return -1;
      const keys = Reflect.ownKeys(current);
      if (keys.some(key => typeof key !== 'string')) return -1;
      let length = 2 + Math.max(0, keys.length - 1);
      for (const key of keys) {
        if (FORBIDDEN_JSON_KEYS.has(key)) return -1;
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
          return -1;
        }
        const propertyLength = visit(descriptor.value, depth + 1);
        if (propertyLength < 0) return -1;
        length += jsonStringCodeUnitLength(key) + 1 + propertyLength;
      }
      seen.delete(current);
      return length;
    }
  }

  try {
    const serializedLength = visit(value, 0);
    return serializedLength >= 0 && serializedLength <= maxCharacters;
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
