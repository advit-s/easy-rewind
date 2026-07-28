'use strict';

const { fail } = require('../domain-error');
const { decodeCursor, encodeCursor } = require('../repository-utils');

const ITEM_KINDS = new Set(['article', 'webpage', 'video', 'pdf', 'note']);
const HIGHLIGHT_COLORS = new Set(['yellow', 'green', 'blue', 'pink', 'purple']);
const ENTITY_TABLES = Object.freeze({
  bookmark: 'bookmarks',
  highlight: 'highlights',
  item_tag: 'item_tags',
  note: 'notes',
  tag: 'tags',
});

function text(value, { empty = true, maximum = 1_000_000 } = {}) {
  if (typeof value !== 'string' || value.length > maximum || (!empty && value.trim() === '')) {
    fail('REPOSITORY_INPUT_INVALID');
  }
  return value;
}

function optionalTimestamp(value) {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value) || value < 0) fail('REPOSITORY_INPUT_INVALID');
  return value;
}

function normalizeUrl(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || value.length > 8_192) fail('REPOSITORY_INPUT_INVALID');
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail('REPOSITORY_INPUT_INVALID');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username !== '' || parsed.password !== '') {
    fail('REPOSITORY_INPUT_INVALID');
  }
  parsed.hash = '';
  parsed.hostname = parsed.hostname.toLowerCase();
  if (
    (parsed.protocol === 'https:' && parsed.port === '443') ||
    (parsed.protocol === 'http:' && parsed.port === '80')
  ) {
    parsed.port = '';
  }
  parsed.searchParams.sort();
  return parsed.toString().replace(/\/$/, '');
}

function normalizeTag(value) {
  return text(value, { empty: false, maximum: 256 }).trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
}

function camelRow(row) {
  if (!row) return row;
  const output = {};
  for (const [key, value] of Object.entries(row)) {
    output[key.replace(/_([a-z])/g, (_match, letter) => letter.toUpperCase())] = value;
  }
  return output;
}

function requireConfiguration({ db, repositoryUtils } = {}) {
  if (
    db === null ||
    typeof db !== 'object' ||
    typeof db.prepare !== 'function' ||
    repositoryUtils === null ||
    typeof repositoryUtils !== 'object' ||
    typeof repositoryUtils.newRecord !== 'function' ||
    typeof repositoryUtils.requireById !== 'function' ||
    typeof repositoryUtils.allocateRevision !== 'function' ||
    typeof repositoryUtils.transaction !== 'function'
  ) {
    fail('REPOSITORY_CONFIGURATION_INVALID');
  }
  return { db, repositoryUtils };
}

function createContentRepository(options) {
  const { db, repositoryUtils } = requireConfiguration(options);

  function ensureItem(profileId, id) {
    return repositoryUtils.requireById({ profileId, table: 'items', id });
  }

  function insertItem({ profileId, item }) {
    if (item === null || typeof item !== 'object' || Array.isArray(item) || !ITEM_KINDS.has(item.kind)) {
      fail('REPOSITORY_INPUT_INVALID');
    }
    const url = normalizeUrl(item.url);
    if (
      url !== null &&
      db
        .prepare('SELECT 1 FROM items WHERE profile_id = ? AND url = ? AND deleted_at IS NULL LIMIT 1')
        .get(profileId, url)
    ) {
      fail('CONFLICT');
    }
    const record = repositoryUtils.newRecord();
    try {
      db.prepare(
        `INSERT INTO items(
           id, profile_id, kind, title, url, excerpt, body, source, published_at,
           archived_at, created_at, updated_at, revision, deleted_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`
      ).run(
        record.id,
        profileId,
        item.kind,
        text(item.title ?? '', { maximum: 4_096 }),
        url,
        text(item.excerpt ?? ''),
        text(item.body ?? ''),
        item.source == null ? null : text(item.source, { maximum: 2_048 }),
        optionalTimestamp(item.publishedAt),
        optionalTimestamp(item.archivedAt),
        record.createdAt,
        record.updatedAt,
        record.revision
      );
    } catch (error) {
      if (error?.code?.startsWith('SQLITE_CONSTRAINT')) fail('CONFLICT');
      throw error;
    }
    return camelRow(ensureItem(profileId, record.id));
  }

  function getItem({ profileId, id }) {
    return camelRow(ensureItem(profileId, id));
  }

  function listItems({ profileId, cursor, limit = 25, includeArchived = false }) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || typeof includeArchived !== 'boolean') {
      fail('PAGINATION_INVALID');
    }
    const position = cursor == null ? null : decodeCursor(cursor);
    const parameters = [profileId];
    let positionSql = '';
    if (position) {
      positionSql = ' AND (updated_at < ? OR (updated_at = ? AND id < ?))';
      parameters.push(position.updatedAt, position.updatedAt, position.id);
    }
    parameters.push(limit + 1);
    const rows = db
      .prepare(
        `SELECT *
         FROM items
         WHERE profile_id = ? AND deleted_at IS NULL
           ${includeArchived ? '' : 'AND archived_at IS NULL'}
           ${positionSql}
         ORDER BY updated_at DESC, id DESC
         LIMIT ?`
      )
      .all(...parameters);
    const hasMore = rows.length > limit;
    const selected = hasMore ? rows.slice(0, limit) : rows;
    const last = selected.at(-1);
    return {
      items: selected.map(camelRow),
      nextCursor: hasMore && last ? encodeCursor({ updatedAt: last.updated_at, id: last.id }) : null,
      hasMore,
    };
  }

  function updateItem({ profileId, id, expectedRevision, patch }) {
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) fail('REPOSITORY_INPUT_INVALID');
    const current = ensureItem(profileId, id);
    const revision = repositoryUtils.allocateRevision({
      profileId,
      table: 'items',
      id,
      expectedRevision,
    });
    const url = Object.hasOwn(patch, 'url') ? normalizeUrl(patch.url) : current.url;
    if (
      url !== null &&
      db
        .prepare('SELECT 1 FROM items WHERE profile_id = ? AND url = ? AND id <> ? AND deleted_at IS NULL LIMIT 1')
        .get(profileId, url, id)
    ) {
      fail('CONFLICT');
    }
    const kind = patch.kind ?? current.kind;
    if (!ITEM_KINDS.has(kind)) fail('REPOSITORY_INPUT_INVALID');
    const updatedAt = repositoryUtils.timestamp();
    db.prepare(
      `UPDATE items
       SET kind = ?, title = ?, url = ?, excerpt = ?, body = ?, source = ?,
           published_at = ?, archived_at = ?, updated_at = ?, revision = ?
       WHERE profile_id = ? AND id = ? AND deleted_at IS NULL`
    ).run(
      kind,
      Object.hasOwn(patch, 'title') ? text(patch.title, { maximum: 4_096 }) : current.title,
      url,
      Object.hasOwn(patch, 'excerpt') ? text(patch.excerpt) : current.excerpt,
      Object.hasOwn(patch, 'body') ? text(patch.body) : current.body,
      Object.hasOwn(patch, 'source')
        ? patch.source == null
          ? null
          : text(patch.source, { maximum: 2_048 })
        : current.source,
      Object.hasOwn(patch, 'publishedAt') ? optionalTimestamp(patch.publishedAt) : current.published_at,
      Object.hasOwn(patch, 'archivedAt') ? optionalTimestamp(patch.archivedAt) : current.archived_at,
      updatedAt,
      revision,
      profileId,
      id
    );
    return camelRow(ensureItem(profileId, id));
  }

  function tombstone({ profileId, entity, id, expectedRevision }) {
    const table = ENTITY_TABLES[entity];
    if (!table) fail('REPOSITORY_INPUT_INVALID');
    const revision = repositoryUtils.allocateRevision({
      profileId,
      table,
      id,
      expectedRevision,
    });
    const deletedAt = repositoryUtils.timestamp();
    db.prepare(
      `UPDATE ${table}
       SET deleted_at = ?, updated_at = ?, revision = ?
       WHERE profile_id = ? AND id = ? AND deleted_at IS NULL`
    ).run(deletedAt, deletedAt, revision, profileId, id);
    return { id, revision, deletedAt };
  }

  function getEntity({ profileId, entity, id }) {
    const table = ENTITY_TABLES[entity];
    if (!table) fail('REPOSITORY_INPUT_INVALID');
    return camelRow(repositoryUtils.requireById({ profileId, table, id }));
  }

  function listEntities({ profileId, entity, cursor, limit = 25 }) {
    const table = ENTITY_TABLES[entity];
    if (!table) fail('REPOSITORY_INPUT_INVALID');
    const page = repositoryUtils.page({ profileId, table, cursor, limit });
    return { ...page, items: page.items.map(camelRow) };
  }

  function updateBookmark(profileId, current, patch) {
    const itemId = Object.hasOwn(patch, 'itemId') ? patch.itemId : current.item_id;
    ensureItem(profileId, itemId);
    return {
      sql: 'item_id = ?',
      values: [itemId],
    };
  }

  function updateNote(profileId, current, patch) {
    const itemId = Object.hasOwn(patch, 'itemId') ? patch.itemId : current.item_id;
    if (itemId !== null) ensureItem(profileId, itemId);
    return {
      sql: 'item_id = ?, body = ?',
      values: [itemId, Object.hasOwn(patch, 'body') ? text(patch.body, { empty: false }) : current.body],
    };
  }

  function updateHighlight(profileId, current, patch) {
    const itemId = Object.hasOwn(patch, 'itemId') ? patch.itemId : current.item_id;
    ensureItem(profileId, itemId);
    const color = patch.color ?? current.color;
    if (!HIGHLIGHT_COLORS.has(color)) fail('REPOSITORY_INPUT_INVALID');
    return {
      sql: 'item_id = ?, quote = ?, prefix = ?, suffix = ?, color = ?',
      values: [
        itemId,
        Object.hasOwn(patch, 'quote') ? text(patch.quote, { empty: false }) : current.quote,
        Object.hasOwn(patch, 'prefix') ? text(patch.prefix) : current.prefix,
        Object.hasOwn(patch, 'suffix') ? text(patch.suffix) : current.suffix,
        color,
      ],
    };
  }

  function updateTag(profileId, current, patch) {
    const name = Object.hasOwn(patch, 'name') ? text(patch.name, { empty: false, maximum: 256 }).trim() : current.name;
    const normalizedName = normalizeTag(name);
    if (
      db
        .prepare(
          `SELECT 1 FROM tags
           WHERE profile_id = ? AND normalized_name = ? AND id <> ? AND deleted_at IS NULL
           LIMIT 1`
        )
        .get(profileId, normalizedName, current.id)
    ) {
      fail('CONFLICT');
    }
    return {
      sql: 'name = ?, normalized_name = ?',
      values: [name, normalizedName],
    };
  }

  function updateItemTag(profileId, current, patch) {
    const itemId = Object.hasOwn(patch, 'itemId') ? patch.itemId : current.item_id;
    const tagId = Object.hasOwn(patch, 'tagId') ? patch.tagId : current.tag_id;
    ensureItem(profileId, itemId);
    repositoryUtils.requireById({ profileId, table: 'tags', id: tagId });
    return {
      sql: 'item_id = ?, tag_id = ?',
      values: [itemId, tagId],
    };
  }

  function updateEntity({ profileId, entity, id, expectedRevision, patch }) {
    const table = ENTITY_TABLES[entity];
    if (!table || patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
      fail('REPOSITORY_INPUT_INVALID');
    }
    const current = repositoryUtils.requireById({ profileId, table, id });
    const revision = repositoryUtils.allocateRevision({
      profileId,
      table,
      id,
      expectedRevision,
    });
    const update =
      entity === 'bookmark'
        ? updateBookmark(profileId, current, patch)
        : entity === 'note'
          ? updateNote(profileId, current, patch)
          : entity === 'highlight'
            ? updateHighlight(profileId, current, patch)
            : entity === 'tag'
              ? updateTag(profileId, current, patch)
              : updateItemTag(profileId, current, patch);
    const updatedAt = repositoryUtils.timestamp();
    try {
      db.prepare(
        `UPDATE ${table}
         SET ${update.sql}, updated_at = ?, revision = ?
         WHERE profile_id = ? AND id = ? AND deleted_at IS NULL`
      ).run(...update.values, updatedAt, revision, profileId, id);
    } catch (error) {
      if (error?.code?.startsWith('SQLITE_CONSTRAINT')) fail('CONFLICT');
      throw error;
    }
    return getEntity({ profileId, entity, id });
  }

  function tombstoneItem({ profileId, id, expectedRevision }) {
    const revision = repositoryUtils.allocateRevision({
      profileId,
      table: 'items',
      id,
      expectedRevision,
    });
    const deletedAt = repositoryUtils.timestamp();
    db.prepare(
      `UPDATE items
       SET deleted_at = ?, updated_at = ?, revision = ?
       WHERE profile_id = ? AND id = ? AND deleted_at IS NULL`
    ).run(deletedAt, deletedAt, revision, profileId, id);
    return { id, revision, deletedAt };
  }

  function searchItems({ profileId, query, limit = 25 }) {
    if (
      typeof query !== 'string' ||
      query.trim() === '' ||
      query.length > 512 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100
    ) {
      fail('REPOSITORY_INPUT_INVALID');
    }
    try {
      return db
        .prepare(
          `SELECT items.*
           FROM items_fts
           JOIN items ON items.id = items_fts.item_id AND items.profile_id = items_fts.profile_id
           WHERE items_fts MATCH ? AND items_fts.profile_id = ?
             AND items.deleted_at IS NULL AND items.archived_at IS NULL
           ORDER BY bm25(items_fts), items.updated_at DESC, items.id ASC
           LIMIT ?`
        )
        .all(query.trim(), profileId, limit)
        .map(camelRow);
    } catch (error) {
      if (error?.code === 'SQLITE_ERROR') fail('REPOSITORY_INPUT_INVALID');
      throw error;
    }
  }

  function insertBookmark({ profileId, itemId }) {
    ensureItem(profileId, itemId);
    if (
      db
        .prepare('SELECT 1 FROM bookmarks WHERE profile_id = ? AND item_id = ? AND deleted_at IS NULL LIMIT 1')
        .get(profileId, itemId)
    ) {
      fail('CONFLICT');
    }
    const record = repositoryUtils.newRecord();
    db.prepare(
      `INSERT INTO bookmarks(id, profile_id, item_id, created_at, updated_at, revision, deleted_at)
       VALUES (?, ?, ?, ?, ?, 1, NULL)`
    ).run(record.id, profileId, itemId, record.createdAt, record.updatedAt);
    return camelRow(repositoryUtils.requireById({ profileId, table: 'bookmarks', id: record.id }));
  }

  function insertNote({ profileId, itemId = null, body }) {
    if (itemId !== null) ensureItem(profileId, itemId);
    const record = repositoryUtils.newRecord();
    db.prepare(
      `INSERT INTO notes(id, profile_id, item_id, body, created_at, updated_at, revision, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, NULL)`
    ).run(record.id, profileId, itemId, text(body, { empty: false }), record.createdAt, record.updatedAt);
    return camelRow(repositoryUtils.requireById({ profileId, table: 'notes', id: record.id }));
  }

  function insertHighlight({ profileId, itemId, quote, prefix = '', suffix = '', color = 'yellow' }) {
    ensureItem(profileId, itemId);
    if (!HIGHLIGHT_COLORS.has(color)) fail('REPOSITORY_INPUT_INVALID');
    const record = repositoryUtils.newRecord();
    db.prepare(
      `INSERT INTO highlights(
         id, profile_id, item_id, quote, prefix, suffix, color,
         created_at, updated_at, revision, deleted_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL)`
    ).run(
      record.id,
      profileId,
      itemId,
      text(quote, { empty: false }),
      text(prefix),
      text(suffix),
      color,
      record.createdAt,
      record.updatedAt
    );
    return camelRow(repositoryUtils.requireById({ profileId, table: 'highlights', id: record.id }));
  }

  function insertTag({ profileId, name }) {
    const normalizedName = normalizeTag(name);
    if (
      db
        .prepare('SELECT 1 FROM tags WHERE profile_id = ? AND normalized_name = ? AND deleted_at IS NULL LIMIT 1')
        .get(profileId, normalizedName)
    ) {
      fail('CONFLICT');
    }
    const record = repositoryUtils.newRecord();
    db.prepare(
      `INSERT INTO tags(
         id, profile_id, name, normalized_name, created_at, updated_at, revision, deleted_at
       ) VALUES (?, ?, ?, ?, ?, ?, 1, NULL)`
    ).run(
      record.id,
      profileId,
      text(name, { empty: false, maximum: 256 }).trim(),
      normalizedName,
      record.createdAt,
      record.updatedAt
    );
    return camelRow(repositoryUtils.requireById({ profileId, table: 'tags', id: record.id }));
  }

  function insertItemTag({ profileId, itemId, tagId }) {
    ensureItem(profileId, itemId);
    repositoryUtils.requireById({ profileId, table: 'tags', id: tagId });
    if (
      db
        .prepare(
          'SELECT 1 FROM item_tags WHERE profile_id = ? AND item_id = ? AND tag_id = ? AND deleted_at IS NULL LIMIT 1'
        )
        .get(profileId, itemId, tagId)
    ) {
      fail('CONFLICT');
    }
    const record = repositoryUtils.newRecord();
    db.prepare(
      `INSERT INTO item_tags(
         id, profile_id, item_id, tag_id, created_at, updated_at, revision, deleted_at
       ) VALUES (?, ?, ?, ?, ?, ?, 1, NULL)`
    ).run(record.id, profileId, itemId, tagId, record.createdAt, record.updatedAt);
    return camelRow(repositoryUtils.requireById({ profileId, table: 'item_tags', id: record.id }));
  }

  return Object.freeze({
    getEntity,
    getItem,
    insertBookmark,
    insertHighlight,
    insertItem,
    insertItemTag,
    insertNote,
    insertTag,
    listEntities,
    listItems,
    searchItems,
    tombstone,
    tombstoneItem,
    transaction: repositoryUtils.transaction,
    updateEntity,
    updateItem,
  });
}

module.exports = { createContentRepository, normalizeTag, normalizeUrl };
