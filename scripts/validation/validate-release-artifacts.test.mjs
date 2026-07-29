import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { createPackage } from '@electron/asar';
import { validateReleaseArtifacts } from './validate-release-artifacts.mjs';

function write(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value);
}

async function fixture({ forbidden = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'easy-rewind-release-artifacts-'));
  const source = join(root, 'source');
  const dist = join(root, 'dist');
  write(
    join(source, 'package.json'),
    JSON.stringify({
      name: 'easy-rewind-desktop',
      version: '2.0.0',
      productName: 'Easy Rewind',
      main: 'desktop/bootstrap.js',
    })
  );
  for (const relative of [
    'desktop/bootstrap.js',
    'desktop/main.js',
    'desktop/preload.js',
    'desktop/overlay.js',
    'desktop/overlay.html',
    'desktop/overlay.css',
    'desktop/assets/tray-icon.png',
    'backend/src/lifecycle/composition-root.js',
    'backend/src/database/migrations/005_reminder_outbox.sql',
    'frontend/dashboard.html',
    'packages/contracts/schema/health.json',
  ]) {
    write(join(source, relative), relative.endsWith('.png') ? Buffer.from([1, 2, 3]) : `'use strict';\n`);
  }
  if (forbidden) write(join(source, 'backend', 'runtime.sqlite3'), Buffer.from('private rows'));

  const resources = join(dist, 'win-unpacked', 'resources');
  mkdirSync(resources, { recursive: true });
  await createPackage(source, join(resources, 'app.asar'));
  write(
    join(resources, 'app.asar.unpacked', 'node_modules', 'better-sqlite3', 'prebuilds', 'win32-x64.node'),
    Buffer.from([1, 2, 3, 4])
  );
  write(join(dist, 'win-unpacked', 'Easy Rewind.exe'), Buffer.from('MZunpacked'));
  write(join(dist, 'Easy-Rewind-UNSIGNED-Setup-2.0.0-x64.exe'), Buffer.from('MZsetup'));
  write(join(dist, 'Easy-Rewind-UNSIGNED-Portable-2.0.0-x64.exe'), Buffer.from('MZportable'));
  write(join(dist, 'Easy-Rewind-UNSIGNED-Setup-2.0.0-x64.exe.blockmap'), Buffer.from('blockmap'));
  return { dist, root };
}

test('release artifact validation inspects ASAR contents and writes stable SHA-256 checksums', async () => {
  const context = await fixture();
  try {
    const result = await validateReleaseArtifacts({
      distDirectory: context.dist,
      writeChecksums: true,
    });
    assert.deepEqual(result.artifacts, [
      'Easy-Rewind-UNSIGNED-Portable-2.0.0-x64.exe',
      'Easy-Rewind-UNSIGNED-Setup-2.0.0-x64.exe',
      'Easy-Rewind-UNSIGNED-Setup-2.0.0-x64.exe.blockmap',
    ]);
    assert.equal(result.packageVersion, '2.0.0');
    const checksums = readFileSync(join(context.dist, 'SHA256SUMS.txt'), 'utf8');
    assert.match(checksums, /^[a-f0-9]{64}  Easy-Rewind-UNSIGNED-Portable-2\.0\.0-x64\.exe$/m);
    assert.equal(checksums.split('\n').filter(Boolean).length, 3);
  } finally {
    rmSync(context.root, { recursive: true, force: true });
  }
});

test('release artifact validation rejects databases inside the packaged application', async () => {
  const context = await fixture({ forbidden: true });
  try {
    await assert.rejects(
      () => validateReleaseArtifacts({ distDirectory: context.dist }),
      error =>
        error?.name === 'ReleaseArtifactValidationError' && error.message === 'Release artifact validation failed.'
    );
  } finally {
    rmSync(context.root, { recursive: true, force: true });
  }
});
