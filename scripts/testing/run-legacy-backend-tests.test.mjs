import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import test from 'node:test';

const script = resolve(import.meta.dirname, 'run-legacy-backend-tests.mjs');

function fixture(testSource) {
  const root = mkdtempSync(join(tmpdir(), 'easy-rewind-wrapper-contract-'));
  mkdirSync(join(root, 'scripts', 'testing'), { recursive: true });
  mkdirSync(join(root, 'backend', 'data'), { recursive: true });
  mkdirSync(join(root, 'backend', 'node_modules', 'private-package'), { recursive: true });
  mkdirSync(join(root, 'backend', '.git'), { recursive: true });
  mkdirSync(join(root, 'backend', 'test'), { recursive: true });
  cpSync(script, join(root, 'scripts', 'testing', 'run-legacy-backend-tests.mjs'));
  writeFileSync(join(root, 'backend', 'server.js'), 'export {};\n');
  writeFileSync(join(root, 'backend', '.env'), 'GEMINI_API_KEY=fixture-secret\n');
  writeFileSync(join(root, 'backend', 'data', 'settings.json'), '{}\n');
  writeFileSync(join(root, 'backend', '.git', 'config'), 'fixture\n');
  writeFileSync(join(root, 'backend', 'node_modules', 'private-package', 'index.js'), 'fixture\n');
  writeFileSync(
    join(root, 'backend', 'test', 'api.test.js'),
    testSource.replaceAll('__FIXTURE_REPOSITORY_ROOT__', JSON.stringify(root))
  );
  writeFileSync(join(root, 'backend', 'test', 'nodemailer-compatibility.test.js'), "'use strict';\n");
  return root;
}

function run(root, env = {}) {
  return spawnSync(process.execPath, ['scripts/testing/run-legacy-backend-tests.mjs'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, GEMINI_API_KEY: 'parent-secret', ...env },
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
    process.stdout.write('fixture node test passed');
  `);
  rmSync(join(root, 'backend', 'data', 'settings.json'));
  writeFileSync(join(root, 'backend', 'data', 'non-sensitive-fixture.txt'), 'excluded\n');

  try {
    const result = run(root);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /fixture node test passed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('legacy runner reports forbidden repository writes using relative labels only', () => {
  const root = fixture(`
    const fs = require('node:fs');
    const path = require('node:path');
    const repositoryRoot = __FIXTURE_REPOSITORY_ROOT__;
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
    process.stderr.write('repo=' + __FIXTURE_REPOSITORY_ROOT__ + '\\n');
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

test('legacy runner rejects junctions in the source backend using a relative label', t => {
  const root = fixture('process.exitCode = 99;');
  const external = mkdtempSync(join(tmpdir(), 'easy-rewind-wrapper-external-'));
  writeFileSync(join(external, 'outside.txt'), 'outside\n');
  try {
    try {
      symlinkSync(external, join(root, 'backend', 'linked'), 'junction');
    } catch (error) {
      if (error?.code === 'EPERM') {
        t.skip('junction creation is unavailable');
        return;
      }
      throw error;
    }
    rmSync(join(root, 'backend', 'data'), { recursive: true, force: true });

    const result = run(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /backend\/linked/);
    assert.doesNotMatch(result.stderr, new RegExp(root.replaceAll('\\', '\\\\'), 'i'));
    assert.doesNotMatch(result.stderr, new RegExp(external.replaceAll('\\', '\\\\'), 'i'));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  }
});

test('legacy runner does not inherit credentials, arbitrary variables, or repository INIT_CWD', () => {
  const root = fixture(`
    const assert = require('node:assert/strict');
    const path = require('node:path');
    assert.equal(process.env.SMTP_PASS ?? '', '');
    assert.equal(process.env.GEMINI_API_KEY ?? '', '');
    assert.equal(process.env.LEGACY_TEST_UNSAFE_WRITE_PATH, undefined);
    assert.equal(path.resolve(process.env.INIT_CWD), path.resolve(process.cwd()));
    assert.equal(path.resolve(process.env.USERPROFILE).includes(path.resolve(process.cwd())), false);
  `);
  rmSync(join(root, 'backend', 'data'), { recursive: true, force: true });

  try {
    const result = run(root, {
      SMTP_PASS: 'smtp-secret',
      LEGACY_TEST_UNSAFE_WRITE_PATH: join(root, 'unsafe-write.txt'),
      INIT_CWD: root,
    });
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('legacy runner redacts slash, file URL, and percent-encoded absolute path variants', () => {
  const root = fixture(`
    const { pathToFileURL } = require('node:url');
    const path = require('node:path');
    const repositoryRoot = __FIXTURE_REPOSITORY_ROOT__;
    const forward = repositoryRoot.replaceAll('\\\\', '/');
    process.stdout.write(forward + '\\n');
    process.stdout.write(pathToFileURL(repositoryRoot).href + '\\n');
    process.stdout.write(encodeURI(forward) + '\\n');
    process.stdout.write(encodeURIComponent(forward) + '\\n');
  `);
  rmSync(join(root, 'backend', 'data'), { recursive: true, force: true });

  try {
    const result = run(root);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /easy-rewind-wrapper-contract-/i);
    assert.doesNotMatch(result.stdout, /%[0-9a-f]{2}/i);
    assert.match(result.stdout, /<repository-root>/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('legacy runner detects arbitrary source additions with relative labels', () => {
  const root = fixture(`
    const fs = require('node:fs');
    const path = require('node:path');
    const repositoryRoot = __FIXTURE_REPOSITORY_ROOT__;
    fs.writeFileSync(path.join(repositoryRoot, 'backend', 'arbitrary-output.log'), 'changed');
  `);
  rmSync(join(root, 'backend', 'data'), { recursive: true, force: true });

  try {
    const result = run(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /backend\/arbitrary-output\.log/);
    assert.doesNotMatch(result.stderr, new RegExp(root.replaceAll('\\', '\\\\'), 'i'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('legacy runner times out a hanging child and removes its temporary tree', () => {
  const root = fixture(`setTimeout(() => {}, 350);`);
  rmSync(join(root, 'backend', 'data'), { recursive: true, force: true });
  const before = new Set(readdirSync(tmpdir()).filter(name => name.startsWith('easy-rewind-legacy-tests-')));

  try {
    const started = Date.now();
    const result = run(root, { EASY_REWIND_LEGACY_TEST_TIMEOUT_MS: '100' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Legacy test process timed out\./);
    assert.ok(Date.now() - started < 2000);
    const added = readdirSync(tmpdir()).filter(
      name => name.startsWith('easy-rewind-legacy-tests-') && !before.has(name)
    );
    assert.deepEqual(added, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
    for (const name of readdirSync(tmpdir())) {
      if (name.startsWith('easy-rewind-legacy-tests-') && !before.has(name)) {
        rmSync(join(tmpdir(), name), { recursive: true, force: true });
      }
    }
  }
});

test('legacy runner preload denies descendant process creation', () => {
  const root = fixture(`
    const assert = require('node:assert/strict');
    const childProcess = require('node:child_process');
    assert.throws(
      () => childProcess.spawnSync(process.execPath, ['-e', 'process.exit(0)']),
      /Legacy test descendant processes are disabled/
    );
  `);
  rmSync(join(root, 'backend', 'data'), { recursive: true, force: true });

  try {
    const result = run(root);
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
