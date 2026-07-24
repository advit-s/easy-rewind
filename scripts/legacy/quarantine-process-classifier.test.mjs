import assert from 'node:assert/strict';
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const repositoryRoot = resolve(import.meta.dirname, '..', '..');
const quarantineScript = join(
  repositoryRoot,
  'scripts',
  'legacy',
  'quarantine-legacy.ps1'
);
const handleHelper = join(
  repositoryRoot,
  'scripts',
  'legacy',
  'legacy-handle-safety.ps1'
);

test('classifies confirmed candidates separately from metadata verification failures', () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'easy-rewind-classifier-'));
  try {
    const sourceRoot = join(fixtureRoot, 'app');
    const scriptSource = readFileSync(quarantineScript, 'utf8');
    const mainMarker = '\n$resolvedSourceRoot = Get-CanonicalPath';
    const mainIndex = scriptSource.indexOf(mainMarker);
    assert.notEqual(mainIndex, -1, 'quarantine main marker must remain inspectable');

    const records = [
      {
        Name: 'Easy Rewind.exe',
        ExecutablePath: '',
        CommandLine: '',
        ProcessId: 101,
      },
      {
        Name: 'node.exe',
        ExecutablePath: join(`${sourceRoot}-old`, 'node.exe'),
        CommandLine: `node "${join(`${sourceRoot}-old`, 'server.js')}"`,
        ProcessId: 102,
      },
      {
        Name: 'electron.exe',
        ExecutablePath: 'C:\\Program Files\\Electron\\electron.exe',
        CommandLine: '',
        ProcessId: 103,
      },
      {
        Name: 'node.exe',
        ExecutablePath: 'C:\\Program Files\\nodejs\\node.exe',
        CommandLine: 'node "C:\\other\\server.js"',
        ProcessId: 104,
      },
      {
        Name: 'node.exe',
        ExecutablePath: 'C:\\Program Files\\nodejs\\node.exe',
        CommandLine: `node "${join(sourceRoot, 'server.js')}"`,
        ProcessId: 105,
      },
      {
        Name: 'electron.exe',
        ExecutablePath: join(sourceRoot, 'tools', 'electron.exe'),
        CommandLine: 'electron "C:\\other\\app.js"',
        ProcessId: 106,
      },
    ];
    const driverPath = join(fixtureRoot, 'classifier-driver.ps1');
    copyFileSync(handleHelper, join(fixtureRoot, 'legacy-handle-safety.ps1'));
    const driverSource = `${scriptSource.slice(0, mainIndex)}
$syntheticProcesses = @'
${JSON.stringify(records)}
'@ | ConvertFrom-Json
$classification = Get-EasyRewindProcessClassification \`
  -Processes @($syntheticProcesses) \`
  -ListeningPids @(104) \`
  -ResolvedSourceRoot '${sourceRoot.replaceAll("'", "''")}'
$classification | ConvertTo-Json -Depth 4 -Compress
`;
    writeFileSync(driverPath, driverSource);

    const result = spawnSync(
      'powershell.exe',
      [
        '-NoLogo',
        '-NonInteractive',
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        driverPath,
        '-SourceRoot',
        sourceRoot,
      ],
      {
        cwd: fixtureRoot,
        encoding: 'utf8',
        timeout: 10_000,
      }
    );

    assert.equal(
      result.status,
      0,
      `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`
    );
    const classification = JSON.parse(result.stdout);
    assert.deepEqual(classification.confirmedCandidates, [101, 104, 105, 106]);
    assert.deepEqual(classification.verificationFailures, [103]);
    assert.equal(
      classification.confirmedCandidates.includes(102),
      false,
      'a sibling sourceRoot-old path must not match sourceRoot'
    );
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
