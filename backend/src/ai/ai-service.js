'use strict';

const { fail } = require('../domain/domain-error');

const ALLOWED_OPERATIONS = new Set(['flashcards', 'research', 'summarize', 'tags']);
const BEGIN_UNTRUSTED = '--- BEGIN UNTRUSTED CONTENT ---';
const END_UNTRUSTED = '--- END UNTRUSTED CONTENT ---';
const MAX_PROMPT_LENGTH = 20_000;
const MAX_CONTENT_LENGTH = 1_000_000;
const MAX_RESULT_LENGTH = 1_000_000;

function boundedText(value, maximum, allowEmpty = false) {
  return typeof value === 'string' && value.length <= maximum && (allowEmpty || value.length > 0);
}

function identifier(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 256 &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function delimitUntrustedContent(content) {
  const neutralized = content
    .replaceAll(BEGIN_UNTRUSTED, '--- UNTRUSTED CONTENT MARKER ---')
    .replaceAll(END_UNTRUSTED, '--- UNTRUSTED CONTENT MARKER ---');
  return `${BEGIN_UNTRUSTED}\n${neutralized}\n${END_UNTRUSTED}`;
}

function ensureDelimitedUntrustedContent(content) {
  if (content.startsWith(`${BEGIN_UNTRUSTED}\n`) && content.endsWith(`\n${END_UNTRUSTED}`)) {
    return content;
  }
  return delimitUntrustedContent(content);
}

function structuredResult(value) {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return null;
  }
  try {
    const serialized = JSON.stringify(value);
    if (typeof serialized !== 'string' || serialized.length > MAX_RESULT_LENGTH) {
      return null;
    }
    const parsed = JSON.parse(serialized);
    return Object.freeze(parsed);
  } catch {
    return null;
  }
}

function createAiService({ registry, jobs, now } = {}) {
  if (
    registry === null ||
    typeof registry !== 'object' ||
    typeof registry.status !== 'function' ||
    typeof registry.generate !== 'function' ||
    jobs === null ||
    typeof jobs !== 'object' ||
    typeof jobs.enqueue !== 'function' ||
    typeof now !== 'function'
  ) {
    fail('REPOSITORY_CONFIGURATION_INVALID');
  }

  async function queue({
    profileId,
    provider,
    model,
    operation,
    prompt,
    untrustedContent,
    idempotencyKey = null,
  } = {}) {
    if (
      !identifier(profileId) ||
      !identifier(provider) ||
      !identifier(model) ||
      !ALLOWED_OPERATIONS.has(operation) ||
      !boundedText(prompt, MAX_PROMPT_LENGTH) ||
      !boundedText(untrustedContent, MAX_CONTENT_LENGTH, true) ||
      (idempotencyKey !== null && !identifier(idempotencyKey))
    ) {
      fail('REPOSITORY_INPUT_INVALID');
    }
    const configuration = await registry.status({ profileId, provider, model });
    if (configuration.state !== 'configured') {
      return Object.freeze({
        model,
        provider,
        state: 'not_configured',
      });
    }
    const timestamp = now();
    if (!Number.isSafeInteger(timestamp) || timestamp < 0) fail('CLOCK_INVALID');
    const job = jobs.enqueue({
      profileId,
      kind: 'ai.generate',
      idempotencyKey,
      availableAt: timestamp,
      payload: {
        model,
        operation,
        prompt,
        profileId,
        provider,
        untrustedContent: delimitUntrustedContent(untrustedContent),
      },
    });
    return Object.freeze({ jobId: job.id, state: 'queued' });
  }

  async function execute(payload, { signal } = {}) {
    if (signal?.aborted) return Object.freeze({ state: 'cancelled' });
    if (
      payload === null ||
      typeof payload !== 'object' ||
      !identifier(payload.profileId) ||
      !identifier(payload.provider) ||
      !identifier(payload.model) ||
      !ALLOWED_OPERATIONS.has(payload.operation) ||
      !boundedText(payload.prompt, MAX_PROMPT_LENGTH) ||
      !boundedText(payload.untrustedContent, MAX_CONTENT_LENGTH, true)
    ) {
      return Object.freeze({
        errorCode: 'AI_REQUEST_INVALID',
        state: 'failed',
      });
    }
    try {
      const result = await registry.generate(
        {
          profileId: payload.profileId,
          provider: payload.provider,
          model: payload.model,
        },
        {
          operation: payload.operation,
          prompt: payload.prompt,
          signal,
          untrustedContent: ensureDelimitedUntrustedContent(payload.untrustedContent),
        }
      );
      if (signal?.aborted) return Object.freeze({ state: 'cancelled' });
      const normalized = structuredResult(result);
      if (normalized === null) {
        return Object.freeze({
          errorCode: 'AI_OUTPUT_INVALID',
          state: 'failed',
        });
      }
      return Object.freeze({ result: normalized, state: 'completed' });
    } catch (error) {
      if (signal?.aborted || error?.name === 'AbortError') {
        return Object.freeze({ state: 'cancelled' });
      }
      const errorCode =
        error?.code === 'AI_NOT_CONFIGURED'
          ? 'AI_NOT_CONFIGURED'
          : error?.code === 'AI_QUOTA_EXCEEDED'
            ? 'AI_QUOTA_EXCEEDED'
            : error?.code === 'AI_AUTH_FAILED'
              ? 'AI_AUTH_FAILED'
              : 'AI_PROVIDER_FAILED';
      return Object.freeze({ errorCode, state: 'failed' });
    }
  }

  return Object.freeze({
    execute,
    queue,
    status: input => registry.status(input),
  });
}

module.exports = { createAiService };
