'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createStage3CompatibilityService } = require('./stage3-compatibility-service');

const PROFILE = '10000000-0000-4000-8000-000000000001';

function harness(overrides = {}) {
  const calls = [];
  const record = (service, method, result) => input => {
    calls.push([service, method, input]);
    return typeof result === 'function' ? result(input) : result;
  };
  const contentService = {
    createBookmark: record('content', 'createBookmark', { id: 'bookmark-1', itemId: 'item-1', revision: 1 }),
    createHighlight: record('content', 'createHighlight', {
      id: 'highlight-1',
      itemId: 'item-1',
      quote: 'Selected text',
      revision: 1,
    }),
    createItem: record('content', 'createItem', {
      id: 'item-1',
      kind: 'webpage',
      title: 'Example',
      url: 'https://example.com',
      revision: 1,
    }),
    createNote: record('content', 'createNote', { id: 'note-1', body: 'Remember this', revision: 1 }),
    deleteEntity: record('content', 'deleteEntity', { id: 'entity-1', revision: 2 }),
    deleteItem: record('content', 'deleteItem', { id: 'item-1', revision: 2 }),
    getEntity: record('content', 'getEntity', { id: 'entity-1', revision: 1 }),
    getItem: record('content', 'getItem', {
      id: 'item-1',
      title: 'Example',
      url: 'https://example.com',
      revision: 1,
    }),
    listEntities: record('content', 'listEntities', {
      items: [{ id: 'entity-1', itemId: 'item-1', revision: 1 }],
      nextCursor: 'next',
      hasMore: true,
    }),
    listItems: record('content', 'listItems', {
      items: [{ id: 'item-1', title: 'Example' }],
      nextCursor: null,
      hasMore: false,
    }),
    searchItems: record('content', 'searchItems', [{ id: 'item-1', title: 'Example' }]),
    updateEntity: record('content', 'updateEntity', { id: 'entity-1', revision: 2 }),
  };
  const graphService = {
    createConnection: record('graph', 'createConnection', { id: 'connection-1', revision: 1 }),
    knowledgeGraph: record('graph', 'knowledgeGraph', {
      nodes: [{ id: 'item-1' }],
      edges: [],
    }),
    relatedItems: record('graph', 'relatedItems', [{ id: 'item-2' }]),
  };
  const learningService = {
    createDigest: record('learning', 'createDigest', { id: 'digest-1', revision: 1 }),
    listDigests: record('learning', 'listDigests', {
      items: [{ id: 'digest-1', title: 'Weekly' }],
      nextCursor: null,
      hasMore: false,
    }),
    statistics: record('learning', 'statistics', {
      activeFlashcards: 3,
      dueFlashcards: 1,
      quizAttempts: 2,
      averageQuizPercent: 80,
    }),
  };
  const reminderService = {
    listReminders: record('reminder', 'listReminders', {
      items: [{ id: 'reminder-1', state: 'pending' }],
      nextCursor: null,
      hasMore: false,
    }),
    transitionReminder: record('reminder', 'transitionReminder', {
      id: 'reminder-1',
      state: 'completed',
      revision: 2,
    }),
  };
  const researchService = {
    list: record('research', 'list', {
      items: [{ id: 'research-1', state: 'queued' }],
      nextCursor: null,
      hasMore: false,
    }),
    queue: record('research', 'queue', {
      jobId: 'job-1',
      researchId: 'research-1',
      state: 'queued',
    }),
  };
  const aiService = {
    execute: record('ai', 'execute', {
      state: 'completed',
      result: { summary: 'A safe summary', providerToken: 'must-not-leak' },
    }),
  };
  const exportService = {
    create: record('export', 'create', {
      runId: 'export-1',
      state: 'succeeded',
      bundle: { manifest: {}, data: { items: [] } },
    }),
  };
  const importService = {
    dryRun: record('import', 'dryRun', {
      totalRows: 2,
      conflicts: [],
    }),
  };
  const settingsService = {
    readSettings: record('settings', 'readSettings', { settings: { theme: 'dark' }, revisions: { theme: 1 } }),
    updateSettings: record('settings', 'updateSettings', { settings: { theme: 'light' }, revisions: { theme: 2 } }),
    readDigestSettings: record('settings', 'readDigestSettings', {
      settings: { enabled: true },
      revisions: {},
    }),
    updateDigestSettings: record('settings', 'updateDigestSettings', {
      settings: { enabled: false },
      revisions: { enabled: 2 },
    }),
  };

  const service = createStage3CompatibilityService({
    contentService,
    graphService,
    learningService,
    reminderService,
    researchService,
    aiService,
    exportService,
    importService,
    settingsService,
    now: () => 1_800_000_000_000,
    ...overrides,
  });
  return { calls, service };
}

function invoke(service, operation, overrides = {}) {
  return service.handle({
    operation,
    context: { profileId: PROFILE, deviceId: 'device-1' },
    params: {},
    query: {},
    body: {},
    ...overrides,
  });
}

test('item reads derive ownership only from context and preserve cursor envelopes', async () => {
  const { calls, service } = harness();
  const result = await invoke(service, 'items.list', {
    body: { profileId: 'attacker' },
    pagination: { cursor: 'cursor-1', limit: 12 },
    query: { includeArchived: 'true' },
  });

  assert.deepEqual(result, {
    items: [{ id: 'item-1', title: 'Example' }],
    nextCursor: null,
    hasMore: false,
  });
  assert.deepEqual(calls[0], [
    'content',
    'listItems',
    { profileId: PROFILE, cursor: 'cursor-1', limit: 12, includeArchived: true },
  ]);
});

test('legacy bookmark creation composes canonical item and bookmark records', async () => {
  const { calls, service } = harness();
  const result = await invoke(service, 'bookmarks.create', {
    body: {
      url: 'https://example.com',
      title: 'Example',
      topic: 'Local first',
      notes: 'Read later',
      profileId: 'attacker',
    },
  });

  assert.equal(result.status, 201);
  assert.equal(result.body.success, true);
  assert.equal(result.body.bookmark.url, 'https://example.com');
  assert.deepEqual(calls, [
    [
      'content',
      'createItem',
      {
        profileId: PROFILE,
        item: {
          kind: 'webpage',
          title: 'Example',
          url: 'https://example.com',
          excerpt: 'Local first',
          body: 'Read later',
        },
      },
    ],
    ['content', 'createBookmark', { profileId: PROFILE, itemId: 'item-1' }],
  ]);
});

test('provider credentials and nested secrets are rejected before any service call', async () => {
  const { calls, service } = harness();

  await assert.rejects(
    invoke(service, 'items.create', {
      body: { kind: 'note', title: 'Unsafe', provider: { apiKey: 'exposed' } },
    }),
    { code: 'validation_failed' }
  );
  await assert.rejects(
    invoke(service, 'items.search', {
      query: { q: 'safe', options: { clientSecret: 'exposed' } },
    }),
    { code: 'validation_failed' }
  );
  await assert.rejects(
    invoke(service, 'settings.update', {
      body: { password: 'exposed' },
    }),
    { code: 'validation_failed' }
  );
  assert.equal(calls.length, 0);
});

test('search and graph operations translate canonical results to legacy client shapes', async () => {
  const { calls, service } = harness();

  assert.deepEqual(await invoke(service, 'items.search', { query: { q: 'Example', limit: '8' } }), {
    results: [{ id: 'item-1', title: 'Example' }],
    items: [{ id: 'item-1', title: 'Example' }],
    count: 1,
  });
  assert.deepEqual(await invoke(service, 'items.related', { params: { id: 'item-1' } }), {
    related: [{ id: 'item-2' }],
  });
  assert.deepEqual(await invoke(service, 'knowledgeGraph.read'), {
    nodes: [{ id: 'item-1' }],
    edges: [],
  });
  assert.deepEqual(calls[0][2], { profileId: PROFILE, query: 'Example', limit: 8 });
  assert.deepEqual(calls[1][2], { profileId: PROFILE, itemId: 'item-1' });
  assert.deepEqual(calls[2][2], { profileId: PROFILE });
});

test('legacy notes and highlights map fields and retain paginated legacy aliases', async () => {
  const { calls, service } = harness();

  const note = await invoke(service, 'notes.create', {
    body: { content: 'Remember this', source_url: 'https://example.com' },
  });
  assert.equal(note.body.note.content, 'Remember this');

  const highlight = await invoke(service, 'highlights.create', {
    body: {
      url: 'https://example.com',
      page_title: 'Example',
      text: 'Selected text',
      context: 'Around the selection',
      color: 'yellow',
    },
  });
  assert.equal(highlight.body.highlight.text, 'Selected text');

  const listed = await invoke(service, 'highlights.list', {
    pagination: { limit: 10 },
  });
  assert.equal(listed.items.length, 1);
  assert.equal(listed.highlights[0].url, 'https://example.com');
  assert.equal(listed.nextCursor, 'next');
  assert.equal(listed.hasMore, true);

  assert.deepEqual(calls[0], ['content', 'createNote', { profileId: PROFILE, itemId: null, body: 'Remember this' }]);
  assert.equal(
    calls.some(call => call[1] === 'createHighlight'),
    true
  );
});

test('canonical mutations require an explicit positive expected revision', async () => {
  const { calls, service } = harness();

  await assert.rejects(invoke(service, 'items.delete', { params: { id: 'item-1' } }), {
    code: 'validation_failed',
  });
  await invoke(service, 'items.delete', {
    params: { id: 'item-1' },
    body: { expectedRevision: 4 },
  });
  await invoke(service, 'notes.delete', {
    params: { id: 'note-1' },
    body: { expectedRevision: 2 },
  });

  assert.deepEqual(calls[0], ['content', 'deleteItem', { profileId: PROFILE, id: 'item-1', expectedRevision: 4 }]);
  assert.deepEqual(calls[1], [
    'content',
    'deleteEntity',
    { profileId: PROFILE, entity: 'note', id: 'note-1', expectedRevision: 2 },
  ]);
});

test('research and reminder operations map owners, defaults, states, and pagination', async () => {
  const { calls, service } = harness();

  const queued = await invoke(service, 'research.create', {
    body: {
      url: 'https://example.com/source',
      title: 'Source',
      user_notes: 'Investigate this',
      auto_process: true,
    },
  });
  assert.equal(queued.status, 202);
  assert.equal(queued.body.status, 'pending');

  const research = await invoke(service, 'research.list', { pagination: { limit: 20 } });
  assert.equal(research.research.length, 1);
  assert.equal(research.items.length, 1);

  const reminders = await invoke(service, 'reminders.list', {
    pagination: { cursor: 'reminder-cursor', limit: 5 },
  });
  assert.equal(reminders.reminders.length, 1);
  await invoke(service, 'reminders.update', {
    params: { id: 'reminder-1' },
    body: { dismissed: true, expectedRevision: 1 },
  });

  assert.deepEqual(calls[0], [
    'research',
    'queue',
    {
      profileId: PROFILE,
      query: 'Investigate this',
      sourceUrl: 'https://example.com/source',
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      idempotencyKey: null,
    },
  ]);
  assert.deepEqual(calls.at(-1)[2], {
    profileId: PROFILE,
    id: 'reminder-1',
    expectedRevision: 1,
    action: 'cancelled',
  });
});

test('AI compatibility executes synchronously and strips sensitive provider output', async () => {
  const { calls, service } = harness();
  const result = await invoke(service, 'pages.summarize', {
    body: { title: 'Example', text_content: 'Untrusted page body' },
  });

  assert.deepEqual(result, {
    summary: 'A safe summary',
    source: 'ai',
    state: 'completed',
  });
  assert.equal(JSON.stringify(result).includes('must-not-leak'), false);
  assert.deepEqual(calls[0][2], {
    profileId: PROFILE,
    provider: 'gemini',
    model: 'gemini-2.5-flash',
    operation: 'summarize',
    prompt: 'Summarize Example',
    untrustedContent: 'Untrusted page body',
  });
});

test('export returns the canonical bundle while legacy import is dry-run and backup-first', async () => {
  const { calls, service } = harness();

  assert.deepEqual(await invoke(service, 'data.export'), {
    manifest: {},
    data: { items: [] },
  });
  assert.deepEqual(
    await invoke(service, 'data.import', {
      body: { data: { items: [] } },
    }),
    {
      state: 'dry_run',
      report: { totalRows: 2, conflicts: [] },
      requiresConfirmation: true,
      backupRequired: true,
    }
  );
  assert.deepEqual(calls[0][2], { profileId: PROFILE });
  assert.deepEqual(calls[1][2], { profileId: PROFILE, bundle: { items: [] } });
});

test('digest pages expose both canonical envelopes and legacy digest aliases', async () => {
  const { calls, service } = harness();
  const result = await invoke(service, 'digest.list', {
    pagination: { cursor: 'digest-cursor', limit: 6 },
  });

  assert.deepEqual(result, {
    items: [{ id: 'digest-1', title: 'Weekly' }],
    digests: [{ id: 'digest-1', title: 'Weekly' }],
    nextCursor: null,
    hasMore: false,
  });
  assert.deepEqual(calls[0][2], {
    profileId: PROFILE,
    cursor: 'digest-cursor',
    limit: 6,
  });
});

test('settings and digest administration use canonical owner-scoped services', async () => {
  const { calls, service } = harness();

  assert.equal((await invoke(service, 'settings.read')).settings.theme, 'dark');
  assert.equal(
    (
      await invoke(service, 'settings.update', {
        body: { settings: { theme: 'light' }, expectedRevisions: { theme: 1 } },
      })
    ).settings.theme,
    'light'
  );
  assert.equal((await invoke(service, 'digestSettings.read')).settings.enabled, true);
  assert.equal(
    (
      await invoke(service, 'digestSettings.update', {
        body: { settings: { enabled: false }, expectedRevisions: { enabled: 1 } },
      })
    ).settings.enabled,
    false
  );
  const generated = await invoke(service, 'digest.generate', {
    body: { title: 'This week', periodStart: 1_700_000_000_000 },
  });
  assert.equal(generated.status, 201);
  assert.equal(generated.body.digest.id, 'digest-1');
  assert.match(calls.find(call => call[1] === 'createDigest')[2].body, /Active flashcards: 3/);

  await assert.rejects(invoke(service, 'notes.toggle'), { code: 'not_implemented' });
  await assert.rejects(invoke(service, 'connections.discover'), { code: 'not_implemented' });
  await assert.rejects(invoke(service, 'unknown.operation'), { code: 'not_implemented' });
});
