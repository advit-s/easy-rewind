import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import test from 'node:test';
import { validateAndroidRelease } from './validate-android-release.mjs';

const repositoryRoot = resolve(import.meta.dirname, '..', '..');

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function fixture(mutator) {
  const root = mkdtempSync(join(tmpdir(), 'easy-rewind-android-release-'));
  cpSync(join(repositoryRoot, 'mobile'), join(root, 'mobile'), {
    recursive: true,
    filter(source) {
      return !source.includes(`${join('mobile', 'node_modules')}`);
    },
  });
  cpSync(join(repositoryRoot, 'package.json'), join(root, 'package.json'));
  const values = {
    app: readJson(join(root, 'mobile', 'app.json')),
    eas: readJson(join(root, 'mobile', 'eas.json')),
    mobilePackage: readJson(join(root, 'mobile', 'package.json')),
    rootPackage: readJson(join(root, 'package.json')),
  };
  mutator?.(values);
  writeJson(join(root, 'mobile', 'app.json'), values.app);
  writeJson(join(root, 'mobile', 'eas.json'), values.eas);
  writeJson(join(root, 'mobile', 'package.json'), values.mobilePackage);
  writeJson(join(root, 'package.json'), values.rootPackage);
  return root;
}

async function rejectsMutation(mutator, pattern) {
  const root = fixture(mutator);
  try {
    await assert.rejects(() => validateAndroidRelease({ repositoryRoot: root }), pattern);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('the checked-in Android release configuration freezes preview APK and production AAB profiles', async () => {
  const result = await validateAndroidRelease({ repositoryRoot });

  assert.deepEqual(result, {
    expoVersion: '~57.0.0',
    packageName: 'com.easyrewind.mobile',
    previewArtifact: 'apk',
    productionArtifact: 'app-bundle',
    version: '0.1.0',
    versionCode: 1,
  });
});

test('validation rejects build profiles that could publish or mutate versions automatically', async () => {
  await rejectsMutation(({ eas }) => {
    eas.build.production.autoIncrement = true;
  }, /autoIncrement/i);

  await rejectsMutation(({ eas }) => {
    eas.build.production.android.buildType = 'apk';
  }, /production.*app-bundle/i);

  await rejectsMutation(({ eas }) => {
    eas.build.preview.distribution = 'store';
  }, /preview.*internal/i);

  await rejectsMutation(({ eas }) => {
    eas.submit = { production: { android: {} } };
  }, /submit/i);
});

test('validation rejects embedded endpoints, credentials, and release secrets', async () => {
  await rejectsMutation(({ eas }) => {
    eas.build.preview.env = {
      EASY_REWIND_PAIRING_BASE_URL: 'https://192.168.1.20:9443',
    };
  }, /endpoint|URL/i);

  await rejectsMutation(({ app }) => {
    app.expo.extra = { apiKey: 'do-not-embed' };
  }, /credential|secret/i);

  await rejectsMutation(({ eas }) => {
    eas.build.production.env = { GEMINI_API_KEY: 'do-not-embed' };
  }, /credential|secret/i);
});

test('the command-line validator reports the artifact contract without invoking EAS', () => {
  const result = spawnSync(
    process.execPath,
    [join(repositoryRoot, 'scripts', 'validation', 'validate-android-release.mjs')],
    {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: { PATH: process.env.PATH },
    }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /preview APK, production AAB/i);
  assert.equal(result.stderr, '');
});

test('validation freezes Android identity, versioning, Expo SDK, and minimized permissions', async () => {
  await rejectsMutation(({ app }) => {
    app.expo.android.package = 'com.example.mobile';
  }, /package/i);

  await rejectsMutation(({ app }) => {
    app.expo.android.versionCode = 0;
  }, /versionCode/i);

  await rejectsMutation(({ mobilePackage }) => {
    mobilePackage.dependencies.expo = '^57.0.0';
  }, /Expo/i);

  await rejectsMutation(({ app }) => {
    app.expo.android.permissions.push('CAMERA');
  }, /permission/i);
});

test('validation requires stable local-only root commands and never exposes automatic build or submit scripts', async () => {
  await rejectsMutation(({ rootPackage }) => {
    rootPackage.scripts['android:build:production'] = 'eas build --platform android --profile production';
  }, /automatic.*build|build.*forbidden/i);

  await rejectsMutation(({ rootPackage }) => {
    delete rootPackage.scripts['validate:android-release'];
  }, /validate:android-release/i);

  await rejectsMutation(({ mobilePackage }) => {
    mobilePackage.scripts.submit = 'eas submit --platform android';
  }, /submit/i);
});
