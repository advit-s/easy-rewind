import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { inspectBackendElectronImports } from './backend-independence.mjs';

test('backend independence scan covers JS, CJS, MJS, TS, and TSX import forms', () => {
  const root = mkdtempSync(join(tmpdir(), 'easy-rewind-backend-independence-'));
  const fixtures = {
    'require.js': `require('electron');\n`,
    'require.cjs': `const electron = require("node:electron");\n`,
    'static.mjs': `import electron from 'electron';\n`,
    'dynamic.ts': `const electron = await import('electron');\n`,
    'component.tsx': `import { ipcRenderer } from "electron";\n`,
    'safe.txt': `require('electron');\n`,
  };
  try {
    for (const [name, content] of Object.entries(fixtures)) {
      writeFileSync(join(root, name), content);
    }
    assert.deepEqual(inspectBackendElectronImports(root), [
      'component.tsx',
      'dynamic.ts',
      'require.cjs',
      'require.js',
      'static.mjs',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('backend independence scan rejects links without following them', t => {
  const root = mkdtempSync(join(tmpdir(), 'easy-rewind-backend-independence-'));
  const external = mkdtempSync(join(tmpdir(), 'easy-rewind-backend-external-'));
  writeFileSync(join(external, 'external.ts'), `import('electron');\n`);
  mkdirSync(join(root, 'nested'));
  try {
    try {
      symlinkSync(external, join(root, 'nested', 'linked'), 'junction');
    } catch (error) {
      if (error?.code === 'EPERM') {
        t.skip('junction creation is unavailable');
        return;
      }
      throw error;
    }
    assert.throws(() => inspectBackendElectronImports(root), /Backend source links are not allowed: nested\/linked/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  }
});
