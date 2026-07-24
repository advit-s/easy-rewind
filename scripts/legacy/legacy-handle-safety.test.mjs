import assert from 'node:assert/strict';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
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

test('atomic directory creation leaves no directory after post-create failure', () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'easy-rewind-directory-create-'));
  try {
    const helperPath = join(fixtureRoot, basename(repositoryHelper));
    copyFileSync(repositoryHelper, helperPath);
    const createdPath = join(fixtureRoot, 'must-not-remain');
    const driverPath = join(fixtureRoot, 'directory-create-driver.ps1');
    writeFileSync(
      driverPath,
      `
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. '${helperPath.replaceAll("'", "''")}'
$parent = [EasyRewind.NativeDirectoryHandle]::OpenExisting('${fixtureRoot.replaceAll("'", "''")}')
try {
  try {
    $created = [EasyRewind.NativeDirectoryHandle]::CreateNewWithInjectedFailure(
      $parent,
      'must-not-remain'
    )
    $created.Dispose()
    throw 'Injected atomic directory creation failure did not occur.'
  } catch {
    if ($_.Exception.Message -notmatch 'Injected atomic directory creation failure') {
      throw
    }
  }
} finally {
  $parent.Dispose()
}
[pscustomobject]@{
  existsAfterFailure = Test-Path -LiteralPath '${createdPath.replaceAll("'", "''")}'
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
    assert.deepEqual(JSON.parse(result.stdout), { existsAfterFailure: false });
    assert.equal(existsSync(createdPath), false);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('relative child handles prevent parent substitution and preserve identity', () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'easy-rewind-relative-open-'));
  try {
    const helperPath = join(fixtureRoot, basename(repositoryHelper));
    copyFileSync(repositoryHelper, helperPath);
    const childPath = join(fixtureRoot, 'child');
    const renamedPath = join(fixtureRoot, 'renamed-child');
    const payloadPath = join(childPath, 'payload.bin');
    mkdirSync(childPath);
    writeFileSync(payloadPath, Buffer.from([0x10, 0x20, 0x30]));
    const driverPath = join(fixtureRoot, 'relative-open-driver.ps1');
    writeFileSync(
      driverPath,
      `
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. '${helperPath.replaceAll("'", "''")}'
$canonicalRoot = [EasyRewind.NativePathSafety]::CanonicalizeLocalDrivePath('${fixtureRoot.replaceAll("'", "''")}')
$volumeRoot = [IO.Path]::GetPathRoot($canonicalRoot)
$directoryHandles = [Collections.Generic.List[EasyRewind.NativeDirectoryHandle]]::new()
$parent = [EasyRewind.NativeDirectoryHandle]::OpenLocalVolumeRoot($canonicalRoot)
$directoryHandles.Add($parent)
foreach ($component in $canonicalRoot.Substring($volumeRoot.Length).Split(
    [char[]]@('\\', '/'),
    [StringSplitOptions]::RemoveEmptyEntries
  )) {
  $parent = [EasyRewind.NativeDirectoryHandle]::OpenExisting(
    $parent,
    [string]$component
  )
  $directoryHandles.Add($parent)
}
$child = $null
$file = $null
try {
  $child = [EasyRewind.NativeDirectoryHandle]::OpenExisting($parent, 'child')
  $file = [EasyRewind.NativeHandleFile]::OpenBackupRead($child, 'payload.bin')
  $before = $file.Snapshot()
  $substitutionBlocked = $false
  try {
    [System.IO.Directory]::Move(
      '${childPath.replaceAll("'", "''")}',
      '${renamedPath.replaceAll("'", "''")}'
    )
  } catch {
    $substitutionBlocked = $true
  }
  $unsafePathRejections = @(
    '\\\\server\\share\\source',
    '\\\\?\\C:\\device-path',
    '${payloadPath.replaceAll("'", "''")}:alternate'
  ) | ForEach-Object {
    try {
      $null = [EasyRewind.NativePathSafety]::CanonicalizeLocalDrivePath($_)
      $false
    } catch {
      $true
    }
  }
  $after = $file.Snapshot()
  [pscustomobject]@{
    substitutionBlocked = $substitutionBlocked
    sameIdentity = $before.HasSameIdentity($after)
    unsafePathRejections = $unsafePathRejections
    childPath = $child.Path
    filePath = $file.Path
  } | ConvertTo-Json -Compress
} finally {
  if ($null -ne $file) { $file.Dispose() }
  if ($null -ne $child) { $child.Dispose() }
  foreach ($directoryHandle in $directoryHandles) {
    $directoryHandle.Dispose()
  }
}
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
    assert.equal(output.substitutionBlocked, true);
    assert.equal(output.sameIdentity, true);
    assert.deepEqual(output.unsafePathRejections, [true, true, true]);
    assert.equal(resolve(output.childPath), resolve(childPath));
    assert.equal(resolve(output.filePath), resolve(payloadPath));
    assert.equal(existsSync(childPath), true);
    assert.equal(existsSync(renamedPath), false);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
