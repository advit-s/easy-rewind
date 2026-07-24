import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import test from 'node:test';

const validator = resolve(import.meta.dirname, 'validate-extension.mjs');

function makeExtension(manifest, files = {}) {
  const root = mkdtempSync(join(tmpdir(), 'easy-rewind-extension-contract-'));
  writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest));
  for (const [relativePath, content] of Object.entries(files)) {
    const target = join(root, relativePath);
    mkdirSync(resolve(target, '..'), { recursive: true });
    writeFileSync(target, content);
  }
  return root;
}

function run(extensionRoot) {
  return spawnSync(process.execPath, [validator, '--extension-root', extensionRoot], {
    encoding: 'utf8',
  });
}

const baseManifest = {
  manifest_version: 3,
  name: 'Fixture Extension',
  version: '1.0.0',
  background: { service_worker: 'background.js' },
  action: { default_popup: 'popup.html' },
};

test('extension validator accepts existing in-root file references', () => {
  const root = makeExtension(baseManifest, {
    'background.js': '',
    'popup.html': '',
  });
  try {
    const result = run(root);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /2 references/);
    assert.doesNotMatch(result.stdout, new RegExp(root.replaceAll('\\', '\\\\'), 'i'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const [label, reference] of [
  ['absolute', resolve('outside.js')],
  ['traversal', '../outside.js'],
]) {
  test(`extension validator rejects ${label} references without exposing absolute paths`, () => {
    const root = makeExtension(
      {
        ...baseManifest,
        background: { service_worker: reference },
      },
      { 'popup.html': '' }
    );
    try {
      const result = run(root);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /background\.service_worker/);
      assert.doesNotMatch(result.stderr, new RegExp(root.replaceAll('\\', '\\\\'), 'i'));
      assert.doesNotMatch(result.stderr, /Users|C:\\/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test('extension validator rejects directories and missing references using relative labels', () => {
  const root = makeExtension(
    {
      ...baseManifest,
      icons: { 16: 'icons', 32: 'missing.png' },
    },
    {
      'background.js': '',
      'popup.html': '',
    }
  );
  mkdirSync(join(root, 'icons'));
  try {
    const result = run(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /icons\.16/);
    assert.match(result.stderr, /icons\.32/);
    assert.doesNotMatch(result.stderr, new RegExp(root.replaceAll('\\', '\\\\'), 'i'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('extension validator rejects an external manifest symlink without exposing paths', t => {
  const root = makeExtension(baseManifest, {
    'background.js': '',
    'popup.html': '',
  });
  const external = mkdtempSync(join(tmpdir(), 'easy-rewind-external-manifest-'));
  const externalManifest = join(external, 'manifest.json');
  writeFileSync(externalManifest, JSON.stringify(baseManifest));
  rmSync(join(root, 'manifest.json'));

  try {
    try {
      symlinkSync(externalManifest, join(root, 'manifest.json'), 'file');
    } catch (error) {
      if (error?.code === 'EPERM') {
        t.skip('file symlink creation is unavailable');
        return;
      }
      throw error;
    }
    const result = run(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /manifest\.json/);
    assert.doesNotMatch(result.stderr, new RegExp(external.replaceAll('\\', '\\\\'), 'i'));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  }
});

test('extension validator rejects arrays where icon maps must be plain objects', () => {
  const root = makeExtension(
    { ...baseManifest, icons: ['icon.png'] },
    { 'background.js': '', 'popup.html': '', 'icon.png': '' }
  );
  try {
    const result = run(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /icons: expected a plain object/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('extension validator rejects percent-encoded path ambiguity even when the literal file exists', () => {
  const root = makeExtension(
    { ...baseManifest, background: { service_worker: '%2e%2e/outside.js' } },
    { '%2e%2e/outside.js': '', 'popup.html': '' }
  );
  try {
    const result = run(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /background\.service_worker/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('extension validator reports malformed schema fields with static relative labels', () => {
  const root = makeExtension(
    {
      ...baseManifest,
      name: [],
      background: [],
      content_scripts: { js: ['content.js'] },
    },
    { 'popup.html': '', 'background.js': '' }
  );
  try {
    const result = run(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /name: expected a non-empty string/);
    assert.match(result.stderr, /background: expected a plain object/);
    assert.match(result.stderr, /content_scripts: expected an array/);
    assert.doesNotMatch(result.stderr, new RegExp(root.replaceAll('\\', '\\\\'), 'i'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
