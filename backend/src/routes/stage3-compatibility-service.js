'use strict';

const { createHttpError } = require('../http/error-handler');
const { withoutProviderCredentials } = require('./route-utils');

const DEFAULT_AI = Object.freeze({
  provider: 'gemini',
  model: 'gemini-2.5-flash',
});
const SENSITIVE_KEY =
  /(?:api[_-]?key|access[_-]?token|client[_-]?secret|password|credential|provider[_-]?(?:key|token|secret))/i;

function invalid() {
  throw createHttpError('validation_failed');
}

function notImplemented() {
  throw createHttpError('not_implemented');
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function settingsPayload(body) {
  if (body.settings !== undefined) return object(body.settings);
  return Object.fromEntries(Object.entries(body).filter(([key]) => !['expectedRevisions', 'revisions'].includes(key)));
}

function hasSensitiveValue(value, observed = new WeakSet()) {
  if (value === null || typeof value !== 'object') return false;
  if (observed.has(value)) return false;
  observed.add(value);
  if (Array.isArray(value)) return value.some(entry => hasSensitiveValue(entry, observed));
  return Object.entries(value).some(([key, nested]) => SENSITIVE_KEY.test(key) || hasSensitiveValue(nested, observed));
}

function requiredText(value) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 1_000_000 ||
    value.trim() !== value ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  ) {
    invalid();
  }
  return value;
}

function optionalText(value, fallback = '') {
  return value === undefined || value === null ? fallback : requiredText(value);
}

function positiveInteger(value, fallback) {
  if (value === undefined && fallback !== undefined) return fallback;
  const normalized = typeof value === 'string' && /^[1-9]\d*$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(normalized) || normalized < 1) invalid();
  return normalized;
}

function expectedRevision(body) {
  return positiveInteger(body.expectedRevision ?? body.expected_revision ?? body.revision);
}

function profileId(context) {
  return requiredText(object(context).profileId);
}

function method(service, name) {
  if (service === null || typeof service !== 'object' || typeof service[name] !== 'function') notImplemented();
  return service[name].bind(service);
}

function firstMethod(service, names) {
  const name = names.find(candidate => typeof service?.[candidate] === 'function');
  return name === undefined ? notImplemented() : service[name].bind(service);
}

function pageInput(profile, pagination, fallback = 25) {
  const value = object(pagination);
  return {
    profileId: profile,
    ...(value.cursor === undefined ? {} : { cursor: requiredText(value.cursor) }),
    limit: positiveInteger(value.limit, fallback),
  };
}

function legacyPage(page, legacyKey, mapper = value => value) {
  if (
    page === null ||
    typeof page !== 'object' ||
    !Array.isArray(page.items) ||
    typeof page.hasMore !== 'boolean' ||
    (page.nextCursor !== null && typeof page.nextCursor !== 'string')
  ) {
    throw createHttpError('internal_error');
  }
  const items = page.items.map(mapper);
  return {
    items,
    [legacyKey]: items,
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
  };
}

function legacyItem(item) {
  return {
    ...item,
    ...(item.createdAt === undefined ? {} : { created_at: item.createdAt }),
    ...(item.updatedAt === undefined ? {} : { updated_at: item.updatedAt }),
  };
}

function legacyNote(note) {
  return {
    ...legacyItem(note),
    content: note.body,
    item_id: note.itemId ?? null,
    completed: false,
  };
}

function legacyHighlight(highlight, item = {}) {
  return {
    ...legacyItem(highlight),
    item_id: highlight.itemId,
    text: highlight.quote,
    context: [highlight.prefix, highlight.suffix].filter(Boolean).join(' '),
    url: item.url ?? null,
    page_title: item.title ?? '',
  };
}

function legacyBookmark(bookmark, item = {}) {
  return {
    ...legacyItem(bookmark),
    item_id: bookmark.itemId,
    url: item.url ?? null,
    title: item.title ?? '',
    topic: item.excerpt ?? '',
    notes: item.body ?? '',
  };
}

function itemInput(body) {
  return {
    kind: body.kind ?? (body.url ? 'webpage' : 'note'),
    title: optionalText(body.title, ''),
    ...(body.url === undefined ? {} : { url: body.url }),
    excerpt: optionalText(body.excerpt ?? body.summary ?? body.topic, ''),
    body: optionalText(body.body ?? body.content ?? body.notes, ''),
    ...(body.source === undefined ? {} : { source: body.source }),
    ...(body.publishedAt === undefined ? {} : { publishedAt: body.publishedAt }),
    ...(body.archivedAt === undefined ? {} : { archivedAt: body.archivedAt }),
  };
}

function reminderAction(body) {
  if (body.action !== undefined) return requiredText(body.action);
  if (body.dismissed === true) return 'cancelled';
  if (body.reminded === true) return 'completed';
  if (body.remind_at !== undefined || body.snoozeUntil !== undefined) return 'snoozed';
  invalid();
}

function timestamp(value) {
  if (Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isSafeInteger(parsed) && parsed >= 0) return parsed;
  }
  invalid();
}

function createStage3CompatibilityService(options = {}) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('Stage 3 compatibility dependencies are invalid');
  }
  const {
    contentService,
    graphService,
    learningService,
    reminderService,
    researchService,
    settingsService,
    aiService,
    exportService,
    importService,
    aiDefaults = DEFAULT_AI,
    now = Date.now,
  } = options;
  if (typeof now !== 'function') {
    throw new TypeError('Stage 3 compatibility clock is invalid');
  }

  async function canonicalItem(profile, id) {
    return method(contentService, 'getItem')({ profileId: profile, id: requiredText(id) });
  }

  async function enrichPage(page, mapper) {
    const items = [];
    for (const entry of page.items) {
      const item = entry.itemId == null ? {} : await canonicalItem(entry.profileId ?? page.profileId, entry.itemId);
      items.push(mapper(entry, item));
    }
    return { ...page, items };
  }

  async function listEntities(profile, entity, pagination, legacyKey, mapper) {
    const input = pageInput(profile, pagination);
    const raw = await method(contentService, 'listEntities')({ ...input, entity });
    const page = mapper === undefined ? raw : await enrichPage({ ...raw, profileId: profile }, mapper);
    return legacyPage(page, legacyKey);
  }

  async function executeAi(profile, body, operation, prompt, untrustedContent) {
    const result = await method(
      aiService,
      'execute'
    )({
      profileId: profile,
      provider: requiredText(body.provider ?? aiDefaults.provider),
      model: requiredText(body.model ?? aiDefaults.model),
      operation,
      prompt: requiredText(prompt),
      untrustedContent: optionalText(untrustedContent, ''),
    });
    return withoutProviderCredentials(result);
  }

  async function dispatch(input) {
    const operation = requiredText(input.operation);
    const context = object(input.context);
    const params = object(input.params);
    const query = object(input.query);
    const body = object(input.body);
    if (hasSensitiveValue(params) || hasSensitiveValue(query) || hasSensitiveValue(body)) invalid();
    const profile = profileId(context);

    switch (operation) {
      case 'settings.read':
        return method(settingsService, 'readSettings')({ profileId: profile });
      case 'settings.update':
        return method(
          settingsService,
          'updateSettings'
        )({
          profileId: profile,
          settings: settingsPayload(body),
          expectedRevisions: body.expectedRevisions ?? body.revisions ?? {},
        });
      case 'items.list': {
        const includeArchived =
          query.includeArchived === undefined
            ? false
            : query.includeArchived === true || query.includeArchived === 'true'
              ? true
              : query.includeArchived === false || query.includeArchived === 'false'
                ? false
                : invalid();
        return method(
          contentService,
          'listItems'
        )({
          ...pageInput(profile, input.pagination),
          includeArchived,
        });
      }
      case 'items.search': {
        const items = await method(
          contentService,
          'searchItems'
        )({
          profileId: profile,
          query: requiredText(query.q ?? query.query),
          limit: positiveInteger(query.limit, 25),
        });
        return { results: items, items, count: items.length };
      }
      case 'items.create': {
        const item = await method(
          contentService,
          'createItem'
        )({
          profileId: profile,
          item: itemInput(body),
        });
        return { status: 201, body: item };
      }
      case 'items.delete': {
        const result = await method(
          contentService,
          'deleteItem'
        )({
          profileId: profile,
          id: requiredText(params.id),
          expectedRevision: expectedRevision(body),
        });
        return { success: true, ...result };
      }
      case 'items.related':
        return {
          related: await method(
            graphService,
            'relatedItems'
          )({
            profileId: profile,
            itemId: requiredText(params.id),
          }),
        };
      case 'items.connect': {
        const connection = await method(
          graphService,
          'createConnection'
        )({
          profileId: profile,
          sourceItemId: requiredText(params.id),
          targetItemId: requiredText(body.targetItemId ?? body.target_id),
          relation: requiredText(body.relation ?? 'related'),
          ...(body.note === undefined ? {} : { note: body.note }),
        });
        return { status: 201, body: { success: true, connection } };
      }
      case 'bookmarks.create': {
        const item =
          body.itemId === undefined
            ? await method(
                contentService,
                'createItem'
              )({
                profileId: profile,
                item: itemInput(body),
              })
            : await canonicalItem(profile, body.itemId);
        const bookmark = await method(
          contentService,
          'createBookmark'
        )({
          profileId: profile,
          itemId: item.id,
        });
        return {
          status: 201,
          body: { success: true, bookmark: legacyBookmark(bookmark, item) },
        };
      }
      case 'bookmarks.list':
        return listEntities(profile, 'bookmark', input.pagination, 'bookmarks', legacyBookmark);
      case 'bookmarks.delete': {
        const result = await method(
          contentService,
          'deleteEntity'
        )({
          profileId: profile,
          entity: 'bookmark',
          id: requiredText(params.id),
          expectedRevision: expectedRevision(body),
        });
        return { success: true, ...result };
      }
      case 'notes.create': {
        const note = await method(
          contentService,
          'createNote'
        )({
          profileId: profile,
          itemId: body.itemId ?? body.item_id ?? null,
          body: requiredText(body.body ?? body.content),
        });
        return { status: 201, body: { success: true, note: legacyNote(note) } };
      }
      case 'notes.list':
        return listEntities(profile, 'note', input.pagination, 'notes', legacyNote);
      case 'notes.delete': {
        const result = await method(
          contentService,
          'deleteEntity'
        )({
          profileId: profile,
          entity: 'note',
          id: requiredText(params.id),
          expectedRevision: expectedRevision(body),
        });
        return { success: true, ...result };
      }
      case 'notes.toggle':
        return notImplemented();
      case 'highlights.create': {
        const item =
          body.itemId === undefined
            ? await method(
                contentService,
                'createItem'
              )({
                profileId: profile,
                item: {
                  kind: 'webpage',
                  title: optionalText(body.page_title ?? body.title, ''),
                  url: requiredText(body.url),
                  excerpt: '',
                  body: '',
                },
              })
            : await canonicalItem(profile, body.itemId);
        const highlight = await method(
          contentService,
          'createHighlight'
        )({
          profileId: profile,
          itemId: item.id,
          quote: requiredText(body.quote ?? body.text),
          prefix: optionalText(body.prefix, ''),
          suffix: optionalText(body.suffix ?? body.context, ''),
          color: optionalText(body.color, 'yellow'),
        });
        return {
          status: 201,
          body: { highlight: legacyHighlight(highlight, item) },
        };
      }
      case 'highlights.list':
        return listEntities(profile, 'highlight', input.pagination, 'highlights', legacyHighlight);
      case 'highlights.stats': {
        const page = await listEntities(profile, 'highlight', { limit: 100 }, 'highlights', legacyHighlight);
        const colors = new Map();
        const pages = new Map();
        for (const highlight of page.items) {
          colors.set(highlight.color, (colors.get(highlight.color) ?? 0) + 1);
          const key = `${highlight.url ?? ''}\u0000${highlight.page_title}`;
          pages.set(key, (pages.get(key) ?? 0) + 1);
        }
        return {
          total: page.items.length,
          hasMore: page.hasMore,
          colors: [...colors].map(([color, count]) => ({ color, count })),
          perPage: [...pages].map(([key, count]) => {
            const [url, pageTitle] = key.split('\u0000');
            return { url, page_title: pageTitle, count };
          }),
        };
      }
      case 'highlights.delete': {
        const result = await method(
          contentService,
          'deleteEntity'
        )({
          profileId: profile,
          entity: 'highlight',
          id: requiredText(params.id),
          expectedRevision: expectedRevision(body),
        });
        return { success: true, ...result };
      }
      case 'lookup.quick': {
        const term = requiredText(body.term);
        const ai = await executeAi(
          profile,
          body,
          'summarize',
          `Explain ${term}`,
          body.page_context ?? body.pageContext ?? ''
        );
        return {
          term,
          definition: ai.result?.definition ?? ai.result?.summary ?? null,
          suggestions: ai.result?.suggestions ?? [],
          source: ai.state === 'completed' ? 'ai' : 'unavailable',
          state: ai.state,
          ...(ai.errorCode === undefined ? {} : { errorCode: ai.errorCode }),
        };
      }
      case 'pages.summarize': {
        const title = optionalText(body.title, 'this page');
        const ai = await executeAi(
          profile,
          body,
          'summarize',
          `Summarize ${title}`,
          body.text_content ?? body.textContent ?? body.content ?? ''
        );
        return {
          summary: ai.result?.summary ?? null,
          source: ai.state === 'completed' ? 'ai' : 'unavailable',
          state: ai.state,
          ...(ai.errorCode === undefined ? {} : { errorCode: ai.errorCode }),
        };
      }
      case 'urls.analyze': {
        const queued = await method(
          researchService,
          'queue'
        )({
          profileId: profile,
          query: requiredText(body.query ?? body.title ?? 'Analyze this source'),
          sourceUrl: requiredText(body.url),
          provider: requiredText(body.provider ?? aiDefaults.provider),
          model: requiredText(body.model ?? aiDefaults.model),
          idempotencyKey: body.idempotencyKey ?? null,
        });
        return { status: queued.state === 'queued' ? 202 : 200, body: queued };
      }
      case 'research.create': {
        const queued = await method(
          researchService,
          'queue'
        )({
          profileId: profile,
          query: requiredText(body.query ?? body.user_notes ?? body.title ?? 'Research this source'),
          sourceUrl: requiredText(body.sourceUrl ?? body.url),
          provider: requiredText(body.provider ?? aiDefaults.provider),
          model: requiredText(body.model ?? aiDefaults.model),
          idempotencyKey: body.idempotencyKey ?? null,
        });
        return {
          status: queued.state === 'queued' ? 202 : 200,
          body: {
            ...queued,
            status: queued.state === 'queued' ? 'pending' : queued.state,
          },
        };
      }
      case 'research.list': {
        const page = await firstMethod(researchService, ['list', 'listResearch'])(pageInput(profile, input.pagination));
        return legacyPage(page, 'research', entry => ({
          ...entry,
          status:
            entry.state === 'queued'
              ? 'pending'
              : entry.state === 'running'
                ? 'processing'
                : entry.state === 'succeeded'
                  ? 'done'
                  : entry.state,
        }));
      }
      case 'reminders.list': {
        const page = await method(reminderService, 'listReminders')(pageInput(profile, input.pagination));
        return legacyPage(page, 'reminders');
      }
      case 'reminders.update': {
        const action = reminderAction(body);
        const result = await method(
          reminderService,
          'transitionReminder'
        )({
          profileId: profile,
          id: requiredText(params.id),
          expectedRevision: expectedRevision(body),
          action,
          ...(action === 'snoozed' ? { snoozeUntil: timestamp(body.snoozeUntil ?? body.remind_at) } : {}),
        });
        return { success: true, reminder: result };
      }
      case 'search.query': {
        const items = await method(
          contentService,
          'searchItems'
        )({
          profileId: profile,
          query: requiredText(query.q ?? query.query),
          limit: positiveInteger(query.limit, 50),
        });
        const notes = items.filter(item => item.kind === 'note');
        const results = items.filter(item => item.kind !== 'note');
        return {
          results,
          notes,
          items,
          count: results.length,
          notes_count: notes.length,
          query: query.q ?? query.query,
        };
      }
      case 'data.export': {
        const result = await method(exportService, 'create')({ profileId: profile });
        return result.bundle;
      }
      case 'data.import': {
        const report = await method(
          importService,
          'dryRun'
        )({
          profileId: profile,
          bundle: body.bundle ?? body.data,
        });
        return {
          state: 'dry_run',
          report,
          requiresConfirmation: true,
          backupRequired: true,
        };
      }
      case 'knowledgeGraph.read':
        return method(graphService, 'knowledgeGraph')({ profileId: profile });
      case 'connections.discover':
        return notImplemented();
      case 'digest.list': {
        const page = await method(learningService, 'listDigests')(pageInput(profile, input.pagination));
        return legacyPage(page, 'digests');
      }
      case 'digest.generate': {
        const periodEnd = body.periodEnd === undefined ? now() : timestamp(body.periodEnd);
        const periodStart =
          body.periodStart === undefined
            ? Math.max(0, periodEnd - 7 * 24 * 60 * 60 * 1000)
            : timestamp(body.periodStart);
        const statistics = await method(
          learningService,
          'statistics'
        )({
          profileId: profile,
          dueAt: periodEnd,
        });
        const digest = await method(
          learningService,
          'createDigest'
        )({
          profileId: profile,
          title: optionalText(body.title, 'Learning review'),
          body: [
            `Active flashcards: ${statistics.activeFlashcards}.`,
            `Due flashcards: ${statistics.dueFlashcards}.`,
            `Quiz attempts: ${statistics.quizAttempts}.`,
            `Average quiz score: ${statistics.averageQuizPercent}%.`,
          ].join(' '),
          periodStart,
          periodEnd,
        });
        return { status: 201, body: { digest, statistics } };
      }
      case 'digestSettings.read':
        return method(settingsService, 'readDigestSettings')({ profileId: profile });
      case 'digestSettings.update':
        return method(
          settingsService,
          'updateDigestSettings'
        )({
          profileId: profile,
          settings: settingsPayload(body),
          expectedRevisions: body.expectedRevisions ?? body.revisions ?? {},
        });
      default:
        return notImplemented();
    }
  }

  async function handle(input = {}) {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) invalid();
    const result = await dispatch(input);
    return result === undefined ? undefined : withoutProviderCredentials(result);
  }

  return Object.freeze({ handle });
}

module.exports = { createStage3CompatibilityService };
