import assert from 'node:assert/strict';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const repositoryRoot = resolve(import.meta.dirname, '..', '..');
const repositoryHelper = join(
  repositoryRoot,
  'scripts',
  'legacy',
  'legacy-handle-safety.ps1'
);

test('delete-by-handle rolls back every prior disposition before close', () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'easy-rewind-handle-safety-'));
  try {
    assert.equal(
      existsSync(repositoryHelper),
      true,
      'the shared native handle helper must exist'
    );
    const helperPath = join(fixtureRoot, basename(repositoryHelper));
    copyFileSync(repositoryHelper, helperPath);
    const paths = [0, 1, 2, 3].map((index) => {
      const path = join(fixtureRoot, `source-${index}.bin`);
      writeFileSync(path, Buffer.from([index, index + 1]));
      return path;
    });
    const encodedPaths = Buffer.from(JSON.stringify(paths), 'utf8').toString('base64');
    const driverPath = join(fixtureRoot, 'rollback-driver.ps1');
    writeFileSync(
      driverPath,
      `
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. '${helperPath.replaceAll("'", "''")}'
$json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPaths}'))
$paths = [string[]](ConvertFrom-Json -InputObject $json)
$handles = [System.Collections.Generic.List[EasyRewind.NativeHandleFile]]::new()
try {
  foreach ($path in $paths) {
    $handles.Add([EasyRewind.NativeHandleFile]::OpenPurgeSource([string]$path))
  }
  try {
    [EasyRewind.NativeHandleOperations]::MarkDeletePendingAll(
      $handles.ToArray(),
      2
    )
    throw 'Injected disposition failure did not occur.'
  } catch {
    if ($_.Exception.Message -notmatch 'Injected disposition failure') {
      throw
    }
  }
} finally {
  foreach ($handle in $handles) {
    $handle.Dispose()
  }
}
$afterRollback = @($paths | ForEach-Object { Test-Path -LiteralPath $_ -PathType Leaf })
$handles.Clear()
try {
  foreach ($path in $paths) {
    $handles.Add([EasyRewind.NativeHandleFile]::OpenPurgeSource([string]$path))
  }
  [EasyRewind.NativeHandleOperations]::MarkDeletePendingAll(
    $handles.ToArray(),
    -1
  )
} finally {
  foreach ($handle in $handles) {
    $handle.Dispose()
  }
}
$afterCommit = @($paths | ForEach-Object { Test-Path -LiteralPath $_ })
[pscustomobject]@{
  afterRollback = $afterRollback
  afterCommit = $afterCommit
} | ConvertTo-Json -Compress
`
    );

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
    const output = JSON.parse(result.stdout);
    assert.deepEqual(output.afterRollback, [true, true, true, true]);
    assert.deepEqual(output.afterCommit, [false, false, false, false]);
    for (const path of paths) {
      assert.equal(existsSync(path), false);
    }
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
