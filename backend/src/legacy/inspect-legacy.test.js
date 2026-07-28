'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { dirname, join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const warning = 'Contains sensitive personal legacy data and is not secure credential storage.';

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex').toUpperCase();
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'easy-rewind-inspection-'));
  const quarantinePath = join(root, 'legacy-backup', '20260724T120000000Z');
  const workRoot = join(root, 'inspection-work');
  mkdirSync(quarantinePath, { recursive: true });
  mkdirSync(workRoot);
  const files = new Map([
    ['easy-rewind.db', Buffer.from('database-snapshot')],
    ['easy-rewind.db-wal', Buffer.from('wal-snapshot')],
    ['easy-rewind.db-shm', Buffer.from('shm-snapshot')],
    ['settings.json', Buffer.from('{"apiKey":"must-not-appear"}')],
  ]);
  const entries = [];
  for (const [name, bytes] of files) {
    writeFileSync(join(quarantinePath, name), bytes);
    entries.push({
      name,
      originalPath: join(root, 'original', name),
      backupRelativePath: name,
      size: bytes.length,
      sha256: hash(bytes),
    });
  }
  const manifestPath = join(quarantinePath, 'manifest.json');
  const manifest = {
    schemaVersion: 1,
    sensitive: true,
    warning,
    backupTimeUtc: '2026-07-24T12:00:00.000Z',
    sqliteOpened: false,
    sourceRoot: join(root, 'original'),
    quarantinePath,
    manifestPath,
    files: entries,
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
  return { files, manifest, manifestPath, quarantinePath, root, workRoot };
}

function permissions() {
  return {
    async restrictDirectory() {},
    async restrictFile() {},
  };
}

test('inspection verifies the manifest and opens only a disposable read-only copy', async t => {
  const current = fixture();
  t.after(() => rmSync(current.root, { recursive: true, force: true }));
  let openedPath;
  let closeCalls = 0;
  const { inspectLegacy } = require('./inspect-legacy');
  const report = await inspectLegacy({
    manifestPath: current.manifestPath,
    workRoot: current.workRoot,
    filePermissions: permissions(),
    async openDatabase({ path, readonly }) {
      openedPath = path;
      assert.equal(readonly, true);
      assert.notEqual(resolve(path), resolve(join(current.quarantinePath, 'easy-rewind.db')));
      assert.equal(readFileSync(path, 'utf8'), 'database-snapshot');
      return {
        pragma(sql, options) {
          assert.match(sql, /^query_only(?: = ON)?$/);
          return options?.simple ? 1 : undefined;
        },
        prepare(sql) {
          if (sql.includes('sqlite_master')) return { all: () => [{ name: 'bookmarks' }, { name: 'users' }] };
          if (sql.startsWith('PRAGMA table_xinfo')) {
            return {
              all: () => [
                { name: 'id', type: 'INTEGER', notnull: 0, pk: 1, hidden: 0 },
                { name: 'title', type: 'TEXT', notnull: 0, pk: 0, hidden: 0 },
              ],
            };
          }
          if (sql.startsWith('SELECT COUNT')) return { pluck: () => ({ get: () => 2 }) };
          if (sql.includes(' AS count')) return { pluck: () => ({ get: () => 0 }) };
          throw new Error('unexpected safe-inspection query');
        },
        close() {
          closeCalls += 1;
        },
      };
    },
  });

  assert.equal(closeCalls, 1);
  assert.equal(openedPath.startsWith(current.workRoot), true);
  assert.deepEqual(report.tables, [
    { name: 'bookmarks', rowCount: 2 },
    { name: 'users', rowCount: 2 },
  ]);
  assert.equal(report.classification, 'SENSITIVE MIGRATION METADATA');
  assert.equal(report.totalRows, 4);
  assert.equal(report.estimatedActions.importPerformed, false);
  assert.equal(report.estimatedActions.schemaConversionPerformed, false);
  assert.equal(report.likelyConflicts.total, 0);
  assert.deepEqual(report.unsupportedSchema.tables, ['users']);
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes(current.root), false);
  assert.equal(serialized.includes('must-not-appear'), false);
  for (const [name, bytes] of current.files) {
    assert.equal(hash(readFileSync(join(current.quarantinePath, name))), hash(bytes));
  }
});

test('tampered quarantine files fail before a database copy is opened', async t => {
  const current = fixture();
  t.after(() => rmSync(current.root, { recursive: true, force: true }));
  writeFileSync(join(current.quarantinePath, 'easy-rewind.db-wal'), 'tampered');
  const { inspectLegacy } = require('./inspect-legacy');
  let opened = false;

  await assert.rejects(
    inspectLegacy({
      manifestPath: current.manifestPath,
      workRoot: current.workRoot,
      filePermissions: permissions(),
      async openDatabase() {
        opened = true;
      },
    }),
    error => error.code === 'LEGACY_MANIFEST_MISMATCH'
  );
  assert.equal(opened, false);
});

test('verified disposable copy exposes all four snapshot files only for the callback and cleans up on failure', async t => {
  const current = fixture();
  t.after(() => rmSync(current.root, { recursive: true, force: true }));
  const { withDisposableLegacyCopy } = require('./inspect-legacy');
  let disposableRoot;

  await assert.rejects(
    withDisposableLegacyCopy(
      {
        manifestPath: current.manifestPath,
        workRoot: current.workRoot,
        filePermissions: permissions(),
        generateId: () => 'callback-failure',
      },
      snapshot => {
        disposableRoot = snapshot.root;
        assert.deepEqual(readdirSync(snapshot.root).sort(), [...current.files.keys()].sort());
        assert.equal(readFileSync(snapshot.settingsPath, 'utf8'), '{"apiKey":"must-not-appear"}');
        assert.notEqual(resolve(snapshot.databasePath), resolve(join(current.quarantinePath, 'easy-rewind.db')));
        throw new Error('DO_NOT_PRINT_THIS_VALUE');
      }
    ),
    error => error.code === 'LEGACY_INSPECTION_FAILED'
  );

  assert.equal(existsSync(disposableRoot), false);
  assert.deepEqual(readdirSync(current.workRoot), []);
});

test('disposable copy never removes a pre-existing directory on an identifier collision', async t => {
  const current = fixture();
  t.after(() => rmSync(current.root, { recursive: true, force: true }));
  const collisionRoot = join(current.workRoot, 'legacy-inspection-collision');
  const sentinel = join(collisionRoot, 'sentinel.txt');
  mkdirSync(collisionRoot);
  writeFileSync(sentinel, 'DO_NOT_DELETE');
  const { withDisposableLegacyCopy } = require('./inspect-legacy');

  await assert.rejects(
    withDisposableLegacyCopy(
      {
        manifestPath: current.manifestPath,
        workRoot: current.workRoot,
        filePermissions: permissions(),
        generateId: () => 'collision',
      },
      () => 'not reached'
    ),
    error => error.code === 'LEGACY_COPY_FAILED'
  );

  assert.equal(readFileSync(sentinel, 'utf8'), 'DO_NOT_DELETE');
});

test('disposable copy fails closed when its exact work directory cannot be removed', async t => {
  const current = fixture();
  t.after(() => rmSync(current.root, { recursive: true, force: true }));
  const { withDisposableLegacyCopy } = require('./inspect-legacy');
  let removeCalls = 0;

  await assert.rejects(
    withDisposableLegacyCopy(
      {
        manifestPath: current.manifestPath,
        workRoot: current.workRoot,
        filePermissions: permissions(),
        generateId: () => 'cleanup-failure',
        removeDisposable() {
          removeCalls += 1;
          throw new Error('DO_NOT_PRINT_THIS_VALUE');
        },
      },
      () => 'complete'
    ),
    error => error.code === 'LEGACY_CLEANUP_FAILED'
  );
  assert.equal(removeCalls, 1);
});

test('inspection explicitly enables and verifies query-only mode and issues metadata/count queries only', async t => {
  const current = fixture();
  t.after(() => rmSync(current.root, { recursive: true, force: true }));
  const statements = [];
  const pragmaCalls = [];
  const { inspectLegacy } = require('./inspect-legacy');

  const report = await inspectLegacy({
    manifestPath: current.manifestPath,
    workRoot: current.workRoot,
    filePermissions: permissions(),
    async openDatabase({ path, readonly }) {
      assert.equal(readonly, true);
      assert.equal(path.startsWith(current.workRoot), true);
      return {
        pragma(sql, options) {
          pragmaCalls.push([sql, options]);
          return options?.simple ? 1 : undefined;
        },
        prepare(sql) {
          statements.push(sql);
          if (sql.includes('sqlite_master')) {
            return { all: () => [{ name: 'bookmarks' }, { name: 'mystery' }] };
          }
          if (sql.startsWith('PRAGMA table_xinfo("bookmarks")')) {
            return {
              all: () => [
                { name: 'id', type: 'INTEGER', notnull: 0, pk: 1, hidden: 0 },
                { name: 'user_id', type: 'TEXT', notnull: 1, pk: 0, hidden: 0 },
                { name: 'url', type: 'TEXT', notnull: 1, pk: 0, hidden: 0 },
                { name: 'credential_like_column', type: 'TEXT', notnull: 0, pk: 0, hidden: 0 },
              ],
            };
          }
          if (sql.startsWith('PRAGMA table_xinfo("mystery")')) {
            return { all: () => [{ name: 'id', type: 'TEXT', notnull: 0, pk: 0, hidden: 0 }] };
          }
          if (sql.startsWith('SELECT COUNT(*) FROM "bookmarks"')) return { pluck: () => ({ get: () => 3 }) };
          if (sql.startsWith('SELECT COUNT(*) FROM "mystery"')) return { pluck: () => ({ get: () => 1 }) };
          if (sql.includes(' AS count')) return { pluck: () => ({ get: () => 1 }) };
          throw new Error('unexpected statement');
        },
        close() {},
      };
    },
  });

  assert.deepEqual(pragmaCalls, [
    ['query_only = ON', undefined],
    ['query_only', { simple: true }],
  ]);
  assert.equal(report.likelyConflicts.total, 1);
  assert.deepEqual(report.unsupportedSchema.tables, ['mystery']);
  assert.deepEqual(report.unsupportedSchema.columns, [{ table: 'bookmarks', columns: ['credential_like_column'] }]);
  assert.equal(report.estimatedActions.inspectableRows, 4);
  for (const sql of statements) {
    assert.doesNotMatch(sql, /\b(?:DELETE|INSERT|UPDATE|REPLACE|VACUUM|ATTACH|DETACH|checkpoint|journal_mode)\b/i);
    assert.match(sql, /^\s*(?:SELECT|PRAGMA)\b/i);
  }
  assert.doesNotMatch(JSON.stringify(report), /database-snapshot|wal-snapshot|must-not-appear|DO_NOT_PRINT_THIS_VALUE/);
});

test('inspection rejects a work root that overlaps the sole quarantine snapshot', async t => {
  const current = fixture();
  t.after(() => rmSync(current.root, { recursive: true, force: true }));
  const { inspectLegacy } = require('./inspect-legacy');

  await assert.rejects(
    inspectLegacy({
      manifestPath: current.manifestPath,
      workRoot: current.quarantinePath,
      filePermissions: permissions(),
      async openDatabase() {
        throw new Error('must not open');
      },
    }),
    error => error.code === 'LEGACY_INPUT_INVALID'
  );
});

test('configured discovery offers only a checksum-verified quarantine manifest', async t => {
  const current = fixture();
  t.after(() => rmSync(current.root, { recursive: true, force: true }));
  const { discoverLegacy } = require('./discover-legacy');

  const discovered = discoverLegacy({
    environment: { EASY_REWIND_LEGACY_MANIFEST: current.manifestPath },
  });
  assert.equal(discovered.available, true);
  assert.equal(discovered.manifestPath, current.manifestPath);
  assert.equal(Object.isFrozen(discovered), true);

  writeFileSync(join(current.quarantinePath, 'settings.json'), '{"apiKey":"tampered"}');
  assert.throws(
    () =>
      discoverLegacy({
        environment: { EASY_REWIND_LEGACY_MANIFEST: current.manifestPath },
      }),
    error => error.code === 'LEGACY_MANIFEST_MISMATCH'
  );
});

test('discovery finds the newest checksum-verified manifest in the configured quarantine root', async t => {
  const current = fixture();
  t.after(() => rmSync(current.root, { recursive: true, force: true }));
  const { discoverLegacy } = require('./discover-legacy');

  const discovered = discoverLegacy({
    quarantineRoot: dirname(current.quarantinePath),
    environment: {},
  });

  assert.equal(discovered.available, true);
  assert.equal(discovered.manifestPath, current.manifestPath);
});

test('native read-only inspection preserves the sole quarantine WAL and creates no source journal', async t => {
  const BetterSqlite3 = require('better-sqlite3');
  const root = mkdtempSync(join(tmpdir(), 'easy-rewind-native-inspection-'));
  const quarantinePath = join(root, 'legacy-backup', '20260724T120000000Z');
  const workRoot = join(root, 'inspection-work');
  mkdirSync(quarantinePath, { recursive: true });
  mkdirSync(workRoot);
  const databasePath = join(quarantinePath, 'easy-rewind.db');
  const writer = new BetterSqlite3(databasePath);
  t.after(() => {
    try {
      writer.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  writer.pragma('journal_mode = WAL');
  writer.exec(`
    CREATE TABLE bookmarks (
      id INTEGER PRIMARY KEY,
      user_id TEXT NOT NULL,
      url TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      topic TEXT NOT NULL,
      notes TEXT DEFAULT '',
      remind_at TEXT,
      reminded INTEGER DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE TABLE items (
      id INTEGER PRIMARY KEY,
      user_id TEXT NOT NULL,
      url TEXT,
      title TEXT DEFAULT '',
      content TEXT DEFAULT '',
      ai_summary TEXT DEFAULT '',
      tags TEXT DEFAULT '',
      embedding TEXT,
      source_type TEXT DEFAULT 'web',
      memory_score REAL DEFAULT 0.5,
      interaction_count INTEGER DEFAULT 0,
      last_interaction TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE research_queue (
      id INTEGER PRIMARY KEY,
      user_id TEXT NOT NULL,
      url TEXT NOT NULL,
      title TEXT,
      user_notes TEXT,
      research_result TEXT,
      status TEXT DEFAULT 'pending',
      error_message TEXT,
      remind_when_done INTEGER DEFAULT 1,
      created_at TEXT NOT NULL,
      completed_at TEXT
    );
    INSERT INTO bookmarks(user_id, url, topic, created_at)
    VALUES ('private-user', 'https://private.invalid/path', 'secret-topic', '2026-07-24T12:00:00Z');
    INSERT INTO bookmarks(user_id, url, topic, created_at)
    VALUES ('private-user', 'https://private.invalid/path', 'secret-topic', '2026-07-24T12:00:01Z');
    INSERT INTO research_queue(user_id, url, status, created_at)
    VALUES ('private-user', 'https://private.invalid/research', 'done', '2026-07-24T12:00:02Z');
  `);
  writeFileSync(join(quarantinePath, 'settings.json'), '{"apiKey":"must-not-appear"}');
  const files = ['easy-rewind.db', 'easy-rewind.db-wal', 'easy-rewind.db-shm', 'settings.json'];
  const entries = files.map(name => {
    const bytes = readFileSync(join(quarantinePath, name));
    return {
      name,
      originalPath: join(root, 'original', name),
      backupRelativePath: name,
      size: bytes.length,
      sha256: hash(bytes),
    };
  });
  const manifestPath = join(quarantinePath, 'manifest.json');
  writeFileSync(
    manifestPath,
    `${JSON.stringify({
      schemaVersion: 1,
      sensitive: true,
      warning,
      backupTimeUtc: '2026-07-24T12:00:00.000Z',
      sqliteOpened: false,
      sourceRoot: join(root, 'original'),
      quarantinePath,
      manifestPath,
      files: entries,
    })}\n`
  );
  const before = new Map(files.map(name => [name, hash(readFileSync(join(quarantinePath, name)))]));
  const { inspectLegacy } = require('./inspect-legacy');

  const report = await inspectLegacy({
    manifestPath,
    workRoot,
    filePermissions: permissions(),
  });

  assert.equal(report.likelyConflicts.total, 1);
  assert.equal(report.tables.find(table => table.name === 'bookmarks').rowCount, 2);
  assert.deepEqual(report.unsupportedSchema.tables, []);
  assert.deepEqual(report.unsupportedSchema.columns, []);
  assert.deepEqual(report.unsupportedSchema.values, []);
  assert.equal(existsSync(join(quarantinePath, 'easy-rewind.db-journal')), false);
  for (const name of files) {
    assert.equal(existsSync(join(quarantinePath, name)), true);
    assert.equal(hash(readFileSync(join(quarantinePath, name))), before.get(name));
  }
  const serialized = JSON.stringify(report);
  assert.doesNotMatch(serialized, /private-user|private\.invalid|secret-topic|must-not-appear/);
});

test('legacy report requires an explicit external non-output path and writes no row values or paths', async t => {
  const current = fixture();
  t.after(() => rmSync(current.root, { recursive: true, force: true }));
  const external = join(current.root, 'private-reports');
  const repositoryRoot = join(current.root, 'repository');
  mkdirSync(external);
  mkdirSync(repositoryRoot);
  const report = Object.freeze({
    classification: 'SENSITIVE MIGRATION METADATA',
    schemaSignature: 'a'.repeat(64),
    tables: Object.freeze([Object.freeze({ name: 'bookmarks', rowCount: 2 })]),
    totalRows: 2,
    likelyConflicts: Object.freeze({ total: 0, tables: Object.freeze([]) }),
    unsupportedSchema: Object.freeze({
      tables: Object.freeze([]),
      columns: Object.freeze([]),
      values: Object.freeze([]),
    }),
    estimatedActions: Object.freeze({
      inspectableRows: 2,
      likelyImports: 2,
      reviewRequired: 0,
      importPerformed: false,
      schemaConversionPerformed: false,
    }),
  });
  const { LegacyReportError, writeLegacyReport } = require('./legacy-report');
  const outputPath = join(external, 'chosen.legacy-inspection-report.json');

  await writeLegacyReport({
    report,
    outputPath,
    repositoryRoot,
    filePermissions: permissions(),
  });
  const written = readFileSync(outputPath, 'utf8');
  assert.match(written, /SENSITIVE MIGRATION METADATA/);
  assert.doesNotMatch(written, /must-not-appear|database-snapshot/);

  for (const rejected of [
    join(repositoryRoot, 'chosen.legacy-inspection-report.json'),
    join(current.root, 'exports', 'chosen.legacy-inspection-report.json'),
    join(current.root, 'logs', 'chosen.legacy-inspection-report.json'),
    join(current.root, 'test-results', 'chosen.legacy-inspection-report.json'),
    join(current.root, 'legacy-backup', 'chosen.legacy-inspection-report.json'),
    join(external, 'report.json'),
  ]) {
    mkdirSync(resolve(rejected, '..'), { recursive: true });
    await assert.rejects(
      writeLegacyReport({
        report,
        outputPath: rejected,
        repositoryRoot,
        filePermissions: permissions(),
      }),
      error => error instanceof LegacyReportError && error.code === 'LEGACY_REPORT_PATH_INVALID'
    );
  }
});

test('legacy inspection modules and CLI are import-inert', () => {
  const modules = [
    './discover-legacy.js',
    './inspect-legacy.js',
    './legacy-report.js',
    '../../../scripts/legacy/inspect-legacy.mjs',
  ].map(relativePath => pathToFileURL(resolve(__dirname, relativePath)).href);
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', `await Promise.all(${JSON.stringify(modules)}.map(value => import(value)));`],
    { encoding: 'utf8' }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});
