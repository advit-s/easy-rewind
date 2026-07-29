import { MobileOfflineDomainError, type MobileRepository, type MobileSyncState } from '../db/repository.ts';

export type MobileReminderState = 'scheduled' | 'completed' | 'dismissed' | 'cancelled';

export interface MobileReminder {
  id: string;
  profileId: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
  itemId: string | null;
  title: string;
  body: string;
  dueAt: number;
  state: MobileReminderState;
  localNotificationId: string | null;
  syncState: MobileSyncState;
}

interface ReminderRow {
  id: string;
  profile_id: string;
  revision: number;
  created_at: number;
  updated_at: number;
  item_id: string | null;
  title: string;
  body: string;
  due_at: number;
  state: MobileReminderState;
  local_notification_id: string | null;
}

export interface CreateMobileReminderInput {
  id?: string;
  itemId?: string | null;
  title: string;
  body?: string;
  dueAt: number;
  state?: MobileReminderState;
  localNotificationId?: string | null;
}

export type EditMobileReminderInput = Partial<Omit<CreateMobileReminderInput, 'id'>>;

function text(value: unknown, name: string, { empty = true, maximum = 32_768 } = {}): string {
  if (typeof value !== 'string' || value.length > maximum || (!empty && value.trim() === '')) {
    throw new MobileOfflineDomainError('INPUT_INVALID', `The mobile reminder ${name} is invalid.`);
  }
  return value;
}

function nullableId(value: unknown, name: string): string | null {
  if (value === null) return null;
  return text(value, name, { empty: false, maximum: 256 });
}

function timestamp(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new MobileOfflineDomainError('INPUT_INVALID', 'The mobile reminder due time is invalid.');
  }
  return value as number;
}

function state(value: unknown): MobileReminderState {
  if (!['scheduled', 'completed', 'dismissed', 'cancelled'].includes(value as string)) {
    throw new MobileOfflineDomainError('INPUT_INVALID', 'The mobile reminder state is invalid.');
  }
  return value as MobileReminderState;
}

function syncPayload(row: ReminderRow): Readonly<Record<string, unknown>> {
  return {
    completedAt: row.state === 'completed' ? row.updated_at : null,
    dueAt: row.due_at,
    itemId: row.item_id,
    state: row.state === 'dismissed' ? 'cancelled' : row.state,
  };
}

export function createReminderService({ repository }: { repository: MobileRepository }) {
  const { database, profileId } = repository;

  function rowById(id: string): ReminderRow | undefined {
    return database
      .prepare(
        `SELECT id, profile_id, revision, created_at, updated_at, item_id,
                title, body, due_at, state, local_notification_id
         FROM reminders
         WHERE profile_id = ? AND id = ?
         LIMIT 1`
      )
      .get<ReminderRow>(profileId, id);
  }

  function result(row: ReminderRow): MobileReminder {
    return {
      id: row.id,
      profileId: row.profile_id,
      revision: row.revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      itemId: row.item_id,
      title: row.title,
      body: row.body,
      dueAt: row.due_at,
      state: row.state,
      localNotificationId: row.local_notification_id,
      syncState: repository.entitySyncState('reminder', row.id),
    };
  }

  function get(id: string): MobileReminder | null {
    const row = rowById(id);
    return row ? result(row) : null;
  }

  function create(input: CreateMobileReminderInput): MobileReminder {
    const id = input.id ?? repository.generateEntityId('reminder');
    const normalized = {
      id,
      itemId: nullableId(input.itemId ?? null, 'item ID'),
      title: text(input.title, 'title', { empty: false, maximum: 4_096 }),
      body: text(input.body ?? '', 'body'),
      dueAt: timestamp(input.dueAt),
      state: state(input.state ?? 'scheduled'),
      localNotificationId: nullableId(input.localNotificationId ?? null, 'notification ID'),
    };
    const payloadRow: ReminderRow = {
      id,
      profile_id: profileId,
      revision: 0,
      created_at: 0,
      updated_at: 0,
      item_id: normalized.itemId,
      title: normalized.title,
      body: normalized.body,
      due_at: normalized.dueAt,
      state: normalized.state,
      local_notification_id: normalized.localNotificationId,
    };
    repository.commitMutation({
      entityType: 'reminder',
      entityId: id,
      operation: 'upsert',
      baseRevision: 0,
      payload: syncPayload(payloadRow),
      apply: ({ database: transactionDatabase, at }) => {
        transactionDatabase
          .prepare(
            `INSERT INTO reminders(
              id, profile_id, revision, created_at, updated_at, item_id,
              title, body, due_at, state, local_notification_id
            ) VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            id,
            profileId,
            at,
            at,
            normalized.itemId,
            normalized.title,
            normalized.body,
            normalized.dueAt,
            normalized.state,
            normalized.localNotificationId
          );
      },
    });
    return result(rowById(id)!);
  }

  function edit(id: string, patch: EditMobileReminderInput): MobileReminder {
    const current = rowById(id);
    if (!current) throw new MobileOfflineDomainError('INPUT_INVALID', 'The mobile reminder was not found.');
    const next: ReminderRow = {
      ...current,
      item_id: patch.itemId === undefined ? current.item_id : nullableId(patch.itemId, 'item ID'),
      title: patch.title === undefined ? current.title : text(patch.title, 'title', { empty: false, maximum: 4_096 }),
      body: patch.body === undefined ? current.body : text(patch.body, 'body'),
      due_at: patch.dueAt === undefined ? current.due_at : timestamp(patch.dueAt),
      state: patch.state === undefined ? current.state : state(patch.state),
      local_notification_id:
        patch.localNotificationId === undefined
          ? current.local_notification_id
          : nullableId(patch.localNotificationId, 'notification ID'),
    };
    repository.commitMutation({
      entityType: 'reminder',
      entityId: id,
      operation: 'upsert',
      baseRevision: current.revision,
      payload: syncPayload(next),
      apply: ({ database: transactionDatabase, at }) => {
        transactionDatabase
          .prepare(
            `UPDATE reminders
             SET item_id = ?, title = ?, body = ?, due_at = ?, state = ?,
                 local_notification_id = ?, updated_at = ?
             WHERE profile_id = ? AND id = ?`
          )
          .run(
            next.item_id,
            next.title,
            next.body,
            next.due_at,
            next.state,
            next.local_notification_id,
            at,
            profileId,
            id
          );
      },
    });
    return result(rowById(id)!);
  }

  function remove(id: string): { id: string; revision: number; syncState: MobileSyncState } {
    const current = rowById(id);
    if (!current) throw new MobileOfflineDomainError('INPUT_INVALID', 'The mobile reminder was not found.');
    const mutation = repository.commitMutation({
      entityType: 'reminder',
      entityId: id,
      operation: 'delete',
      baseRevision: current.revision,
      payload: {},
      apply: ({ database: transactionDatabase, at }) => {
        transactionDatabase.prepare(`DELETE FROM reminders WHERE profile_id = ? AND id = ?`).run(profileId, id);
        transactionDatabase
          .prepare(
            `INSERT INTO tombstones(
              id, profile_id, revision, created_at, updated_at,
              entity_type, entity_id, deleted_at
            ) VALUES (?, ?, ?, ?, ?, 'reminder', ?, ?)
            ON CONFLICT(profile_id, entity_type, entity_id) DO UPDATE SET
              revision = excluded.revision,
              updated_at = excluded.updated_at,
              deleted_at = excluded.deleted_at`
          )
          .run(`tombstone:${profileId}:reminder:${id}`, profileId, current.revision, at, at, id, at);
      },
    });
    return { id, revision: current.revision, syncState: mutation.syncState };
  }

  function search(query: string, { limit = 50 }: { limit?: number } = {}): MobileReminder[] {
    if (typeof query !== 'string' || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
      throw new MobileOfflineDomainError('INPUT_INVALID', 'The mobile reminder search is invalid.');
    }
    const pattern = `%${query.replace(/[\\%_]/gu, '\\$&')}%`;
    return database
      .prepare(
        `SELECT id, profile_id, revision, created_at, updated_at, item_id,
                title, body, due_at, state, local_notification_id
         FROM reminders
         WHERE profile_id = ?
           AND (title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\' OR state LIKE ? ESCAPE '\\')
         ORDER BY due_at, id
         LIMIT ?`
      )
      .all<ReminderRow>(profileId, pattern, pattern, pattern, limit)
      .map(result);
  }

  return Object.freeze({ create, delete: remove, edit, get, search });
}
