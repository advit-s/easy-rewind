import { MobileOfflineDomainError, type MobileRepository, type MobileSyncState } from '../db/repository.ts';

export type MobileContentKind = 'item' | 'article' | 'video' | 'document';

export interface MobileContent {
  id: string;
  profileId: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
  kind: MobileContentKind;
  url: string | null;
  title: string;
  summary: string;
  content: string;
  sourceDeviceId: string | null;
  syncState: MobileSyncState;
}

export interface CreateMobileContentInput {
  id?: string;
  kind?: MobileContentKind;
  url?: string | null;
  title: string;
  summary?: string;
  content?: string;
}

export interface EditMobileContentInput {
  kind?: MobileContentKind;
  url?: string | null;
  title?: string;
  summary?: string;
  content?: string;
}

interface ContentRow {
  id: string;
  profile_id: string;
  revision: number;
  created_at: number;
  updated_at: number;
  kind: MobileContentKind;
  url: string | null;
  title: string;
  summary: string;
  content: string;
  source_device_id: string | null;
}

function requireText(value: unknown, field: string, maximum = 32_768): string {
  if (typeof value !== 'string' || value.length > maximum) {
    throw new MobileOfflineDomainError('INPUT_INVALID', `The mobile content ${field} is invalid.`);
  }
  return value;
}

function requireUrl(value: unknown): string | null {
  if (value === null) return null;
  const text = requireText(value, 'URL', 8_192);
  if (text === '') return null;
  try {
    const url = new URL(text);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error();
    return url.toString();
  } catch {
    throw new MobileOfflineDomainError('INPUT_INVALID', 'The mobile content URL is invalid.');
  }
}

function requireKind(value: unknown): MobileContentKind {
  if (!['item', 'article', 'video', 'document'].includes(value as string)) {
    throw new MobileOfflineDomainError('INPUT_INVALID', 'The mobile content kind is invalid.');
  }
  return value as MobileContentKind;
}

function toSyncPayload(row: ContentRow): Readonly<Record<string, unknown>> {
  const kind = row.kind === 'document' ? 'pdf' : row.kind === 'item' ? 'note' : row.kind;
  return {
    archivedAt: null,
    body: row.content,
    excerpt: row.summary,
    kind,
    publishedAt: null,
    source: row.source_device_id,
    title: row.title,
    url: row.url,
  };
}

export function createContentService({ repository }: { repository: MobileRepository }) {
  const { database, profileId, deviceId } = repository;

  function rowById(id: string): ContentRow | undefined {
    return database
      .prepare(
        `SELECT id, profile_id, revision, created_at, updated_at, kind, url,
                title, summary, content, source_device_id
         FROM items
         WHERE profile_id = ? AND id = ?
         LIMIT 1`
      )
      .get<ContentRow>(profileId, id);
  }

  function result(row: ContentRow): MobileContent {
    return {
      id: row.id,
      profileId: row.profile_id,
      revision: row.revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      kind: row.kind,
      url: row.url,
      title: row.title,
      summary: row.summary,
      content: row.content,
      sourceDeviceId: row.source_device_id,
      syncState: repository.entitySyncState('item', row.id),
    };
  }

  function get(id: string): MobileContent | null {
    const row = rowById(id);
    return row ? result(row) : null;
  }

  function create(input: CreateMobileContentInput): MobileContent {
    const id = input.id ?? repository.generateEntityId('item');
    const row = {
      id,
      kind: requireKind(input.kind ?? 'article'),
      url: requireUrl(input.url ?? null),
      title: requireText(input.title, 'title', 4_096),
      summary: requireText(input.summary ?? '', 'summary'),
      content: requireText(input.content ?? '', 'body'),
    };
    repository.commitMutation({
      entityType: 'item',
      entityId: id,
      operation: 'upsert',
      baseRevision: 0,
      payload: toSyncPayload({
        ...row,
        profile_id: profileId,
        revision: 0,
        created_at: 0,
        updated_at: 0,
        source_device_id: deviceId,
      }),
      apply: ({ database: transactionDatabase, at }) => {
        transactionDatabase
          .prepare(
            `INSERT INTO items(
              id, profile_id, revision, created_at, updated_at,
              kind, url, title, summary, content, source_device_id
            ) VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(id, profileId, at, at, row.kind, row.url, row.title, row.summary, row.content, deviceId);
      },
    });
    return result(rowById(id)!);
  }

  function edit(id: string, patch: EditMobileContentInput): MobileContent {
    const current = rowById(id);
    if (!current) throw new MobileOfflineDomainError('INPUT_INVALID', 'The mobile content item was not found.');
    const next: ContentRow = {
      ...current,
      kind: patch.kind === undefined ? current.kind : requireKind(patch.kind),
      url: patch.url === undefined ? current.url : requireUrl(patch.url),
      title: patch.title === undefined ? current.title : requireText(patch.title, 'title', 4_096),
      summary: patch.summary === undefined ? current.summary : requireText(patch.summary, 'summary'),
      content: patch.content === undefined ? current.content : requireText(patch.content, 'body'),
      source_device_id: deviceId,
    };
    repository.commitMutation({
      entityType: 'item',
      entityId: id,
      operation: 'upsert',
      baseRevision: current.revision,
      payload: toSyncPayload(next),
      apply: ({ database: transactionDatabase, at }) => {
        transactionDatabase
          .prepare(
            `UPDATE items
             SET kind = ?, url = ?, title = ?, summary = ?, content = ?,
                 source_device_id = ?, updated_at = ?
             WHERE profile_id = ? AND id = ?`
          )
          .run(next.kind, next.url, next.title, next.summary, next.content, deviceId, at, profileId, id);
      },
    });
    return result(rowById(id)!);
  }

  function remove(id: string): { id: string; revision: number; syncState: MobileSyncState } {
    const current = rowById(id);
    if (!current) throw new MobileOfflineDomainError('INPUT_INVALID', 'The mobile content item was not found.');
    const mutation = repository.commitMutation({
      entityType: 'item',
      entityId: id,
      operation: 'delete',
      baseRevision: current.revision,
      payload: {},
      apply: ({ database: transactionDatabase, at }) => {
        transactionDatabase.prepare(`DELETE FROM items WHERE profile_id = ? AND id = ?`).run(profileId, id);
        transactionDatabase
          .prepare(
            `INSERT INTO tombstones(
              id, profile_id, revision, created_at, updated_at,
              entity_type, entity_id, deleted_at
            ) VALUES (?, ?, ?, ?, ?, 'item', ?, ?)
            ON CONFLICT(profile_id, entity_type, entity_id) DO UPDATE SET
              revision = excluded.revision,
              updated_at = excluded.updated_at,
              deleted_at = excluded.deleted_at`
          )
          .run(`tombstone:${profileId}:item:${id}`, profileId, current.revision, at, at, id, at);
      },
    });
    return { id, revision: current.revision, syncState: mutation.syncState };
  }

  function search(query: string, { limit = 50 }: { limit?: number } = {}): MobileContent[] {
    if (typeof query !== 'string' || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
      throw new MobileOfflineDomainError('INPUT_INVALID', 'The mobile content search is invalid.');
    }
    const pattern = `%${query.replace(/[\\%_]/gu, '\\$&')}%`;
    return database
      .prepare(
        `SELECT id, profile_id, revision, created_at, updated_at, kind, url,
                title, summary, content, source_device_id
         FROM items
         WHERE profile_id = ?
           AND (title LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\')
         ORDER BY updated_at DESC, id
         LIMIT ?`
      )
      .all<ContentRow>(profileId, pattern, pattern, pattern, limit)
      .map(result);
  }

  return Object.freeze({ create, delete: remove, edit, get, search });
}
