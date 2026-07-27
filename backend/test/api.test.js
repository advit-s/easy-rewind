const assert = require('node:assert/strict');
const { afterEach, beforeEach, describe, test } = require('node:test');
const supertest = require('supertest');
const { closeDb, resetRuntimeState } = require('../routes/helpers');
const { createApp } = require('../server');
const { createTestEnvironment } = require('./support/test-environment');
const { startTestServer } = require('./support/test-server');

const USER_ID = 'test-user-123';
const headers = { 'x-user-id': USER_ID };
const runtimeEnvironmentKeys = [
  'DATABASE_PATH',
  'SETTINGS_PATH',
  'LOG_PATH',
  'EXPORT_PATH',
  'EASY_REWIND_FIXED_TIME',
  'EASY_REWIND_PROFILE_USER_ID',
  'EASY_REWIND_SCHEDULERS_ENABLED',
  'GEMINI_API_KEY',
];
let environment;
let server;
let request;
let previousEnvironment;

beforeEach(async () => {
  environment = await createTestEnvironment();
  previousEnvironment = Object.fromEntries(runtimeEnvironmentKeys.map(key => [key, process.env[key]]));
  Object.assign(process.env, environment.env);
  resetRuntimeState();
  const app = createApp({ rateLimitsEnabled: false, requestLogging: false });
  server = await startTestServer(app);
  request = supertest(server.origin);
});

afterEach(async () => {
  await server?.close();
  closeDb();
  await environment?.cleanup();
  resetRuntimeState({ loadSettings: false });
  for (const key of runtimeEnvironmentKeys) {
    if (previousEnvironment[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnvironment[key];
  }
});

async function createBookmark(overrides = {}) {
  return request
    .post('/api/bookmark')
    .set(headers)
    .send({
      url: 'https://example.com/test',
      title: 'Test Page',
      topic: 'testing',
      notes: 'A test bookmark',
      ...overrides,
    });
}

async function createNote() {
  return request.post('/api/notes').set(headers).send({
    content: 'This is a test note',
    source_url: 'https://example.com',
    source_title: 'Example',
  });
}

async function createReminder() {
  return request
    .post('/api/reminders')
    .set(headers)
    .send({
      title: 'Test Reminder',
      message: 'This is a test reminder',
      remind_at: new Date(Date.now() + 3_600_000).toISOString(),
      reminder_type: 'custom',
    });
}

async function createHighlight() {
  return request.post('/api/highlights').set(headers).send({
    url: 'https://example.com',
    page_title: 'Example',
    text: 'Important text to highlight',
    context: 'Some surrounding context',
    color: 'yellow',
  });
}

async function createFlashcard() {
  return request.post('/api/flashcards').set(headers).send({
    term: 'What is the DOM?',
    definition: 'Document Object Model — a programming interface for web documents',
    source: 'manual',
  });
}

describe('Health Endpoint', () => {
  test('GET /api/health returns ok', async () => {
    const response = await request.get('/api/health');
    assert.equal(response.status, 200);
    assert.equal(response.body.status, 'ok');
    assert.match(response.body.service, /easy-rewind/);
  });
});

describe('Bookmark Endpoints', () => {
  test('POST /api/bookmark creates a bookmark', async () => {
    const response = await createBookmark();
    assert.equal(response.status, 200);
    assert.equal(response.body.success, true);
    assert.notEqual(response.body.bookmark, undefined);
    assert.equal(response.body.bookmark.url, 'https://example.com/test');
  });

  test('POST /api/bookmark rejects missing URL', async () => {
    const response = await request.post('/api/bookmark').set(headers).send({ topic: 'testing' });
    assert.equal(response.status, 400);
    assert.notEqual(response.body.error, undefined);
  });

  test('POST /api/bookmark rejects missing title', async () => {
    const response = await request
      .post('/api/bookmark')
      .set(headers)
      .send({ url: 'https://example.com', topic: 'testing' });
    assert.equal(response.status, 400);
    assert.equal(response.body.error, 'Title is required.');
  });

  test('POST /api/bookmark rejects missing topic', async () => {
    const response = await request
      .post('/api/bookmark')
      .set(headers)
      .send({ url: 'https://example.com', title: 'Test Page' });
    assert.equal(response.status, 400);
    assert.notEqual(response.body.error, undefined);
  });

  test('POST /api/bookmark rejects invalid URL', async () => {
    const response = await request
      .post('/api/bookmark')
      .set(headers)
      .send({ url: 'not-a-url', title: 'Test Page', topic: 'testing' });
    assert.equal(response.status, 400);
    assert.match(response.body.error, /Invalid URL/);
  });

  test('GET /api/bookmarks returns bookmarks', async () => {
    await createBookmark();
    const response = await request.get('/api/bookmarks').set(headers);
    assert.equal(response.status, 200);
    assert.equal(Array.isArray(response.body.bookmarks), true);
    assert.ok(response.body.bookmarks.length > 0);
  });

  test('GET /api/bookmarks supports pagination', async () => {
    await createBookmark();
    const response = await request.get('/api/bookmarks?limit=5&offset=0').set(headers);
    assert.equal(response.status, 200);
    assert.ok(response.body.bookmarks.length <= 5);
  });

  test('GET /api/search finds bookmarks', async () => {
    await createBookmark();
    const response = await request.get('/api/search?q=Test').set(headers);
    assert.equal(response.status, 200);
    assert.ok(response.body.results.length > 0);
  });

  test('GET /api/search returns 400 without query', async () => {
    const response = await request.get('/api/search').set(headers);
    assert.equal(response.status, 400);
  });

  test('DELETE /api/bookmark/:id deletes bookmark', async () => {
    const created = await createBookmark();
    const response = await request.delete(`/api/bookmark/${created.body.bookmark.id}`).set(headers);
    assert.equal(response.status, 200);
    assert.equal(response.body.success, true);
  });

  test('DELETE /api/bookmark/:id rejects invalid ID', async () => {
    const response = await request.delete('/api/bookmark/invalid').set(headers);
    assert.equal(response.status, 400);
    assert.notEqual(response.body.error, undefined);
  });
});

describe('Notes Endpoints', () => {
  test('POST /api/notes creates a note', async () => {
    const response = await createNote();
    assert.equal(response.status, 200);
    assert.equal(response.body.success, true);
    assert.notEqual(response.body.note, undefined);
  });

  test('POST /api/notes rejects empty content', async () => {
    const response = await request.post('/api/notes').set(headers).send({ content: '' });
    assert.equal(response.status, 400);
  });

  test('GET /api/notes returns notes', async () => {
    const response = await request.get('/api/notes').set(headers);
    assert.equal(response.status, 200);
    assert.equal(Array.isArray(response.body.notes), true);
  });

  test('PATCH /api/notes/:id/toggle toggles completed', async () => {
    const created = await createNote();
    const response = await request.patch(`/api/notes/${created.body.note.id}/toggle`).set(headers);
    assert.equal(response.status, 200);
    assert.equal(response.body.completed, true);
  });

  test('PATCH /api/notes/:id/toggle toggles back', async () => {
    const created = await createNote();
    await request.patch(`/api/notes/${created.body.note.id}/toggle`).set(headers);
    const response = await request.patch(`/api/notes/${created.body.note.id}/toggle`).set(headers);
    assert.equal(response.status, 200);
    assert.equal(response.body.completed, false);
  });

  test('PATCH /api/notes/:id/toggle rejects invalid ID', async () => {
    const response = await request.patch('/api/notes/invalid/toggle').set(headers);
    assert.equal(response.status, 400);
  });

  test('DELETE /api/notes/:id deletes note', async () => {
    const created = await createNote();
    const response = await request.delete(`/api/notes/${created.body.note.id}`).set(headers);
    assert.equal(response.status, 200);
    assert.equal(response.body.success, true);
  });
});

describe('Reminders Endpoints', () => {
  test('POST /api/reminders creates a reminder', async () => {
    const response = await createReminder();
    assert.equal(response.status, 200);
    assert.equal(response.body.success, true);
  });

  test('POST /api/reminders rejects missing title', async () => {
    const response = await request.post('/api/reminders').set(headers).send({ remind_at: new Date().toISOString() });
    assert.equal(response.status, 400);
  });

  test('POST /api/reminders rejects missing timestamps', async () => {
    const response = await request.post('/api/reminders').set(headers).send({ title: 'Test' });
    assert.equal(response.status, 400);
  });

  test('GET /api/reminders returns reminders', async () => {
    const response = await request.get('/api/reminders').set(headers);
    assert.equal(response.status, 200);
    assert.equal(Array.isArray(response.body.reminders), true);
  });

  test('PATCH /api/reminders/:id acknowledges reminder', async () => {
    const created = await createReminder();
    const response = await request
      .patch(`/api/reminders/${created.body.reminder.id}`)
      .set(headers)
      .send({ reminded: true });
    assert.equal(response.status, 200);
    assert.equal(response.body.success, true);
  });

  test('PATCH /api/reminders/:id rejects invalid ID', async () => {
    const response = await request.patch('/api/reminders/invalid').set(headers).send({ reminded: true });
    assert.equal(response.status, 400);
  });

  test('DELETE /api/reminders/:id deletes reminder', async () => {
    const created = await createReminder();
    const response = await request.delete(`/api/reminders/${created.body.reminder.id}`).set(headers);
    assert.equal(response.status, 200);
  });
});

describe('Research Endpoints', () => {
  test('POST /api/research queues research (no auto-process)', async () => {
    const response = await request.post('/api/research').set(headers).send({
      url: 'https://example.com/article',
      title: 'Test Article',
      user_notes: 'Interesting',
      auto_process: false,
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.success, true);
  });

  test('POST /api/research rejects missing URL', async () => {
    const response = await request.post('/api/research').set(headers).send({ title: 'Test' });
    assert.equal(response.status, 400);
  });

  test('POST /api/research rejects invalid URL', async () => {
    const response = await request.post('/api/research').set(headers).send({ url: 'not-a-url' });
    assert.equal(response.status, 400);
  });

  test('GET /api/research returns queued items', async () => {
    const response = await request.get('/api/research').set(headers);
    assert.equal(response.status, 200);
    assert.equal(Array.isArray(response.body.research), true);
  });
});

describe('Highlights Endpoints', () => {
  test('POST /api/highlights saves a highlight', async () => {
    const response = await createHighlight();
    assert.equal(response.status, 200);
    assert.notEqual(response.body.highlight, undefined);
  });

  test('POST /api/highlights rejects missing text', async () => {
    const response = await request.post('/api/highlights').set(headers).send({ url: 'https://example.com' });
    assert.equal(response.status, 400);
  });

  test('GET /api/highlights returns highlights', async () => {
    const response = await request.get('/api/highlights').set(headers);
    assert.equal(response.status, 200);
    assert.equal(Array.isArray(response.body.highlights), true);
  });

  test('DELETE /api/highlights/:id deletes highlight', async () => {
    const created = await createHighlight();
    const response = await request.delete(`/api/highlights/${created.body.highlight.id}`).set(headers);
    assert.equal(response.status, 200);
    assert.equal(response.body.success, true);
  });
});

describe('Export/Import Endpoints', () => {
  test('GET /api/export returns user data', async () => {
    const response = await request.get('/api/export').set(headers);
    assert.equal(response.status, 200);
    assert.notEqual(response.body.version, undefined);
    assert.notEqual(response.body.data, undefined);
    assert.notEqual(response.body.data.bookmarks, undefined);
  });

  test('POST /api/import with valid data succeeds', async () => {
    const response = await request
      .post('/api/import')
      .set(headers)
      .send({
        data: {
          bookmarks: [],
          notes: [],
          highlights: [],
          research: [],
          reminders: [],
        },
      });
    assert.equal(response.status, 200);
    assert.equal(response.body.success, true);
  });
});

describe('Settings Endpoints', () => {
  test('GET /api/settings returns settings', async () => {
    const response = await request.get('/api/settings');
    assert.equal(response.status, 200);
    assert.notEqual(response.body.ai_configured, undefined);
  });

  test('POST /api/settings updates settings', async () => {
    const response = await request.post('/api/settings').set(headers).send({
      spaced_review_enabled: true,
      review_interval_days: 7,
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.success, true);
  });
});

describe('Logging Endpoints', () => {
  test('POST /api/log stores an error log', async () => {
    const response = await request.post('/api/log').set(headers).send({
      level: 'ERROR',
      component: 'test',
      message: 'Test error',
      stack: 'Test stack trace',
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.success, true);
  });

  test('GET /api/logs returns recent logs', async () => {
    const response = await request.get('/api/logs');
    assert.equal(response.status, 200);
    assert.equal(Array.isArray(response.body.logs), true);
  });
});

describe('Knowledge Graph Endpoints', () => {
  test('GET /api/knowledge-graph returns graph data', async () => {
    const response = await request.get('/api/knowledge-graph').set(headers);
    assert.equal(response.status, 200);
    assert.notEqual(response.body.nodes, undefined);
    assert.notEqual(response.body.edges, undefined);
  });
});

describe('Review Digest Endpoint', () => {
  test('GET /api/review-digest returns digest', async () => {
    const response = await request.get('/api/review-digest').set(headers);
    assert.equal(response.status, 200);
    assert.equal(response.body.days, 7);
    assert.notEqual(response.body.stats, undefined);
    assert.notEqual(response.body.review_items, undefined);
  });
});

describe('Flashcard Endpoints', () => {
  test('POST /api/flashcards creates a flashcard', async () => {
    const response = await createFlashcard();
    assert.equal(response.status, 200);
    assert.equal(response.body.success, true);
    assert.notEqual(response.body.flashcard, undefined);
    assert.equal(response.body.flashcard.term, 'What is the DOM?');
    assert.match(response.body.flashcard.definition, /Document Object Model/);
  });

  test('POST /api/flashcards rejects missing term', async () => {
    const response = await request.post('/api/flashcards').set(headers).send({ definition: 'Some definition' });
    assert.equal(response.status, 400);
    assert.notEqual(response.body.error, undefined);
  });

  test('POST /api/flashcards rejects missing definition', async () => {
    const response = await request.post('/api/flashcards').set(headers).send({ term: 'Some term' });
    assert.equal(response.status, 400);
    assert.notEqual(response.body.error, undefined);
  });

  test('GET /api/flashcards returns flashcards', async () => {
    await createFlashcard();
    const response = await request.get('/api/flashcards').set(headers);
    assert.equal(response.status, 200);
    assert.equal(Array.isArray(response.body.flashcards), true);
    assert.ok(response.body.flashcards.length > 0);
  });

  test('GET /api/flashcards?due=true returns due cards', async () => {
    await createFlashcard();
    const response = await request.get('/api/flashcards?due=true').set(headers);
    assert.equal(response.status, 200);
    assert.equal(Array.isArray(response.body.flashcards), true);
  });

  test('PATCH /api/flashcards/:id/review with quality 5', async () => {
    const created = await createFlashcard();
    const response = await request
      .patch(`/api/flashcards/${created.body.flashcard.id}/review`)
      .set(headers)
      .send({ quality: 5 });
    assert.equal(response.status, 200);
    assert.equal(response.body.success, true);
    assert.notEqual(response.body.flashcard, undefined);
    assert.equal(response.body.flashcard.repetitions, 1);
    assert.equal(response.body.flashcard.interval_days, 1);
  });

  test('PATCH /api/flashcards/:id/review with quality 1 resets', async () => {
    const created = await createFlashcard();
    await request.patch(`/api/flashcards/${created.body.flashcard.id}/review`).set(headers).send({ quality: 5 });
    const response = await request
      .patch(`/api/flashcards/${created.body.flashcard.id}/review`)
      .set(headers)
      .send({ quality: 1 });
    assert.equal(response.status, 200);
    assert.equal(response.body.success, true);
    assert.equal(response.body.flashcard.repetitions, 0);
    assert.equal(response.body.flashcard.interval_days, 1);
  });

  test('PATCH /api/flashcards/:id/review rejects invalid quality', async () => {
    const created = await createFlashcard();
    const response = await request
      .patch(`/api/flashcards/${created.body.flashcard.id}/review`)
      .set(headers)
      .send({ quality: 10 });
    assert.equal(response.status, 400);
  });

  test('PATCH /api/flashcards/:id/review rejects invalid ID', async () => {
    const response = await request.patch('/api/flashcards/invalid/review').set(headers).send({ quality: 3 });
    assert.equal(response.status, 400);
  });

  test('POST /api/flashcards/generate generates from bookmarks', async () => {
    await createBookmark({
      url: 'https://example.com/flashcard-gen',
      title: 'Flashcard Gen Test',
      topic: 'flashcard-testing',
    });
    const response = await request.post('/api/flashcards/generate').set(headers).send({ source_type: 'bookmark' });
    assert.equal(response.status, 200);
    assert.equal(response.body.success, true);
    assert.equal(typeof response.body.inserted, 'number');
  });

  test('DELETE /api/flashcards/:id deletes flashcard', async () => {
    const created = await createFlashcard();
    const response = await request.delete(`/api/flashcards/${created.body.flashcard.id}`).set(headers);
    assert.equal(response.status, 200);
    assert.equal(response.body.success, true);
  });

  test('DELETE /api/flashcards/:id rejects invalid ID', async () => {
    const response = await request.delete('/api/flashcards/invalid').set(headers);
    assert.equal(response.status, 400);
  });
});

describe('Error Handling', () => {
  test('GET /api/nonexistent returns 404', async () => {
    const response = await request.get('/api/nonexistent');
    assert.equal(response.status, 404);
  });

  test('POST /api/quick-lookup with no body returns 400', async () => {
    const response = await request.post('/api/quick-lookup').set(headers).send({});
    assert.equal(response.status, 400);
    assert.notEqual(response.body.error, undefined);
  });
});
