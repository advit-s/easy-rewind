import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const packageRoot = resolve(import.meta.dirname, '..');

test('public modules have no backend, Electron, DOM, React, React Native, or Node-only imports', async () => {
  const { inspectPublicImports } = await import('../scripts/validate-independence.mjs');
  assert.deepEqual(inspectPublicImports(packageRoot), []);
});

test('package exports explicit modules and canonical schemas without runtime listeners or file writes', () => {
  const manifest = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8'));
  assert.equal(manifest.dependencies.ajv, '8.20.0');
  assert.deepEqual(Object.keys(manifest.exports).sort(), [
    '.',
    './errors',
    './health',
    './pagination',
    './pairing',
    './reminders',
    './schemas/*',
    './sync',
  ]);
  assert.doesNotMatch(JSON.stringify(manifest), /backend|electron|react|react-native|jsdom|node:/i);
});
