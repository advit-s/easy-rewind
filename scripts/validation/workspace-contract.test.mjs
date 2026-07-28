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

  assert.deepEqual(repository.workspaces, ['backend', 'desktop', 'packages/contracts']);
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
    'test:backend',
    'test:backend:legacy-safe',
    'test:contracts',
    'test:migrations',
    'test:lifecycle',
    'audit:production',
    'verify:stage2',
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
  assert.equal(Object.hasOwn(backend.devDependencies, 'jest'), false);
  assert.equal(repository.scripts['test:integration'], 'npm run test:backend && npm run test:backend:legacy-safe');
  assert.equal(repository.scripts['test:backend'], 'npm --workspace backend test');
  assert.equal(
    repository.scripts['test:contracts'],
    'npm --workspace @easy-rewind/contracts test && node --test backend/src/http/contract-routes.test.js backend/src/http/compatibility-routes.test.js'
  );
  assert.equal(
    repository.scripts['test:migrations'],
    'node --test backend/src/database/*.test.js backend/src/legacy/*.test.js'
  );
  assert.equal(backend.scripts['test:migrations'], 'node --test src/database/*.test.js src/legacy/*.test.js');
  assert.equal(
    repository.scripts['test:lifecycle'],
    'node --test backend/src/lifecycle/*.test.js backend/test/import-safety.test.js'
  );
  assert.equal(repository.scripts['audit:production'], 'npm audit --omit=dev');
  assert.equal(
    repository.scripts['verify:stage2'],
    'npm run test:requirements && npm --workspace backend test && npm run test:contracts && npm run test:migrations && npm run test:lifecycle && npm run verify:native && npm run audit:production && npm run scan:secrets && npm run check:hygiene'
  );
  assert.equal(repository.scripts.verify, 'npm run verify:stage1 && npm run verify:stage2');
  assert.equal(backend.scripts.test, 'node --test test/**/*.test.js src/**/*.test.js');
  assert.doesNotMatch(backend.scripts.test, /forceExit|detectOpenHandles|jest/i);
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

test('workspace normalizes tracked text files to LF on every platform', () => {
  const attributesPath = join(root, '.gitattributes');

  assert.equal(existsSync(attributesPath), true, 'missing root .gitattributes');
  const attributes = readFileSync(attributesPath, 'utf8')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'));

  assert.ok(attributes.includes('* text=auto eol=lf'), 'missing repo-wide LF normalization rule');
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

test('operator documentation covers the shared runtime, protected storage, migration boundary, and recovery', () => {
  const readme = readFileSync(join(root, 'README.md'), 'utf8').replace(/\s+/g, ' ');
  const security = readFileSync(join(root, 'SECURITY.md'), 'utf8').replace(/\s+/g, ' ');

  for (const required of [
    'Electron-embedded production mode',
    'Standalone CLI development mode',
    'Injected test mode',
    'EASY_REWIND_STORAGE_ROOT',
    'SIGINT',
    'SIGTERM',
    '/v1',
    '/api',
    'not_implemented',
    'SENSITIVE MIGRATION METADATA',
    'Stage 3',
  ]) {
    assert.match(readme, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
  }

  for (const required of [
    'safeStorage',
    'DPAPI',
    'current Windows user',
    'explicit confirmation',
    'CSRF',
    'quarantine',
    'revoke',
    'sole preserved copy',
  ]) {
    assert.match(security, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
  }
});
