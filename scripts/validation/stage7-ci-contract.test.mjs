import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { load as parseYaml } from 'js-yaml';

const repositoryRoot = resolve(import.meta.dirname, '..', '..');

function read(relativePath) {
  return readFileSync(join(repositoryRoot, relativePath), 'utf8');
}

function parseWorkflow(relativePath) {
  return parseYaml(read(relativePath));
}

function allSteps(workflow) {
  return Object.values(workflow.jobs).flatMap(job => job.steps ?? []);
}

function allRunSource(workflow) {
  return allSteps(workflow)
    .map(step => step.run ?? '')
    .join('\n');
}

function setupNodeSteps(workflow) {
  return allSteps(workflow).filter(step => String(step.uses ?? '').startsWith('actions/setup-node@'));
}

function assertPinnedActions(workflow) {
  for (const step of allSteps(workflow)) {
    if (!step.uses) continue;
    assert.match(
      step.uses,
      /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[0-9a-f]{40}$/u,
      `${step.name ?? step.uses} must use an immutable action SHA`
    );
  }
}

function assertExactToolchain(workflow, minimumSetupCount) {
  for (const setup of setupNodeSteps(workflow)) {
    assert.equal(setup.with?.['node-version'], '24.18.0');
    assert.equal(setup.with?.cache, 'npm');
    assert.equal(setup.with?.['cache-dependency-path'], 'package-lock.json');
  }
  assert.ok(setupNodeSteps(workflow).length >= minimumSetupCount, 'each independent validation lane must set up Node');
  assert.match(allRunSource(workflow), /npm --version[\s\S]*11\.6\.2|11\.6\.2[\s\S]*npm --version/u);
}

test('Stage 7 CI has isolated quality, backend, client, Electron, and artifact lanes', () => {
  const workflow = parseWorkflow('.github/workflows/stage7-ci.yml');
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.deepEqual(Object.keys(workflow.jobs), [
    'quality',
    'backend',
    'clients',
    'electron-package',
    'artifact-checksums',
  ]);
  assertPinnedActions(workflow);
  assertExactToolchain(workflow, 4);

  const quality = allRunSource({ jobs: { quality: workflow.jobs.quality } });
  for (const command of [
    'npm run format:check',
    'npm run lint',
    'npm run scan:secrets',
    'npm run check:hygiene',
    'npm run audit:production',
  ]) {
    assert.match(quality, new RegExp(command.replaceAll(':', '\\:')));
  }

  const backend = allRunSource({ jobs: { backend: workflow.jobs.backend } });
  for (const command of [
    'npm run test:backend:legacy-safe',
    'npm run test:contracts',
    'npm run test:migrations',
    'npm run test:domain',
    'npm run test:jobs',
    'npm run test:sync',
  ]) {
    assert.match(backend, new RegExp(command.replaceAll(':', '\\:')));
  }

  const clients = allRunSource({ jobs: { clients: workflow.jobs.clients } });
  for (const command of [
    'npm run test:extension',
    'npm run validate:extension',
    'npm run test:dashboard',
    'npm run validate:dashboard',
    'npm run test:mobile',
    'npm run test:android-release',
    'npm run mobile:typecheck',
    'npm run validate:mobile',
    'npm run validate:android-release',
    'npm exec --workspace=@easy-rewind/mobile -- expo export',
    'node scripts/validation/stage7-ci-artifacts.mjs',
  ]) {
    assert.match(clients, new RegExp(command.replaceAll(':', '\\:')));
  }
  const clientSteps = workflow.jobs.clients.steps;
  const clientInspectionIndex = clientSteps.findIndex(step =>
    String(step.run ?? '').includes('stage7-ci-artifacts.mjs')
  );
  const clientUploadIndex = clientSteps.findIndex(step =>
    String(step.uses ?? '').startsWith('actions/upload-artifact@')
  );
  assert.ok(clientInspectionIndex >= 0 && clientInspectionIndex < clientUploadIndex);

  const electron = workflow.jobs['electron-package'];
  assert.equal(electron['runs-on'], 'windows-latest');
  const electronRuns = allRunSource({ jobs: { electron } });
  for (const command of [
    'node --test desktop/*.test.js',
    'npm run test:desktop-package',
    'npm run validate:desktop-package',
    'npm run validate:native',
    'npm run package:windows',
    'node --test scripts/validation/validate-release-artifacts.test.mjs',
    'node scripts/validation/validate-release-artifacts.mjs --write-checksums',
  ]) {
    assert.match(electronRuns, new RegExp(command.replaceAll('*', '\\*').replaceAll(':', '\\:')));
  }

  const artifactJob = workflow.jobs['artifact-checksums'];
  assert.deepEqual(artifactJob.needs, ['clients', 'electron-package']);
  assert.match(allRunSource({ jobs: { artifactJob } }), /stage7-ci-artifacts\.mjs/u);
  assert.equal(artifactJob.steps.at(-1).with?.['if-no-files-found'], 'error');

  const source = read('.github/workflows/stage7-ci.yml');
  assert.doesNotMatch(source, /\b(?:node_modules|\.expo|dist)\b[\s\S]{0,80}\bactions\/cache@/iu);
  assert.doesNotMatch(source, /\$\{\{\s*secrets\./u);
  assert.doesNotMatch(source, /(?:Write-(?:Host|Output)|echo)\s+.*(?:secret|token|password|certificate)/iu);
});

test('release gate fails closed without revocation evidence and signing material', () => {
  const workflow = parseWorkflow('.github/workflows/release-gate.yml');
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assertPinnedActions(workflow);
  assertExactToolchain(workflow, 2);

  const dispatch = workflow.on?.workflow_dispatch;
  assert.ok(dispatch, 'release gate must be manually dispatched');
  for (const inputName of [
    'release_commit',
    'provider_revocation_reference',
    'provider_revocation_attestation_sha256',
  ]) {
    assert.equal(dispatch.inputs?.[inputName]?.required, true, `${inputName} must be required`);
  }

  const gate = workflow.jobs['external-release-gates'];
  assert.ok(gate, 'missing external release gate job');
  const gateSource = allRunSource({ jobs: { gate } });
  assert.match(gateSource, /GITHUB_SHA/u);
  assert.match(gateSource, /\^\[a-f0-9\]\{64\}\$/iu);
  assert.match(gateSource, /WINDOWS_SIGNING_CERTIFICATE/u);
  assert.match(gateSource, /WINDOWS_SIGNING_PASSWORD/u);
  assert.match(gateSource, /ANDROID_KEYSTORE/u);
  assert.match(gateSource, /ANDROID_KEY_ALIAS/u);
  assert.match(gateSource, /ANDROID_KEY_PASSWORD/u);
  assert.doesNotMatch(gateSource, /Write-(?:Host|Output)|echo/iu);

  const releaseJob = workflow.jobs['release-acceptance'];
  assert.deepEqual(releaseJob.needs, ['external-release-gates']);
  assert.equal(releaseJob['runs-on'], 'windows-latest');
  assert.match(allRunSource({ jobs: { releaseJob } }), /stage7-ci-artifacts\.mjs[\s\S]*--release/u);

  const source = read('.github/workflows/release-gate.yml');
  assert.match(source, /UNSIGNED/u);
  assert.match(source, /non-release/iu);
  assert.doesNotMatch(source, /(?:Write-(?:Host|Output)|echo)\s+.*(?:secret|token|password|certificate)/iu);
});

test('artifact inspector checks content, emits deterministic SHA-256 records, and rejects unsafe release files', async t => {
  const { inspectArtifacts } = await import('./stage7-ci-artifacts.mjs');
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'easy-rewind-stage7-ci-'));
  const inputRoot = join(fixtureRoot, 'input');
  const outputRoot = join(fixtureRoot, 'evidence');
  mkdirSync(join(inputRoot, 'extension'), { recursive: true });
  writeFileSync(join(inputRoot, 'extension', 'manifest.json'), '{"manifest_version":3}\n');
  writeFileSync(join(inputRoot, 'extension', 'worker.js'), 'export const ready = true;\n');

  t.after(() => rmSync(fixtureRoot, { force: true, recursive: true }));

  const first = inspectArtifacts({ inputRoot, outputRoot, release: false });
  const firstManifest = readFileSync(first.manifestPath, 'utf8');
  const firstChecksums = readFileSync(first.checksumPath, 'utf8');
  rmSync(outputRoot, { force: true, recursive: true });
  const second = inspectArtifacts({ inputRoot, outputRoot, release: false });

  assert.equal(readFileSync(second.manifestPath, 'utf8'), firstManifest);
  assert.equal(readFileSync(second.checksumPath, 'utf8'), firstChecksums);
  assert.match(firstManifest, /"algorithm": "SHA-256"/u);
  assert.match(firstChecksums, /^[a-f0-9]{64}  extension\/manifest\.json/mu);

  for (const forbiddenName of [
    'history.sqlite3',
    'history.sqlite3-wal',
    'settings.json',
    '.env.production',
    'private.pem',
    'debug.log',
    'source.map',
  ]) {
    await t.test(`rejects ${forbiddenName}`, () => {
      const path = join(inputRoot, 'extension', forbiddenName);
      writeFileSync(path, 'forbidden\n');
      try {
        assert.throws(
          () => inspectArtifacts({ inputRoot, outputRoot: join(fixtureRoot, `evidence-${forbiddenName}`) }),
          /Artifact inspection failed/u
        );
      } finally {
        rmSync(path, { force: true });
      }
    });
  }

  writeFileSync(join(inputRoot, 'extension', 'leaked.txt'), `Bearer ${'x'.repeat(32)}\n`);
  assert.throws(
    () => inspectArtifacts({ inputRoot, outputRoot: join(fixtureRoot, 'evidence-secret') }),
    /Artifact inspection failed/u
  );
  rmSync(join(inputRoot, 'extension', 'leaked.txt'));

  writeFileSync(join(inputRoot, 'Easy-Rewind-UNSIGNED-Setup.exe'), 'binary placeholder');
  assert.throws(
    () => inspectArtifacts({ inputRoot, outputRoot: join(fixtureRoot, 'evidence-release'), release: true }),
    /Artifact inspection failed/u
  );

  if (process.platform === 'win32') {
    const external = join(fixtureRoot, 'external.txt');
    writeFileSync(external, 'external');
    const link = join(inputRoot, 'extension', 'linked.txt');
    try {
      symlinkSync(external, link, 'file');
      assert.throws(
        () => inspectArtifacts({ inputRoot, outputRoot: join(fixtureRoot, 'evidence-link') }),
        /Artifact inspection failed/u
      );
    } catch (error) {
      if (error?.code !== 'EPERM') throw error;
    }
  }
});
