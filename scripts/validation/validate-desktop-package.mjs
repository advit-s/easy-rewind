import { createRequire } from 'node:module';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const require = createRequire(import.meta.url);
const { validateConfiguration } = require('app-builder-lib/out/util/config/config.js');

const expected = Object.freeze({
  appId: 'com.easyrewind.desktop',
  productName: 'Easy Rewind',
  version: '2.0.0',
  electronVersion: '43.2.0',
  nativeVersion: '13.0.1',
  builderVersion: '26.15.3',
});

const requiredFileSets = Object.freeze({
  '.': 'desktop',
  '../backend': 'backend',
  '../frontend': 'frontend',
  '../packages/contracts': 'packages/contracts',
});

const requiredPositiveFilters = Object.freeze({
  '.': ['*.js', '*.html', '*.css', '*.svg', 'assets/**/*'],
  '../backend': ['package.json', 'server.js', 'src/**/*'],
  '../frontend': ['dashboard.html', 'js/**/*', 'styles/**/*'],
  '../packages/contracts': ['package.json', 'src/**/*', 'schema/**/*'],
});

const requiredExclusions = Object.freeze([
  '!**/*.test.*',
  '!**/*.map',
  '!**/*.{db,sqlite,sqlite3}',
  '!**/*.{db,sqlite,sqlite3}-{wal,shm,journal}',
  '!**/*-{wal,shm,journal}',
  '!**/*{settings,secrets,credentials}*.json',
  '!**/.env{,.*}',
  '!**/*.{log,pem,key}',
  '!**/{test,tests,__tests__,coverage,dist,build,.cache,.npm,.yarn,.pnpm-store,legacy-backup,quarantine,migration-work,logs,exports,tmp,temp}/**/*',
]);

const runtimeFiles = Object.freeze([
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
  'backend/package.json',
  'backend/server.js',
  'backend/src',
  'frontend/dashboard.html',
  'frontend/js',
  'frontend/styles',
  'packages/contracts/package.json',
  'packages/contracts/src',
  'packages/contracts/schema',
]);

class DesktopPackageValidationError extends Error {}

function fail() {
  throw new DesktopPackageValidationError('Desktop package validation failed.');
}

function readJson(path) {
  let value;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    fail();
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail();
  return value;
}

function assertRegularPath(path, type = 'either') {
  let metadata;
  try {
    metadata = lstatSync(path);
  } catch {
    fail();
  }
  if (metadata.isSymbolicLink()) fail();
  if (
    (type === 'file' && !metadata.isFile()) ||
    (type === 'directory' && !metadata.isDirectory()) ||
    (type === 'either' && !metadata.isFile() && !metadata.isDirectory())
  ) {
    fail();
  }
}

function normalizedRepositoryRoot(repositoryRoot) {
  if (typeof repositoryRoot !== 'string' || !isAbsolute(repositoryRoot) || resolve(repositoryRoot) !== repositoryRoot) {
    fail();
  }
  let canonical;
  try {
    canonical = realpathSync.native(repositoryRoot);
  } catch {
    fail();
  }
  if (resolve(canonical) !== canonical) fail();
  return canonical;
}

function validateVersions(rootManifest, desktopManifest, backendManifest) {
  if (
    rootManifest.name !== 'easy-rewind' ||
    rootManifest.version !== expected.version ||
    desktopManifest.name !== 'easy-rewind-desktop' ||
    desktopManifest.version !== expected.version ||
    desktopManifest.productName !== expected.productName ||
    desktopManifest.main !== 'bootstrap.js' ||
    desktopManifest.devDependencies?.electron !== expected.electronVersion ||
    desktopManifest.devDependencies?.['electron-builder'] !== expected.builderVersion ||
    desktopManifest.dependencies?.['better-sqlite3'] !== expected.nativeVersion ||
    backendManifest.dependencies?.['better-sqlite3'] !== expected.nativeVersion
  ) {
    fail();
  }

  const backendDependencies = Object.entries(backendManifest.dependencies ?? {}).sort();
  const desktopDependencies = Object.entries(desktopManifest.dependencies ?? {}).sort();
  if (JSON.stringify(backendDependencies) !== JSON.stringify(desktopDependencies)) fail();
}

function validateDesktopLockfile(lockfile, desktopManifest) {
  const lockedDesktop = lockfile.packages?.desktop;
  const comparableEntries = value => Object.entries(value ?? {}).sort();
  if (
    lockfile.name !== 'easy-rewind' ||
    lockfile.version !== expected.version ||
    lockfile.lockfileVersion !== 3 ||
    lockedDesktop?.name !== desktopManifest.name ||
    lockedDesktop?.version !== desktopManifest.version ||
    JSON.stringify(comparableEntries(lockedDesktop.dependencies)) !==
      JSON.stringify(comparableEntries(desktopManifest.dependencies)) ||
    JSON.stringify(comparableEntries(lockedDesktop.devDependencies)) !==
      JSON.stringify(comparableEntries(desktopManifest.devDependencies))
  ) {
    fail();
  }
}

function validateScripts(rootManifest, desktopManifest) {
  if (
    rootManifest.scripts?.['test:desktop-package'] !==
      'node --test scripts/validation/validate-desktop-package.test.mjs' ||
    rootManifest.scripts?.['validate:desktop-package'] !== 'node scripts/validation/validate-desktop-package.mjs' ||
    rootManifest.scripts?.['validate:native'] !== 'npm --workspace desktop run validate:native' ||
    desktopManifest.scripts?.['validate:native'] !==
      'npm run install:electron && node ../scripts/build/rebuild-electron-native.mjs --validate-only' ||
    desktopManifest.scripts?.['validate:package'] !== 'node ../scripts/validation/validate-desktop-package.mjs' ||
    desktopManifest.scripts?.build !==
      'npm run validate:package && npm run rebuild:native && electron-builder --win --config build.config.json'
  ) {
    fail();
  }
}

function validateFileSets(configuration, repositoryRoot) {
  if (!Array.isArray(configuration.files) || configuration.files.length !== 5) fail();
  const manifestFileSets = configuration.files.filter(
    fileSet =>
      fileSet?.from === '.' &&
      fileSet?.to === '.' &&
      Array.isArray(fileSet.filter) &&
      fileSet.filter.length === 1 &&
      fileSet.filter[0] === 'package.json'
  );
  if (manifestFileSets.length !== 1) {
    fail();
  }
  assertRegularPath(resolve(repositoryRoot, 'desktop', 'package.json'), 'file');

  const seenSources = new Set();

  for (const fileSet of configuration.files.filter(fileSet => fileSet !== manifestFileSets[0])) {
    if (
      fileSet === null ||
      typeof fileSet !== 'object' ||
      Array.isArray(fileSet) ||
      typeof fileSet.from !== 'string' ||
      typeof fileSet.to !== 'string' ||
      !Array.isArray(fileSet.filter) ||
      fileSet.filter.some(pattern => typeof pattern !== 'string')
    ) {
      fail();
    }
    if (
      seenSources.has(fileSet.from) ||
      requiredFileSets[fileSet.from] !== fileSet.to ||
      fileSet.filter.includes('**/*') ||
      fileSet.filter.some(
        pattern => pattern.includes('\\') || isAbsolute(pattern) || pattern === '..' || pattern.startsWith('../')
      )
    ) {
      fail();
    }
    seenSources.add(fileSet.from);

    for (const pattern of requiredPositiveFilters[fileSet.from] ?? []) {
      if (!fileSet.filter.includes(pattern)) fail();
    }
    for (const exclusion of requiredExclusions) {
      if (!fileSet.filter.includes(exclusion)) fail();
    }

    const sourceRoot = resolve(repositoryRoot, 'desktop', fileSet.from);
    assertRegularPath(sourceRoot, 'directory');
  }

  if (
    seenSources.size !== Object.keys(requiredFileSets).length ||
    Object.keys(requiredFileSets).some(source => !seenSources.has(source))
  ) {
    fail();
  }
}

function validateArchiveAndTargets(configuration) {
  if (
    configuration.appId !== expected.appId ||
    configuration.productName !== expected.productName ||
    configuration.asar !== true ||
    configuration.directories?.output !== '../dist' ||
    configuration.directories?.buildResources !== '.' ||
    configuration.extraMetadata?.main !== 'desktop/bootstrap.js' ||
    configuration.extraMetadata?.productName !== expected.productName
  ) {
    fail();
  }

  const unpackPatterns = configuration.asarUnpack;
  if (
    !Array.isArray(unpackPatterns) ||
    unpackPatterns.length !== 2 ||
    !unpackPatterns.includes('node_modules/better-sqlite3/**/*') ||
    !unpackPatterns.includes('node_modules/**/*.node')
  ) {
    fail();
  }

  if (
    !Array.isArray(configuration.win?.target) ||
    JSON.stringify([...configuration.win.target].sort()) !== JSON.stringify(['nsis', 'portable']) ||
    configuration.nsis?.artifactName !== 'Easy-Rewind-UNSIGNED-Setup-${version}-${arch}.${ext}' ||
    configuration.nsis?.oneClick !== false ||
    configuration.nsis?.allowToChangeInstallationDirectory !== true ||
    configuration.nsis?.perMachine !== false ||
    configuration.portable?.artifactName !== 'Easy-Rewind-UNSIGNED-Portable-${version}-${arch}.${ext}' ||
    configuration.portable?.requestExecutionLevel !== 'user'
  ) {
    fail();
  }

  for (const hook of [
    'afterAllArtifactBuild',
    'afterPack',
    'afterSign',
    'artifactBuildCompleted',
    'artifactBuildStarted',
    'beforeBuild',
    'beforePack',
  ]) {
    if (configuration[hook] !== undefined) fail();
  }
}

function validateConfiguredPaths(configuration, repositoryRoot) {
  const desktopRoot = join(repositoryRoot, 'desktop');
  const paths = [
    configuration.win?.icon,
    configuration.nsis?.installerIcon,
    configuration.nsis?.uninstallerIcon,
    configuration.nsis?.installerHeader,
    configuration.nsis?.installerSidebar,
    configuration.nsis?.uninstallerSidebar,
    configuration.portable?.splashImage,
  ].filter(value => value !== undefined && value !== null);

  for (const configuredPath of paths) {
    if (
      typeof configuredPath !== 'string' ||
      configuredPath.trim() !== configuredPath ||
      configuredPath.length === 0 ||
      isAbsolute(configuredPath) ||
      configuredPath.split(/[\\/]/u).includes('..')
    ) {
      fail();
    }
    assertRegularPath(resolve(desktopRoot, configuredPath), 'file');
  }
}

export function containsForbiddenSystemNodeSpawn(source) {
  if (typeof source !== 'string') return true;
  return (
    /(?:spawn|spawnSync|execFile|execFileSync)\s*\(\s*(?:process\.execPath|['"`][^'"`]*(?:^|[\\/])?node(?:\.exe)?(?:\s|['"`]))/iu.test(
      source
    ) || /(?:exec|execSync)\s*\(\s*['"`]\s*(?:[^'"`]*[\\/])?node(?:\.exe)?(?:\s|['"`])/iu.test(source)
  );
}

function scanDesktopRuntime(repositoryRoot) {
  const desktopRoot = join(repositoryRoot, 'desktop');
  const pending = [desktopRoot];
  while (pending.length > 0) {
    const directory = pending.pop();
    assertRegularPath(directory, 'directory');
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const metadata = lstatSync(path);
      if (metadata.isSymbolicLink()) fail();
      if (metadata.isDirectory()) {
        if (['dist', 'build', 'node_modules'].includes(entry.name)) fail();
        pending.push(path);
      } else if (metadata.isFile() && entry.name.endsWith('.js') && !entry.name.includes('.test.')) {
        if (containsForbiddenSystemNodeSpawn(readFileSync(path, 'utf8'))) fail();
      } else if (!metadata.isFile()) {
        fail();
      }
    }
  }
}

function validatePackagedResourceLayout(repositoryRoot) {
  const source = readFileSync(join(repositoryRoot, 'desktop', 'resource-paths.js'), 'utf8');
  if (
    !/path\.join\(\s*processLike\.resourcesPath\s*,\s*['"]app\.asar['"]\s*\)/u.test(source) ||
    !/path\.join\(\s*resourceRoot\s*,\s*['"]backend['"]\s*\)/u.test(source) ||
    !/path\.join\(\s*resourceRoot\s*,\s*['"]frontend['"]\s*\)/u.test(source) ||
    !/path\.join\(\s*resourceRoot\s*,\s*['"]desktop['"]\s*\)/u.test(source) ||
    /path\.join\(\s*processLike\.resourcesPath\s*,\s*['"](?:backend|frontend|desktop)['"]/u.test(source)
  ) {
    fail();
  }
}

function validateRuntimeStorageBoundary(repositoryRoot) {
  const mainSource = readFileSync(join(repositoryRoot, 'desktop', 'main.js'), 'utf8');
  const adapterSource = readFileSync(join(repositoryRoot, 'desktop', 'windows-platform-adapters.js'), 'utf8');
  if (
    !/localAppData:\s*processLike\.env\?\.LOCALAPPDATA/u.test(mainSource) ||
    !/resolve\(\s*localAppData\s*,\s*['"]easy-rewind['"]\s*,\s*['"]runtime['"]\s*\)/u.test(adapterSource) ||
    /getPath\(\s*['"]userData['"]\s*\)/u.test(`${mainSource}\n${adapterSource}`)
  ) {
    fail();
  }
}

export async function validateDesktopPackage({ repositoryRoot } = {}) {
  const root = normalizedRepositoryRoot(repositoryRoot);
  const configuration = readJson(join(root, 'desktop', 'build.config.json'));
  const rootManifest = readJson(join(root, 'package.json'));
  const desktopManifest = readJson(join(root, 'desktop', 'package.json'));
  const backendManifest = readJson(join(root, 'backend', 'package.json'));
  const lockfile = readJson(join(root, 'package-lock.json'));

  try {
    await validateConfiguration(configuration, { add() {} });
  } catch {
    fail();
  }

  validateVersions(rootManifest, desktopManifest, backendManifest);
  validateDesktopLockfile(lockfile, desktopManifest);
  validateScripts(rootManifest, desktopManifest);
  validateFileSets(configuration, root);
  validateArchiveAndTargets(configuration);
  validateConfiguredPaths(configuration, root);
  for (const path of runtimeFiles) assertRegularPath(join(root, ...path.split('/')));
  validatePackagedResourceLayout(root);
  validateRuntimeStorageBoundary(root);
  scanDesktopRuntime(root);

  return Object.freeze({
    targets: Object.freeze([...configuration.win.target]),
    electronVersion: expected.electronVersion,
    nativeVersion: expected.nativeVersion,
    productName: expected.productName,
  });
}

async function main() {
  try {
    if (process.argv.length !== 2) fail();
    const repositoryRoot = resolve(import.meta.dirname, '..', '..');
    const result = await validateDesktopPackage({ repositoryRoot });
    process.stdout.write(
      `Desktop package validation passed (${result.productName}, Electron ${result.electronVersion}, better-sqlite3 ${result.nativeVersion}, NSIS + portable).\n`
    );
  } catch {
    process.stderr.write('Desktop package validation failed.\n');
    process.exitCode = 1;
  }
}

if (resolve(process.argv[1] ?? '') === resolve(fileURLToPath(import.meta.url))) {
  await main();
}
