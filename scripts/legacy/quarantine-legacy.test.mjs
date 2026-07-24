import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const repositoryRoot = resolve(import.meta.dirname, '..', '..');
const quarantineScript = join(
  repositoryRoot,
  'scripts',
  'legacy',
  'quarantine-legacy.ps1'
);
const purgeScript = join(
  repositoryRoot,
  'scripts',
  'legacy',
  'purge-legacy-source.ps1'
);
const tempRoots = [];

function newFixture() {
  const root = mkdtempSync(join(tmpdir(), 'easy-rewind-containment-'));
  tempRoots.push(root);
  const sourceRoot = join(root, 'repo');
  const dataRoot = join(sourceRoot, 'backend', 'data');
  const quarantineRoot = join(root, 'local-app-data', 'easy-rewind', 'legacy-backup');
  mkdirSync(dataRoot, { recursive: true });

  const files = new Map([
    ['easy-rewind.db', Buffer.from([0x53, 0x51, 0x4c, 0x69, 0x74, 0x65])],
    ['easy-rewind.db-wal', Buffer.from([0x37, 0x7f, 0x06, 0x82, 0x01])],
    ['easy-rewind.db-shm', Buffer.from([0x18, 0xe2, 0x2d, 0x00])],
    ['settings.json', Buffer.from('{"legacy":true}\n', 'utf8')],
  ]);

  for (const [name, bytes] of files) {
    writeFileSync(join(dataRoot, name), bytes);
  }

  return { root, sourceRoot, dataRoot, quarantineRoot, files };
}

function runPowerShell(script, args) {
  return spawnSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...args],
    { cwd: repositoryRoot, encoding: 'utf8' }
  );
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex').toUpperCase();
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

test('quarantine copies the coherent set byte-for-byte and writes a safe manifest', () => {
  const fixture = newFixture();
  const result = runPowerShell(quarantineScript, [
    '-SourceRoot',
    fixture.sourceRoot,
    '-QuarantineRoot',
    fixture.quarantineRoot,
    '-Timestamp',
    '20260724T120000000Z',
  ]);

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.sensitive, true);
  assert.equal(output.files.length, 4);
  assert.match(output.backupTimeUtc, /Z$/);
  assert.equal(output.sqliteOpened, false);
  assert.equal(basename(output.quarantinePath), '20260724T120000000Z');

  for (const entry of output.files) {
    const original = fixture.files.get(entry.name);
    assert.ok(original, `unexpected manifest entry ${entry.name}`);
    assert.equal(entry.size, original.byteLength);
    assert.equal(entry.sha256, sha256(original));
    assert.deepEqual(
      readFileSync(join(output.quarantinePath, entry.backupRelativePath)),
      original
    );
  }

  assert.equal(existsSync(output.manifestPath), true);
});

test('quarantine fails closed if any SQLite companion is absent', () => {
  const fixture = newFixture();
  rmSync(join(fixture.dataRoot, 'easy-rewind.db-wal'));

  const result = runPowerShell(quarantineScript, [
    '-SourceRoot',
    fixture.sourceRoot,
    '-QuarantineRoot',
    fixture.quarantineRoot,
    '-Timestamp',
    '20260724T120000001Z',
  ]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /required legacy file is missing/i);
  assert.equal(existsSync(fixture.quarantineRoot), false);
});

test('manifest-bound purge refuses tampered backups and preserves every source', () => {
  const fixture = newFixture();
  const backup = runPowerShell(quarantineScript, [
    '-SourceRoot',
    fixture.sourceRoot,
    '-QuarantineRoot',
    fixture.quarantineRoot,
    '-Timestamp',
    '20260724T120000002Z',
  ]);
  assert.equal(backup.status, 0, backup.stderr);
  const manifest = JSON.parse(backup.stdout);
  writeFileSync(
    join(manifest.quarantinePath, manifest.files[0].backupRelativePath),
    'tampered'
  );

  const purge = runPowerShell(purgeScript, [
    '-ManifestPath',
    manifest.manifestPath,
    '-Confirm:$false',
  ]);

  assert.notEqual(purge.status, 0);
  assert.match(purge.stderr, /backup checksum mismatch/i);
  for (const name of fixture.files.keys()) {
    assert.equal(existsSync(join(fixture.dataRoot, name)), true);
  }
});

test('manifest-bound purge removes only verified source files', () => {
  const fixture = newFixture();
  const unrelated = join(fixture.dataRoot, 'keep-me.txt');
  writeFileSync(unrelated, 'keep');
  const backup = runPowerShell(quarantineScript, [
    '-SourceRoot',
    fixture.sourceRoot,
    '-QuarantineRoot',
    fixture.quarantineRoot,
    '-Timestamp',
    '20260724T120000003Z',
  ]);
  assert.equal(backup.status, 0, backup.stderr);
  const manifest = JSON.parse(backup.stdout);

  const purge = runPowerShell(purgeScript, [
    '-ManifestPath',
    manifest.manifestPath,
    '-Confirm:$false',
  ]);

  assert.equal(purge.status, 0, purge.stderr);
  for (const name of fixture.files.keys()) {
    assert.equal(existsSync(join(fixture.dataRoot, name)), false);
  }
  assert.equal(readFileSync(unrelated, 'utf8'), 'keep');
});
