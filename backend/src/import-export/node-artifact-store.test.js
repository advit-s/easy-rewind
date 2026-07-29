'use strict';

const assert = require('node:assert/strict');
const {
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const { isAbsolute, join, relative } = require('node:path');
const test = require('node:test');

const { createNodeArtifactPathAdapter, createNodeArtifactStore } = require('./node-artifact-store');

const roots = [];

test.afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function fixture(filePermissions = { restrictFile() {} }) {
  const root = mkdtempSync(join(tmpdir(), 'easy-rewind-artifacts-'));
  roots.push(root);
  const exportsRoot = join(root, 'exports');
  const backupsRoot = join(root, 'backups');
  return {
    root,
    exportsRoot,
    backupsRoot,
    paths: createNodeArtifactPathAdapter({ exportsRoot, backupsRoot }),
    store: createNodeArtifactStore({ exportsRoot, backupsRoot, filePermissions }),
  };
}

function assertWithin(root, candidate) {
  const child = relative(root, candidate);
  assert.equal(isAbsolute(child), false);
  assert.equal(child.startsWith('..'), false);
}

test('path adapter creates canonical absolute references beneath their configured roots', () => {
  const context = fixture();

  const exportReference = context.paths.exportReference({
    profileId: 'owner-one',
    id: 'export-1',
  });
  const backupReference = context.paths.backupReference({
    profileId: 'owner-one',
    id: 'backup-1',
  });

  assert.equal(isAbsolute(exportReference), true);
  assert.equal(isAbsolute(backupReference), true);
  assertWithin(context.exportsRoot, exportReference);
  assertWithin(context.backupsRoot, backupReference);
  assert.equal(exportReference.endsWith(join('owner-one', 'export-1.json')), true);
  assert.equal(backupReference.endsWith(join('owner-one', 'backup-1.json')), true);
});

test('path adapter rejects traversal, separators, absolute segments, and invalid roots', () => {
  const context = fixture();

  for (const value of ['..', '../outside', '..\\outside', '/outside', 'C:\\outside', '.', '']) {
    assert.throws(
      () => context.paths.exportReference({ profileId: value, id: 'artifact' }),
      error => error?.code === 'ARTIFACT_SEGMENT_INVALID'
    );
    assert.throws(
      () => context.paths.backupReference({ profileId: 'owner-one', id: value }),
      error => error?.code === 'ARTIFACT_SEGMENT_INVALID'
    );
  }

  assert.throws(
    () => createNodeArtifactPathAdapter({ exportsRoot: 'relative', backupsRoot: context.backupsRoot }),
    error => error?.code === 'ARTIFACT_ROOT_INVALID'
  );
});

test('store atomically writes, restricts, reads, and removes sensitive artifacts', () => {
  const restricted = [];
  const restrictedLinks = [];
  const context = fixture({
    restrictFile(reference) {
      assert.equal(existsSync(reference), true);
      restricted.push(reference);
      restrictedLinks.push(lstatSync(reference).isSymbolicLink());
    },
  });
  const reference = context.paths.exportReference({
    profileId: 'owner-one',
    id: 'export-1',
  });
  const bytes = Buffer.from('private export');

  context.store.writeAtomic(reference, bytes, { sensitive: true });

  assert.deepEqual(context.store.read(reference), bytes);
  assert.equal(restricted.length, 1);
  assert.notEqual(restricted[0], reference);
  assert.deepEqual(restrictedLinks, [false]);
  assert.equal(context.store.remove(reference), true);
  assert.equal(context.store.remove(reference), false);
  assert.equal(existsSync(reference), false);
});

test('store rejects relative, traversal, and absolute outside-root references', () => {
  const context = fixture();
  const outside = join(context.root, 'outside.json');

  for (const reference of [
    'exports/owner-one/file.json',
    join(context.exportsRoot, 'owner-one', '..', '..', 'outside.json'),
    outside,
  ]) {
    assert.throws(
      () => context.store.writeAtomic(reference, Buffer.from('private'), { sensitive: true }),
      error => error?.code === 'ARTIFACT_REFERENCE_INVALID' || error?.code === 'ARTIFACT_REFERENCE_OUTSIDE_ROOT'
    );
  }

  assert.equal(existsSync(outside), false);
});

test('store rejects directory junction and file symlink escapes for every operation', t => {
  const context = fixture();
  const outside = join(context.root, 'outside');
  const linkedDirectory = join(context.exportsRoot, 'linked-owner');
  mkdirSync(outside, { recursive: true });

  try {
    symlinkSync(outside, linkedDirectory, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (error?.code === 'EPERM' || error?.code === 'EACCES') {
      t.skip('creating links is unavailable to this Windows user');
      return;
    }
    throw error;
  }

  const escaped = join(linkedDirectory, 'export-1.json');
  assert.throws(
    () => context.store.writeAtomic(escaped, Buffer.from('private'), { sensitive: true }),
    error => error?.code === 'ARTIFACT_REFERENCE_LINKED'
  );
  assert.equal(existsSync(join(outside, 'export-1.json')), false);

  const outsideFile = join(outside, 'outside.json');
  writeFileSync(outsideFile, 'outside');
  const linkedFile = join(context.backupsRoot, 'linked.json');
  symlinkSync(outsideFile, linkedFile, 'file');
  for (const operation of [() => context.store.read(linkedFile), () => context.store.remove(linkedFile)]) {
    assert.throws(operation, error => error?.code === 'ARTIFACT_REFERENCE_LINKED');
  }
  assert.equal(readFileSync(outsideFile, 'utf8'), 'outside');
});

test('permission failure removes the temporary file and preserves an existing destination', () => {
  let failRestriction = false;
  const context = fixture({
    restrictFile() {
      if (failRestriction) throw new Error('permission adapter failed');
    },
  });
  const first = context.paths.exportReference({
    profileId: 'owner-one',
    id: 'first',
  });
  context.store.writeAtomic(first, Buffer.from('first'), { sensitive: true });

  const second = context.paths.exportReference({
    profileId: 'owner-one',
    id: 'second',
  });
  failRestriction = true;
  assert.throws(
    () => context.store.writeAtomic(second, Buffer.from('second'), { sensitive: true }),
    error => error?.code === 'ARTIFACT_PERMISSION_FAILED'
  );

  assert.equal(context.store.read(first).toString('utf8'), 'first');
  assert.equal(existsSync(second), false);
  const ownerDirectory = join(context.exportsRoot, 'owner-one');
  assert.deepEqual(readdirSync(ownerDirectory), ['first.json']);
});

test('store fails closed when a permission adapter returns a promise', () => {
  const context = fixture({
    async restrictFile() {},
  });
  const reference = context.paths.backupReference({
    profileId: 'owner-one',
    id: 'backup-1',
  });

  assert.throws(
    () => context.store.writeAtomic(reference, Buffer.from('backup'), { sensitive: true }),
    error => error?.code === 'ARTIFACT_PERMISSION_ASYNC_UNSUPPORTED'
  );
  assert.equal(existsSync(reference), false);
  assert.deepEqual(readdirSync(join(context.backupsRoot, 'owner-one')), []);
});

test('store rejects attempts to overwrite an existing artifact', () => {
  const context = fixture();
  const reference = context.paths.exportReference({
    profileId: 'owner-one',
    id: 'export-1',
  });

  context.store.writeAtomic(reference, Buffer.from('first'), { sensitive: true });

  assert.throws(
    () => context.store.writeAtomic(reference, Buffer.from('second'), { sensitive: true }),
    error => error?.code === 'ARTIFACT_ALREADY_EXISTS'
  );
  assert.equal(context.store.read(reference).toString('utf8'), 'first');
});
