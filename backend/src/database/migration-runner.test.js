'use strict';

const assert = require('node:assert/strict');
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const BetterSqlite3 = require('better-sqlite3');

const temporaryRoots = new Set();

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'easy-rewind-migrations-'));
  temporaryRoots.add(root);
  return root;
}

function makeMigrationDirectory(files) {
  const directory = join(makeRoot(), 'migrations');
  mkdirSync(directory);
  for (const [name, bytes] of Object.entries(files)) writeFileSync(join(directory, name), bytes);
  return directory;
}

function memoryDatabase() {
  const db = new BetterSqlite3(':memory:');
  db.pragma('foreign_keys = ON');
  return db;
}

function assertMigrationError(operation, expectedCode, forbiddenValue) {
  assert.throws(operation, error => {
    assert.equal(error.name, 'MigrationError');
    assert.equal(error.code, expectedCode);
    assert.equal(typeof error.message, 'string');
    if (forbiddenValue) assert.equal(error.message.includes(forbiddenValue), false);
    assert.equal(Object.hasOwn(error, 'sql'), false);
    assert.equal(Object.hasOwn(error, 'path'), false);
    assert.equal(Object.hasOwn(error, 'cause'), false);
    return true;
  });
}

test.after(() => {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
});

test('importing the migration runner performs no filesystem or database I/O', () => {
  const modulePath = join(__dirname, 'migration-runner.js');
  const script = `
    const fs = require('node:fs');
    for (const name of ['lstatSync', 'readdirSync']) {
      fs[name] = () => { throw new Error('filesystem I/O during import'); };
    }
    require(${JSON.stringify(modulePath)});
  `;
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: resolve(__dirname, '..', '..', '..'),
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(result.status, 0, `migration runner import must remain inert: ${result.stderr}`);
});

test('new databases apply ordered migrations and repeated runs are no-ops', () => {
  const directory = makeMigrationDirectory({
    '001_core.sql': 'CREATE TABLE core_record (id TEXT PRIMARY KEY);',
    '002_more.sql': 'CREATE TABLE more_record (id TEXT PRIMARY KEY);',
  });
  const { discoverMigrations, runMigrations } = require('./migration-runner');
  const db = memoryDatabase();
  const now = () => 1730000000000;

  const migrations = discoverMigrations({ directory });
  const first = runMigrations({ db, migrations, now });
  const second = runMigrations({ db, migrations, now });

  assert.deepEqual(first, { appliedVersions: [1, 2], currentVersion: 2 });
  assert.deepEqual(second, { appliedVersions: [], currentVersion: 2 });
  assert.deepEqual(
    db.prepare('SELECT version, name, length(checksum) AS checksum_length, applied_at FROM schema_migrations').all(),
    [
      { version: 1, name: 'core', checksum_length: 64, applied_at: 1730000000000 },
      { version: 2, name: 'more', checksum_length: 64, applied_at: 1730000000000 },
    ]
  );
  db.close();
});

test('modified applied migration bytes are rejected before applying anything', () => {
  const initialDirectory = makeMigrationDirectory({
    '001_core.sql': 'CREATE TABLE original_record (id TEXT PRIMARY KEY);',
  });
  const modifiedDirectory = makeMigrationDirectory({
    '001_core.sql': 'CREATE TABLE changed_record (id TEXT PRIMARY KEY);',
    '002_pending.sql': 'CREATE TABLE must_not_exist (id TEXT PRIMARY KEY);',
  });
  const { discoverMigrations, runMigrations } = require('./migration-runner');
  const db = memoryDatabase();
  runMigrations({ db, migrations: discoverMigrations({ directory: initialDirectory }) });

  assertMigrationError(
    () => runMigrations({ db, migrations: discoverMigrations({ directory: modifiedDirectory }) }),
    'MIGRATION_CHECKSUM_MISMATCH'
  );
  assert.equal(
    db.prepare("SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'must_not_exist'").pluck().get(),
    0
  );
  db.close();
});

test('interrupted migrations roll back all SQL and omit the migration record', () => {
  const directory = makeMigrationDirectory({
    '001_core.sql': 'CREATE TABLE stable_record (id TEXT PRIMARY KEY);',
    '002_broken.sql': 'CREATE TABLE partial_record (id TEXT PRIMARY KEY); INSERT INTO missing_record DEFAULT VALUES;',
  });
  const { discoverMigrations, runMigrations } = require('./migration-runner');
  const db = memoryDatabase();

  assertMigrationError(
    () => runMigrations({ db, migrations: discoverMigrations({ directory }) }),
    'MIGRATION_SQL_FAILED'
  );
  assert.equal(
    db.prepare("SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'stable_record'").pluck().get(),
    1
  );
  assert.equal(
    db.prepare("SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'partial_record'").pluck().get(),
    0
  );
  assert.deepEqual(db.prepare('SELECT version FROM schema_migrations ORDER BY version').pluck().all(), [1]);
  db.close();
});

test('databases newer than the known migration manifest are rejected', () => {
  const directory = makeMigrationDirectory({
    '001_core.sql': 'CREATE TABLE core_record (id TEXT PRIMARY KEY);',
  });
  const { discoverMigrations, runMigrations } = require('./migration-runner');
  const db = memoryDatabase();
  const migrations = discoverMigrations({ directory });
  db.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      checksum TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    )
  `);
  db.prepare('INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (?, ?, ?, ?)').run(
    99,
    'future',
    'a'.repeat(64),
    1730000000000
  );

  assertMigrationError(() => runMigrations({ db, migrations }), 'MIGRATION_DATABASE_NEWER');
  db.close();
});

test('migration discovery rejects gaps, duplicate versions, duplicate names, and invalid names', async t => {
  const { discoverMigrations } = require('./migration-runner');
  const cases = [
    [
      'gap',
      {
        '001_core.sql': 'SELECT 1;',
        '003_later.sql': 'SELECT 1;',
      },
      'MIGRATION_VERSION_GAP',
    ],
    [
      'duplicate version',
      {
        '001_core.sql': 'SELECT 1;',
        '001_other.sql': 'SELECT 1;',
      },
      'MIGRATION_VERSION_DUPLICATE',
    ],
    [
      'duplicate name',
      {
        '001_core.sql': 'SELECT 1;',
        '002_core.sql': 'SELECT 1;',
      },
      'MIGRATION_NAME_DUPLICATE',
    ],
    [
      'zero version',
      {
        '000_core.sql': 'SELECT 1;',
      },
      'MIGRATION_VERSION_INVALID',
    ],
    [
      'invalid SQL filename',
      {
        '001_core.sql': 'SELECT 1;',
        'second.sql': 'SELECT 1;',
      },
      'MIGRATION_FILENAME_INVALID',
    ],
  ];

  for (const [label, files, expectedCode] of cases) {
    await t.test(label, () => {
      const directory = makeMigrationDirectory(files);
      assertMigrationError(() => discoverMigrations({ directory }), expectedCode, directory);
    });
  }
});

test('applied migration name drift and corrupt applied history are rejected', async t => {
  const { discoverMigrations, runMigrations } = require('./migration-runner');

  await t.test('stable name mismatch', () => {
    const initial = discoverMigrations({
      directory: makeMigrationDirectory({ '001_core.sql': 'CREATE TABLE core_record (id TEXT);' }),
    });
    const renamed = discoverMigrations({
      directory: makeMigrationDirectory({ '001_renamed.sql': 'CREATE TABLE core_record (id TEXT);' }),
    });
    const db = memoryDatabase();
    runMigrations({ db, migrations: initial });
    assertMigrationError(() => runMigrations({ db, migrations: renamed }), 'MIGRATION_NAME_MISMATCH');
    db.close();
  });

  await t.test('applied history gap', () => {
    const migrations = discoverMigrations({
      directory: makeMigrationDirectory({
        '001_core.sql': 'SELECT 1;',
        '002_more.sql': 'SELECT 1;',
      }),
    });
    const db = memoryDatabase();
    runMigrations({ db, migrations });
    db.prepare('DELETE FROM schema_migrations WHERE version = 1').run();
    assertMigrationError(() => runMigrations({ db, migrations }), 'MIGRATION_HISTORY_INVALID');
    db.close();
  });
});

test('migration application revalidates state inside each immediate write transaction', () => {
  const directory = makeMigrationDirectory({
    '001_core.sql': 'CREATE TABLE core_record (id TEXT PRIMARY KEY);',
  });
  const { discoverMigrations, runMigrations } = require('./migration-runner');
  const db = memoryDatabase();
  const statements = [];
  const originalExec = db.exec.bind(db);
  db.exec = sql => {
    statements.push(sql.trim().toUpperCase());
    return originalExec(sql);
  };

  runMigrations({ db, migrations: discoverMigrations({ directory }) });

  assert.equal(statements.filter(sql => sql === 'BEGIN IMMEDIATE').length >= 2, true);
  assert.equal(statements.includes('COMMIT'), true);
  db.close();
});

test('concurrent migration writers fail safely when the configured busy timeout expires', () => {
  const root = makeRoot();
  const path = join(root, 'concurrent.sqlite3');
  const directory = makeMigrationDirectory({
    '001_core.sql': 'CREATE TABLE core_record (id TEXT PRIMARY KEY);',
  });
  const { discoverMigrations, runMigrations } = require('./migration-runner');
  const first = new BetterSqlite3(path);
  const second = new BetterSqlite3(path);
  second.pragma('busy_timeout = 1');
  first.exec('BEGIN IMMEDIATE');

  try {
    assertMigrationError(
      () => runMigrations({ db: second, migrations: discoverMigrations({ directory }) }),
      'MIGRATION_BUSY'
    );
    assert.equal(
      second.prepare("SELECT count(*) FROM sqlite_master WHERE name = 'schema_migrations'").pluck().get(),
      0
    );
  } finally {
    first.exec('ROLLBACK');
    first.close();
    second.close();
  }
});

test('transaction-control statements are rejected before any migration executes', async t => {
  const { discoverMigrations, runMigrations } = require('./migration-runner');
  const forbiddenStatements = [
    ['BEGIN', 'BEGIN'],
    ['COMMIT', 'COMMIT'],
    ['END', 'END'],
    ['ROLLBACK', 'ROLLBACK'],
    ['SAVEPOINT', 'SAVEPOINT migration_escape'],
    ['RELEASE', 'RELEASE migration_escape'],
    ['ATTACH', "ATTACH DATABASE ':memory:' AS escaped"],
    ['DETACH', 'DETACH DATABASE escaped'],
  ];

  for (const [keyword, statement] of forbiddenStatements) {
    await t.test(keyword, () => {
      const directory = makeMigrationDirectory({
        '001_escape.sql': `
          CREATE TABLE escaped_record (id TEXT PRIMARY KEY);
          ${statement};
          CREATE TABLE partial_record (id TEXT PRIMARY KEY);
        `,
      });
      const db = memoryDatabase();
      assertMigrationError(
        () => runMigrations({ db, migrations: discoverMigrations({ directory }) }),
        'MIGRATION_TRANSACTION_CONTROL'
      );
      assert.deepEqual(
        db
          .prepare(
            `SELECT name
             FROM sqlite_master
             WHERE type = 'table' AND name IN ('escaped_record', 'partial_record', 'schema_migrations')
             ORDER BY name`
          )
          .pluck()
          .all(),
        []
      );
      db.close();
    });
  }
});

test('transaction keywords inside comments, strings, and quoted identifiers remain valid SQL', () => {
  const directory = makeMigrationDirectory({
    '001_keywords.sql': `
      -- COMMIT and ROLLBACK are documentation here.
      /* BEGIN; SAVEPOINT ignored; RELEASE ignored; */
      CREATE TABLE "BEGIN" (value TEXT NOT NULL);
      INSERT INTO "BEGIN"(value) VALUES ('COMMIT; END; ROLLBACK;');
      CREATE TRIGGER keyword_trigger AFTER INSERT ON "BEGIN"
      BEGIN
        UPDATE "BEGIN"
        SET value = CASE WHEN NEW.value = 'ATTACH' THEN 'DETACH' ELSE NEW.value END;
      END;
    `,
  });
  const { discoverMigrations, runMigrations } = require('./migration-runner');
  const db = memoryDatabase();

  assert.deepEqual(runMigrations({ db, migrations: discoverMigrations({ directory }) }).appliedVersions, [1]);
  assert.equal(db.prepare('SELECT value FROM "BEGIN"').pluck().get(), 'COMMIT; END; ROLLBACK;');
  db.close();
});
