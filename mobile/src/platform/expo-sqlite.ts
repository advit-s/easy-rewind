import { MobileMigrationError } from '../db/migrations.ts';
import { openMobileDatabase, type OpenMobileDatabaseOptions, type OpenedMobileDatabase } from '../db/open-database.ts';
import type { MobileRepositoryDatabase, MobileRepositoryStatement } from '../db/repository.ts';

interface ExpoSqliteResult {
  readonly changes?: number;
  readonly lastInsertRowId?: number;
  getFirstSync(...parameters: unknown[]): unknown;
  getAllSync(...parameters: unknown[]): unknown[];
}

interface ExpoSqliteStatement {
  executeSync(...parameters: unknown[]): ExpoSqliteResult;
}

interface ExpoSqliteDatabase {
  execSync(sql: string): void;
  prepareSync(sql: string): ExpoSqliteStatement;
  closeSync?(): void;
}

export interface ExpoSqliteModule {
  openDatabaseSync(databasePath: string): ExpoSqliteDatabase;
}

export type ExpoSqliteLoader = () => Promise<ExpoSqliteModule>;

function defaultExpoSqliteLoader(): Promise<ExpoSqliteModule> {
  return import('expo-sqlite') as unknown as Promise<ExpoSqliteModule>;
}

function requireNativeDatabase(value: unknown): ExpoSqliteDatabase {
  const database = value as Partial<ExpoSqliteDatabase> | null;
  if (
    database === null ||
    typeof database !== 'object' ||
    typeof database.execSync !== 'function' ||
    typeof database.prepareSync !== 'function'
  ) {
    throw new MobileMigrationError('MOBILE_DATABASE_OPEN_FAILED');
  }
  return database as ExpoSqliteDatabase;
}

function requireNativeStatement(value: unknown): ExpoSqliteStatement {
  const statement = value as Partial<ExpoSqliteStatement> | null;
  if (statement === null || typeof statement !== 'object' || typeof statement.executeSync !== 'function') {
    throw new MobileMigrationError('MOBILE_DATABASE_OPEN_FAILED');
  }
  return statement as ExpoSqliteStatement;
}

export function adaptExpoSqliteDatabase(nativeDatabase: ExpoSqliteDatabase): MobileRepositoryDatabase {
  const database = requireNativeDatabase(nativeDatabase);
  return Object.freeze({
    exec(sql: string): void {
      database.execSync(sql);
    },
    prepare(sql: string): MobileRepositoryStatement {
      const statement = requireNativeStatement(database.prepareSync(sql));
      return Object.freeze({
        all<T extends object = Record<string, unknown>>(...parameters: unknown[]): T[] {
          return statement.executeSync(...parameters).getAllSync() as T[];
        },
        get<T extends object = Record<string, unknown>>(...parameters: unknown[]): T | undefined {
          return (statement.executeSync(...parameters).getFirstSync() ?? undefined) as T | undefined;
        },
        run(...parameters: unknown[]): unknown {
          return statement.executeSync(...parameters);
        },
      });
    },
    close(): void {
      database.closeSync?.();
    },
  });
}

export interface OpenExpoMobileDatabaseOptions {
  databasePath: string;
  loadExpoSqlite?: ExpoSqliteLoader;
  migrations?: OpenMobileDatabaseOptions['migrations'];
  now?: () => number;
}

export async function openExpoMobileDatabase({
  databasePath,
  loadExpoSqlite = defaultExpoSqliteLoader,
  migrations,
  now,
}: OpenExpoMobileDatabaseOptions): Promise<OpenedMobileDatabase & { database: MobileRepositoryDatabase }> {
  if (typeof databasePath !== 'string' || databasePath.trim() === '' || typeof loadExpoSqlite !== 'function') {
    throw new MobileMigrationError('MOBILE_DATABASE_PATH_INVALID');
  }

  let expoSqlite: ExpoSqliteModule;
  try {
    expoSqlite = await loadExpoSqlite();
    if (expoSqlite === null || typeof expoSqlite !== 'object' || typeof expoSqlite.openDatabaseSync !== 'function') {
      throw new Error('invalid Expo SQLite module');
    }
  } catch {
    throw new MobileMigrationError('MOBILE_DATABASE_OPEN_FAILED');
  }

  const options: OpenMobileDatabaseOptions = {
    databasePath,
    open: requestedPath => adaptExpoSqliteDatabase(expoSqlite.openDatabaseSync(requestedPath)),
  };
  if (migrations !== undefined) options.migrations = migrations;
  if (now !== undefined) options.now = now;
  return openMobileDatabase(options) as OpenedMobileDatabase & { database: MobileRepositoryDatabase };
}
