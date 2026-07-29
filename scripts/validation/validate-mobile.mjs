import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import process from 'node:process';

const REQUIRED_FILES = Object.freeze([
  'app.json',
  'package.json',
  'tsconfig.json',
  'babel.config.js',
  'metro.config.js',
  'app/_layout.tsx',
  'app/index.tsx',
  'app/(tabs)/_layout.tsx',
  'app/(tabs)/index.tsx',
  'app/(tabs)/search.tsx',
  'app/(tabs)/reminders.tsx',
  'app/(tabs)/review.tsx',
  'app/capture.tsx',
  'app/item/[id].tsx',
  'app/conflicts.tsx',
  'app/settings.tsx',
  'src/db/migrations.ts',
  'src/db/open-database.ts',
  'src/db/repository.ts',
  'src/db/schema.ts',
  'src/domain/content-service.ts',
  'src/domain/reminder-service.ts',
  'src/domain/flashcard-service.ts',
  'src/pairing/pairing-service.ts',
  'src/pairing/qr-payload.ts',
  'src/pairing/tls-pin.ts',
  'src/sync/protocol.ts',
  'src/sync/replay.ts',
  'src/sync/sync-coordinator.ts',
  'src/sync/sync-triggers.ts',
  'src/platform/ports.ts',
  'src/platform/expo-network-status.ts',
  'src/platform/expo-secure-store.ts',
  'src/platform/expo-sqlite.ts',
  'src/platform/expo-background-scheduler.ts',
  'src/platform/expo-notifications.ts',
  'src/runtime/mobile-runtime-core.ts',
  'src/runtime/mobile-runtime.ts',
  'src/ui/sync-status.ts',
  'test/import-safety.test.mjs',
  'test/migrations.test.mjs',
  'test/offline-domain.test.mjs',
  'test/pairing.test.mjs',
  'test/sync-replay.test.mjs',
  'test/background-sync.test.mjs',
  'test/platform-adapters.test.mjs',
  'test/runtime-ui-binding.test.mjs',
  'test/ui-states.test.mjs',
  'test/notifications.test.mjs',
]);

const REQUIRED_DEPENDENCIES = Object.freeze({
  expo: '~57.0.0',
  'expo-background-task': '~57.0.6',
  'expo-constants': '~57.0.0',
  'expo-crypto': '~57.0.1',
  'expo-linking': '~57.0.3',
  'expo-network': '~57.0.1',
  'expo-notifications': '~57.0.7',
  'expo-router': '~57.0.7',
  'expo-secure-store': '~57.0.1',
  'expo-sqlite': '~57.0.1',
  'expo-status-bar': '~57.0.1',
  'expo-task-manager': '~57.0.6',
  react: '19.2.8',
  'react-native': '0.86.0',
  'react-native-safe-area-context': '~5.7.0',
  'react-native-screens': '~4.26.0',
});

const REQUIRED_PLUGINS = Object.freeze(['expo-router', 'expo-notifications', 'expo-secure-store', 'expo-sqlite']);
const FORBIDDEN_DIRECTORY_NAMES = new Set([
  '.expo',
  '.gradle',
  'android',
  'artifacts',
  'build',
  'coverage',
  'dist',
  'out',
  'release',
  'test-results',
]);
const TEXT_EXTENSIONS = new Set(['.js', '.json', '.mjs', '.ts', '.tsx']);
const SENSITIVE_FILE_PATTERN =
  /(?:^|\/)(?:\.env(?:\..+)?|\.npmrc|credentials\.json|secrets\.json|settings\.json)$|(?:\.(?:key|p12|pfx|pem))$/i;
const DATABASE_FILE_PATTERN = /\.(?:db|sqlite)(?:-(?:wal|shm))?$/i;
const BUILD_FILE_PATTERN = /\.(?:aab|apk|apks|bundle|map)$/i;
const CREDENTIAL_MATERIAL_PATTERN =
  /(?:AIza[0-9A-Za-z_-]{35}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|Bearer\s+[A-Za-z0-9._~+/=-]{24,})/;

function parseArguments(argv) {
  let mobileRoot = resolve(import.meta.dirname, '..', '..', 'mobile');
  if (argv.length === 0) return { mobileRoot };
  if (argv.length !== 2 || argv[0] !== '--mobile-root' || !argv[1] || argv[1].startsWith('--')) {
    throw new Error('Mobile validation arguments are invalid.');
  }
  mobileRoot = resolve(argv[1]);
  return { mobileRoot };
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function repositoryPath(root, target) {
  return relative(root, target).split(sep).join('/');
}

function isContained(root, target) {
  const fromRoot = relative(root, target);
  return fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot);
}

function readJson(path, label) {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    if (!isPlainObject(value)) throw new Error();
    return value;
  } catch {
    throw new Error(`${label} must contain one valid JSON object.`);
  }
}

function collectMobileFiles(root, failures) {
  const files = [];

  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (directory === root && entry.name === 'node_modules') continue;
      const absolutePath = join(directory, entry.name);
      const relativePath = repositoryPath(root, absolutePath);
      const metadata = lstatSync(absolutePath);
      if (entry.isSymbolicLink() || metadata.isSymbolicLink()) {
        failures.push(`${relativePath}: symbolic or reparse links are forbidden`);
        continue;
      }
      if (entry.isDirectory()) {
        if (FORBIDDEN_DIRECTORY_NAMES.has(entry.name.toLowerCase())) {
          failures.push(`${relativePath}: generated or build directory is forbidden`);
          continue;
        }
        visit(absolutePath);
      } else if (entry.isFile()) {
        files.push(relativePath);
      } else {
        failures.push(`${relativePath}: unsupported filesystem entry`);
      }
    }
  }

  visit(root);
  return files.sort();
}

function validateFiles(root, canonicalRoot, files, failures) {
  const observed = new Set(files);
  for (const required of REQUIRED_FILES) {
    if (!observed.has(required)) failures.push(`${required}: required Android source file is missing`);
  }

  for (const relativePath of files) {
    const absolutePath = resolve(root, relativePath);
    if (!isContained(root, absolutePath) || !isContained(canonicalRoot, realpathSync.native(absolutePath))) {
      failures.push(`${relativePath}: resolved path leaves the mobile source root`);
      continue;
    }
    if (SENSITIVE_FILE_PATTERN.test(relativePath)) {
      failures.push(`${relativePath}: secret-bearing configuration file is forbidden`);
    }
    if (DATABASE_FILE_PATTERN.test(relativePath)) {
      failures.push(`${relativePath}: runtime database or SQLite sidecar is forbidden`);
    }
    if (BUILD_FILE_PATTERN.test(relativePath)) {
      failures.push(`${relativePath}: generated build artifact is forbidden`);
    }
    if (!TEXT_EXTENSIONS.has(extname(relativePath).toLowerCase())) continue;
    const content = readFileSync(absolutePath, 'utf8');
    if (CREDENTIAL_MATERIAL_PATTERN.test(content)) {
      failures.push(`${relativePath}: credential material is forbidden`);
    }
  }
}

function pluginName(plugin) {
  if (typeof plugin === 'string') return plugin;
  return Array.isArray(plugin) && typeof plugin[0] === 'string' ? plugin[0] : null;
}

function validateExpoConfig(config, failures) {
  const expo = config.expo;
  if (!isPlainObject(expo)) {
    failures.push('app.json: expo configuration is missing');
    return;
  }
  if (!Array.isArray(expo.platforms) || expo.platforms.length !== 1 || expo.platforms[0] !== 'android') {
    failures.push('app.json: platforms must contain only android');
  }
  if ('ios' in expo || 'web' in expo) {
    failures.push('app.json: iOS and web configuration are unsupported for this release');
  }
  if (!isPlainObject(expo.android)) {
    failures.push('app.json: android configuration is missing');
  } else {
    if (
      typeof expo.android.package !== 'string' ||
      !/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*){2,}$/.test(expo.android.package)
    ) {
      failures.push('app.json: android.package is invalid');
    }
    if (!Number.isSafeInteger(expo.android.versionCode) || expo.android.versionCode < 1) {
      failures.push('app.json: android.versionCode must be a positive integer');
    }
  }
  if (expo.newArchEnabled !== true) {
    failures.push('app.json: the Android new architecture must remain enabled');
  }

  const plugins = Array.isArray(expo.plugins) ? expo.plugins.map(pluginName) : [];
  if (plugins.some(name => name === null) || new Set(plugins).size !== plugins.length) {
    failures.push('app.json: plugins must have unique valid names');
  }
  for (const required of REQUIRED_PLUGINS) {
    if (!plugins.includes(required)) failures.push(`app.json: required plugin ${required} is missing`);
  }
}

function validateMobilePackage(manifest, config, files, root, failures) {
  if (manifest.name !== '@easy-rewind/mobile' || manifest.private !== true || manifest.type !== 'module') {
    failures.push('mobile/package.json: workspace identity must remain private ESM @easy-rewind/mobile');
  }
  if (manifest.main !== 'expo-router/entry') {
    failures.push('mobile/package.json: Expo Router must remain the application entry');
  }
  if (!isPlainObject(manifest.dependencies)) {
    failures.push('mobile/package.json: dependencies object is missing');
    return;
  }
  for (const [name, expected] of Object.entries(REQUIRED_DEPENDENCIES)) {
    if (manifest.dependencies[name] !== expected) {
      failures.push(`mobile/package.json: ${name} must use ${expected}`);
    }
  }

  const scripts = isPlainObject(manifest.scripts) ? manifest.scripts : {};
  for (const [name, command] of Object.entries(scripts)) {
    if (
      /(?:^|:)(?:ios|web)(?:$|:)/i.test(name) ||
      (typeof command === 'string' && /(?:--platform[ =](?:ios|web)|--(?:ios|web)\b)/i.test(command))
    ) {
      failures.push(`mobile/package.json: unsupported ${name} script is forbidden`);
    }
  }

  const declared = new Set([
    ...Object.keys(manifest.dependencies),
    ...Object.keys(isPlainObject(manifest.devDependencies) ? manifest.devDependencies : {}),
  ]);
  const requiredByConfig = (config.expo?.plugins ?? []).map(pluginName).filter(Boolean);
  const requiredBySource = new Set();
  const modulePattern =
    /(?:\b(?:import|export)\s+(?:[^'"]*?\s+from\s*)?|\bimport\s*\()\s*['"]([^'"]+)['"]|loadModule\(\s*['"]([^'"]+)['"]/g;
  for (const relativePath of files) {
    if (!/\.(?:ts|tsx)$/.test(relativePath) || relativePath.startsWith('test/')) continue;
    const content = readFileSync(join(root, relativePath), 'utf8');
    for (const match of content.matchAll(modulePattern)) {
      const specifier = match[1] ?? match[2];
      if (
        specifier &&
        !specifier.startsWith('.') &&
        (specifier === 'react' || specifier === 'react-native' || specifier.startsWith('expo-'))
      ) {
        requiredBySource.add(specifier);
      }
    }
  }
  for (const required of [...requiredByConfig, ...requiredBySource]) {
    if (!declared.has(required)) {
      failures.push(`mobile/package.json: ${required} is used by Android config/source but undeclared`);
    }
  }
}

function validateRootPackage(rootPackage, failures) {
  if (!Array.isArray(rootPackage.workspaces) || !rootPackage.workspaces.includes('mobile')) {
    failures.push('package.json: mobile workspace is missing');
  }
  if (rootPackage.scripts?.['test:mobile'] !== 'node --test mobile/test/*.test.mjs') {
    failures.push('package.json: test:mobile command is missing or unstable');
  }
  if (rootPackage.scripts?.['validate:mobile'] !== 'node scripts/validation/validate-mobile.mjs') {
    failures.push('package.json: validate:mobile command is missing or unstable');
  }
}

function main() {
  try {
    const { mobileRoot } = parseArguments(process.argv.slice(2));
    const metadata = lstatSync(mobileRoot, { throwIfNoEntry: false });
    if (!metadata?.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error('Mobile root must be a regular directory without links.');
    }
    const canonicalRoot = realpathSync.native(mobileRoot);
    const failures = [];
    const files = collectMobileFiles(mobileRoot, failures);
    validateFiles(mobileRoot, canonicalRoot, files, failures);
    const mobilePackage = readJson(join(mobileRoot, 'package.json'), 'mobile/package.json');
    const appConfig = readJson(join(mobileRoot, 'app.json'), 'app.json');
    const rootPackage = readJson(join(mobileRoot, '..', 'package.json'), 'package.json');
    validateExpoConfig(appConfig, failures);
    validateMobilePackage(mobilePackage, appConfig, files, mobileRoot, failures);
    validateRootPackage(rootPackage, failures);

    if (failures.length > 0) {
      process.stderr.write(`Mobile validation failed:\n${failures.join('\n')}\n`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write(
      `Mobile source validation passed (${REQUIRED_FILES.length} required files, ${files.length} inspected files, Android only).\n`
    );
  } catch (error) {
    const message =
      error instanceof Error &&
      /^(?:Mobile root|Mobile validation arguments|mobile\/package\.json|app\.json|package\.json)/.test(error.message)
        ? error.message
        : 'Mobile validation could not be completed.';
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}

main();
