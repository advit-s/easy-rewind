'use strict';

const assert = require('node:assert/strict');
const { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { isAbsolute, join, resolve } = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const repositoryRoot = resolve(__dirname, '..', '..', '..');
const modulePath = join(__dirname, 'create-config.js');
const temporaryParents = new Set();

function loadConfigModule() {
  return require('./create-config');
}

function makeTemporaryParent() {
  const parent = mkdtempSync(join(tmpdir(), 'easy-rewind-config-test-'));
  temporaryParents.add(parent);
  return parent;
}

function makeStorageRoot({ existing = false } = {}) {
  const root = join(makeTemporaryParent(), 'storage');
  if (existing) mkdirSync(root);
  return root;
}

function productionInput(overrides = {}) {
  return {
    mode: 'production',
    storageRoot: makeStorageRoot(),
    applicationApi: {
      enabled: true,
      host: '127.0.0.1',
      port: 3210,
      credentialRef: 'secret:application-api',
    },
    ...overrides,
  };
}

function enabledLanSync(overrides = {}) {
  return {
    enabled: true,
    port: 4321,
    tlsIdentityRef: 'secret:lan-tls-identity',
    pairingPolicy: { mode: 'explicit-confirmation' },
    allowedSubnetPolicy: { mode: 'private-lan-only' },
    ...overrides,
  };
}

function assertConfigError(input, expectedCode) {
  const { ConfigValidationError, createConfig } = loadConfigModule();
  assert.throws(
    () => createConfig(input),
    error => {
      assert.equal(error instanceof ConfigValidationError, true);
      assert.equal(error.code, expectedCode);
      assert.equal(typeof error.message, 'string');
      assert.equal(error.message.length > 0, true);
      return true;
    }
  );
}

function assertDeepFrozen(value) {
  if (value === null || typeof value !== 'object') return;
  assert.equal(Object.isFrozen(value), true);
  for (const nested of Object.values(value)) assertDeepFrozen(nested);
}

test.after(() => {
  for (const parent of temporaryParents) {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('production configuration normalizes explicit storage and loopback API boundaries', () => {
  const root = makeStorageRoot();
  const { createConfig } = loadConfigModule();

  const config = createConfig({
    mode: 'production',
    storageRoot: root,
    applicationApi: { port: 3210, credentialRef: 'secret:application-api' },
  });

  assert.equal(config.mode, 'production');
  assert.equal(config.storageRoot, resolve(root));
  assert.deepEqual(config.applicationApi, {
    enabled: true,
    host: '127.0.0.1',
    port: 3210,
    allowEphemeralPort: false,
    credentialRef: 'secret:application-api',
  });
  assert.deepEqual(config.scheduler, { enabled: true });
  assert.deepEqual(config.lanSync, {
    enabled: false,
    port: null,
    tlsIdentityRef: null,
    pairingPolicy: null,
    allowedSubnetPolicy: null,
  });
  assert.deepEqual(config.paths, {
    database: join(root, 'database', 'easy-rewind.sqlite3'),
    settings: join(root, 'settings', 'settings.json'),
    runtimeState: join(root, 'runtime', 'state.json'),
    logs: join(root, 'logs'),
    exports: join(root, 'exports'),
    backups: join(root, 'backups'),
    migrationWork: join(root, 'migration-work'),
  });
  for (const path of Object.values(config.paths)) assert.equal(isAbsolute(path), true);
});

test('standalone configuration permits port zero only through an explicit development flag', () => {
  const { createConfig } = loadConfigModule();
  const config = createConfig({
    mode: 'standalone',
    storageRoot: makeStorageRoot(),
    applicationApi: {
      enabled: true,
      host: '::1',
      port: 0,
      allowEphemeralPort: true,
      credentialRef: 'secret:application-api',
    },
  });

  assert.equal(config.mode, 'standalone');
  assert.equal(config.applicationApi.host, '::1');
  assert.equal(config.applicationApi.port, 0);
  assert.equal(config.applicationApi.allowEphemeralPort, true);
  assert.equal(config.applicationApi.enabled, true);
  assert.equal(config.scheduler.enabled, true);
});

test('test configuration requires an external temporary root and disables active runtime components', () => {
  const root = makeStorageRoot();
  const { createConfig } = loadConfigModule();
  const config = createConfig({ mode: 'test', storageRoot: root });

  assert.equal(config.mode, 'test');
  assert.equal(config.storageRoot, resolve(root));
  assert.deepEqual(config.applicationApi, {
    enabled: false,
    host: '127.0.0.1',
    port: 0,
    allowEphemeralPort: false,
    credentialRef: null,
  });
  assert.deepEqual(config.scheduler, { enabled: false });
  assert.equal(config.lanSync.enabled, false);
});

test('missing storage roots are rejected', () => {
  assertConfigError({ mode: 'production', applicationApi: { port: 3210 } }, 'CONFIG_STORAGE_ROOT_REQUIRED');
});

test('relative storage roots and path overrides are rejected', async t => {
  await t.test('relative storage root', () => {
    assertConfigError(
      { mode: 'production', storageRoot: 'runtime', applicationApi: { port: 3210 } },
      'CONFIG_STORAGE_ROOT_ABSOLUTE'
    );
  });
  await t.test('relative path override', () => {
    assertConfigError(productionInput({ paths: { logs: join('relative', 'logs') } }), 'CONFIG_PATH_ABSOLUTE');
  });
});

test('application API accepts only unambiguous bindable loopback literals', async t => {
  for (const host of [
    '0.0.0.0',
    '192.168.1.10',
    'localhost',
    '127.0.0.2',
    '127.000.000.001',
    '2130706433',
    '::',
    '::ffff:127.0.0.1',
    '[::1]',
  ]) {
    await t.test(host, () => {
      assertConfigError(
        productionInput({ applicationApi: { enabled: true, host, port: 3210 } }),
        'CONFIG_APPLICATION_HOST_LOOPBACK'
      );
    });
  }
});

test('test mode rejects explicit scheduler or listener enablement', async t => {
  await t.test('scheduler', () => {
    assertConfigError(
      { mode: 'test', storageRoot: makeStorageRoot(), scheduler: { enabled: true } },
      'CONFIG_TEST_SCHEDULER_ENABLED'
    );
  });
  await t.test('application listener', () => {
    assertConfigError(
      {
        mode: 'test',
        storageRoot: makeStorageRoot(),
        applicationApi: { enabled: true, host: '127.0.0.1', port: 0 },
      },
      'CONFIG_TEST_LISTENER_ENABLED'
    );
  });
  await t.test('LAN listener', () => {
    assertConfigError(
      { mode: 'test', storageRoot: makeStorageRoot(), lanSync: enabledLanSync() },
      'CONFIG_TEST_LISTENER_ENABLED'
    );
  });
});

test('test mode rejects omitted, repository-contained, and non-temporary storage roots', async t => {
  await t.test('omitted root', () => {
    assertConfigError({ mode: 'test' }, 'CONFIG_TEST_STORAGE_ROOT_REQUIRED');
  });
  await t.test('repository-contained root', () => {
    assertConfigError(
      { mode: 'test', storageRoot: join(repositoryRoot, 'backend', 'data', 'task-3-test') },
      'CONFIG_TEST_STORAGE_ROOT_EXTERNAL'
    );
  });
  await t.test('repository-external but non-temporary root', () => {
    const volumeRoot = resolve(repositoryRoot, '..', '..', '..', 'easy-rewind-task-3-not-temp');
    assertConfigError({ mode: 'test', storageRoot: volumeRoot, repositoryRoot }, 'CONFIG_TEST_STORAGE_ROOT_TEMPORARY');
  });
});

test('enabled LAN sync requires a port, TLS identity, pairing policy, and allowed-subnet policy', async t => {
  const invalidCases = [
    ['port', { port: undefined }],
    ['TLS identity', { tlsIdentityRef: undefined }],
    ['pairing policy', { pairingPolicy: undefined }],
    ['allowed-subnet policy', { allowedSubnetPolicy: undefined }],
    ['invalid pairing policy', { pairingPolicy: { mode: 'automatic' } }],
    ['invalid allowed-subnet policy', { allowedSubnetPolicy: { mode: 'allow-all' } }],
  ];

  for (const [label, override] of invalidCases) {
    await t.test(label, () => {
      const lanSync = enabledLanSync();
      for (const [key, value] of Object.entries(override)) {
        if (value === undefined) delete lanSync[key];
        else lanSync[key] = value;
      }
      assertConfigError(productionInput({ lanSync }), 'CONFIG_LAN_SYNC_INCOMPLETE');
    });
  }
});

test('enabled LAN sync is normalized as a separate trust boundary', () => {
  const { createConfig } = loadConfigModule();
  const config = createConfig(productionInput({ lanSync: enabledLanSync() }));

  assert.deepEqual(config.lanSync, enabledLanSync());
  assert.notEqual(config.lanSync.pairingPolicy, config.applicationApi);
  assert.notEqual(config.lanSync.allowedSubnetPolicy, config.applicationApi);
});

test('LAN sync rejects loopback application credential or configuration reuse', async t => {
  await t.test('forbidden application credential field', () => {
    assertConfigError(
      productionInput({
        lanSync: enabledLanSync({ applicationApiCredentialRef: 'secret:application-api' }),
      }),
      'CONFIG_LAN_SYNC_BOUNDARY_REUSE'
    );
  });
  await t.test('same protected reference', () => {
    assertConfigError(
      productionInput({
        lanSync: enabledLanSync({ tlsIdentityRef: 'secret:application-api' }),
      }),
      'CONFIG_LAN_SYNC_BOUNDARY_REUSE'
    );
  });
});

test('invalid application and LAN ports are rejected', async t => {
  for (const port of [-1, 0, 65536, 1.5, '3210', Number.NaN]) {
    await t.test(`production application port ${String(port)}`, () => {
      assertConfigError(
        productionInput({ applicationApi: { host: '127.0.0.1', port } }),
        'CONFIG_APPLICATION_PORT_INVALID'
      );
    });
  }
  await t.test('standalone port zero without explicit development flag', () => {
    assertConfigError(
      {
        mode: 'standalone',
        storageRoot: makeStorageRoot(),
        applicationApi: { host: '127.0.0.1', port: 0 },
      },
      'CONFIG_APPLICATION_PORT_INVALID'
    );
  });
  for (const port of [0, -1, 65536, 1.5, '4321']) {
    await t.test(`LAN port ${String(port)}`, () => {
      assertConfigError(productionInput({ lanSync: enabledLanSync({ port }) }), 'CONFIG_LAN_PORT_INVALID');
    });
  }
});

test('absolute storage path overrides cannot escape the storage root', () => {
  const root = makeStorageRoot();
  assertConfigError(
    productionInput({
      storageRoot: root,
      paths: { backups: resolve(root, '..', 'outside-backups') },
    }),
    'CONFIG_PATH_ESCAPE'
  );
});

test('linked storage ancestry is rejected without touching its target', () => {
  const root = makeStorageRoot({ existing: true });
  const external = join(makeTemporaryParent(), 'external');
  const logsLink = join(root, 'logs');
  const marker = join(external, 'marker.txt');
  mkdirSync(external);
  writeFileSync(marker, 'keep');
  symlinkSync(external, logsLink, process.platform === 'win32' ? 'junction' : 'dir');

  try {
    assertConfigError(
      {
        mode: 'production',
        storageRoot: root,
        applicationApi: { port: 3210 },
      },
      'CONFIG_STORAGE_LINKED'
    );
    assert.equal(existsSync(marker), true);
  } finally {
    if (existsSync(logsLink)) unlinkSync(logsLink);
  }
});

test('dangling linked storage ancestry is rejected', () => {
  const root = makeStorageRoot({ existing: true });
  const missingTarget = join(makeTemporaryParent(), 'missing-target');
  const logsLink = join(root, 'logs');
  symlinkSync(missingTarget, logsLink, process.platform === 'win32' ? 'junction' : 'dir');

  try {
    assertConfigError(
      {
        mode: 'production',
        storageRoot: root,
        applicationApi: { port: 3210 },
      },
      'CONFIG_STORAGE_LINKED'
    );
  } finally {
    unlinkSync(logsLink);
  }
});

test('createConfig does not create a storage root or derived directories', () => {
  const root = makeStorageRoot();
  const { createConfig } = loadConfigModule();

  createConfig(productionInput({ storageRoot: root }));

  assert.equal(existsSync(root), false);
});

test('returned configurations are deeply frozen and do not share mutable state', () => {
  const { createConfig } = loadConfigModule();
  const first = createConfig(productionInput({ lanSync: enabledLanSync() }));
  const second = createConfig(productionInput({ lanSync: enabledLanSync() }));

  assertDeepFrozen(first);
  assertDeepFrozen(second);
  assert.notEqual(first, second);
  assert.notEqual(first.paths, second.paths);
  assert.notEqual(first.applicationApi, second.applicationApi);
  assert.notEqual(first.scheduler, second.scheduler);
  assert.notEqual(first.lanSync, second.lanSync);
  assert.notEqual(first.lanSync.pairingPolicy, second.lanSync.pairingPolicy);
  assert.throws(() => {
    first.lanSync.pairingPolicy.mode = 'automatic';
  }, TypeError);
  assert.equal(second.lanSync.pairingPolicy.mode, 'explicit-confirmation');
});

test('configuration errors expose stable safe codes without input values', () => {
  const sensitiveRoot = join(makeTemporaryParent(), 'personal-user-storage');
  const sensitiveReference = 'secret:credential-material-must-not-leak';
  const { createConfig } = loadConfigModule();

  assert.throws(
    () =>
      createConfig(
        productionInput({
          storageRoot: sensitiveRoot,
          lanSync: enabledLanSync({ tlsIdentityRef: sensitiveReference, port: 0 }),
        })
      ),
    error => {
      assert.equal(error.code, 'CONFIG_LAN_PORT_INVALID');
      assert.doesNotMatch(error.message, /personal-user-storage|credential-material-must-not-leak/i);
      assert.equal(Object.hasOwn(error, 'input'), false);
      assert.equal(Object.hasOwn(error, 'details'), false);
      return true;
    }
  );
});

test('importing the configuration module performs no filesystem I/O', () => {
  const script = `
    const fs = require('node:fs');
    for (const name of [
      'accessSync', 'existsSync', 'lstatSync', 'mkdirSync', 'openSync',
      'statSync', 'writeFileSync'
    ]) {
      fs[name] = () => { throw new Error('filesystem I/O during import: ' + name); };
    }
    require(${JSON.stringify(modulePath)});
  `;
  const result = spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    windowsHide: true,
  });

  assert.equal(result.status, 0, 'configuration import must remain inert');
});

test('unique temporary test roots keep cleanup scoped to their parent', () => {
  const parent = makeTemporaryParent();
  const firstRoot = join(parent, 'first-storage');
  const secondRoot = join(parent, 'second-storage');
  const sentinel = join(parent, 'sentinel.txt');
  writeFileSync(sentinel, 'keep');
  const { createConfig } = loadConfigModule();

  const first = createConfig({ mode: 'test', storageRoot: firstRoot });
  const second = createConfig({ mode: 'test', storageRoot: secondRoot });

  assert.notEqual(first.storageRoot, second.storageRoot);
  assert.equal(existsSync(first.storageRoot), false);
  assert.equal(existsSync(second.storageRoot), false);
  assert.equal(existsSync(sentinel), true);
});
