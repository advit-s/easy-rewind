'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { DomainError } = require('../domain/domain-error');
const { createAiService } = require('./ai-service');
const { createProviderRegistry } = require('./provider-registry');

function fixture() {
  const secrets = new Map();
  const providerCalls = [];
  const queued = [];
  const secretStore = {
    async get(name) {
      return secrets.get(name) ?? null;
    },
    async set(name, value) {
      secrets.set(name, value);
    },
    async delete(name) {
      secrets.delete(name);
    },
  };
  const registry = createProviderRegistry({
    secretStore,
    providers: {
      gemini: {
        models: ['gemini-2.5-flash'],
        createClient({ apiKey, model }) {
          providerCalls.push(['create', apiKey, model]);
          return {
            async test() {
              providerCalls.push(['test']);
              return true;
            },
            async generate(input) {
              providerCalls.push(['generate', input]);
              return { summary: 'Grounded summary', tags: ['local-first'] };
            },
          };
        },
      },
    },
  });
  const jobs = {
    enqueue(input) {
      queued.push(input);
      return { id: `job-${queued.length}`, state: 'queued' };
    },
  };
  const service = createAiService({
    registry,
    jobs,
    now: () => 1_800_000_000_000,
  });
  return { jobs, providerCalls, queued, registry, secrets, service };
}

test('provider configuration validates allowlists and never echoes credentials', async () => {
  const context = fixture();
  const apiKey = 'replacement-key-must-never-be-returned';

  const configured = await context.registry.configure({
    profileId: 'profile-one',
    provider: 'gemini',
    model: 'gemini-2.5-flash',
    apiKey,
  });
  assert.deepEqual(configured, {
    model: 'gemini-2.5-flash',
    provider: 'gemini',
    state: 'configured',
  });
  assert.doesNotMatch(JSON.stringify(configured), new RegExp(apiKey));
  assert.equal(
    (
      await context.registry.status({
        ...configured,
        profileId: 'profile-one',
      })
    ).state,
    'configured'
  );

  const tested = await context.registry.test({
    ...configured,
    profileId: 'profile-one',
  });
  assert.equal(tested.state, 'configured');
  assert.equal(context.providerCalls[0][1], apiKey);
  assert.doesNotMatch(JSON.stringify(tested), new RegExp(apiKey));

  await context.registry.clear({ ...configured, profileId: 'profile-one' });
  assert.equal(
    (
      await context.registry.status({
        ...configured,
        profileId: 'profile-one',
      })
    ).state,
    'not_configured'
  );

  await assert.rejects(
    context.registry.configure({
      profileId: 'profile-one',
      provider: 'gemini',
      model: 'made-up-model',
      apiKey,
    }),
    error =>
      error instanceof DomainError && error.code === 'REPOSITORY_INPUT_INVALID' && !error.message.includes(apiKey)
  );
});

test('credential rotation replaces protected storage without exposing either key', async () => {
  const context = fixture();
  await context.registry.configure({
    profileId: 'profile-one',
    provider: 'gemini',
    model: 'gemini-2.5-flash',
    apiKey: 'old-private-key',
  });

  const result = await context.registry.rotate({
    profileId: 'profile-one',
    provider: 'gemini',
    model: 'gemini-2.5-flash',
    apiKey: 'new-private-key',
  });

  assert.equal(context.secrets.get('ai/profile-one/gemini/api-key'), 'new-private-key');
  assert.doesNotMatch(JSON.stringify(result), /old-private-key|new-private-key/);
});

test('provider credentials remain isolated by owner profile', async () => {
  const context = fixture();
  await context.registry.configure({
    profileId: 'profile-one',
    provider: 'gemini',
    model: 'gemini-2.5-flash',
    apiKey: 'profile-one-key',
  });

  assert.equal(
    (
      await context.registry.status({
        profileId: 'profile-one',
        provider: 'gemini',
        model: 'gemini-2.5-flash',
      })
    ).state,
    'configured'
  );
  assert.equal(
    (
      await context.registry.status({
        profileId: 'profile-two',
        provider: 'gemini',
        model: 'gemini-2.5-flash',
      })
    ).state,
    'not_configured'
  );
});

test('AI queueing is truthful when configuration is missing', async () => {
  const context = fixture();

  assert.deepEqual(
    await context.service.queue({
      profileId: 'profile-one',
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      operation: 'summarize',
      prompt: 'Summarize this source.',
      untrustedContent: '<p>source</p>',
    }),
    {
      model: 'gemini-2.5-flash',
      provider: 'gemini',
      state: 'not_configured',
    }
  );
  assert.equal(context.queued.length, 0);
});

test('configured AI queues bounded delimited content without provider credentials', async () => {
  const context = fixture();
  await context.registry.configure({
    profileId: 'profile-one',
    provider: 'gemini',
    model: 'gemini-2.5-flash',
    apiKey: 'private-key',
  });

  const result = await context.service.queue({
    profileId: 'profile-one',
    provider: 'gemini',
    model: 'gemini-2.5-flash',
    operation: 'summarize',
    prompt: 'Summarize this source.',
    untrustedContent: '<p>source</p>',
    idempotencyKey: 'research-one',
  });

  assert.deepEqual(result, { jobId: 'job-1', state: 'queued' });
  assert.equal(context.queued[0].kind, 'ai.generate');
  assert.equal(context.queued[0].profileId, 'profile-one');
  assert.equal(context.queued[0].idempotencyKey, 'research-one');
  assert.match(context.queued[0].payload.untrustedContent, /^--- BEGIN UNTRUSTED CONTENT ---\n/);
  assert.match(context.queued[0].payload.untrustedContent, /\n--- END UNTRUSTED CONTENT ---$/);
  assert.doesNotMatch(JSON.stringify(context.queued[0]), /private-key/);

  await assert.rejects(
    context.service.queue({
      profileId: 'profile-one',
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      operation: 'summarize',
      prompt: 'x'.repeat(20_001),
      untrustedContent: '',
    }),
    error => error instanceof DomainError && error.code === 'REPOSITORY_INPUT_INVALID'
  );
});

test('execution validates structured provider output and reports failure or cancellation truthfully', async () => {
  const context = fixture();
  await context.registry.configure({
    profileId: 'profile-one',
    provider: 'gemini',
    model: 'gemini-2.5-flash',
    apiKey: 'private-key',
  });
  const payload = {
    profileId: 'profile-one',
    provider: 'gemini',
    model: 'gemini-2.5-flash',
    operation: 'summarize',
    prompt: 'Summarize.',
    untrustedContent: '--- BEGIN UNTRUSTED CONTENT ---\nsource\n--- END UNTRUSTED CONTENT ---',
  };

  assert.deepEqual(await context.service.execute(payload, { signal: new AbortController().signal }), {
    result: { summary: 'Grounded summary', tags: ['local-first'] },
    state: 'completed',
  });
  await context.service.execute(
    { ...payload, untrustedContent: '<p>remote source</p>' },
    { signal: new AbortController().signal }
  );
  const generatedRequest = context.providerCalls.at(-1)[1];
  assert.match(generatedRequest.untrustedContent, /^--- BEGIN UNTRUSTED CONTENT ---\n/);
  assert.match(generatedRequest.untrustedContent, /\n--- END UNTRUSTED CONTENT ---$/);

  const broken = createAiService({
    registry: {
      status: context.registry.status,
      async generate() {
        return 'fabricated';
      },
    },
    jobs: context.jobs,
    now: () => 1,
  });
  assert.deepEqual(await broken.execute(payload, { signal: new AbortController().signal }), {
    errorCode: 'AI_OUTPUT_INVALID',
    state: 'failed',
  });

  const controller = new AbortController();
  controller.abort();
  assert.deepEqual(await context.service.execute(payload, { signal: controller.signal }), {
    state: 'cancelled',
  });
});
