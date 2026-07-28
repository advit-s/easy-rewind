'use strict';

const { fail } = require('../domain/domain-error');

function identifier(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 128 &&
    value.trim() === value &&
    /^[a-z0-9][a-z0-9._-]*$/i.test(value)
  );
}

function normalizeProviders(providers) {
  if (providers === null || typeof providers !== 'object' || Array.isArray(providers)) {
    fail('REPOSITORY_CONFIGURATION_INVALID');
  }
  const normalized = new Map();
  for (const [name, provider] of Object.entries(providers)) {
    if (
      !identifier(name) ||
      provider === null ||
      typeof provider !== 'object' ||
      !Array.isArray(provider.models) ||
      provider.models.length === 0 ||
      provider.models.some(model => !identifier(model)) ||
      new Set(provider.models).size !== provider.models.length ||
      typeof provider.createClient !== 'function'
    ) {
      fail('REPOSITORY_CONFIGURATION_INVALID');
    }
    normalized.set(
      name,
      Object.freeze({
        createClient: provider.createClient,
        models: new Set(provider.models),
      })
    );
  }
  if (normalized.size === 0) fail('REPOSITORY_CONFIGURATION_INVALID');
  return normalized;
}

function createProviderRegistry({ secretStore, providers } = {}) {
  if (
    secretStore === null ||
    typeof secretStore !== 'object' ||
    !['get', 'set', 'delete'].every(operation => typeof secretStore[operation] === 'function')
  ) {
    fail('REPOSITORY_CONFIGURATION_INVALID');
  }
  const allowed = normalizeProviders(providers);

  function selection({ provider, model } = {}) {
    if (
      !identifier(provider) ||
      !identifier(model) ||
      !allowed.has(provider) ||
      !allowed.get(provider).models.has(model)
    ) {
      fail('REPOSITORY_INPUT_INVALID');
    }
    return { model, provider };
  }

  function secretName(provider) {
    return `ai/${provider}/api-key`;
  }

  async function status(input) {
    const selected = selection(input);
    const apiKey = await secretStore.get(secretName(selected.provider));
    return Object.freeze({
      ...selected,
      state: apiKey === null ? 'not_configured' : 'configured',
    });
  }

  async function configure({ provider, model, apiKey } = {}) {
    const selected = selection({ provider, model });
    if (typeof apiKey !== 'string' || apiKey.length < 1 || apiKey.length > 16_384) {
      fail('REPOSITORY_INPUT_INVALID');
    }
    await secretStore.set(secretName(selected.provider), apiKey);
    return Object.freeze({ ...selected, state: 'configured' });
  }

  async function clear(input) {
    const selected = selection(input);
    await secretStore.delete(secretName(selected.provider));
    return Object.freeze({ ...selected, state: 'not_configured' });
  }

  async function client(input) {
    const selected = selection(input);
    const apiKey = await secretStore.get(secretName(selected.provider));
    if (apiKey === null) return null;
    let created;
    try {
      created = await allowed.get(selected.provider).createClient({ apiKey, model: selected.model });
    } catch {
      return null;
    }
    if (created === null || typeof created !== 'object' || typeof created.generate !== 'function') {
      return null;
    }
    return created;
  }

  async function testConfiguration(input) {
    const selected = selection(input);
    const created = await client(selected);
    if (created === null || typeof created.test !== 'function') {
      return Object.freeze({ ...selected, state: 'error' });
    }
    try {
      const valid = await created.test();
      return Object.freeze({
        ...selected,
        state: valid === true ? 'configured' : 'error',
      });
    } catch {
      return Object.freeze({ ...selected, state: 'error' });
    }
  }

  async function generate(input, request) {
    const selected = selection(input);
    const created = await client(selected);
    if (created === null) {
      const error = new Error('AI provider is not configured.');
      error.code = 'AI_NOT_CONFIGURED';
      throw error;
    }
    return created.generate(request);
  }

  return Object.freeze({
    clear,
    configure,
    generate,
    rotate: configure,
    status,
    test: testConfiguration,
  });
}

module.exports = { createProviderRegistry };
