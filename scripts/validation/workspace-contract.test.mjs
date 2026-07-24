import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { inspectBackendElectronImports } from './backend-independence.mjs';

const root = resolve(import.meta.dirname, '..', '..');

function readJson(relativePath) {
  return JSON.parse(readFileSync(join(root, relativePath), 'utf8'));
}

function dependencyValues(manifest) {
  return Object.values({
    ...(manifest.dependencies ?? {}),
    ...(manifest.devDependencies ?? {}),
    ...(manifest.optionalDependencies ?? {}),
    ...(manifest.peerDependencies ?? {}),
  });
}

test('workspace pins the selected development runtime and one product version', () => {
  const repository = readJson('package.json');
  const backend = readJson('backend/package.json');
  const desktop = readJson('desktop/package.json');

  assert.deepEqual(repository.workspaces, ['backend', 'desktop']);
  assert.equal(repository.version, '2.0.0');
  assert.equal(backend.version, repository.version);
  assert.equal(desktop.version, repository.version);
  assert.equal(repository.packageManager, 'npm@11.6.2');
  assert.equal(readFileSync(join(root, '.nvmrc'), 'utf8').trim(), '24.18.0');

  for (const manifest of [repository, backend, desktop]) {
    assert.equal(manifest.private, true);
    assert.deepEqual(manifest.engines, {
      node: '>=24.18.0 <25',
      npm: '>=11.6.2 <12',
    });
    assert.ok(
      dependencyValues(manifest).every(
        version => typeof version === 'string' && !version.startsWith('^') && !version.startsWith('~')
      ),
      `${manifest.name} must use exact dependency pins`
    );
  }
});

test('workspace exposes the complete Stage 1 command contract and selected package pins', () => {
  const repository = readJson('package.json');
  const backend = readJson('backend/package.json');
  const desktop = readJson('desktop/package.json');
  const requiredScripts = [
    'install:clean',
    'start',
    'dev',
    'lint',
    'format',
    'format:check',
    'test',
    'test:unit',
    'test:integration',
    'test:containment',
    'test:hygiene',
    'test:workspace',
    'test:backend:legacy-safe',
    'validate:extension',
    'scan:secrets',
    'check:hygiene',
    'build',
    'verify',
    'verify:stage1',
    'desktop:dev',
    'desktop:build',
    'package:windows',
  ];

  for (const script of requiredScripts) {
    assert.equal(typeof repository.scripts?.[script], 'string', `missing root script ${script}`);
  }
  assert.equal(repository.devDependencies.secretlint, '13.0.4');
  assert.equal(repository.devDependencies['@secretlint/secretlint-rule-preset-recommend'], '13.0.4');
  assert.equal(repository.devDependencies.prettier, '3.9.6');
  assert.equal(backend.dependencies['better-sqlite3'], '13.0.1');
  assert.equal(backend.dependencies['@google/generative-ai'], '0.24.1');
  assert.equal(backend.dependencies.nodemailer, '9.0.3');
  assert.equal(backend.devDependencies.eslint, '10.7.0');
  assert.equal(backend.devDependencies.jest, '30.4.2');
  assert.equal(desktop.devDependencies.electron, '43.2.0');
  assert.equal(desktop.devDependencies['@electron/rebuild'], '4.2.0');
  assert.equal(desktop.devDependencies['electron-builder'], '26.15.3');
  assert.equal(desktop.scripts['rebuild:native'], 'node ../scripts/build/rebuild-electron-native.mjs');
  assert.match(backend.description, /Electron-independent/i);
});

test('workspace has one root lockfile and strict reproducible npm settings', () => {
  assert.equal(existsSync(join(root, 'package-lock.json')), true);
  assert.equal(existsSync(join(root, 'backend', 'package-lock.json')), false);
  assert.equal(existsSync(join(root, 'desktop', 'package-lock.json')), false);

  const npmrc = readFileSync(join(root, '.npmrc'), 'utf8');
  for (const setting of ['engine-strict=true', 'fund=false', 'audit=true', 'save-exact=true']) {
    assert.match(npmrc, new RegExp(`^${setting}$`, 'm'));
  }
});

test('environment example contains placeholders only and backend source is Electron-independent', () => {
  const example = readFileSync(join(root, 'backend', '.env.example'), 'utf8');
  assert.match(example, /^HOST=127\.0\.0\.1$/m);
  assert.match(example, /^DATABASE_PATH=$/m);
  assert.match(example, /^GEMINI_API_KEY=$/m);
  assert.doesNotMatch(example, /your[_-]gemini|AIza/i);

  assert.deepEqual(inspectBackendElectronImports(join(root, 'backend')), []);
});

test('Secretlint ignores generated and sensitive outputs without excluding release evidence or source', () => {
  const ignored = readFileSync(join(root, '.secretlintignore'), 'utf8')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'));

  for (const pattern of [
    'node_modules/**',
    'dist/**',
    'build/**',
    'out/**',
    '/release/**',
    'artifacts/**',
    'coverage/**',
    'backend/data/**',
    '/runtime/**',
    'legacy-backup/**',
    'quarantine/**',
    'migration-work/**',
    'package-lock.json',
  ]) {
    assert.ok(ignored.includes(pattern), `missing Secretlint ignore ${pattern}`);
  }
  assert.ok(!ignored.some(pattern => pattern === '**' || pattern === 'backend/**'));
  assert.ok(!ignored.some(pattern => pattern.includes('docs/release')));
});
