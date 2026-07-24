import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import test from 'node:test';

const script = resolve(import.meta.dirname, 'rebuild-electron-native.mjs');

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function fixture(rebuildSource) {
  const root = mkdtempSync(join(tmpdir(), 'easy-rewind-electron-rebuild-fixture-'));
  const moduleRoot = join(root, 'node_modules', 'better-sqlite3');
  mkdirSync(join(root, 'scripts', 'build'), { recursive: true });
  mkdirSync(join(moduleRoot, 'prebuilds'), { recursive: true });
  mkdirSync(join(root, 'node_modules', 'node-addon-api'), { recursive: true });
  mkdirSync(join(root, 'node_modules', '@electron', 'rebuild', 'lib'), { recursive: true });
  cpSync(script, join(root, 'scripts', 'build', 'rebuild-electron-native.mjs'));
  writeFileSync(
    join(moduleRoot, 'package.json'),
    JSON.stringify({
      name: 'better-sqlite3',
      version: '13.0.1',
      main: 'index.js',
      dependencies: { 'node-addon-api': '8.5.0' },
    })
  );
  writeFileSync(
    join(moduleRoot, 'index.js'),
    `module.exports = class Database {
      prepare() { return { get() { return { ok: 1 }; } }; }
      close() {}
    };\n`
  );
  writeFileSync(join(moduleRoot, 'prebuilds', 'win32-x64.node'), 'node-binding');
  writeFileSync(
    join(root, 'node_modules', 'node-addon-api', 'package.json'),
    JSON.stringify({ name: 'node-addon-api', version: '8.5.0' })
  );
  writeFileSync(join(root, 'node_modules', '@electron', 'rebuild', 'lib', 'cli.js'), rebuildSource);
  return root;
}

function stageDirectories() {
  return new Set(readdirSync(tmpdir()).filter(name => name.startsWith('easy-rewind-electron-native-')));
}

function run(root) {
  return spawnSync(process.execPath, ['scripts/build/rebuild-electron-native.mjs'], {
    cwd: root,
    encoding: 'utf8',
  });
}

test('Electron rebuild mutates only the disposable native-module tree', () => {
  const root = fixture(`
    const fs = require('node:fs');
    const path = require('node:path');
    const index = process.argv.indexOf('--module-dir');
    const moduleDirectory = process.argv[index + 1];
    fs.appendFileSync(
      path.join(moduleDirectory, 'better-sqlite3', 'prebuilds', 'win32-x64.node'),
      '-electron'
    );
  `);
  const binding = join(root, 'node_modules', 'better-sqlite3', 'prebuilds', 'win32-x64.node');
  const beforeHash = sha256(binding);
  const beforeStages = stageDirectories();

  try {
    const result = run(root);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(sha256(binding), beforeHash);
    assert.match(result.stdout, /staging rebuild passed/);
    assert.match(result.stdout, /Stage 6/);
    assert.deepEqual(stageDirectories(), beforeStages);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Electron rebuild failure preserves the shared binding and cleans staging', () => {
  const root = fixture(`process.exitCode = 7;\n`);
  const binding = join(root, 'node_modules', 'better-sqlite3', 'prebuilds', 'win32-x64.node');
  const beforeHash = sha256(binding);
  const beforeStages = stageDirectories();

  try {
    const result = run(root);
    assert.notEqual(result.status, 0);
    assert.equal(sha256(binding), beforeHash);
    assert.match(result.stderr, /Electron native staging rebuild failed\./);
    assert.doesNotMatch(result.stderr, new RegExp(root.replaceAll('\\', '\\\\'), 'i'));
    assert.deepEqual(stageDirectories(), beforeStages);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
