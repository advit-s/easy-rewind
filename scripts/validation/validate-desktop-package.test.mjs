import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { containsForbiddenSystemNodeSpawn, validateDesktopPackage } from './validate-desktop-package.mjs';

const repositoryRoot = resolve(import.meta.dirname, '..', '..');

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function fixture(mutator = () => {}) {
  const root = mkdtempSync(join(tmpdir(), 'easy-rewind-desktop-package-fixture-'));
  const config = JSON.parse(readFileSync(join(repositoryRoot, 'desktop', 'build.config.json'), 'utf8'));
  const rootManifest = JSON.parse(readFileSync(join(repositoryRoot, 'package.json'), 'utf8'));
  const desktopManifest = JSON.parse(readFileSync(join(repositoryRoot, 'desktop', 'package.json'), 'utf8'));
  mutator({ config, rootManifest, desktopManifest });
  writeJson(join(root, 'desktop', 'build.config.json'), config);
  writeJson(join(root, 'desktop', 'package.json'), desktopManifest);
  writeJson(join(root, 'package.json'), rootManifest);
  writeJson(join(root, 'package-lock.json'), {
    name: 'easy-rewind',
    version: '2.0.0',
    lockfileVersion: 3,
    packages: {
      desktop: {
        name: desktopManifest.name,
        version: desktopManifest.version,
        dependencies: { ...desktopManifest.dependencies },
        devDependencies: { ...desktopManifest.devDependencies },
      },
    },
  });
  writeJson(join(root, 'backend', 'package.json'), {
    name: 'easy-rewind-backend',
    version: '2.0.0',
    dependencies: { ...desktopManifest.dependencies },
  });
  writeJson(join(root, 'packages', 'contracts', 'package.json'), {
    name: '@easy-rewind/contracts',
    version: '2.0.0',
  });

  for (const relativePath of [
    'desktop/bootstrap.js',
    'desktop/main.js',
    'desktop/backend-lifecycle.js',
    'desktop/preload.js',
    'desktop/overlay.js',
    'desktop/overlay.html',
    'desktop/overlay.css',
    'desktop/main-process-controller.js',
    'desktop/resource-paths.js',
    'desktop/local-api-client.js',
    'desktop/windows-platform-adapters.js',
    'desktop/tray-icon.svg',
    'desktop/assets/icon.ico',
    'desktop/assets/icon.png',
    'desktop/assets/tray-icon.png',
    'backend/server.js',
    'backend/src/runtime.js',
    'frontend/dashboard.html',
    'frontend/js/dashboard.js',
    'frontend/styles/dashboard.css',
    'packages/contracts/src/index.js',
    'packages/contracts/schema/health.json',
  ]) {
    const path = join(root, relativePath);
    mkdirSync(dirname(path), { recursive: true });
    if (!path.endsWith('.json')) writeFileSync(path, path.endsWith('.svg') ? '<svg></svg>' : '');
  }
  writeFileSync(
    join(root, 'desktop', 'resource-paths.js'),
    `const resourceRoot = path.join(processLike.resourcesPath, 'app.asar');
const backendModuleRoot = path.join(resourceRoot, 'backend');
const dashboardDirectory = path.join(resourceRoot, 'frontend');
const desktopRoot = path.join(resourceRoot, 'desktop');
`
  );
  writeFileSync(
    join(root, 'desktop', 'main.js'),
    `createWindowsPlatformAdapters({ localAppData: processLike.env?.LOCALAPPDATA });`
  );
  writeFileSync(
    join(root, 'desktop', 'windows-platform-adapters.js'),
    `const storageRoot = resolve(localAppData, 'easy-rewind', 'runtime');`
  );
  return root;
}

test('the checked-in desktop package configuration passes the frozen validation contract', async () => {
  const result = await validateDesktopPackage({ repositoryRoot });

  assert.deepEqual(result.targets, ['nsis', 'portable']);
  assert.equal(result.electronVersion, '43.2.0');
  assert.equal(result.nativeVersion, '13.0.1');
  assert.equal(result.productName, 'Easy Rewind');
});

test('the application manifest is mapped to the ASAR root', () => {
  const configuration = JSON.parse(readFileSync(join(repositoryRoot, 'desktop', 'build.config.json'), 'utf8'));
  assert.ok(
    configuration.files.some(
      fileSet =>
        fileSet?.from === '.' &&
        fileSet.to === '.' &&
        JSON.stringify(fileSet.filter) === JSON.stringify(['package.json'])
    )
  );
});

test('validation rejects omission of every shared runtime source tree', async t => {
  for (const source of ['../backend', '../frontend', '../packages/contracts']) {
    await t.test(source, async () => {
      const root = fixture(({ config }) => {
        config.files = config.files.filter(fileSet => fileSet.from !== source);
      });
      try {
        await assert.rejects(() => validateDesktopPackage({ repositoryRoot: root }));
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

test('validation rejects permissive source globs and missing sensitive artifact exclusions', async () => {
  const root = fixture(({ config }) => {
    config.files[0].filter = ['**/*'];
  });
  try {
    await assert.rejects(() => validateDesktopPackage({ repositoryRoot: root }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('validation requires wildcard exclusion for every legacy settings JSON name', async () => {
  const root = fixture(({ config }) => {
    for (const fileSet of config.files) {
      if (!Array.isArray(fileSet.filter)) continue;
      fileSet.filter = fileSet.filter.map(pattern =>
        pattern === '!**/*{settings,secrets,credentials}*.json' ? '!**/{settings,secrets,credentials}.json' : pattern
      );
    }
  });
  try {
    await assert.rejects(() => validateDesktopPackage({ repositoryRoot: root }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('validation keeps production node_modules eligible while excluding only node caches', async () => {
  const root = fixture(({ config }) => {
    for (const fileSet of config.files) {
      if (!Array.isArray(fileSet.filter)) continue;
      fileSet.filter = fileSet.filter.map(pattern =>
        pattern.includes('.pnpm-store,legacy-backup')
          ? pattern.replace('.pnpm-store,legacy-backup', '.pnpm-store,node_modules,legacy-backup')
          : pattern
      );
    }
  });
  try {
    await assert.rejects(() => validateDesktopPackage({ repositoryRoot: root }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('validation requires native modules to remain outside the ASAR archive', async () => {
  const root = fixture(({ config }) => {
    config.asarUnpack = config.asarUnpack.filter(pattern => !pattern.includes('better-sqlite3'));
  });
  try {
    await assert.rejects(() => validateDesktopPackage({ repositoryRoot: root }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('validation rejects a packaged resource resolver that diverges from the ASAR layout', async () => {
  const root = fixture();
  writeFileSync(join(root, 'desktop', 'resource-paths.js'), `path.join(processLike.resourcesPath, 'backend');`);
  try {
    await assert.rejects(() => validateDesktopPackage({ repositoryRoot: root }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('validation freezes protected runtime storage under LOCALAPPDATA easy-rewind runtime', async () => {
  const root = fixture();
  writeFileSync(
    join(root, 'desktop', 'windows-platform-adapters.js'),
    `const storageRoot = electronApp.getPath('userData');`
  );
  try {
    await assert.rejects(() => validateDesktopPackage({ repositoryRoot: root }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('validation rejects unsigned Windows artifacts without an explicit non-release marker', async () => {
  const root = fixture(({ config }) => {
    config.nsis.artifactName = 'Easy-Rewind-Setup-${version}-${arch}.${ext}';
    config.portable.artifactName = 'Easy-Rewind-Portable-${version}-${arch}.${ext}';
  });
  try {
    await assert.rejects(() => validateDesktopPackage({ repositoryRoot: root }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('validation rejects version drift and incomplete Windows target configuration', async t => {
  await t.test('Electron version drift', async () => {
    const root = fixture(({ desktopManifest }) => {
      desktopManifest.devDependencies.electron = '43.2.1';
    });
    try {
      await assert.rejects(() => validateDesktopPackage({ repositoryRoot: root }));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test('better-sqlite3 version drift', async () => {
    const root = fixture(({ desktopManifest }) => {
      desktopManifest.dependencies['better-sqlite3'] = '13.0.0';
    });
    try {
      await assert.rejects(() => validateDesktopPackage({ repositoryRoot: root }));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test('missing portable target', async () => {
    const root = fixture(({ config }) => {
      config.win.target = ['nsis'];
    });
    try {
      await assert.rejects(() => validateDesktopPackage({ repositoryRoot: root }));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test('validation rejects desktop dependency metadata drift in the lockfile', async () => {
  const root = fixture();
  const lockPath = join(root, 'package-lock.json');
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  delete lock.packages.desktop.dependencies['better-sqlite3'];
  writeJson(lockPath, lock);

  try {
    await assert.rejects(() => validateDesktopPackage({ repositoryRoot: root }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('electron-builder schema validation rejects invalid target options', async () => {
  const root = fixture(({ config }) => {
    config.portable.unexpectedOption = true;
  });
  try {
    await assert.rejects(() => validateDesktopPackage({ repositoryRoot: root }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('validation rejects configured resource and icon paths that do not exist', async () => {
  const root = fixture(({ config }) => {
    config.win.icon = 'missing-icon.ico';
  });
  try {
    await assert.rejects(() => validateDesktopPackage({ repositoryRoot: root }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('system Node process launch patterns are rejected without flagging Electron runtime checks', () => {
  assert.equal(containsForbiddenSystemNodeSpawn(`spawn('node', ['server.js'])`), true);
  assert.equal(containsForbiddenSystemNodeSpawn(`execFile('C:\\\\Program Files\\\\nodejs\\\\node.exe')`), true);
  assert.equal(containsForbiddenSystemNodeSpawn(`spawn(process.execPath, ['server.js'])`), true);
  assert.equal(containsForbiddenSystemNodeSpawn(`require('electron')`), false);
});
