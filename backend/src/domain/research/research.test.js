'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');

const BetterSqlite3 = require('better-sqlite3');
const { DomainError, createRepositoryUtils } = require('../repository-utils');
const { createResearchRepository } = require('./research-repository');
const { createResearchService } = require('./research-service');

const NOW = Date.UTC(2026, 6, 28, 16);

function fixture({ configurationState = 'configured', aiResult } = {}) {
  const db = new BetterSqlite3(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(readFileSync(join(__dirname, '..', '..', 'database', 'migrations', '001_core.sql'), 'utf8'));
  for (const id of ['profile-one', 'profile-two']) {
    db.prepare(
      `INSERT INTO profiles(id, display_name, created_at, updated_at)
       VALUES (?, ?, ?, ?)`
    ).run(id, id, NOW, NOW);
  }
  let sequence = 0;
  let currentTime = NOW;
  const repositoryUtils = createRepositoryUtils({
    db,
    ids: () => `research-${String((sequence += 1)).padStart(3, '0')}`,
    now: () => currentTime,
  });
  const repository = createResearchRepository({ db, repositoryUtils });
  const jobs = [];
  const fetched = [];
  const aiCalls = [];
  const service = createResearchService({
    repository,
    jobs: {
      enqueue(input) {
        jobs.push(input);
        return { id: `job-${jobs.length}`, state: 'queued' };
      },
    },
    remoteFetcher: {
      async fetch(url) {
        fetched.push(url);
        return { body: '<main>Verified source</main>', contentType: 'text/html' };
      },
    },
    aiService: {
      async status() {
        return { state: configurationState };
      },
      async execute(payload, context) {
        aiCalls.push([payload, context]);
        return (
          aiResult ?? {
            state: 'completed',
            result: { summary: 'Source-backed result' },
          }
        );
      },
    },
  });
  return {
    aiCalls,
    db,
    fetched,
    jobs,
    repository,
    service,
    setTime(value) {
      currentTime = value;
    },
  };
}

test('missing AI configuration returns not_configured without creating fake work', async t => {
  const context = fixture({ configurationState: 'not_configured' });
  t.after(() => context.db.close());

  const result = await context.service.queue({
    profileId: 'profile-one',
    query: 'Investigate local-first synchronization',
    sourceUrl: 'https://example.com/source',
    provider: 'gemini',
    model: 'gemini-2.5-flash',
  });

  assert.deepEqual(result, {
    model: 'gemini-2.5-flash',
    provider: 'gemini',
    state: 'not_configured',
  });
  assert.equal(context.jobs.length, 0);
  assert.equal(context.db.prepare('SELECT COUNT(*) FROM research_jobs').pluck().get(), 0);
});

test('queueing persists owner-scoped research and one durable job', async t => {
  const context = fixture();
  t.after(() => context.db.close());

  const queued = await context.service.queue({
    profileId: 'profile-one',
    query: 'Investigate local-first synchronization',
    sourceUrl: 'https://example.com/source',
    provider: 'gemini',
    model: 'gemini-2.5-flash',
    idempotencyKey: 'research-request-one',
  });

  assert.deepEqual(queued, {
    jobId: 'job-1',
    researchId: 'research-001',
    state: 'queued',
  });
  assert.equal(context.jobs.length, 1);
  assert.equal(context.jobs[0].kind, 'research.run');
  assert.equal(context.jobs[0].idempotencyKey, 'research-request-one');
  assert.equal(
    context.repository.get({
      profileId: 'profile-one',
      id: queued.researchId,
    }).state,
    'queued'
  );
  assert.throws(
    () =>
      context.repository.get({
        profileId: 'profile-two',
        id: queued.researchId,
      }),
    error => error instanceof DomainError && error.code === 'NOT_FOUND'
  );
});

test('research execution uses hardened fetch output and records completed truthfully', async t => {
  const context = fixture();
  t.after(() => context.db.close());
  const queued = await context.service.queue({
    profileId: 'profile-one',
    query: 'Investigate local-first synchronization',
    sourceUrl: 'https://example.com/source',
    provider: 'gemini',
    model: 'gemini-2.5-flash',
  });

  const result = await context.service.run(context.jobs[0].payload, { signal: new AbortController().signal });

  assert.deepEqual(result, {
    researchId: queued.researchId,
    result: { summary: 'Source-backed result' },
    state: 'completed',
  });
  assert.deepEqual(context.fetched, ['https://example.com/source']);
  assert.match(context.aiCalls[0][0].untrustedContent, /Verified source/);
  const stored = context.repository.get({
    profileId: 'profile-one',
    id: queued.researchId,
  });
  assert.equal(stored.state, 'succeeded');
  assert.deepEqual(stored.result, { summary: 'Source-backed result' });
});

test('provider failure and cancellation never become completed research', async t => {
  const failed = fixture({
    aiResult: { state: 'failed', errorCode: 'AI_PROVIDER_FAILED' },
  });
  t.after(() => failed.db.close());
  await failed.service.queue({
    profileId: 'profile-one',
    query: 'Failure',
    sourceUrl: 'https://example.com/failure',
    provider: 'gemini',
    model: 'gemini-2.5-flash',
  });
  assert.deepEqual(
    await failed.service.run(failed.jobs[0].payload, {
      signal: new AbortController().signal,
    }),
    {
      errorCode: 'AI_PROVIDER_FAILED',
      researchId: 'research-001',
      state: 'failed',
    }
  );
  assert.equal(failed.repository.get({ profileId: 'profile-one', id: 'research-001' }).state, 'failed');

  const cancelled = fixture();
  t.after(() => cancelled.db.close());
  await cancelled.service.queue({
    profileId: 'profile-one',
    query: 'Cancel',
    sourceUrl: 'https://example.com/cancel',
    provider: 'gemini',
    model: 'gemini-2.5-flash',
  });
  const controller = new AbortController();
  controller.abort();
  assert.deepEqual(
    await cancelled.service.run(cancelled.jobs[0].payload, {
      signal: controller.signal,
    }),
    { researchId: 'research-001', state: 'cancelled' }
  );
  assert.equal(cancelled.fetched.length, 0);
});
