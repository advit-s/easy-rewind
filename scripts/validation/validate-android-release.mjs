import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import process from 'node:process';

const EXPECTED_PACKAGE = 'com.easyrewind.mobile';
const EXPECTED_EXPO = '~57.0.0';
const EXPECTED_NODE = '24.18.0';
const EXPECTED_PERMISSIONS = Object.freeze(['INTERNET', 'ACCESS_NETWORK_STATE', 'POST_NOTIFICATIONS']);
const EXPECTED_BLOCKED_PERMISSIONS = Object.freeze([
  'android.permission.ACCESS_COARSE_LOCATION',
  'android.permission.ACCESS_FINE_LOCATION',
  'android.permission.CAMERA',
  'android.permission.READ_CONTACTS',
  'android.permission.READ_EXTERNAL_STORAGE',
  'android.permission.RECORD_AUDIO',
  'android.permission.WRITE_EXTERNAL_STORAGE',
]);
const EXPECTED_PAIRING_ENV = Object.freeze({
  EASY_REWIND_PAIRING_MODE: 'lan',
  EASY_REWIND_PAIRING_ENDPOINT_SOURCE: 'qr-runtime',
});
const REQUIRED_ASSETS = Object.freeze(['assets/icon.png', 'assets/adaptive-icon.png', 'assets/notification-icon.png']);
const FORBIDDEN_RELEASE_FILE = /\.(?:aab|apk|apks|db|sqlite)(?:-(?:wal|shm))?$/i;
const FORBIDDEN_DIRECTORY = new Set(['.expo', '.expo-release-export', 'dist', 'release']);
const URL_PATTERN = /\b(?:https?|wss?):\/\/[^\s"'<>]+/i;
const SENSITIVE_KEY_PATTERN =
  /(?:api.?key|authorization|bearer|credential|password|private.?key|secret|service.?account|token)/i;
const SENSITIVE_VALUE_PATTERN =
  /(?:AIza[0-9A-Za-z_-]{35}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|legacy-backup|quarantine)/i;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readJson(path, label) {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    if (!isObject(value)) throw new Error();
    return value;
  } catch {
    throw new Error(`${label} must contain one valid JSON object.`);
  }
}

function equalJson(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function assertSafeObject(value, label) {
  function inspect(current, path) {
    if (Array.isArray(current)) {
      current.forEach((entry, index) => inspect(entry, `${path}[${index}]`));
      return;
    }
    if (!isObject(current)) {
      if (typeof current === 'string') {
        if (URL_PATTERN.test(current)) {
          throw new Error(`${label} must not embed a network endpoint or URL (${path}).`);
        }
        if (SENSITIVE_VALUE_PATTERN.test(current)) {
          throw new Error(`${label} must not embed credential or sensitive material (${path}).`);
        }
      }
      return;
    }
    for (const [key, entry] of Object.entries(current)) {
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        throw new Error(`${label} must not define credential or secret field ${path}.${key}.`);
      }
      inspect(entry, `${path}.${key}`);
    }
  }
  inspect(value, label);
}

function validateMobileFiles(mobileRoot) {
  for (const asset of REQUIRED_ASSETS) {
    const metadata = lstatSync(join(mobileRoot, asset), { throwIfNoEntry: false });
    if (!metadata?.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`Android release asset ${asset} is missing or unsafe.`);
    }
  }

  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Android release source must not contain symbolic links.');
      if (entry.isDirectory()) {
        if (FORBIDDEN_DIRECTORY.has(entry.name.toLowerCase())) {
          throw new Error(`Generated Android release directory ${entry.name} must not be checked in.`);
        }
        visit(path);
      } else if (entry.isFile() && FORBIDDEN_RELEASE_FILE.test(entry.name)) {
        throw new Error(`Android release source must not contain ${extname(entry.name)} artifacts or databases.`);
      }
    }
  }
  visit(mobileRoot);
}

function validateAppConfig(app, mobilePackage) {
  const expo = app.expo;
  if (!isObject(expo) || !isObject(expo.android)) {
    throw new Error('Android Expo configuration is missing.');
  }
  if (mobilePackage.dependencies?.expo !== EXPECTED_EXPO) {
    throw new Error(`Expo must remain pinned to ${EXPECTED_EXPO}.`);
  }
  if (expo.version !== mobilePackage.version || !/^\d+\.\d+\.\d+$/.test(expo.version ?? '')) {
    throw new Error('Android application and mobile package versions must match.');
  }
  if (expo.android.package !== EXPECTED_PACKAGE) {
    throw new Error(`Android package must remain ${EXPECTED_PACKAGE}.`);
  }
  if (!Number.isSafeInteger(expo.android.versionCode) || expo.android.versionCode < 1) {
    throw new Error('Android versionCode must be a positive integer.');
  }
  if (!equalJson(expo.android.permissions, EXPECTED_PERMISSIONS)) {
    throw new Error('Android permissions must remain the minimized offline-first allowlist.');
  }
  if (!equalJson(expo.android.blockedPermissions, EXPECTED_BLOCKED_PERMISSIONS)) {
    throw new Error('Android blocked permissions must remain the frozen privacy denylist.');
  }
  if (
    expo.icon !== './assets/icon.png' ||
    expo.android.adaptiveIcon?.foregroundImage !== './assets/adaptive-icon.png'
  ) {
    throw new Error('Android release icons must use the checked-in generated assets.');
  }
  if (!Array.isArray(expo.platforms) || !equalJson(expo.platforms, ['android']) || expo.newArchEnabled !== true) {
    throw new Error('Expo release configuration must remain Android-only with the new architecture enabled.');
  }

  if (isObject(expo.extra)) assertSafeObject(expo.extra, 'app.json expo.extra');
}

function validateEasConfig(eas) {
  if (!equalJson(Object.keys(eas).sort(), ['build', 'cli'])) {
    throw new Error('eas.json may contain only local CLI and build configuration; submit is forbidden.');
  }
  if (eas.cli?.appVersionSource !== 'local' || eas.cli?.requireCommit !== true || eas.cli?.version !== '>=16.0.0') {
    throw new Error('EAS CLI must require a commit and use local application versioning.');
  }
  if (!equalJson(Object.keys(eas.build ?? {}).sort(), ['base', 'preview', 'production'])) {
    throw new Error('EAS build profiles must be exactly base, preview, and production.');
  }

  const { base, preview, production } = eas.build;
  if (base?.node !== EXPECTED_NODE || !equalJson(base.env, EXPECTED_PAIRING_ENV)) {
    throw new Error('EAS base must pin Node and expose only LAN QR-runtime pairing placeholders.');
  }
  if (preview?.extends !== 'base' || preview?.distribution !== 'internal' || preview?.android?.buildType !== 'apk') {
    throw new Error('EAS preview must produce an internal APK.');
  }
  if (
    production?.extends !== 'base' ||
    production?.distribution !== 'store' ||
    production?.android?.buildType !== 'app-bundle'
  ) {
    throw new Error('EAS production must produce a store app-bundle.');
  }
  if (production.autoIncrement !== false || preview.autoIncrement === true) {
    throw new Error('EAS autoIncrement is forbidden; versionCode changes must be explicit and reviewed.');
  }
  assertSafeObject(eas, 'eas.json');
}

function validateScripts(rootPackage, mobilePackage) {
  if (
    rootPackage.scripts?.['test:android-release'] !==
      'node --test scripts/validation/validate-android-release.test.mjs' ||
    rootPackage.scripts?.['validate:android-release'] !== 'node scripts/validation/validate-android-release.mjs'
  ) {
    throw new Error('Root test:android-release and validate:android-release commands must remain stable.');
  }
  if (rootPackage.scripts?.['mobile:android:export'] !== 'npm run android:export --workspace=@easy-rewind/mobile') {
    throw new Error('Root mobile:android:export must remain a local JS export command.');
  }
  if (
    mobilePackage.scripts?.['android:export'] !== 'expo export --platform android --output-dir .expo-release-export'
  ) {
    throw new Error('Mobile android:export must remain a deterministic local Android JS export.');
  }

  for (const [name, command] of [
    ...Object.entries(rootPackage.scripts ?? {}),
    ...Object.entries(mobilePackage.scripts ?? {}),
  ]) {
    if (/\beas\s+(?:build|submit)\b/i.test(String(command)) || /(?:^|:)submit(?:$|:)/i.test(name)) {
      throw new Error(`Automatic Android build or submit script ${name} is forbidden.`);
    }
  }
}

export async function validateAndroidRelease({ repositoryRoot } = {}) {
  const root = resolve(repositoryRoot ?? resolve(import.meta.dirname, '..', '..'));
  const mobileRoot = join(root, 'mobile');
  const app = readJson(join(mobileRoot, 'app.json'), 'mobile/app.json');
  const eas = readJson(join(mobileRoot, 'eas.json'), 'mobile/eas.json');
  const mobilePackage = readJson(join(mobileRoot, 'package.json'), 'mobile/package.json');
  const rootPackage = readJson(join(root, 'package.json'), 'package.json');

  validateAppConfig(app, mobilePackage);
  validateEasConfig(eas);
  validateScripts(rootPackage, mobilePackage);
  validateMobileFiles(mobileRoot);

  return {
    expoVersion: mobilePackage.dependencies.expo,
    packageName: app.expo.android.package,
    previewArtifact: eas.build.preview.android.buildType,
    productionArtifact: eas.build.production.android.buildType,
    version: app.expo.version,
    versionCode: app.expo.android.versionCode,
  };
}

function parseRepositoryRoot(argv) {
  if (argv.length === 0) return undefined;
  if (argv.length === 2 && argv[0] === '--repository-root' && argv[1] && !argv[1].startsWith('--')) {
    return argv[1];
  }
  throw new Error('Android release validation arguments are invalid.');
}

async function main() {
  try {
    const result = await validateAndroidRelease({
      repositoryRoot: parseRepositoryRoot(process.argv.slice(2)),
    });
    process.stdout.write(
      `Android release validation passed (${result.packageName} ${result.version} (${result.versionCode}), preview APK, production AAB).\n`
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Android release validation failed.'}\n`);
    process.exitCode = 1;
  }
}

const isDirectRun =
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/i, '$1'));
if (isDirectRun) await main();
