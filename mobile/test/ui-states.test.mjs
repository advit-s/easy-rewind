import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { MOBILE_UI_STATES, createSyncStatusModel, runLocalFirstAction } from '../src/ui/sync-status.ts';

const mobileRoot = path.resolve(import.meta.dirname, '..');

const SCREEN_FILES = [
  'app/(tabs)/_layout.tsx',
  'app/(tabs)/index.tsx',
  'app/(tabs)/search.tsx',
  'app/(tabs)/reminders.tsx',
  'app/(tabs)/review.tsx',
  'app/capture.tsx',
  'app/item/[id].tsx',
  'app/conflicts.tsx',
  'app/settings.tsx',
];

test('sync status models cover every truthful mobile state with accessible copy', () => {
  assert.deepEqual(MOBILE_UI_STATES, [
    'loading',
    'empty',
    'offline',
    'queued',
    'synchronized',
    'conflicted',
    'revoked',
    'incompatible',
    'retry',
  ]);

  for (const state of MOBILE_UI_STATES) {
    const model = createSyncStatusModel(state, {
      queuedCount: state === 'queued' ? 3 : 0,
      lastSyncedAt: state === 'synchronized' ? 1_800_000_000_000 : null,
    });
    assert.equal(model.state, state);
    assert.ok(model.title.length > 0, state);
    assert.ok(model.message.length > 0, state);
    assert.ok(model.accessibilityLabel.includes(model.title), state);
    assert.equal(Object.isFrozen(model), true);
  }

  assert.match(createSyncStatusModel('offline', {}).message, /saved on this device/i);
  assert.match(createSyncStatusModel('queued', { queuedCount: 3 }).message, /3 changes/i);
  assert.match(createSyncStatusModel('conflicted', {}).actionLabel, /review/i);
  assert.match(createSyncStatusModel('revoked', {}).actionLabel, /pair/i);
  assert.match(createSyncStatusModel('incompatible', {}).actionLabel, /update/i);
  assert.match(createSyncStatusModel('retry', {}).actionLabel, /retry/i);
});

test('status copy remains stable when persisted timing metadata is invalid', () => {
  const model = createSyncStatusModel('synchronized', {
    lastSyncedAt: Number.MAX_SAFE_INTEGER,
  });
  assert.equal(model.message, 'This device is synchronized with the paired PC.');
});

test('local-first actions commit locally before requesting synchronization', async () => {
  const events = [];
  const result = await runLocalFirstAction({
    writeLocal: async () => {
      events.push('local:start');
      await Promise.resolve();
      events.push('local:committed');
      return { id: 'item-1', syncState: 'queued' };
    },
    requestSync: async local => {
      events.push(`sync:${local.id}`);
    },
  });

  assert.deepEqual(events, ['local:start', 'local:committed', 'sync:item-1']);
  assert.deepEqual(result, {
    local: { id: 'item-1', syncState: 'queued' },
    syncRequested: true,
  });
});

test('local failure never requests sync and sync failure never rolls back the local result', async () => {
  let syncCalls = 0;
  await assert.rejects(
    () =>
      runLocalFirstAction({
        writeLocal: async () => {
          throw new Error('database unavailable');
        },
        requestSync: async () => {
          syncCalls += 1;
        },
      }),
    /database unavailable/
  );
  assert.equal(syncCalls, 0);

  const result = await runLocalFirstAction({
    writeLocal: async () => ({ id: 'item-2', syncState: 'queued' }),
    requestSync: async () => {
      throw new Error('PC offline');
    },
  });
  assert.deepEqual(result, {
    local: { id: 'item-2', syncState: 'queued' },
    syncRequested: false,
  });
});

test('the Android navigation surface contains only the approved mobile routes', async () => {
  const tabLayout = await readFile(path.join(mobileRoot, 'app', '(tabs)', '_layout.tsx'), 'utf8');
  for (const [name, title] of [
    ['index', 'Home'],
    ['search', 'Search'],
    ['reminders', 'Reminders'],
    ['review', 'Review'],
  ]) {
    assert.match(tabLayout, new RegExp(`name=["']${name}["']`));
    assert.match(tabLayout, new RegExp(`title:\\s*["']${title}["']`));
  }

  const rootLayout = await readFile(path.join(mobileRoot, 'app', '_layout.tsx'), 'utf8');
  for (const route of ['(tabs)', 'capture', 'item/[id]', 'conflicts', 'settings']) {
    assert.match(rootLayout, new RegExp(`name=["']${route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']`));
  }
});

test('screens and primitives keep safe text, accessible targets, and mobile-only scope', async () => {
  const sources = await Promise.all(
    [
      ...SCREEN_FILES,
      'src/ui/action-button.tsx',
      'src/ui/app-theme.tsx',
      'src/ui/screen.tsx',
      'src/ui/status-panel.tsx',
    ].map(async file => ({
      file,
      source: await readFile(path.join(mobileRoot, file), 'utf8'),
    }))
  );
  const combined = sources.map(entry => entry.source).join('\n');

  assert.doesNotMatch(combined, /dangerouslySetInnerHTML|innerHTML|WebView|eval\s*\(/);
  assert.doesNotMatch(combined, /research graph|bulk import|bulk export|provider administration|advanced diagnostics/i);
  assert.match(combined, /accessibilityRole=/);
  assert.match(combined, /accessibilityLabel=/);
  assert.match(combined, /minHeight:\s*48/);
  assert.match(combined, /maxWidth:/);
  assert.match(combined, /useColorScheme/);
});
