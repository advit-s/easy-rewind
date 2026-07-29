import {
  createMobileRepository,
  type MobileRepository,
  type MobileRepositoryDatabase,
  type MobileSyncState,
} from '../db/repository.ts';
import {
  createContentService,
  type CreateMobileContentInput,
  type EditMobileContentInput,
  type MobileContent,
} from '../domain/content-service.ts';
import {
  createFlashcardService,
  type CreateMobileFlashcardInput,
  type MobileFlashcard,
} from '../domain/flashcard-service.ts';
import {
  createReminderService,
  type CreateMobileReminderInput,
  type MobileReminder,
} from '../domain/reminder-service.ts';
import { openExpoMobileDatabase } from '../platform/expo-sqlite.ts';
import { createExpoSecureCredentialStore } from '../platform/expo-secure-store.ts';
import type { SecureCredentialStore } from '../platform/ports.ts';
import type { MobileUiState } from '../ui/sync-status.ts';

const PROFILE_ID_KEY = 'easy-rewind/mobile/profile-id';
const DEVICE_ID_KEY = 'easy-rewind/mobile/device-id';
const DATABASE_NAME = 'easy-rewind.sqlite';
const DAY_MS = 24 * 60 * 60 * 1_000;

export type MobileRuntimeStatus = 'loading' | 'ready' | 'error';

export interface MobileRuntimeSnapshot {
  readonly status: MobileRuntimeStatus;
  readonly revision: number;
  readonly errorMessage: string | null;
}

export interface MobileRuntimeIdentity {
  readonly profileId: string;
  readonly deviceId: string;
}

export interface MobileLocalStatus {
  readonly syncState: MobileUiState;
  readonly queuedCount: number;
  readonly conflictCount: number;
  readonly pairedPcName: string | null;
}

export interface MobileRuntimeConflict {
  readonly id: string;
  readonly title: string;
  readonly localSummary: string;
  readonly pcSummary: string;
}

interface OpenedRuntimeDatabase {
  readonly database: MobileRepositoryDatabase;
}

interface CryptoModule {
  randomUUID(): string;
}

interface ConflictRow {
  id: string;
  entity_type: string;
  entity_id: string;
  local_payload_json: string;
  remote_payload_json: string;
}

interface CountRow {
  count: number;
}

interface DeviceStatusRow {
  paired_pc_id: string | null;
}

export interface CreateMobileRuntimeOptions {
  readonly credentialStore?: SecureCredentialStore;
  readonly openDatabase?: (databaseName: string) => Promise<OpenedRuntimeDatabase>;
  readonly loadCrypto?: () => Promise<CryptoModule>;
  readonly databaseName?: string;
  readonly now?: () => number;
  readonly generateId?: (prefix: string) => string;
}

export interface MobileRuntime {
  snapshot(): MobileRuntimeSnapshot;
  subscribe(listener: (snapshot: MobileRuntimeSnapshot) => void): () => void;
  initialize(): Promise<void>;
  dispose(): void;
  refresh(): void;
  identity(): MobileRuntimeIdentity;
  localStatus(): MobileLocalStatus;
  listContent(query?: string): MobileContent[];
  getContent(id: string): MobileContent | null;
  createContent(input: CreateMobileContentInput): MobileContent;
  editContent(id: string, input: EditMobileContentInput): MobileContent;
  deleteContent(id: string): void;
  listReminders(): MobileReminder[];
  createReminder(input: CreateMobileReminderInput): MobileReminder;
  listFlashcards(): MobileFlashcard[];
  createFlashcard(input: CreateMobileFlashcardInput): MobileFlashcard;
  nextDueFlashcard(): MobileFlashcard | null;
  rateFlashcard(id: string, rating: 'again' | 'hard' | 'good'): MobileFlashcard;
  listConflicts(): MobileRuntimeConflict[];
}

function defaultOpenDatabase(databaseName: string): Promise<OpenedRuntimeDatabase> {
  return openExpoMobileDatabase({ databasePath: databaseName });
}

function defaultLoadCrypto(): Promise<CryptoModule> {
  return import('expo-crypto') as unknown as Promise<CryptoModule>;
}

function validIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= 256 &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function requireTimestamp(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('The mobile runtime clock is invalid.');
  }
  return value;
}

function jsonSummary(serialized: string): string {
  try {
    const value = JSON.parse(serialized) as unknown;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      for (const field of ['title', 'front', 'prompt', 'body', 'excerpt']) {
        const candidate = record[field];
        if (typeof candidate === 'string' && candidate.trim() !== '') {
          return candidate.slice(0, 240);
        }
      }
    }
  } catch {
    // Invalid conflict payloads remain represented without rendering their raw content.
  }
  return 'A preserved version is available.';
}

export function mapDomainSyncState(state: MobileSyncState): MobileUiState {
  const mapping: Record<MobileSyncState, MobileUiState> = {
    local_only: 'offline',
    queued: 'queued',
    synchronized: 'synchronized',
    conflicted: 'conflicted',
    failed: 'retry',
  };
  return mapping[state];
}

export function createMobileRuntime({
  credentialStore = createExpoSecureCredentialStore({
    service: 'easy-rewind.mobile.identity',
  }),
  openDatabase = defaultOpenDatabase,
  loadCrypto = defaultLoadCrypto,
  databaseName = DATABASE_NAME,
  now = Date.now,
  generateId,
}: CreateMobileRuntimeOptions = {}): MobileRuntime {
  if (
    credentialStore === null ||
    typeof credentialStore !== 'object' ||
    typeof credentialStore.get !== 'function' ||
    typeof credentialStore.set !== 'function' ||
    typeof openDatabase !== 'function' ||
    typeof loadCrypto !== 'function' ||
    typeof databaseName !== 'string' ||
    databaseName.trim() === '' ||
    typeof now !== 'function' ||
    (generateId !== undefined && typeof generateId !== 'function')
  ) {
    throw new TypeError('The mobile runtime configuration is invalid.');
  }

  let currentSnapshot: MobileRuntimeSnapshot = Object.freeze({
    status: 'loading',
    revision: 0,
    errorMessage: null,
  });
  let repository: MobileRepository | undefined;
  let content: ReturnType<typeof createContentService> | undefined;
  let reminders: ReturnType<typeof createReminderService> | undefined;
  let flashcards: ReturnType<typeof createFlashcardService> | undefined;
  let runtimeIdentity: MobileRuntimeIdentity | undefined;
  let database: MobileRepositoryDatabase | undefined;
  let initializePromise: Promise<void> | undefined;
  let disposed = false;
  const listeners = new Set<(snapshot: MobileRuntimeSnapshot) => void>();

  function publish(status: MobileRuntimeStatus, errorMessage: string | null = null): void {
    currentSnapshot = Object.freeze({
      status,
      revision: currentSnapshot.revision + 1,
      errorMessage,
    });
    for (const listener of listeners) listener(currentSnapshot);
  }

  function snapshot(): MobileRuntimeSnapshot {
    return currentSnapshot;
  }

  function subscribe(listener: (snapshot: MobileRuntimeSnapshot) => void): () => void {
    if (typeof listener !== 'function') throw new TypeError('The runtime listener is invalid.');
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function requireReady(): {
    repository: MobileRepository;
    content: ReturnType<typeof createContentService>;
    reminders: ReturnType<typeof createReminderService>;
    flashcards: ReturnType<typeof createFlashcardService>;
    identity: MobileRuntimeIdentity;
  } {
    if (
      currentSnapshot.status !== 'ready' ||
      repository === undefined ||
      content === undefined ||
      reminders === undefined ||
      flashcards === undefined ||
      runtimeIdentity === undefined
    ) {
      throw new Error('The local mobile library is not ready.');
    }
    return { repository, content, reminders, flashcards, identity: runtimeIdentity };
  }

  async function getOrCreateIdentity(
    key: string,
    prefix: 'profile' | 'device',
    createId: (prefix: string) => string
  ): Promise<string> {
    const existing = await credentialStore.get(key);
    if (existing !== null) {
      if (!validIdentifier(existing)) {
        throw new Error('The protected mobile identity is invalid.');
      }
      return existing;
    }
    const created = createId(prefix);
    if (!validIdentifier(created)) {
      throw new Error('The mobile identity generator returned an invalid identifier.');
    }
    await credentialStore.set(key, created);
    return created;
  }

  async function performInitialize(): Promise<void> {
    try {
      const crypto = generateId === undefined ? await loadCrypto() : undefined;
      const createId =
        generateId ??
        ((prefix: string) => {
          const id = crypto?.randomUUID();
          if (typeof id !== 'string' || id === '') {
            throw new Error('Expo Crypto did not return an identifier.');
          }
          return `${prefix}-${id}`;
        });
      const [profileId, deviceId] = await Promise.all([
        getOrCreateIdentity(PROFILE_ID_KEY, 'profile', createId),
        getOrCreateIdentity(DEVICE_ID_KEY, 'device', createId),
      ]);
      if (disposed) return;
      const opened = await openDatabase(databaseName);
      if (
        opened === null ||
        typeof opened !== 'object' ||
        opened.database === null ||
        typeof opened.database !== 'object'
      ) {
        throw new Error('The local mobile database could not be opened.');
      }
      if (disposed) {
        opened.database.close?.();
        return;
      }
      database = opened.database;
      repository = createMobileRepository({
        database,
        profileId,
        deviceId,
        displayName: 'Easy Rewind Android',
        now,
        generateId: createId,
      });
      content = createContentService({ repository });
      reminders = createReminderService({ repository });
      flashcards = createFlashcardService({ repository });
      runtimeIdentity = Object.freeze({ profileId, deviceId });
      publish('ready');
    } catch {
      if (!disposed) publish('error', 'The local library could not be opened. Your data was not cleared.');
    }
  }

  function initialize(): Promise<void> {
    if (disposed) return Promise.reject(new Error('The mobile runtime is closed.'));
    initializePromise ??= performInitialize();
    return initializePromise;
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    listeners.clear();
    database?.close?.();
    database = undefined;
    repository = undefined;
    content = undefined;
    reminders = undefined;
    flashcards = undefined;
  }

  function refresh(): void {
    requireReady();
    publish('ready');
  }

  function identity(): MobileRuntimeIdentity {
    return requireReady().identity;
  }

  function count(sql: string, ...parameters: unknown[]): number {
    const row = requireReady()
      .repository.database.prepare(sql)
      .get<CountRow>(...parameters);
    return Number.isSafeInteger(row?.count) && (row?.count ?? -1) >= 0 ? row!.count : 0;
  }

  function localStatus(): MobileLocalStatus {
    const ready = requireReady();
    const { profileId, deviceId } = ready.identity;
    const queuedCount = count(
      `SELECT COUNT(*) AS count
       FROM outbox
       WHERE profile_id = ? AND state IN ('queued', 'sending')`,
      profileId
    );
    const failedCount = count(
      `SELECT COUNT(*) AS count
       FROM outbox
       WHERE profile_id = ? AND state = 'failed'`,
      profileId
    );
    const conflictCount = count(
      `SELECT COUNT(*) AS count
       FROM conflicts
       WHERE profile_id = ? AND state = 'unresolved'`,
      profileId
    );
    const device = ready.repository.database
      .prepare(
        `SELECT paired_pc_id
         FROM device_metadata
         WHERE profile_id = ? AND device_id = ?
         LIMIT 1`
      )
      .get<DeviceStatusRow>(profileId, deviceId);
    const paired = typeof device?.paired_pc_id === 'string' && device.paired_pc_id !== '';
    const syncState: MobileUiState =
      conflictCount > 0
        ? 'conflicted'
        : failedCount > 0
          ? 'retry'
          : paired && queuedCount > 0
            ? 'queued'
            : paired
              ? 'synchronized'
              : 'offline';
    return Object.freeze({
      syncState,
      queuedCount,
      conflictCount,
      pairedPcName: null,
    });
  }

  function listContent(query = ''): MobileContent[] {
    return requireReady().content.search(query, { limit: 200 });
  }

  function getContent(id: string): MobileContent | null {
    return requireReady().content.get(id);
  }

  function createContent(input: CreateMobileContentInput): MobileContent {
    const created = requireReady().content.create(input);
    publish('ready');
    return created;
  }

  function editContent(id: string, input: EditMobileContentInput): MobileContent {
    const edited = requireReady().content.edit(id, input);
    publish('ready');
    return edited;
  }

  function deleteContent(id: string): void {
    requireReady().content.delete(id);
    publish('ready');
  }

  function listReminders(): MobileReminder[] {
    return requireReady().reminders.search('', { limit: 200 });
  }

  function createReminder(input: CreateMobileReminderInput): MobileReminder {
    const created = requireReady().reminders.create(input);
    publish('ready');
    return created;
  }

  function listFlashcards(): MobileFlashcard[] {
    return requireReady().flashcards.search('', { limit: 200 });
  }

  function createFlashcard(input: CreateMobileFlashcardInput): MobileFlashcard {
    const created = requireReady().flashcards.create(input);
    publish('ready');
    return created;
  }

  function nextDueFlashcard(): MobileFlashcard | null {
    const timestamp = requireTimestamp(now());
    return listFlashcards().find(card => card.dueAt <= timestamp) ?? null;
  }

  function rateFlashcard(id: string, rating: 'again' | 'hard' | 'good'): MobileFlashcard {
    const ready = requireReady();
    const current = ready.flashcards.get(id);
    if (current === null || !['again', 'hard', 'good'].includes(rating)) {
      throw new Error('The flashcard rating is invalid.');
    }
    const timestamp = requireTimestamp(now());
    const intervalDays =
      rating === 'again'
        ? 0
        : rating === 'hard'
          ? Math.max(1, Math.round(Math.max(1, current.intervalDays) * 1.2))
          : Math.max(1, Math.round(Math.max(1, current.intervalDays) * 2.5));
    const dueAt = rating === 'again' ? timestamp + 10 * 60 * 1_000 : timestamp + intervalDays * DAY_MS;
    const easeMillis =
      rating === 'again'
        ? Math.max(1_300, current.easeMillis - 200)
        : rating === 'hard'
          ? Math.max(1_300, current.easeMillis - 100)
          : current.easeMillis;
    const edited = ready.flashcards.edit(id, {
      dueAt,
      intervalDays,
      easeMillis,
      reviewCount: current.reviewCount + 1,
    });
    publish('ready');
    return edited;
  }

  function listConflicts(): MobileRuntimeConflict[] {
    const ready = requireReady();
    return ready.repository.database
      .prepare(
        `SELECT id, entity_type, entity_id, local_payload_json, remote_payload_json
         FROM conflicts
         WHERE profile_id = ? AND state = 'unresolved'
         ORDER BY created_at, id
         LIMIT 200`
      )
      .all<ConflictRow>(ready.identity.profileId)
      .map(row =>
        Object.freeze({
          id: row.id,
          title: `${row.entity_type} ${row.entity_id}`,
          localSummary: jsonSummary(row.local_payload_json),
          pcSummary: jsonSummary(row.remote_payload_json),
        })
      );
  }

  return Object.freeze({
    snapshot,
    subscribe,
    initialize,
    dispose,
    refresh,
    identity,
    localStatus,
    listContent,
    getContent,
    createContent,
    editContent,
    deleteContent,
    listReminders,
    createReminder,
    listFlashcards,
    createFlashcard,
    nextDueFlashcard,
    rateFlashcard,
    listConflicts,
  });
}
