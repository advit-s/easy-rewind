import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import test from 'node:test';

const repositoryRoot = resolve(import.meta.dirname, '..', '..');
const extensionRoot = join(repositoryRoot, 'extension');
const validator = join(import.meta.dirname, 'validate-extension.mjs');

function runValidator(args) {
  return spawnSync(process.execPath, [validator, ...args], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function copyFixture() {
  const root = mkdtempSync(join(tmpdir(), 'easy-rewind-extension-fixture-'));
  cpSync(extensionRoot, root, { recursive: true });
  return root;
}

test('manifest grants only executable-code-used permissions and loopback hosts', () => {
  const manifest = readJson(join(extensionRoot, 'manifest.json'));

  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.background, {
    service_worker: 'background.js',
    type: 'module',
  });
  assert.deepEqual(manifest.permissions, ['activeTab', 'alarms', 'contextMenus', 'notifications', 'storage']);
  assert.deepEqual(manifest.host_permissions, ['http://127.0.0.1/*', 'http://localhost/*']);
  assert.equal(
    manifest.host_permissions.some(pattern => /:\*\/\*/.test(pattern)),
    false
  );
  assert.equal(JSON.stringify(manifest).includes('<all_urls>'), false);
  assert.equal(
    manifest.content_security_policy.extension_pages,
    "script-src 'self'; object-src 'none'; base-uri 'none'; frame-src 'none'"
  );
});

test('manifest wires the ESM content entry through one fail-closed classic loader', () => {
  const manifest = readJson(join(extensionRoot, 'manifest.json'));

  assert.deepEqual(manifest.content_scripts, [
    {
      matches: ['http://*/*', 'https://*/*'],
      js: ['content-loader.js'],
      run_at: 'document_idle',
    },
  ]);
  assert.deepEqual(manifest.web_accessible_resources, [
    {
      resources: ['content.js', 'src/message-contracts.js', 'src/privacy-policy.js'],
      matches: ['http://*/*', 'https://*/*'],
      use_dynamic_url: true,
    },
  ]);

  const loader = readFileSync(join(extensionRoot, 'content-loader.js'), 'utf8');
  assert.match(loader, /^void import\(chrome\.runtime\.getURL\('content\.js'\)\)\.catch\(\(\) => \{\}\);\s*$/);
  assert.doesNotMatch(loader, /console|innerHTML|fetch\s*\(/);
});

test('package command copies and validates a disposable production-only extension', () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'easy-rewind-extension-package-test-'));
  const output = join(temporaryRoot, 'package');

  try {
    const result = runValidator(['--extension-root', extensionRoot, '--package-output', output]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /packaged extension validation passed/i);

    const packagedManifest = readJson(join(output, 'manifest.json'));
    assert.equal(packagedManifest.manifest_version, 3);
    assert.equal(readFileSync(join(output, 'popup.js'), 'utf8').length > 0, true);
    assert.throws(() => readFileSync(join(output, 'test', 'api-client.test.js')));
    assert.throws(() => readFileSync(join(output, 'generate-icons.js')));
    assert.throws(() => readFileSync(join(output, 'icons', 'icon.svg')));
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

for (const [name, relativePath, content, pattern] of [
  ['source maps', 'background.js.map', '{}', /source map/i],
  ['inline event handlers', 'popup.html', '<button onclick="alert(1)">Save</button>', /inline event handler/i],
  ['unsafe HTML sinks', 'background.js', 'node.innerHTML = value;', /unsafe html/i],
  ['direct fetch outside the API client', 'background.js', "fetch('http://127.0.0.1:3210');", /direct fetch/i],
  [
    'credential material',
    'background.js',
    "const key = 'AIza01234567890123456789012345678901234';",
    /credential material/i,
  ],
]) {
  test(`packaged validator rejects ${name}`, () => {
    const root = copyFixture();
    try {
      writeFileSync(join(root, relativePath), content);
      const result = runValidator(['--extension-root', root, '--package']);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, pattern);
      assert.doesNotMatch(result.stderr, new RegExp(root.replaceAll('\\', '\\\\'), 'i'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test('packaged validator rejects missing JavaScript import references', () => {
  const root = copyFixture();
  try {
    writeFileSync(join(root, 'background.js'), "import './src/missing-module.js';");
    const result = runValidator(['--extension-root', root, '--package']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /missing local code reference/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('root package exposes the exact extension test gate', () => {
  const packageJson = readJson(join(repositoryRoot, 'package.json'));
  assert.equal(
    packageJson.scripts['test:extension'],
    'node --test extension/test/*.test.js scripts/validation/extension-package.test.mjs'
  );
});
