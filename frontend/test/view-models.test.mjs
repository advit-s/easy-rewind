import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_COLLECTION_ITEMS,
  MAX_LONG_TEXT_LENGTH,
  MAX_SHORT_TEXT_LENGTH,
  createBookmarksView,
  createDigestsView,
  createHighlightsView,
  createMemoriesView,
  createNotesView,
  createRemindersView,
  createResearchView,
} from '../js/view-models.js';

const PROFILE_ID = 'profile-owner';

const factories = [
  [
    'bookmarks',
    createBookmarksView,
    {
      id: 'bookmark-1',
      profileId: PROFILE_ID,
      title: 'Bookmark',
      description: 'Useful page',
      url: 'https://example.com/page',
      tags: ['learning'],
      createdAt: 1_800_000_000_000,
    },
  ],
  [
    'notes',
    createNotesView,
    {
      id: 'note-1',
      profile_id: PROFILE_ID,
      title: 'Note',
      body: 'Remember this',
      completed: false,
      updatedAt: 1_800_000_000_000,
    },
  ],
  [
    'research',
    createResearchView,
    {
      id: 'research-1',
      profileId: PROFILE_ID,
      title: 'Research',
      summary: 'Queued locally',
      state: 'queued',
      url: 'https://example.com/research',
      updatedAt: 1_800_000_000_000,
    },
  ],
  [
    'memories',
    createMemoriesView,
    {
      id: 'memory-1',
      profileId: PROFILE_ID,
      title: 'Memory',
      summary: 'A compact summary',
      url: 'https://example.com/memory',
      memoryScore: 0.75,
      createdAt: 1_800_000_000_000,
    },
  ],
  [
    'highlights',
    createHighlightsView,
    {
      id: 'highlight-1',
      profileId: PROFILE_ID,
      text: 'Selected text',
      pageTitle: 'Source page',
      url: 'https://example.com/highlight',
      color: 'yellow',
      createdAt: 1_800_000_000_000,
    },
  ],
  [
    'reminders',
    createRemindersView,
    {
      id: 'reminder-1',
      profileId: PROFILE_ID,
      title: 'Review',
      message: 'Review this item',
      state: 'scheduled',
      dueAt: 1_800_000_000_000,
    },
  ],
  [
    'digests',
    createDigestsView,
    {
      id: 'digest-1',
      profileId: PROFILE_ID,
      title: 'Weekly digest',
      state: 'ready',
      itemCount: 4,
      createdAt: 1_800_000_000_000,
    },
  ],
];

for (const [kind, factory, record] of factories) {
  test(`${kind} produces loading, empty, ready, and error states`, () => {
    assert.deepEqual(factory({ profileId: PROFILE_ID, status: 'loading' }), {
      kind,
      state: 'loading',
      items: [],
      pagination: { nextCursor: null, hasMore: false },
      omittedCount: 0,
      error: null,
    });
    assert.equal(factory({ profileId: PROFILE_ID, status: 'ready', items: [] }).state, 'empty');
    const ready = factory({ profileId: PROFILE_ID, status: 'ready', items: [record] });
    assert.equal(ready.state, 'ready');
    assert.equal(ready.items.length, 1);
    assert.equal(ready.items[0].id, record.id);
    assert.equal(Object.isFrozen(ready.items[0]), true);
    assert.deepEqual(
      factory({
        profileId: PROFILE_ID,
        status: 'error',
        error: new Error('unsafe server detail token=secret'),
      }),
      {
        kind,
        state: 'error',
        items: [],
        pagination: { nextCursor: null, hasMore: false },
        omittedCount: 0,
        error: {
          code: 'view_unavailable',
          message: 'This dashboard section is temporarily unavailable.',
        },
      }
    );
  });
}

test('cross-profile records fail closed for every collection', () => {
  for (const [kind, factory, record] of factories) {
    assert.throws(
      () =>
        factory({
          profileId: PROFILE_ID,
          status: 'ready',
          items: [{ ...record, profileId: 'profile-other', profile_id: undefined }],
        }),
      error => {
        assert.equal(error.code, 'PROFILE_ISOLATION_VIOLATION', kind);
        return true;
      }
    );
    assert.throws(
      () =>
        factory({
          profileId: PROFILE_ID,
          status: 'ready',
          items: [{ ...record, profileId: PROFILE_ID, profile_id: 'profile-other' }],
        }),
      error => {
        assert.equal(error.code, 'PROFILE_ISOLATION_VIOLATION', `${kind} contradictory owner`);
        return true;
      }
    );
  }
});

test('arrays and text are capped and malformed same-profile rows produce a partial state', () => {
  const items = Array.from({ length: MAX_COLLECTION_ITEMS + 5 }, (_, index) => ({
    id: `bookmark-${index}`,
    profileId: PROFILE_ID,
    title: 'T'.repeat(MAX_SHORT_TEXT_LENGTH + 20),
    description: 'D'.repeat(MAX_LONG_TEXT_LENGTH + 20),
    url: index === 1 ? 'javascript:alert(1)' : 'https://example.com/',
    tags: Array.from({ length: 30 }, (_entry, tagIndex) => `tag-${tagIndex}`),
    createdAt: index,
  }));
  items.splice(2, 0, {
    id: '',
    profileId: PROFILE_ID,
    title: 'invalid same-profile row',
  });

  const view = createBookmarksView({
    profileId: PROFILE_ID,
    status: 'ready',
    items,
    nextCursor: 'opaque-next-page',
    hasMore: true,
  });

  assert.equal(view.state, 'partial');
  assert.equal(view.items.length, MAX_COLLECTION_ITEMS);
  assert.equal(view.omittedCount, 6);
  assert.equal(view.items[0].title.length, MAX_SHORT_TEXT_LENGTH);
  assert.equal(view.items[0].description.length, MAX_LONG_TEXT_LENGTH);
  assert.equal(view.items[0].tags.length, 20);
  assert.equal(view.items[1].url, null);
  assert.deepEqual(view.pagination, {
    nextCursor: 'opaque-next-page',
    hasMore: true,
  });
});

test('pagination requires an opaque bounded cursor exactly when another page exists', () => {
  const record = factories[0][2];
  assert.throws(
    () =>
      createBookmarksView({
        profileId: PROFILE_ID,
        status: 'ready',
        items: [record],
        hasMore: true,
        nextCursor: null,
      }),
    /pagination/
  );
  assert.throws(
    () =>
      createBookmarksView({
        profileId: PROFILE_ID,
        status: 'ready',
        items: [record],
        hasMore: false,
        nextCursor: 'unexpected',
      }),
    /pagination/
  );
  assert.throws(
    () =>
      createBookmarksView({
        profileId: PROFILE_ID,
        status: 'ready',
        items: [record],
        hasMore: true,
        nextCursor: 'x'.repeat(1025),
      }),
    /pagination/
  );
});

test('type-specific values are normalized without executable URLs or unsafe numeric ranges', () => {
  const memories = createMemoriesView({
    profileId: PROFILE_ID,
    status: 'ready',
    items: [
      {
        ...factories.find(([kind]) => kind === 'memories')[2],
        memoryScore: 9,
        url: 'data:text/html,bad',
      },
    ],
  });
  assert.equal(memories.items[0].memoryScore, 1);
  assert.equal(memories.items[0].url, null);

  const reminder = createRemindersView({
    profileId: PROFILE_ID,
    status: 'ready',
    items: [
      {
        ...factories.find(([kind]) => kind === 'reminders')[2],
        dueAt: Number.MAX_VALUE,
      },
    ],
  });
  assert.equal(reminder.state, 'partial');
  assert.equal(reminder.items.length, 0);
});
