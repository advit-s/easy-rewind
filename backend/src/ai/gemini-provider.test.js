'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createGeminiProvider } = require('./gemini-provider');

function fixture(text = '{"summary":"Grounded"}') {
  const calls = [];
  const provider = createGeminiProvider({
    clientFactory(apiKey) {
      calls.push(['client', apiKey]);
      return {
        getGenerativeModel({ model }) {
          calls.push(['model', model]);
          return {
            async generateContent(prompt) {
              calls.push(['generate', prompt]);
              return {
                response: {
                  text() {
                    return text;
                  },
                },
              };
            },
          };
        },
      };
    },
  });
  return { calls, provider };
}

test('Gemini provider exposes a frozen allowlist and parses JSON-only structured output', async () => {
  const context = fixture();
  const client = context.provider.createClient({
    apiKey: 'private-key',
    model: 'gemini-2.5-flash',
  });
  const result = await client.generate({
    operation: 'research',
    prompt: 'Use only the supplied source.',
    untrustedContent: '--- BEGIN UNTRUSTED CONTENT ---\nsource\n--- END UNTRUSTED CONTENT ---',
    signal: new AbortController().signal,
  });

  assert.deepEqual(result, { summary: 'Grounded' });
  assert.deepEqual(context.provider.models, ['gemini-2.5-flash']);
  assert.equal(Object.isFrozen(context.provider), true);
  assert.match(context.calls[2][1], /Return exactly one JSON object/);
  assert.match(context.calls[2][1], /BEGIN UNTRUSTED CONTENT/);
  assert.doesNotMatch(context.calls[2][1], /private-key/);
});

test('Gemini provider rejects invalid structured output and maps provider failures safely', async () => {
  const invalid = fixture('not-json').provider.createClient({
    apiKey: 'private-key',
    model: 'gemini-2.5-flash',
  });
  await assert.rejects(
    invalid.generate({
      operation: 'summarize',
      prompt: 'Summarize.',
      untrustedContent: 'source',
      signal: new AbortController().signal,
    }),
    error => error.code === 'AI_OUTPUT_INVALID' && !error.message.includes('not-json')
  );

  const failed = createGeminiProvider({
    clientFactory() {
      return {
        getGenerativeModel() {
          return {
            async generateContent() {
              throw Object.assign(new Error('private provider response'), {
                status: 429,
              });
            },
          };
        },
      };
    },
  }).createClient({ apiKey: 'private-key', model: 'gemini-2.5-flash' });
  await assert.rejects(
    failed.generate({
      operation: 'summarize',
      prompt: 'Summarize.',
      untrustedContent: 'source',
      signal: new AbortController().signal,
    }),
    error =>
      error.code === 'AI_QUOTA_EXCEEDED' &&
      !error.message.includes('private provider response') &&
      !error.message.includes('private-key')
  );
});

test('Gemini provider honors cancellation before contacting the SDK', async () => {
  const context = fixture();
  const client = context.provider.createClient({
    apiKey: 'private-key',
    model: 'gemini-2.5-flash',
  });
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    client.generate({
      operation: 'summarize',
      prompt: 'Summarize.',
      untrustedContent: 'source',
      signal: controller.signal,
    }),
    error => error.name === 'AbortError'
  );
  assert.deepEqual(
    context.calls.map(call => call[0]),
    ['client', 'model']
  );
});
