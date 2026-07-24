import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import test from 'node:test';

const script = resolve(import.meta.dirname, 'run-legacy-backend-tests.mjs');

function fixture(jestSource) {
  const root = mkdtempSync(join(tmpdir(), 'easy-rewind-wrapper-contract-'));
  mkdirSync(join(root, 'scripts', 'testing'), { recursive: true });
  mkdirSync(join(root, 'backend', 'data'), { recursive: true });
  mkdirSync(join(root, 'backend', 'node_modules', 'private-package'), { recursive: true });
  mkdirSync(join(root, 'backend', '.git'), { recursive: true });
  mkdirSync(join(root, 'node_modules', 'jest', 'bin'), { recursive: true });
  cpSync(script, join(root, 'scripts', 'testing', 'run-legacy-backend-tests.mjs'));
  writeFileSync(join(root, 'backend', 'server.js'), 'export {};\n');
  writeFileSync(join(root, 'backend', '.env'), 'GEMINI_API_KEY=fixture-secret\n');
  writeFileSync(join(root, 'backend', 'data', 'settings.json'), '{}\n');
  writeFileSync(join(root, 'backend', '.git', 'config'), 'fixture\n');
  writeFileSync(join(root, 'backend', 'node_modules', 'private-package', 'index.js'), 'fixture\n');
  writeFileSync(join(root, 'node_modules', 'jest', 'bin', 'jest.js'), jestSource);
  return root;
}

function run(root) {
  return spawnSync(process.execPath, ['scripts/testing/run-legacy-backend-tests.mjs'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, GEMINI_API_KEY: 'parent-secret' },
  });
}

test('legacy runner uses a disposable backend copy and a repository-external database', () => {
  const root = fixture(`
    const fs = require('node:fs');
    const path = require('node:path');
    const assert = require('node:assert/strict');
    assert.notEqual(path.resolve(process.cwd()), path.resolve(${JSON.stringify(join('placeholder', 'backend'))}));
    assert.equal(process.env.GEMINI_API_KEY, '');
    assert.equal(process.env.NODE_ENV, 'test');
    assert.equal(fs.existsSync(path.join(process.cwd(), '.env')), false);
    assert.equal(fs.existsSync(path.join(process.cwd(), '.git')), false);
    assert.equal(fs.existsSync(path.join(process.cwd(), 'data')), false);
    assert.equal(fs.existsSync(path.join(process.cwd(), 'node_modules')), false);
    assert.ok(path.isAbsolute(process.env.DATABASE_PATH));
    assert.equal(process.env.DATABASE_PATH.includes(process.cwd()), false);
    process.stdout.write('fixture jest passed');
  `);
  rmSync(join(root, 'backend', 'data', 'settings.json'));
  writeFileSync(join(root, 'backend', 'data', 'non-sensitive-fixture.txt'), 'excluded\n');

  try {
    const result = run(root);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /fixture jest passed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('legacy runner reports forbidden repository writes using relative labels only', () => {
  const root = fixture(`
    const fs = require('node:fs');
    const path = require('node:path');
    const repositoryRoot = path.resolve(__dirname, '..', '..', '..');
    const sourceData = path.join(repositoryRoot, 'backend', 'data');
    fs.mkdirSync(sourceData, { recursive: true });
    fs.writeFileSync(path.join(sourceData, 'easy-rewind.db'), 'forbidden');
  `);
  rmSync(join(root, 'backend', 'data'), { recursive: true, force: true });

  try {
    const result = run(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /backend\/data\/easy-rewind\.db/);
    assert.doesNotMatch(result.stderr, new RegExp(root.replaceAll('\\', '\\\\'), 'i'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('legacy runner redacts repository and temporary absolute paths from child output', () => {
  const root = fixture(`
    const path = require('node:path');
    process.stdout.write('cwd=' + process.cwd() + '\\n');
    process.stderr.write('repo=' + path.resolve(__dirname, '..', '..', '..') + '\\n');
  `);
  rmSync(join(root, 'backend', 'data'), { recursive: true, force: true });

  try {
    const result = run(root);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /<temporary-backend>/);
    assert.match(result.stderr, /<repository-root>/);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(root.replaceAll('\\', '\\\\'), 'i'));
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /easy-rewind-legacy-tests-[^\\/\s]+/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
