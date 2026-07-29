import { MOBILE_SCHEMA_VERSION } from './schema.ts';

export interface MobileStatement {
  all<T extends object = Record<string, unknown>>(...parameters: unknown[]): T[];
  run(...parameters: unknown[]): unknown;
}

export interface MobileDatabase {
  exec(sql: string): void;
  prepare(sql: string): MobileStatement;
  close?(): void;
}

export interface MobileMigration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
  readonly checksum: string;
}

export const MOBILE_MIGRATION_ERROR_MESSAGES = Object.freeze({
  MOBILE_MIGRATION_OPTIONS_INVALID: 'Mobile migration options are invalid.',
  MOBILE_MIGRATION_MANIFEST_INVALID: 'The mobile migration manifest is invalid.',
  MOBILE_MIGRATION_VERSION_GAP: 'Mobile migration versions must be contiguous and start at one.',
  MOBILE_MIGRATION_DATABASE_NEWER: 'The mobile database schema is newer than this application.',
  MOBILE_MIGRATION_HISTORY_INVALID: 'The applied mobile migration history is invalid.',
  MOBILE_MIGRATION_NAME_MISMATCH: 'An applied mobile migration name does not match the application.',
  MOBILE_MIGRATION_CHECKSUM_MISMATCH: 'An applied mobile migration checksum does not match the application.',
  MOBILE_MIGRATION_CLOCK_INVALID: 'The mobile migration clock is invalid.',
  MOBILE_MIGRATION_FAILED: 'A mobile database migration failed atomically.',
  MOBILE_DATABASE_PATH_INVALID: 'The injected mobile database path is invalid.',
  MOBILE_DATABASE_OPEN_FAILED: 'The injected mobile database could not be opened.',
});

export type MobileMigrationErrorCode = keyof typeof MOBILE_MIGRATION_ERROR_MESSAGES;

export class MobileMigrationError extends Error {
  readonly code: MobileMigrationErrorCode;

  constructor(code: MobileMigrationErrorCode) {
    super(MOBILE_MIGRATION_ERROR_MESSAGES[code]);
    this.name = 'MobileMigrationError';
    this.code = code;
  }
}

function fail(code: MobileMigrationErrorCode): never {
  throw new MobileMigrationError(code);
}

function rotateRight(value: number, count: number): number {
  return (value >>> count) | (value << (32 - count));
}

function sha256(value: string): string {
  const bytes = new TextEncoder().encode(value);
  const bitLength = bytes.length * 8;
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const message = new Uint8Array(paddedLength);
  message.set(bytes);
  message[bytes.length] = 0x80;

  const view = new DataView(message.buffer);
  const high = Math.floor(bitLength / 0x1_0000_0000);
  const low = bitLength >>> 0;
  view.setUint32(paddedLength - 8, high, false);
  view.setUint32(paddedLength - 4, low, false);

  const hashes = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const constants = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
    0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
    0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
    0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
    0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
    0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
    0xc67178f2,
  ]);
  const words = new Uint32Array(64);

  for (let offset = 0; offset < message.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      words[index] = view.getUint32(offset + index * 4, false);
    }
    for (let index = 16; index < 64; index += 1) {
      const beforeTwo = words[index - 2] ?? 0;
      const beforeFifteen = words[index - 15] ?? 0;
      const sigmaOne = rotateRight(beforeTwo, 17) ^ rotateRight(beforeTwo, 19) ^ (beforeTwo >>> 10);
      const sigmaZero = rotateRight(beforeFifteen, 7) ^ rotateRight(beforeFifteen, 18) ^ (beforeFifteen >>> 3);
      words[index] = (words[index - 16] ?? 0) + sigmaZero + (words[index - 7] ?? 0) + sigmaOne;
    }

    let a = hashes[0] ?? 0;
    let b = hashes[1] ?? 0;
    let c = hashes[2] ?? 0;
    let d = hashes[3] ?? 0;
    let e = hashes[4] ?? 0;
    let f = hashes[5] ?? 0;
    let g = hashes[6] ?? 0;
    let h = hashes[7] ?? 0;

    for (let index = 0; index < 64; index += 1) {
      const sumOne = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temporaryOne = h + sumOne + choice + (constants[index] ?? 0) + (words[index] ?? 0);
      const sumZero = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temporaryTwo = sumZero + majority;

      h = g;
      g = f;
      f = e;
      e = (d + temporaryOne) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temporaryOne + temporaryTwo) >>> 0;
    }

    hashes[0] = ((hashes[0] ?? 0) + a) >>> 0;
    hashes[1] = ((hashes[1] ?? 0) + b) >>> 0;
    hashes[2] = ((hashes[2] ?? 0) + c) >>> 0;
    hashes[3] = ((hashes[3] ?? 0) + d) >>> 0;
    hashes[4] = ((hashes[4] ?? 0) + e) >>> 0;
    hashes[5] = ((hashes[5] ?? 0) + f) >>> 0;
    hashes[6] = ((hashes[6] ?? 0) + g) >>> 0;
    hashes[7] = ((hashes[7] ?? 0) + h) >>> 0;
  }

  return [...hashes].map(part => part.toString(16).padStart(8, '0')).join('');
}

export function createMobileMigration(version: number, name: string, sql: string): MobileMigration {
  return Object.freeze({ version, name, sql, checksum: sha256(sql) });
}

const ownerColumns = `
  profile_id TEXT NOT NULL CHECK (profile_id <> ''),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (typeof(updated_at) = 'integer' AND updated_at >= created_at)
`;

const contentSql = `
CREATE TABLE items (
  id TEXT PRIMARY KEY CHECK (id <> ''),
  ${ownerColumns},
  kind TEXT NOT NULL CHECK (kind IN ('item', 'article', 'video', 'document')),
  url TEXT,
  title TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  source_device_id TEXT,
  UNIQUE (profile_id, id)
);
CREATE INDEX idx_mobile_items_profile_created
  ON items(profile_id, created_at DESC, id);
CREATE INDEX idx_mobile_items_profile_updated
  ON items(profile_id, updated_at DESC, id);

CREATE TABLE bookmarks (
  id TEXT PRIMARY KEY CHECK (id <> ''),
  ${ownerColumns},
  item_id TEXT NOT NULL,
  UNIQUE (profile_id, item_id),
  UNIQUE (profile_id, id),
  FOREIGN KEY (profile_id, item_id) REFERENCES items(profile_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_mobile_bookmarks_profile_item
  ON bookmarks(profile_id, item_id, id);

CREATE TABLE notes (
  id TEXT PRIMARY KEY CHECK (id <> ''),
  ${ownerColumns},
  item_id TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  UNIQUE (profile_id, id),
  FOREIGN KEY (profile_id, item_id) REFERENCES items(profile_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_mobile_notes_profile_item
  ON notes(profile_id, item_id, updated_at DESC, id);

CREATE TABLE highlights (
  id TEXT PRIMARY KEY CHECK (id <> ''),
  ${ownerColumns},
  item_id TEXT NOT NULL,
  quote TEXT NOT NULL CHECK (quote <> ''),
  note TEXT NOT NULL DEFAULT '',
  selector_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE (profile_id, id),
  FOREIGN KEY (profile_id, item_id) REFERENCES items(profile_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_mobile_highlights_profile_item
  ON highlights(profile_id, item_id, created_at, id);

CREATE TABLE tags (
  id TEXT PRIMARY KEY CHECK (id <> ''),
  ${ownerColumns},
  name TEXT NOT NULL CHECK (name <> ''),
  normalized_name TEXT NOT NULL CHECK (normalized_name <> ''),
  UNIQUE (profile_id, normalized_name),
  UNIQUE (profile_id, id)
);
CREATE INDEX idx_mobile_tags_profile_name
  ON tags(profile_id, normalized_name, id);

CREATE TABLE item_tags (
  id TEXT PRIMARY KEY CHECK (id <> ''),
  ${ownerColumns},
  item_id TEXT NOT NULL,
  tag_id TEXT NOT NULL,
  UNIQUE (profile_id, item_id, tag_id),
  FOREIGN KEY (profile_id, item_id) REFERENCES items(profile_id, id) ON DELETE CASCADE,
  FOREIGN KEY (profile_id, tag_id) REFERENCES tags(profile_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_mobile_item_tags_profile_item
  ON item_tags(profile_id, item_id, tag_id);
CREATE INDEX idx_mobile_item_tags_profile_tag
  ON item_tags(profile_id, tag_id, item_id);
`;

const learningSql = `
CREATE TABLE reminders (
  id TEXT PRIMARY KEY CHECK (id <> ''),
  ${ownerColumns},
  item_id TEXT,
  title TEXT NOT NULL CHECK (title <> ''),
  body TEXT NOT NULL DEFAULT '',
  due_at INTEGER NOT NULL CHECK (typeof(due_at) = 'integer' AND due_at >= 0),
  state TEXT NOT NULL CHECK (state IN ('scheduled', 'completed', 'dismissed', 'cancelled')),
  local_notification_id TEXT,
  UNIQUE (profile_id, id),
  FOREIGN KEY (profile_id, item_id) REFERENCES items(profile_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_mobile_reminders_profile_due
  ON reminders(profile_id, state, due_at, id);

CREATE TABLE flashcards (
  id TEXT PRIMARY KEY CHECK (id <> ''),
  ${ownerColumns},
  item_id TEXT,
  front TEXT NOT NULL CHECK (front <> ''),
  back TEXT NOT NULL CHECK (back <> ''),
  due_at INTEGER NOT NULL CHECK (typeof(due_at) = 'integer' AND due_at >= 0),
  interval_days INTEGER NOT NULL DEFAULT 0 CHECK (interval_days >= 0),
  ease_millis INTEGER NOT NULL DEFAULT 2500 CHECK (ease_millis > 0),
  review_count INTEGER NOT NULL DEFAULT 0 CHECK (review_count >= 0),
  UNIQUE (profile_id, id),
  FOREIGN KEY (profile_id, item_id) REFERENCES items(profile_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_mobile_flashcards_profile_due
  ON flashcards(profile_id, due_at, id);
`;

const syncSql = `
CREATE TABLE outbox (
  id TEXT PRIMARY KEY CHECK (id <> ''),
  ${ownerColumns},
  device_id TEXT NOT NULL CHECK (device_id <> ''),
  device_sequence INTEGER NOT NULL CHECK (device_sequence >= 1),
  entity_type TEXT NOT NULL CHECK (entity_type <> ''),
  entity_id TEXT NOT NULL CHECK (entity_id <> ''),
  operation TEXT NOT NULL CHECK (operation IN ('upsert', 'delete', 'resolve')),
  payload_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued', 'sending', 'acknowledged', 'failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error_code TEXT,
  UNIQUE (profile_id, device_id, device_sequence),
  UNIQUE (profile_id, id)
);
CREATE INDEX idx_mobile_outbox_profile_device_sequence
  ON outbox(profile_id, device_id, device_sequence);
CREATE INDEX idx_mobile_outbox_profile_state
  ON outbox(profile_id, state, created_at, id);

CREATE TABLE inbox_acknowledgements (
  id TEXT PRIMARY KEY CHECK (id <> ''),
  ${ownerColumns},
  device_id TEXT NOT NULL CHECK (device_id <> ''),
  change_id TEXT NOT NULL CHECK (change_id <> ''),
  server_sequence INTEGER NOT NULL CHECK (server_sequence >= 1),
  UNIQUE (profile_id, device_id, change_id),
  UNIQUE (profile_id, id)
);
CREATE INDEX idx_mobile_inbox_profile_change
  ON inbox_acknowledgements(profile_id, device_id, server_sequence, change_id);

CREATE TABLE sync_cursor (
  id TEXT PRIMARY KEY CHECK (id <> ''),
  ${ownerColumns},
  device_id TEXT NOT NULL CHECK (device_id <> ''),
  opaque_cursor TEXT,
  last_success_at INTEGER CHECK (
    last_success_at IS NULL OR
    (typeof(last_success_at) = 'integer' AND last_success_at >= 0)
  ),
  UNIQUE (profile_id, device_id),
  UNIQUE (profile_id, id)
);
CREATE INDEX idx_mobile_sync_cursor_profile_device
  ON sync_cursor(profile_id, device_id, id);

CREATE TABLE conflicts (
  id TEXT PRIMARY KEY CHECK (id <> ''),
  ${ownerColumns},
  entity_type TEXT NOT NULL CHECK (entity_type <> ''),
  entity_id TEXT NOT NULL CHECK (entity_id <> ''),
  local_payload_json TEXT NOT NULL,
  remote_payload_json TEXT NOT NULL,
  base_revision INTEGER NOT NULL CHECK (base_revision >= 0),
  remote_revision INTEGER NOT NULL CHECK (remote_revision >= 0),
  state TEXT NOT NULL CHECK (state IN ('unresolved', 'resolved_local', 'resolved_remote', 'resolved_merged')),
  resolved_at INTEGER CHECK (
    resolved_at IS NULL OR
    (typeof(resolved_at) = 'integer' AND resolved_at >= 0)
  ),
  UNIQUE (profile_id, id)
);
CREATE INDEX idx_mobile_conflicts_profile_state
  ON conflicts(profile_id, state, created_at, id);

CREATE TABLE tombstones (
  id TEXT PRIMARY KEY CHECK (id <> ''),
  ${ownerColumns},
  entity_type TEXT NOT NULL CHECK (entity_type <> ''),
  entity_id TEXT NOT NULL CHECK (entity_id <> ''),
  deleted_at INTEGER NOT NULL CHECK (typeof(deleted_at) = 'integer' AND deleted_at >= 0),
  UNIQUE (profile_id, entity_type, entity_id),
  UNIQUE (profile_id, id)
);
CREATE INDEX idx_mobile_tombstones_profile_entity
  ON tombstones(profile_id, entity_type, entity_id);

CREATE TABLE device_metadata (
  id TEXT PRIMARY KEY CHECK (id <> ''),
  ${ownerColumns},
  device_id TEXT NOT NULL CHECK (device_id <> ''),
  display_name TEXT NOT NULL CHECK (display_name <> ''),
  next_sequence INTEGER NOT NULL DEFAULT 1 CHECK (next_sequence >= 1),
  protocol_version INTEGER NOT NULL CHECK (protocol_version >= 1),
  paired_pc_id TEXT,
  UNIQUE (profile_id, device_id),
  UNIQUE (profile_id, id)
);
CREATE INDEX idx_mobile_device_metadata_profile_device
  ON device_metadata(profile_id, device_id, id);
`;

export const MOBILE_MIGRATIONS = Object.freeze([
  createMobileMigration(1, 'content', contentSql),
  createMobileMigration(2, 'learning', learningSql),
  createMobileMigration(3, 'sync', syncSql),
]);

interface AppliedMigrationRow {
  version: unknown;
  name: unknown;
  checksum: unknown;
  applied_at: unknown;
}

function validateManifest(migrations: readonly MobileMigration[]): readonly MobileMigration[] {
  if (!Array.isArray(migrations) || migrations.length === 0) {
    fail('MOBILE_MIGRATION_MANIFEST_INVALID');
  }

  const normalized = migrations
    .map(migration => {
      if (
        migration === null ||
        typeof migration !== 'object' ||
        !Number.isSafeInteger(migration.version) ||
        migration.version < 1 ||
        typeof migration.name !== 'string' ||
        !/^[a-z][a-z0-9_]*$/.test(migration.name) ||
        typeof migration.sql !== 'string' ||
        migration.sql.trim() === '' ||
        typeof migration.checksum !== 'string' ||
        !/^[a-f0-9]{64}$/.test(migration.checksum) ||
        sha256(migration.sql) !== migration.checksum
      ) {
        fail('MOBILE_MIGRATION_MANIFEST_INVALID');
      }
      return migration;
    })
    .sort((left, right) => left.version - right.version);

  const names = new Set<string>();
  for (const [index, migration] of normalized.entries()) {
    if (migration.version !== index + 1) {
      fail('MOBILE_MIGRATION_VERSION_GAP');
    }
    if (names.has(migration.name)) {
      fail('MOBILE_MIGRATION_MANIFEST_INVALID');
    }
    names.add(migration.name);
  }
  return normalized;
}

function createMigrationTable(database: MobileDatabase): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY CHECK (version >= 1),
      name TEXT NOT NULL UNIQUE CHECK (name <> ''),
      checksum TEXT NOT NULL CHECK (length(checksum) = 64),
      applied_at INTEGER NOT NULL CHECK (
        typeof(applied_at) = 'integer' AND applied_at >= 0
      )
    )
  `);
}

function readApplied(database: MobileDatabase): AppliedMigrationRow[] {
  return database
    .prepare(
      `SELECT version, name, checksum, applied_at
       FROM schema_migrations
       ORDER BY version`
    )
    .all<AppliedMigrationRow>();
}

function validateApplied(applied: readonly AppliedMigrationRow[], migrations: readonly MobileMigration[]): number {
  const latestKnown = migrations.at(-1)?.version ?? 0;
  if (applied.some(row => Number.isSafeInteger(row.version) && (row.version as number) > latestKnown)) {
    fail('MOBILE_MIGRATION_DATABASE_NEWER');
  }

  for (const [index, row] of applied.entries()) {
    if (
      !Number.isSafeInteger(row.version) ||
      row.version !== index + 1 ||
      typeof row.name !== 'string' ||
      typeof row.checksum !== 'string' ||
      !Number.isSafeInteger(row.applied_at) ||
      (row.applied_at as number) < 0
    ) {
      fail('MOBILE_MIGRATION_HISTORY_INVALID');
    }

    const canonical = migrations[index];
    if (canonical === undefined) {
      fail('MOBILE_MIGRATION_DATABASE_NEWER');
    }
    if (row.name !== canonical.name) {
      fail('MOBILE_MIGRATION_NAME_MISMATCH');
    }
    if (row.checksum !== canonical.checksum) {
      fail('MOBILE_MIGRATION_CHECKSUM_MISMATCH');
    }
  }
  return applied.length;
}

function rollback(database: MobileDatabase): void {
  try {
    database.exec('ROLLBACK');
  } catch {
    // Preserve the stable migration failure as the public error.
  }
}

function runTransaction<T>(database: MobileDatabase, work: () => T): T {
  try {
    database.exec('BEGIN IMMEDIATE');
  } catch {
    fail('MOBILE_MIGRATION_FAILED');
  }

  try {
    const result = work();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    rollback(database);
    if (error instanceof MobileMigrationError) {
      throw error;
    }
    fail('MOBILE_MIGRATION_FAILED');
  }
}

export interface ApplyMobileMigrationsOptions {
  database: MobileDatabase;
  migrations?: readonly MobileMigration[];
  now?: () => number;
}

export interface AppliedMobileMigrations {
  appliedVersions: number[];
  currentVersion: number;
}

export function applyMobileMigrations({
  database,
  migrations = MOBILE_MIGRATIONS,
  now = Date.now,
}: ApplyMobileMigrationsOptions): AppliedMobileMigrations {
  if (
    database === null ||
    typeof database !== 'object' ||
    typeof database.exec !== 'function' ||
    typeof database.prepare !== 'function' ||
    typeof now !== 'function'
  ) {
    fail('MOBILE_MIGRATION_OPTIONS_INVALID');
  }

  const manifest = validateManifest(migrations);
  const appliedCount = runTransaction(database, () => {
    createMigrationTable(database);
    return validateApplied(readApplied(database), manifest);
  });

  const appliedVersions: number[] = [];
  for (const migration of manifest.slice(appliedCount)) {
    runTransaction(database, () => {
      createMigrationTable(database);
      const currentCount = validateApplied(readApplied(database), manifest);
      if (currentCount >= migration.version) {
        return;
      }
      if (currentCount !== migration.version - 1) {
        fail('MOBILE_MIGRATION_HISTORY_INVALID');
      }

      const appliedAt = now();
      if (!Number.isSafeInteger(appliedAt) || appliedAt < 0) {
        fail('MOBILE_MIGRATION_CLOCK_INVALID');
      }
      database.exec(migration.sql);
      database
        .prepare(
          `INSERT INTO schema_migrations(version, name, checksum, applied_at)
           VALUES (?, ?, ?, ?)`
        )
        .run(migration.version, migration.name, migration.checksum, appliedAt);
      appliedVersions.push(migration.version);
    });
  }

  const currentVersion = manifest.at(-1)?.version;
  if (currentVersion !== MOBILE_SCHEMA_VERSION && migrations === MOBILE_MIGRATIONS) {
    fail('MOBILE_MIGRATION_MANIFEST_INVALID');
  }

  return { appliedVersions, currentVersion: currentVersion ?? 0 };
}
