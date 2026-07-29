import assert from 'node:assert/strict';
import test from 'node:test';

import Database from 'better-sqlite3';

import { createExpoNetworkStatus } from '../src/platform/expo-network-status.ts';
import { createExpoSecureCredentialStore } from '../src/platform/expo-secure-store.ts';
import { openExpoMobileDatabase } from '../src/platform/expo-sqlite.ts';

test('platform adapter imports and construction do not load Expo modules', () => {
  let loads = 0;
  const loader = async () => {
    loads += 1;
    throw new Error('must remain lazy');
  };

  createExpoSecureCredentialStore({ loadSecureStore: loader });
  createExpoNetworkStatus({ loadNetwork: loader });

  assert.equal(loads, 0);
});

test('Expo SQLite adapter opens the injected path and supports migrations and repository statements', async t => {
  const opened = [];
  const nativeDatabases = [];
  const expoModule = {
    openDatabaseSync(databasePath) {
      opened.push(databasePath);
      const nativeDatabase = new Database(':memory:');
      nativeDatabases.push(nativeDatabase);
      return {
        execSync(sql) {
          nativeDatabase.exec(sql);
        },
        prepareSync(sql) {
          const statement = nativeDatabase.prepare(sql);
          return {
            executeSync(...parameters) {
              if (statement.reader) {
                const rows = statement.all(...parameters);
                return {
                  changes: 0,
                  lastInsertRowId: 0,
                  getFirstSync() {
                    return rows[0] ?? null;
                  },
                  getAllSync() {
                    return rows;
                  },
                };
              }
              const run = statement.run(...parameters);
              return {
                ...run,
                getFirstSync() {
                  return null;
                },
                getAllSync() {
                  return [];
                },
              };
            },
          };
        },
        closeSync() {
          nativeDatabase.close();
        },
      };
    },
  };

  let loads = 0;
  const openedDatabase = await openExpoMobileDatabase({
    databasePath: 'profile.sqlite',
    loadExpoSqlite: async () => {
      loads += 1;
      return expoModule;
    },
    now: () => 1_800_000_000_000,
  });
  t.after(() => openedDatabase.database.close?.());

  assert.equal(loads, 1);
  assert.deepEqual(opened, ['profile.sqlite']);
  assert.deepEqual(openedDatabase.migration.appliedVersions, [1, 2, 3]);
  assert.equal(openedDatabase.database.prepare(`SELECT COUNT(*) AS count FROM schema_migrations`).get().count, 3);

  const inserted = openedDatabase.database
    .prepare(
      `INSERT INTO items(
        id, profile_id, revision, created_at, updated_at,
        kind, url, title, summary, content, source_device_id
      ) VALUES (?, ?, 0, ?, ?, 'article', NULL, ?, '', '', ?)`
    )
    .run('item-1', 'profile-a', 1, 1, 'Offline item', 'android-a');
  assert.equal(Number(inserted.changes), 1);
  assert.deepEqual(
    openedDatabase.database.prepare(`SELECT id, title FROM items WHERE profile_id = ? ORDER BY id`).all('profile-a'),
    [{ id: 'item-1', title: 'Offline item' }]
  );
  assert.equal(nativeDatabases.length, 1);
});

test('Expo SQLite opening failures use the existing stable mobile migration error', async () => {
  await assert.rejects(
    () =>
      openExpoMobileDatabase({
        databasePath: 'profile.sqlite',
        loadExpoSqlite: async () => ({
          openDatabaseSync() {
            throw new Error('native detail must not escape');
          },
        }),
      }),
    error => {
      assert.equal(error.code, 'MOBILE_DATABASE_OPEN_FAILED');
      assert.doesNotMatch(error.message, /native detail/i);
      return true;
    }
  );
});

test('Expo SecureStore adapter lazily stores credentials in an isolated Android Keystore service', async () => {
  const values = new Map();
  const calls = [];
  let loads = 0;
  const secureStore = createExpoSecureCredentialStore({
    service: 'easy-rewind.sync.credentials',
    loadSecureStore: async () => {
      loads += 1;
      return {
        async getItemAsync(key, options) {
          calls.push(['get', key, options]);
          return values.get(key) ?? null;
        },
        async setItemAsync(key, value, options) {
          calls.push(['set', key, value, options]);
          values.set(key, value);
        },
        async deleteItemAsync(key, options) {
          calls.push(['delete', key, options]);
          values.delete(key);
        },
      };
    },
  });

  assert.equal(loads, 0);
  const logicalKey = 'easy-rewind/pairing/install_123456789/credential';
  await secureStore.set(logicalKey, 'secret-sync-token');
  assert.equal(await secureStore.get(logicalKey), 'secret-sync-token');
  await secureStore.remove(logicalKey);
  assert.equal(await secureStore.get(logicalKey), null);

  assert.equal(loads, 1, 'the lazy Expo module load should be memoized');
  const nativeKey = calls[0][1];
  assert.match(nativeKey, /^er_[a-f0-9]+$/);
  assert.doesNotMatch(nativeKey, /\//);
  assert.equal(calls[0][2], 'secret-sync-token');
  for (const call of calls) {
    const options = call.at(-1);
    assert.deepEqual(options, {
      keychainService: 'easy-rewind.sync.credentials',
      requireAuthentication: false,
    });
  }
});

test('Expo Network adapter returns truthful normalized snapshots and removes listeners', async () => {
  let nativeListener;
  let removed = 0;
  let loads = 0;
  const network = createExpoNetworkStatus({
    loadNetwork: async () => {
      loads += 1;
      return {
        async getNetworkStateAsync() {
          return {
            type: 'WIFI',
            isConnected: true,
            isInternetReachable: null,
          };
        },
        addNetworkStateListener(listener) {
          nativeListener = listener;
          return {
            remove() {
              removed += 1;
            },
          };
        },
      };
    },
  });

  assert.equal(loads, 0);
  assert.deepEqual(await network.getStatus(), {
    connected: true,
    internetReachable: null,
    connectionType: 'wifi',
  });

  const updates = [];
  const unsubscribe = network.subscribe(snapshot => updates.push(snapshot));
  await Promise.resolve();
  await Promise.resolve();
  nativeListener({
    type: 'CELLULAR',
    isConnected: true,
    isInternetReachable: false,
  });
  assert.deepEqual(updates, [
    {
      connected: true,
      internetReachable: false,
      connectionType: 'cellular',
    },
  ]);

  unsubscribe();
  assert.equal(removed, 1);
  assert.equal(loads, 1);
});

test('Expo Network subscription can be cancelled before the lazy module resolves', async () => {
  let resolveModule;
  let listenerRegistrations = 0;
  const network = createExpoNetworkStatus({
    loadNetwork: () =>
      new Promise(resolve => {
        resolveModule = resolve;
      }),
  });

  const unsubscribe = network.subscribe(() => {
    throw new Error('cancelled listener must not run');
  });
  unsubscribe();
  await Promise.resolve();
  resolveModule({
    async getNetworkStateAsync() {
      throw new Error('unused');
    },
    addNetworkStateListener() {
      listenerRegistrations += 1;
      return { remove() {} };
    },
  });
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(listenerRegistrations, 0);
});
