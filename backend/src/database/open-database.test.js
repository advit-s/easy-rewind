'use strict';

const assert = require('node:assert/strict');
const {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const { dirname, join, resolve, sep } = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const modulePath = join(__dirname, 'open-database.js');
const temporaryRoots = new Set();

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'easy-rewind-open-db-'));
  temporaryRoots.add(root);
  return root;
}

function makeDatabasePath() {
  const root = makeRoot();
  const parent = join(root, 'database');
  mkdirSync(parent);
  return join(parent, 'runtime.sqlite3');
}

function permissionRecorder() {
  const calls = [];
  return {
    calls,
    adapter: {
      async restrictDirectory(path) {
        calls.push(['directory', path]);
      },
      async restrictFile(path) {
        calls.push(['file', path]);
      },
    },
  };
}

function assertDatabaseError(operation, expectedCode, forbiddenValue) {
  return assert.rejects(operation, error => {
    assert.equal(error.name, 'DatabaseOpenError');
    assert.equal(error.code, expectedCode);
    assert.equal(typeof error.message, 'string');
    assert.equal(error.message.length > 0, true);
    if (forbiddenValue) assert.equal(error.message.includes(forbiddenValue), false);
    assert.equal(Object.hasOwn(error, 'path'), false);
    assert.equal(Object.hasOwn(error, 'cause'), false);
    return true;
  });
}

test.after(() => {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
});

test('importing the database opener performs no filesystem or database I/O', () => {
  const script = `
    const Module = require('node:module');
    const nativeLoad = Module._load;
    Module._load = function guardedLoad(request, parent, isMain) {
      if (request === 'better-sqlite3') throw new Error('database dependency loaded during import');
      return nativeLoad.call(this, request, parent, isMain);
    };
    const fs = require('node:fs');
    for (const name of [
      'accessSync', 'existsSync', 'lstatSync', 'mkdirSync', 'openSync',
      'statSync', 'writeFileSync'
    ]) {
      fs[name] = () => { throw new Error('filesystem I/O during import'); };
    }
    require(${JSON.stringify(modulePath)});
  `;
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: resolve(__dirname, '..', '..', '..'),
    encoding: 'utf8',
    windowsHide: true,
  });

  assert.equal(result.status, 0, `database opener import must remain inert: ${result.stderr}`);
});

test('writable open enforces foreign keys, WAL, busy timeout, permissions, and idempotent close', async () => {
  const path = makeDatabasePath();
  const permissions = permissionRecorder();
  const { openDatabase } = require('./open-database');

  const db = await openDatabase({
    path,
    filePermissions: permissions.adapter,
    busyTimeoutMs: 2345,
  });

  assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
  assert.equal(db.pragma('journal_mode', { simple: true }), 'wal');
  assert.equal(db.pragma('busy_timeout', { simple: true }), 2345);
  assert.deepEqual(permissions.calls, [['file', path]]);
  assert.equal(existsSync(path), true);
  assert.doesNotThrow(() => db.close());
  assert.doesNotThrow(() => db.close());
});

test('readonly open uses query-only mode and cannot mutate the database', async () => {
  const path = makeDatabasePath();
  const permissions = permissionRecorder();
  const { openDatabase } = require('./open-database');
  const writable = await openDatabase({ path, filePermissions: permissions.adapter });
  writable.exec('CREATE TABLE sample (id INTEGER PRIMARY KEY);');
  writable.close();

  const readonly = await openDatabase({
    path,
    readonly: true,
    filePermissions: permissions.adapter,
  });

  assert.equal(readonly.pragma('query_only', { simple: true }), 1);
  assert.equal(readonly.pragma('foreign_keys', { simple: true }), 1);
  assert.throws(() => readonly.exec('INSERT INTO sample DEFAULT VALUES'), /readonly|read-only/i);
  readonly.close();
});

test('database paths must be exact absolute paths with an existing regular parent', async t => {
  const { openDatabase } = require('./open-database');
  const permissions = permissionRecorder();

  await t.test('relative path', async () => {
    await assertDatabaseError(
      () => openDatabase({ path: join('relative', 'runtime.sqlite3'), filePermissions: permissions.adapter }),
      'DATABASE_PATH_INVALID'
    );
  });

  await t.test('non-normalized path', async () => {
    const root = makeRoot();
    mkdirSync(join(root, 'database'));
    const path = `${join(root, 'database')}${sep}..${sep}database${sep}runtime.sqlite3`;
    await assertDatabaseError(
      () => openDatabase({ path, filePermissions: permissions.adapter }),
      'DATABASE_PATH_INVALID',
      root
    );
  });

  await t.test('missing parent', async () => {
    const root = makeRoot();
    const path = join(root, 'missing', 'runtime.sqlite3');
    await assertDatabaseError(
      () => openDatabase({ path, filePermissions: permissions.adapter }),
      'DATABASE_PARENT_MISSING',
      root
    );
    assert.equal(existsSync(dirname(path)), false);
  });

  await t.test('parent is a file', async () => {
    const root = makeRoot();
    const parent = join(root, 'not-a-directory');
    writeFileSync(parent, 'sentinel');
    await assertDatabaseError(
      () => openDatabase({ path: join(parent, 'runtime.sqlite3'), filePermissions: permissions.adapter }),
      'DATABASE_PARENT_INVALID',
      root
    );
  });
});

test('linked ancestry and linked database targets are rejected without touching link destinations', async t => {
  const { openDatabase } = require('./open-database');
  const permissions = permissionRecorder();

  await t.test('linked parent ancestry', async () => {
    const root = makeRoot();
    const external = makeRoot();
    const link = join(root, 'linked');
    const marker = join(external, 'sentinel.txt');
    writeFileSync(marker, 'keep');
    symlinkSync(external, link, process.platform === 'win32' ? 'junction' : 'dir');

    await assertDatabaseError(
      () => openDatabase({ path: join(link, 'runtime.sqlite3'), filePermissions: permissions.adapter }),
      'DATABASE_PATH_LINKED',
      external
    );
    assert.equal(existsSync(join(external, 'runtime.sqlite3')), false);
    assert.equal(existsSync(marker), true);
  });

  await t.test('linked database target', async () => {
    const root = makeRoot();
    const external = join(makeRoot(), 'external.sqlite3');
    writeFileSync(external, 'keep');
    const path = join(root, 'runtime.sqlite3');
    symlinkSync(external, path, 'file');

    await assertDatabaseError(
      () => openDatabase({ path, filePermissions: permissions.adapter }),
      'DATABASE_PATH_LINKED',
      external
    );
    assert.equal(Buffer.from(require('node:fs').readFileSync(external)).toString(), 'keep');
  });
});

test('invalid options and permission failures use stable safe errors and close failed opens', async t => {
  const { openDatabase } = require('./open-database');

  await t.test('invalid permission adapter', async () => {
    const path = makeDatabasePath();
    await assertDatabaseError(
      () => openDatabase({ path, filePermissions: null }),
      'DATABASE_FILE_PERMISSIONS_INVALID',
      path
    );
  });

  for (const busyTimeoutMs of [-1, 1.5, '5000', Number.NaN]) {
    await t.test(`invalid timeout ${String(busyTimeoutMs)}`, async () => {
      const path = makeDatabasePath();
      await assertDatabaseError(
        () => openDatabase({ path, filePermissions: permissionRecorder().adapter, busyTimeoutMs }),
        'DATABASE_BUSY_TIMEOUT_INVALID',
        path
      );
    });
  }

  await t.test('permission failure', async () => {
    const path = makeDatabasePath();
    const secret = 'private-adapter-detail';
    await assertDatabaseError(
      () =>
        openDatabase({
          path,
          filePermissions: {
            async restrictDirectory() {},
            async restrictFile() {
              throw new Error(secret);
            },
          },
        }),
      'DATABASE_FILE_PERMISSIONS_FAILED',
      secret
    );
  });
});

test('existing non-database files and directories are rejected safely', async t => {
  const { openDatabase } = require('./open-database');
  const permissions = permissionRecorder();

  await t.test('directory target', async () => {
    const root = makeRoot();
    const path = join(root, 'runtime.sqlite3');
    mkdirSync(path);
    await assertDatabaseError(
      () => openDatabase({ path, filePermissions: permissions.adapter }),
      'DATABASE_TARGET_INVALID',
      root
    );
  });

  await t.test('unreadable or invalid database target', async () => {
    const path = makeDatabasePath();
    const descriptor = openSync(path, 'w');
    closeSync(descriptor);
    writeFileSync(path, 'not-a-sqlite-database');
    if (process.platform !== 'win32') chmodSync(path, 0o600);
    await assertDatabaseError(
      () => openDatabase({ path, filePermissions: permissions.adapter }),
      'DATABASE_OPEN_FAILED',
      path
    );
  });
});
