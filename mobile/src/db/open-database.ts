import * as migrationsModule from './migrations.ts';

const { MOBILE_MIGRATIONS, MobileMigrationError, applyMobileMigrations } = migrationsModule;

interface MobileDatabase {
  exec(sql: string): void;
  prepare(sql: string): {
    all<T extends object = Record<string, unknown>>(...parameters: unknown[]): T[];
    run(...parameters: unknown[]): unknown;
  };
  close?(): void;
}

interface MobileMigration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
  readonly checksum: string;
}

interface AppliedMobileMigrations {
  appliedVersions: number[];
  currentVersion: number;
}

export interface OpenMobileDatabaseOptions {
  databasePath: string;
  open: (databasePath: string) => MobileDatabase;
  migrations?: readonly MobileMigration[];
  now?: () => number;
}

export interface OpenedMobileDatabase {
  database: MobileDatabase;
  migration: AppliedMobileMigrations;
}

export function openMobileDatabase({
  databasePath,
  open,
  migrations = MOBILE_MIGRATIONS,
  now = Date.now,
}: OpenMobileDatabaseOptions): OpenedMobileDatabase {
  if (typeof databasePath !== 'string' || databasePath.trim() === '' || typeof open !== 'function') {
    throw new MobileMigrationError('MOBILE_DATABASE_PATH_INVALID');
  }

  let database: MobileDatabase;
  try {
    database = open(databasePath);
  } catch {
    throw new MobileMigrationError('MOBILE_DATABASE_OPEN_FAILED');
  }

  try {
    database.exec('PRAGMA foreign_keys = ON');
    const migration = applyMobileMigrations({
      database,
      migrations,
      now,
    });
    return { database, migration };
  } catch (error) {
    try {
      database.close?.();
    } catch {
      // The stable opening or migration failure remains authoritative.
    }
    if (error instanceof MobileMigrationError) {
      throw error;
    }
    throw new MobileMigrationError('MOBILE_DATABASE_OPEN_FAILED');
  }
}
