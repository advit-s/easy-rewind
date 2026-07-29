'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');

const Database = require('better-sqlite3');
const { BUNDLE_SCHEMA, bundleChecksum, createExportService, stableStringify } = require('./export-service');
const { createImportService } = require('./import-service');
const { createBackupService } = require('./backup-service');

const migrations = join(__dirname, '..', 'database', 'migrations');

function database() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  for (const name of ['001_core.sql', '002_auth_and_devices.sql', '003_jobs_and_sync.sql', '004_stage3.sql']) {
    db.exec(readFileSync(join(migrations, name), 'utf8'));
  }
  db.prepare(
    `INSERT INTO profiles(id, display_name, created_at, updated_at)
     VALUES (?, ?, ?, ?)`
  ).run('owner-one', 'Owner one', 1, 1);
  db.prepare(
    `INSERT INTO profiles(id, display_name, created_at, updated_at)
     VALUES (?, ?, ?, ?)`
  ).run('owner-two', 'Owner two', 1, 1);
  return db;
}

function sequence(prefix) {
  let value = 0;
  return () => `${prefix}-${++value}`;
}

function memoryArtifacts() {
  const artifacts = new Map();
  const removed = [];
  const writes = [];
  return {
    artifacts,
    removed,
    writes,
    adapter: {
      writeAtomic(reference, bytes, options) {
        artifacts.set(reference, Buffer.from(bytes));
        writes.push({ reference, options });
      },
      read(reference) {
        const bytes = artifacts.get(reference);
        if (bytes === undefined) throw new Error('missing artifact');
        return Buffer.from(bytes);
      },
      remove(reference) {
        removed.push(reference);
        artifacts.delete(reference);
      },
    },
  };
}

function paths() {
  return {
    exportReference({ profileId, id }) {
      return `exports/${profileId}/${id}.json`;
    },
    backupReference({ profileId, id }) {
      return `backups/${profileId}/${id}.json`;
    },
  };
}

function services(db, overrides = {}) {
  const store = overrides.store ?? memoryArtifacts();
  const id = overrides.ids ?? sequence('run');
  const now = overrides.now ?? (() => 10_000);
  const backupService =
    overrides.backupService ??
    createBackupService({
      artifactStore: store.adapter,
      pathAdapter: paths(),
      filePermissions: {
        restrict(reference) {
          assert.match(reference, /^backups\//);
        },
      },
      ids: id,
      now,
    });
  const exportService = createExportService({
    db,
    artifactStore: store.adapter,
    pathAdapter: paths(),
    ids: id,
    now,
  });
  const importService = createImportService({
    db,
    backupService,
    ids: id,
    now,
  });
  return { backupService, exportService, importService, store };
}

function rechecksum(bundle) {
  const copy = structuredClone(bundle);
  copy.manifest.checksum = bundleChecksum(copy.data);
  return copy;
}

function addItem(db, { id, owner = 'owner-one', title, url = null }) {
  db.prepare(
    `INSERT INTO items(
       id, profile_id, kind, title, url, excerpt, body, created_at, updated_at
     ) VALUES (?, ?, 'article', ?, ?, '', '', 2, 2)`
  ).run(id, owner, title, url);
}

test('canonical export is owner scoped, stable, checksummed, and excludes secrets and devices', () => {
  const db = database();
  addItem(db, { id: 'item-z', title: 'Zulu' });
  addItem(db, { id: 'item-a', title: 'Alpha' });
  addItem(db, { id: 'other-item', owner: 'owner-two', title: 'Other owner' });
  db.prepare(
    `INSERT INTO settings(
       id, profile_id, key, value_json, created_at, updated_at
     ) VALUES (?, ?, ?, ?, 3, 3)`
  ).run('setting-theme', 'owner-one', 'theme', '"dark"');
  db.prepare(
    `INSERT INTO settings(
       id, profile_id, key, value_json, created_at, updated_at
     ) VALUES (?, ?, ?, ?, 3, 3)`
  ).run('setting-secret', 'owner-one', 'gemini_api_key', '"provider-secret"');
  db.prepare(
    `INSERT INTO settings(
       id, profile_id, key, value_json, created_at, updated_at
     ) VALUES (?, ?, ?, ?, 3, 3)`
  ).run(
    'setting-nested-secret',
    'owner-one',
    'ai_config',
    '{"provider":{"apiKey":"nested-provider-secret"},"model":"allowed"}'
  );
  db.prepare(
    `INSERT INTO sync_devices(
       id, profile_id, name, platform, state, public_key, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, 3, 3)`
  ).run('device-one', 'owner-one', 'Private PC name', 'windows', 'active', 'public-key-material');

  const context = services(db);
  const first = context.exportService.create({ profileId: 'owner-one' });
  const second = context.exportService.create({ profileId: 'owner-one' });

  assert.deepEqual(Object.keys(first.bundle), ['manifest', 'data']);
  assert.deepEqual(first.bundle.manifest, {
    format: 'easy-rewind',
    formatVersion: 1,
    schemaVersion: 4,
    ownerId: 'owner-one',
    createdAt: 10_000,
    checksum: bundleChecksum(first.bundle.data),
  });
  assert.deepEqual(
    first.bundle.data.items.map(row => row.id),
    ['item-a', 'item-z']
  );
  assert.deepEqual(
    first.bundle.data.settings.map(row => row.key),
    ['theme']
  );
  assert.equal(JSON.stringify(first.bundle).includes('provider-secret'), false);
  assert.equal(JSON.stringify(first.bundle).includes('nested-provider-secret'), false);
  assert.equal(JSON.stringify(first.bundle).includes('Private PC name'), false);
  assert.equal(JSON.stringify(first.bundle).includes('public-key-material'), false);
  assert.equal(JSON.stringify(first.bundle).includes('other-item'), false);
  assert.equal(first.checksum, second.checksum);
  assert.equal(stableStringify(first.bundle), stableStringify(second.bundle));
  assert.equal(
    context.store.writes.every(write => write.options.sensitive === true),
    true
  );
  assert.equal(db.prepare(`SELECT state FROM export_runs WHERE id = ?`).pluck().get(first.runId), 'succeeded');
});

test('dry-run reports counts and conflicts without writing to any database table or artifact', () => {
  const source = database();
  addItem(source, { id: 'same-item', title: 'Imported replacement' });
  addItem(source, { id: 'new-item', title: 'Imported new item' });
  const bundle = services(source).exportService.create({ profileId: 'owner-one' }).bundle;

  const destination = database();
  addItem(destination, { id: 'same-item', title: 'Existing' });
  const context = services(destination);
  const before = destination.serialize();

  const report = context.importService.dryRun({ profileId: 'owner-one', bundle });

  assert.deepEqual(report.counts.items, { incoming: 2, inserts: 1, conflicts: 1 });
  assert.deepEqual(report.conflicts, [{ table: 'items', id: 'same-item', reason: 'id_exists' }]);
  assert.equal(report.totalRows >= 2, true);
  assert.deepEqual(destination.serialize(), before);
  assert.equal(context.store.writes.length, 0);
});

test('bundle validation rejects malformed, oversized, unknown, duplicate, wrong-version, and cross-owner payloads', () => {
  const source = database();
  addItem(source, { id: 'item-one', title: 'One' });
  const bundle = services(source).exportService.create({ profileId: 'owner-one' }).bundle;
  const destination = services(database()).importService;

  const cases = [
    ['{', 'IMPORT_JSON_INVALID'],
    [Buffer.alloc(10_000_001, 0x20), 'IMPORT_TOO_LARGE'],
    [{ ...bundle, unexpected: true }, 'IMPORT_BUNDLE_INVALID'],
    [
      rechecksum({
        ...bundle,
        data: { ...bundle.data, items: [bundle.data.items[0], bundle.data.items[0]] },
      }),
      'IMPORT_DUPLICATE_ID',
    ],
    [
      {
        ...bundle,
        manifest: { ...bundle.manifest, formatVersion: 2 },
      },
      'IMPORT_VERSION_UNSUPPORTED',
    ],
    [
      rechecksum({
        ...bundle,
        data: {
          ...bundle.data,
          items: [{ ...bundle.data.items[0], profile_id: 'owner-two' }],
        },
      }),
      'IMPORT_OWNER_MISMATCH',
    ],
  ];

  for (const [input, code] of cases) {
    assert.throws(
      () => destination.dryRun({ profileId: 'owner-one', bundle: input }),
      error => error?.code === code && !error.message.includes('owner-one')
    );
  }
});

test('bundle validation rejects excessive nesting, row counts, invalid references, and checksum changes', () => {
  const source = database();
  addItem(source, { id: 'item-one', title: 'One' });
  const bundle = services(source).exportService.create({ profileId: 'owner-one' }).bundle;
  const destination = services(database()).importService;

  const nested = structuredClone(bundle);
  let value = {};
  for (let index = 0; index < 15; index += 1) value = { nested: value };
  nested.data.items[0].title = value;

  const tooMany = structuredClone(bundle);
  tooMany.data.items = Array.from({ length: 10_001 }, (_, index) => ({
    ...bundle.data.items[0],
    id: `item-${index}`,
  }));

  const badReference = structuredClone(bundle);
  badReference.data.bookmarks = [
    {
      id: 'bookmark-one',
      profile_id: 'owner-one',
      item_id: 'missing-item',
      created_at: 1,
      updated_at: 1,
      revision: 1,
      deleted_at: null,
    },
  ];

  const changed = structuredClone(bundle);
  changed.data.items[0].title = 'Changed after checksum';

  for (const [input, code] of [
    [rechecksum(nested), 'IMPORT_TOO_DEEP'],
    [rechecksum(tooMany), 'IMPORT_TOO_MANY_ROWS'],
    [rechecksum(badReference), 'IMPORT_REFERENCE_INVALID'],
    [changed, 'IMPORT_CHECKSUM_INVALID'],
  ]) {
    assert.throws(() => destination.dryRun({ profileId: 'owner-one', bundle: input }), {
      code,
    });
  }
});

test('apply requires a verified destination backup and applies all rows in one transaction', () => {
  const source = database();
  addItem(source, { id: 'first', title: 'First', url: 'https://example.com/first' });
  addItem(source, { id: 'second', title: 'Second', url: 'https://example.com/second' });
  const bundle = services(source).exportService.create({ profileId: 'owner-one' }).bundle;

  const destination = database();
  const refused = createImportService({
    db: destination,
    backupService: {
      createVerified() {
        return { reference: 'backup', checksum: '0'.repeat(64), verified: false };
      },
    },
    ids: sequence('import'),
    now: () => 20_000,
  });
  assert.throws(() => refused.apply({ profileId: 'owner-one', bundle, conflictStrategy: 'replace' }), {
    code: 'IMPORT_BACKUP_REQUIRED',
  });
  assert.equal(destination.prepare('SELECT COUNT(*) FROM items').pluck().get(), 0);

  const context = services(destination);
  const result = context.importService.apply({
    profileId: 'owner-one',
    bundle,
    conflictStrategy: 'replace',
  });

  assert.equal(result.state, 'succeeded');
  assert.match(result.backupRef, /^backups\/owner-one\//);
  assert.deepEqual(
    destination.prepare(`SELECT id FROM items WHERE profile_id = ? ORDER BY id`).pluck().all('owner-one'),
    ['first', 'second']
  );
  assert.equal(
    destination.prepare(`SELECT backup_ref FROM import_runs WHERE id = ?`).pluck().get(result.runId),
    result.backupRef
  );
});

test('failed apply rolls back partial rows and removes its backup artifact', () => {
  const source = database();
  addItem(source, { id: 'first', title: 'First' });
  const exported = services(source).exportService.create({ profileId: 'owner-one' }).bundle;
  const tag = {
    id: 'tag-one',
    profile_id: 'owner-one',
    name: 'Duplicate',
    normalized_name: 'duplicate',
    created_at: 2,
    updated_at: 2,
    revision: 1,
    deleted_at: null,
  };
  const bundle = rechecksum({
    ...exported,
    data: {
      ...exported.data,
      tags: [tag, { ...tag, id: 'tag-two', name: 'DUPLICATE' }],
    },
  });

  const destination = database();
  const context = services(destination);

  assert.throws(
    () =>
      context.importService.apply({
        profileId: 'owner-one',
        bundle,
        conflictStrategy: 'replace',
      }),
    { code: 'IMPORT_APPLY_FAILED' }
  );
  assert.equal(destination.prepare('SELECT COUNT(*) FROM items').pluck().get(), 0);
  assert.equal(context.store.artifacts.size, 0);
  assert.equal(context.store.removed.length, 1);
  assert.equal(
    destination.prepare(`SELECT state FROM import_runs ORDER BY created_at DESC LIMIT 1`).pluck().get(),
    'failed'
  );
});

test('explicit rollback atomically restores the verified pre-import snapshot', () => {
  const source = database();
  addItem(source, { id: 'item-one', title: 'Imported title' });
  const bundle = services(source).exportService.create({ profileId: 'owner-one' }).bundle;

  const destination = database();
  addItem(destination, { id: 'item-one', title: 'Original title' });
  const context = services(destination);
  const applied = context.importService.apply({
    profileId: 'owner-one',
    bundle,
    conflictStrategy: 'replace',
  });
  assert.equal(destination.prepare(`SELECT title FROM items WHERE id = ?`).pluck().get('item-one'), 'Imported title');

  const rolledBack = context.importService.rollback({
    profileId: 'owner-one',
    runId: applied.runId,
  });

  assert.equal(rolledBack.state, 'rolled_back');
  assert.equal(destination.prepare(`SELECT title FROM items WHERE id = ?`).pluck().get('item-one'), 'Original title');
  assert.equal(context.store.artifacts.has(applied.backupRef), true);
});

test('backup verifies SHA-256 bytes, marks artifacts sensitive, restricts access, and detects corruption', () => {
  const store = memoryArtifacts();
  const restricted = [];
  const backup = createBackupService({
    artifactStore: store.adapter,
    pathAdapter: paths(),
    filePermissions: {
      restrict(reference) {
        restricted.push(reference);
      },
    },
    ids: sequence('backup'),
    now: () => 30_000,
  });
  const created = backup.createVerified({
    profileId: 'owner-one',
    bytes: Buffer.from('destination snapshot'),
  });

  assert.equal(created.verified, true);
  assert.match(created.checksum, /^[a-f0-9]{64}$/);
  assert.deepEqual(restricted, [created.reference]);
  assert.equal(store.writes[0].options.sensitive, true);

  store.artifacts.set(created.reference, Buffer.from('corrupted'));
  assert.throws(
    () =>
      backup.readVerified({
        profileId: 'owner-one',
        reference: created.reference,
        checksum: created.checksum,
      }),
    { code: 'BACKUP_CHECKSUM_INVALID' }
  );
});

test('export cancellation and artifact failure leave no partial artifact and record a truthful state', () => {
  const db = database();
  addItem(db, { id: 'item-one', title: 'One' });
  const store = memoryArtifacts();
  store.adapter.writeAtomic = (reference, bytes) => {
    store.artifacts.set(reference, Buffer.from(bytes));
    const error = new Error('cancelled by caller');
    error.name = 'AbortError';
    throw error;
  };
  const context = services(db, { store });

  assert.throws(() => context.exportService.create({ profileId: 'owner-one' }), {
    code: 'EXPORT_CANCELLED',
  });
  assert.equal(store.artifacts.size, 0);
  assert.equal(store.removed.length, 1);
  assert.equal(db.prepare(`SELECT state FROM export_runs ORDER BY created_at DESC LIMIT 1`).pluck().get(), 'cancelled');
});

test('schema declaration remains a frozen allowlist without operational or credential tables', () => {
  assert.equal(Object.isFrozen(BUNDLE_SCHEMA), true);
  assert.equal(Object.isFrozen(BUNDLE_SCHEMA.tables), true);
  for (const forbidden of [
    'client_credentials',
    'browser_sessions',
    'pairing_challenges',
    'sync_devices',
    'provider_configurations',
    'diagnostics',
    'jobs',
    'import_runs',
    'export_runs',
  ]) {
    assert.equal(Object.hasOwn(BUNDLE_SCHEMA.tables, forbidden), false);
  }
});
