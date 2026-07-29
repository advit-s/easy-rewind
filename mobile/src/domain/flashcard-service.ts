import { MobileOfflineDomainError, type MobileRepository, type MobileSyncState } from '../db/repository.ts';

export interface MobileFlashcard {
  id: string;
  profileId: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
  itemId: string | null;
  front: string;
  back: string;
  dueAt: number;
  intervalDays: number;
  easeMillis: number;
  reviewCount: number;
  syncState: MobileSyncState;
}

interface FlashcardRow {
  id: string;
  profile_id: string;
  revision: number;
  created_at: number;
  updated_at: number;
  item_id: string | null;
  front: string;
  back: string;
  due_at: number;
  interval_days: number;
  ease_millis: number;
  review_count: number;
}

export interface CreateMobileFlashcardInput {
  id?: string;
  itemId?: string | null;
  front: string;
  back: string;
  dueAt: number;
  intervalDays?: number;
  easeMillis?: number;
  reviewCount?: number;
}

export type EditMobileFlashcardInput = Partial<Omit<CreateMobileFlashcardInput, 'id'>>;

function requiredText(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 32_768) {
    throw new MobileOfflineDomainError('INPUT_INVALID', `The mobile flashcard ${name} is invalid.`);
  }
  return value;
}

function nullableId(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || value.trim() === '' || value.length > 256) {
    throw new MobileOfflineDomainError('INPUT_INVALID', 'The mobile flashcard item ID is invalid.');
  }
  return value;
}

function integer(value: unknown, name: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new MobileOfflineDomainError('INPUT_INVALID', `The mobile flashcard ${name} is invalid.`);
  }
  return value as number;
}

function syncPayload(row: FlashcardRow): Readonly<Record<string, unknown>> {
  return {
    answer: row.back,
    dueAt: row.due_at,
    easeFactor: row.ease_millis / 1_000,
    intervalDays: row.interval_days,
    itemId: row.item_id,
    prompt: row.front,
    state: 'active',
  };
}

export function createFlashcardService({ repository }: { repository: MobileRepository }) {
  const { database, profileId } = repository;

  function rowById(id: string): FlashcardRow | undefined {
    return database
      .prepare(
        `SELECT id, profile_id, revision, created_at, updated_at, item_id,
                front, back, due_at, interval_days, ease_millis, review_count
         FROM flashcards
         WHERE profile_id = ? AND id = ?
         LIMIT 1`
      )
      .get<FlashcardRow>(profileId, id);
  }

  function result(row: FlashcardRow): MobileFlashcard {
    return {
      id: row.id,
      profileId: row.profile_id,
      revision: row.revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      itemId: row.item_id,
      front: row.front,
      back: row.back,
      dueAt: row.due_at,
      intervalDays: row.interval_days,
      easeMillis: row.ease_millis,
      reviewCount: row.review_count,
      syncState: repository.entitySyncState('flashcard', row.id),
    };
  }

  function get(id: string): MobileFlashcard | null {
    const row = rowById(id);
    return row ? result(row) : null;
  }

  function create(input: CreateMobileFlashcardInput): MobileFlashcard {
    const id = input.id ?? repository.generateEntityId('flashcard');
    const normalized: FlashcardRow = {
      id,
      profile_id: profileId,
      revision: 0,
      created_at: 0,
      updated_at: 0,
      item_id: nullableId(input.itemId ?? null),
      front: requiredText(input.front, 'front'),
      back: requiredText(input.back, 'back'),
      due_at: integer(input.dueAt, 'due time'),
      interval_days: integer(input.intervalDays ?? 0, 'interval'),
      ease_millis: integer(input.easeMillis ?? 2_500, 'ease', 1),
      review_count: integer(input.reviewCount ?? 0, 'review count'),
    };
    repository.commitMutation({
      entityType: 'flashcard',
      entityId: id,
      operation: 'upsert',
      baseRevision: 0,
      payload: syncPayload(normalized),
      apply: ({ database: transactionDatabase, at }) => {
        transactionDatabase
          .prepare(
            `INSERT INTO flashcards(
              id, profile_id, revision, created_at, updated_at, item_id,
              front, back, due_at, interval_days, ease_millis, review_count
            ) VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            id,
            profileId,
            at,
            at,
            normalized.item_id,
            normalized.front,
            normalized.back,
            normalized.due_at,
            normalized.interval_days,
            normalized.ease_millis,
            normalized.review_count
          );
      },
    });
    return result(rowById(id)!);
  }

  function edit(id: string, patch: EditMobileFlashcardInput): MobileFlashcard {
    const current = rowById(id);
    if (!current) throw new MobileOfflineDomainError('INPUT_INVALID', 'The mobile flashcard was not found.');
    const next: FlashcardRow = {
      ...current,
      item_id: patch.itemId === undefined ? current.item_id : nullableId(patch.itemId),
      front: patch.front === undefined ? current.front : requiredText(patch.front, 'front'),
      back: patch.back === undefined ? current.back : requiredText(patch.back, 'back'),
      due_at: patch.dueAt === undefined ? current.due_at : integer(patch.dueAt, 'due time'),
      interval_days: patch.intervalDays === undefined ? current.interval_days : integer(patch.intervalDays, 'interval'),
      ease_millis: patch.easeMillis === undefined ? current.ease_millis : integer(patch.easeMillis, 'ease', 1),
      review_count: patch.reviewCount === undefined ? current.review_count : integer(patch.reviewCount, 'review count'),
    };
    repository.commitMutation({
      entityType: 'flashcard',
      entityId: id,
      operation: 'upsert',
      baseRevision: current.revision,
      payload: syncPayload(next),
      apply: ({ database: transactionDatabase, at }) => {
        transactionDatabase
          .prepare(
            `UPDATE flashcards
             SET item_id = ?, front = ?, back = ?, due_at = ?,
                 interval_days = ?, ease_millis = ?, review_count = ?, updated_at = ?
             WHERE profile_id = ? AND id = ?`
          )
          .run(
            next.item_id,
            next.front,
            next.back,
            next.due_at,
            next.interval_days,
            next.ease_millis,
            next.review_count,
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
    if (!current) throw new MobileOfflineDomainError('INPUT_INVALID', 'The mobile flashcard was not found.');
    const mutation = repository.commitMutation({
      entityType: 'flashcard',
      entityId: id,
      operation: 'delete',
      baseRevision: current.revision,
      payload: {},
      apply: ({ database: transactionDatabase, at }) => {
        transactionDatabase.prepare(`DELETE FROM flashcards WHERE profile_id = ? AND id = ?`).run(profileId, id);
        transactionDatabase
          .prepare(
            `INSERT INTO tombstones(
              id, profile_id, revision, created_at, updated_at,
              entity_type, entity_id, deleted_at
            ) VALUES (?, ?, ?, ?, ?, 'flashcard', ?, ?)
            ON CONFLICT(profile_id, entity_type, entity_id) DO UPDATE SET
              revision = excluded.revision,
              updated_at = excluded.updated_at,
              deleted_at = excluded.deleted_at`
          )
          .run(`tombstone:${profileId}:flashcard:${id}`, profileId, current.revision, at, at, id, at);
      },
    });
    return { id, revision: current.revision, syncState: mutation.syncState };
  }

  function search(query: string, { limit = 50 }: { limit?: number } = {}): MobileFlashcard[] {
    if (typeof query !== 'string' || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
      throw new MobileOfflineDomainError('INPUT_INVALID', 'The mobile flashcard search is invalid.');
    }
    const pattern = `%${query.replace(/[\\%_]/gu, '\\$&')}%`;
    return database
      .prepare(
        `SELECT id, profile_id, revision, created_at, updated_at, item_id,
                front, back, due_at, interval_days, ease_millis, review_count
         FROM flashcards
         WHERE profile_id = ?
           AND (front LIKE ? ESCAPE '\\' OR back LIKE ? ESCAPE '\\')
         ORDER BY due_at, id
         LIMIT ?`
      )
      .all<FlashcardRow>(profileId, pattern, pattern, limit)
      .map(result);
  }

  return Object.freeze({ create, delete: remove, edit, get, search });
}
