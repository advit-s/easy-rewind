'use strict';

const { fail } = require('../domain-error');

function identifier(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 256 &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function createResearchService({ repository, jobs, remoteFetcher, aiService } = {}) {
  if (
    repository === null ||
    typeof repository !== 'object' ||
    !['cancel', 'complete', 'createQueued', 'fail', 'get', 'markRunning', 'transaction'].every(
      method => typeof repository[method] === 'function'
    ) ||
    jobs === null ||
    typeof jobs !== 'object' ||
    typeof jobs.enqueue !== 'function' ||
    remoteFetcher === null ||
    typeof remoteFetcher !== 'object' ||
    typeof remoteFetcher.fetch !== 'function' ||
    aiService === null ||
    typeof aiService !== 'object' ||
    typeof aiService.status !== 'function' ||
    typeof aiService.execute !== 'function'
  ) {
    fail('REPOSITORY_CONFIGURATION_INVALID');
  }

  async function queue({ profileId, query, sourceUrl, provider, model, idempotencyKey = null } = {}) {
    if (
      !identifier(profileId) ||
      !identifier(provider) ||
      !identifier(model) ||
      typeof query !== 'string' ||
      query.length === 0 ||
      query.length > 20_000 ||
      query.trim() !== query ||
      typeof sourceUrl !== 'string' ||
      sourceUrl.length === 0 ||
      sourceUrl.length > 2_048 ||
      (idempotencyKey !== null && !identifier(idempotencyKey))
    ) {
      fail('REPOSITORY_INPUT_INVALID');
    }
    const configuration = await aiService.status({ provider, model });
    if (configuration.state !== 'configured') {
      return Object.freeze({ model, provider, state: 'not_configured' });
    }

    return repository.transaction(() => {
      const research = repository.createQueued({ profileId, query });
      const job = jobs.enqueue({
        profileId,
        kind: 'research.run',
        idempotencyKey,
        payload: {
          model,
          profileId,
          provider,
          query,
          researchId: research.id,
          sourceUrl,
        },
      });
      return Object.freeze({
        jobId: job.id,
        researchId: research.id,
        state: 'queued',
      });
    });
  }

  async function run({ profileId, researchId, query, sourceUrl, provider, model } = {}, { signal } = {}) {
    const current = repository.get({ profileId, id: researchId });
    if (signal?.aborted) {
      repository.cancel({
        profileId,
        id: researchId,
        expectedRevision: current.revision,
      });
      return Object.freeze({ researchId, state: 'cancelled' });
    }

    const running = repository.markRunning({
      profileId,
      id: researchId,
      expectedRevision: current.revision,
    });
    try {
      const source = await remoteFetcher.fetch(sourceUrl);
      if (signal?.aborted) {
        repository.cancel({
          profileId,
          id: researchId,
          expectedRevision: running.revision,
          from: 'running',
        });
        return Object.freeze({ researchId, state: 'cancelled' });
      }
      const generated = await aiService.execute(
        {
          model,
          operation: 'research',
          prompt: query,
          provider,
          untrustedContent: source.body,
        },
        { signal }
      );
      if (generated.state === 'cancelled') {
        repository.cancel({
          profileId,
          id: researchId,
          expectedRevision: running.revision,
          from: 'running',
        });
        return Object.freeze({ researchId, state: 'cancelled' });
      }
      if (generated.state !== 'completed') {
        const errorCode =
          identifier(generated.errorCode) && generated.errorCode.length <= 128
            ? generated.errorCode
            : 'AI_PROVIDER_FAILED';
        repository.fail({
          profileId,
          id: researchId,
          expectedRevision: running.revision,
          errorCode,
        });
        return Object.freeze({ errorCode, researchId, state: 'failed' });
      }
      repository.complete({
        profileId,
        id: researchId,
        expectedRevision: running.revision,
        result: generated.result,
      });
      return Object.freeze({
        researchId,
        result: generated.result,
        state: 'completed',
      });
    } catch {
      repository.fail({
        profileId,
        id: researchId,
        expectedRevision: running.revision,
        errorCode: 'RESEARCH_SOURCE_FAILED',
      });
      return Object.freeze({
        errorCode: 'RESEARCH_SOURCE_FAILED',
        researchId,
        state: 'failed',
      });
    }
  }

  return Object.freeze({
    cancel: input => repository.cancel(input),
    get: input => repository.get(input),
    queue,
    run,
  });
}

module.exports = { createResearchService };
