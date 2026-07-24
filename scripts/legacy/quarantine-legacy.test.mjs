import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import {
  copyFileSync,
  closeSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const repositoryRoot = resolve(import.meta.dirname, '..', '..');
const repositoryQuarantineScript = join(
  repositoryRoot,
  'scripts',
  'legacy',
  'quarantine-legacy.ps1'
);
const repositoryPurgeScript = join(
  repositoryRoot,
  'scripts',
  'legacy',
  'purge-legacy-source.ps1'
);
const repositoryHandleHelper = join(
  repositoryRoot,
  'scripts',
  'legacy',
  'legacy-handle-safety.ps1'
);
const requiredNames = [
  'easy-rewind.db',
  'easy-rewind.db-wal',
  'easy-rewind.db-shm',
  'settings.json',
];
const sensitivityWarning =
  'Contains sensitive personal legacy data and is not secure credential storage.';
const tempRoots = [];

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex').toUpperCase();
}

function diagnostic(result) {
  return [
    `status: ${result.status}`,
    `signal: ${result.signal ?? 'none'}`,
    `stdout:\n${result.stdout ?? ''}`,
    `stderr:\n${result.stderr ?? ''}`,
  ].join('\n');
}

function assertPathWithin(path, root, label) {
  const resolvedPath = resolve(path);
  const resolvedRoot = resolve(root);
  const pathRelativeToRoot = relative(resolvedRoot, resolvedPath);
  assert.equal(
    isAbsolute(pathRelativeToRoot) ||
      pathRelativeToRoot === '..' ||
      pathRelativeToRoot.startsWith('../') ||
      pathRelativeToRoot.startsWith('..\\'),
    false,
    `${label} must stay within ${resolvedRoot}: ${resolvedPath}`
  );
  return resolvedPath;
}

function assertManifestContainment(fixture, manifest) {
  assertPathWithin(manifest.sourceRoot, fixture.root, 'sourceRoot');
  assert.equal(
    resolve(manifest.sourceRoot),
    resolve(fixture.sourceRoot),
    'sourceRoot must be the fixture source root'
  );
  assertPathWithin(manifest.manifestPath, fixture.root, 'manifestPath');
  assertPathWithin(manifest.quarantinePath, fixture.root, 'quarantinePath');
  assertPathWithin(manifest.manifestPath, fixture.quarantineRoot, 'manifestPath');
  assertPathWithin(manifest.quarantinePath, fixture.quarantineRoot, 'quarantinePath');

  for (const entry of manifest.files) {
    assertPathWithin(entry.originalPath, fixture.root, `${entry.name} originalPath`);
    assert.equal(
      resolve(entry.originalPath),
      resolve(fixture.dataRoot, entry.name),
      `${entry.name} originalPath must be the fixture source file`
    );
    assert.equal(
      entry.backupRelativePath,
      entry.name,
      `${entry.name} backupRelativePath must be the root-level filename`
    );
    const backupPath = resolve(manifest.quarantinePath, entry.backupRelativePath);
    assertPathWithin(backupPath, fixture.root, `${entry.name} backupRelativePath`);
    assertPathWithin(
      backupPath,
      fixture.quarantineRoot,
      `${entry.name} backupRelativePath`
    );
  }
}

function newFixture() {
  const root = mkdtempSync(join(tmpdir(), 'easy-rewind-containment-'));
  tempRoots.push(root);
  const sourceRoot = join(root, 'repo');
  const dataRoot = join(sourceRoot, 'backend', 'data');
  const toolingRoot = join(root, 'tooling');
  const localAppData = join(root, 'local-app-data');
  const quarantineRoot = join(localAppData, 'easy-rewind', 'legacy-backup');
  mkdirSync(dataRoot, { recursive: true });
  mkdirSync(toolingRoot, { recursive: true });
  mkdirSync(localAppData, { recursive: true });

  const files = new Map([
    ['easy-rewind.db', Buffer.from([0x53, 0x51, 0x4c, 0x69, 0x74, 0x65])],
    ['easy-rewind.db-wal', Buffer.from([0x37, 0x7f, 0x06, 0x82, 0x01])],
    ['easy-rewind.db-shm', Buffer.from([0x18, 0xe2, 0x2d, 0x00])],
    ['settings.json', Buffer.from('{"legacy":true}\n', 'utf8')],
  ]);

  for (const [name, bytes] of files) {
    writeFileSync(join(dataRoot, name), bytes);
  }

  return {
    root,
    sourceRoot,
    dataRoot,
    toolingRoot,
    localAppData,
    quarantineRoot,
    files,
  };
}

function fixtureLocalScript(fixture, repositoryScript) {
  const localScript = join(fixture.toolingRoot, basename(repositoryScript));
  if (existsSync(repositoryScript)) {
    copyFileSync(repositoryScript, localScript);
  }
  if (existsSync(repositoryHandleHelper)) {
    copyFileSync(
      repositoryHandleHelper,
      join(fixture.toolingRoot, basename(repositoryHandleHelper))
    );
  }
  return localScript;
}

function validatePowerShellResult(result) {
  if (result.error) {
    throw new Error(`PowerShell failed to start: ${result.error.message}\n${diagnostic(result)}`);
  }
  if (result.signal !== null) {
    throw new Error(`PowerShell exited from signal ${result.signal}\n${diagnostic(result)}`);
  }
  if (!Number.isInteger(result.status)) {
    throw new Error(`PowerShell returned no integer status\n${diagnostic(result)}`);
  }
  return result;
}

function spawnPowerShell(fixture, args) {
  return validatePowerShellResult(spawnSync(
    'powershell.exe',
    args,
    {
      cwd: fixture.root,
      encoding: 'utf8',
      env: { ...process.env, LOCALAPPDATA: fixture.localAppData },
      timeout: 10_000,
    }
  ));
}

function runPowerShell(fixture, repositoryScript, args) {
  const script = fixtureLocalScript(fixture, repositoryScript);
  return spawnPowerShell(fixture, [
    '-NoLogo',
    '-NonInteractive',
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    script,
    ...args,
  ]);
}

function quotePowerShellLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function runPurgePowerShell(
  fixture,
  repositoryScript,
  manifestPath,
  extraArguments = ['-Confirm:$false']
) {
  const script = fixtureLocalScript(fixture, repositoryScript);
  const command = [
    '&',
    quotePowerShellLiteral(script),
    '-ManifestPath',
    quotePowerShellLiteral(manifestPath),
    ...extraArguments,
  ].join(' ');
  const encodedCommand = Buffer.from(command, 'utf16le').toString('base64');
  return spawnPowerShell(fixture, [
    '-NoLogo',
    '-NonInteractive',
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-EncodedCommand',
    encodedCommand,
  ]);
}

function inspectAcls(fixture, paths) {
  const encodedPaths = Buffer.from(JSON.stringify(paths), 'utf8').toString('base64');
  const command = [
    `$json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPaths}'))`,
    '$paths = [string[]](ConvertFrom-Json -InputObject $json)',
    '$records = foreach ($path in $paths) {',
    '  $acl = Get-Acl -LiteralPath $path',
    '  $owner = (New-Object Security.Principal.NTAccount($acl.Owner)).Translate([Security.Principal.SecurityIdentifier]).Value',
    '  $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | ForEach-Object {',
    '    [pscustomobject]@{ Identity = $_.IdentityReference.Value; Type = [string]$_.AccessControlType; Rights = [long]$_.FileSystemRights; Inheritance = [int]$_.InheritanceFlags; IsInherited = [bool]$_.IsInherited }',
    '  })',
    '  [pscustomobject]@{ Path = $path; Owner = $owner; Protected = [bool]$acl.AreAccessRulesProtected; Rules = $rules }',
    '}',
    'ConvertTo-Json -InputObject @($records) -Depth 6 -Compress',
  ].join('; ');
  const encodedCommand = Buffer.from(command, 'utf16le').toString('base64');
  const result = spawnPowerShell(fixture, [
    '-NoLogo',
    '-NonInteractive',
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-EncodedCommand',
    encodedCommand,
  ]);
  assert.equal(result.status, 0, diagnostic(result));
  return JSON.parse(result.stdout);
}

function createManifestFixture(fixture, timestamp) {
  const quarantinePath = join(fixture.quarantineRoot, timestamp);
  const manifestPath = join(quarantinePath, 'manifest.json');
  mkdirSync(quarantinePath, { recursive: true });

  const files = requiredNames.map((name) => {
    const bytes = fixture.files.get(name);
    const backupRelativePath = name;
    writeFileSync(join(quarantinePath, backupRelativePath), bytes);
    return {
      name,
      originalPath: join(fixture.dataRoot, name),
      backupRelativePath,
      size: bytes.byteLength,
      sha256: sha256(bytes),
    };
  });
  const manifest = {
    schemaVersion: 1,
    sensitive: true,
    warning: sensitivityWarning,
    sqliteOpened: false,
    backupTimeUtc: '2026-07-24T12:00:00.000Z',
    sourceRoot: fixture.sourceRoot,
    quarantinePath,
    manifestPath,
    files,
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return JSON.parse(readFileSync(manifestPath, 'utf8'));
}

afterEach(() => {
  const cleanupFailures = [];
  for (const root of tempRoots.splice(0)) {
    try {
      assertPathWithin(root, tmpdir(), 'fixture root');
      rmSync(root, { recursive: true, force: true });
      assert.equal(existsSync(root), false, `fixture root was not removed: ${root}`);
    } catch (error) {
      cleanupFailures.push(`${root}: ${error.message}`);
    }
  }
  assert.deepEqual(cleanupFailures, [], cleanupFailures.join('\n'));
});

test('quarantine copies the coherent set byte-for-byte and writes a safe manifest', () => {
  const fixture = newFixture();
  const sourceSentinel = join(fixture.dataRoot, 'keep-me.txt');
  writeFileSync(sourceSentinel, 'keep');
  const result = runPowerShell(fixture, repositoryQuarantineScript, [
    '-SourceRoot',
    fixture.sourceRoot,
    '-QuarantineRoot',
    fixture.quarantineRoot,
    '-Timestamp',
    '20260724T120000000Z',
  ]);

  assert.equal(result.status, 0, diagnostic(result));
  const output = JSON.parse(result.stdout);
  assertManifestContainment(fixture, output);
  const persistedManifest = JSON.parse(readFileSync(output.manifestPath, 'utf8'));
  assert.deepEqual(persistedManifest, output);
  assert.equal(output.schemaVersion, 1);
  assert.equal(output.sensitive, true);
  assert.equal(output.warning, sensitivityWarning);
  assert.equal(output.sqliteOpened, false);
  assert.match(output.backupTimeUtc, /Z$/);
  assert.equal(basename(output.quarantinePath), '20260724T120000000Z');
  assert.deepEqual(
    output.files.map((entry) => entry.name).sort(),
    [...fixture.files.keys()].sort()
  );

  for (const entry of output.files) {
    const original = fixture.files.get(entry.name);
    assert.ok(original, `unexpected manifest entry ${entry.name}`);
    assert.equal(entry.originalPath, join(fixture.dataRoot, entry.name));
    assert.equal(entry.size, original.byteLength);
    assert.match(entry.sha256, /^[0-9A-F]{64}$/);
    assert.equal(entry.sha256, sha256(original));
    assert.deepEqual(
      readFileSync(resolve(output.quarantinePath, entry.backupRelativePath)),
      original
    );
  }
  assert.equal(existsSync(output.manifestPath), true);
  for (const [name, bytes] of fixture.files) {
    assert.deepEqual(readFileSync(join(fixture.dataRoot, name)), bytes);
  }
  assert.equal(readFileSync(sourceSentinel, 'utf8'), 'keep');

  const aclPaths = [
    output.quarantinePath,
    ...output.files.map((entry) =>
      resolve(output.quarantinePath, entry.backupRelativePath)
    ),
    output.manifestPath,
  ];
  const aclRecords = inspectAcls(fixture, aclPaths);
  assert.equal(aclRecords.length, 6);
  for (const acl of aclRecords) {
    assert.equal(acl.Protected, true, `${acl.Path} must have protected ACLs`);
    assert.equal(acl.Rules.length, 1, `${acl.Path} must have exactly one ACE`);
    assert.equal(acl.Rules[0].Identity, acl.Owner, `${acl.Path} owner/ACE mismatch`);
    assert.equal(acl.Rules[0].Type, 'Allow', `${acl.Path} must have only Allow`);
    assert.equal(acl.Rules[0].IsInherited, false, `${acl.Path} ACE must be explicit`);
  }

  const quarantineSource = readFileSync(repositoryQuarantineScript, 'utf8');
  assert.match(
    quarantineSource,
    /if \(\$PSVersionTable\.PSEdition -eq 'Core'\) \{[\s\S]*?\[System\.IO\.FileSystemAclExtensions\]::SetAccessControl\([\s\S]*?\} else \{\s*\$directory\.SetAccessControl\(\$accessSecurity\)/,
    'PowerShell Core must use the static API while Windows PowerShell uses instance binding'
  );
  assert.match(
    quarantineSource,
    /\[System\.Text\.RegularExpressions\.Regex\]::Escape\(/,
    'command-line source matching must escape the canonical source root'
  );
  assert.doesNotMatch(
    quarantineSource,
    /\.IndexOf\(\$ResolvedSourceRoot/,
    'process association must not use substring matching'
  );
  assert.doesNotMatch(
    quarantineSource,
    /\$cannotInspect(?:GenericRuntime|PortServer)/,
    'unreadable generic runtimes are not established Easy Rewind candidates'
  );
});

test('quarantine fails closed while any source writer handle is open', () => {
  const fixture = newFixture();
  const writer = openSync(join(fixture.dataRoot, 'easy-rewind.db'), 'r+');
  let result;
  try {
    result = runPowerShell(fixture, repositoryQuarantineScript, [
      '-SourceRoot',
      fixture.sourceRoot,
      '-QuarantineRoot',
      fixture.quarantineRoot,
      '-Timestamp',
      '20260724T120000020Z',
    ]);
  } finally {
    closeSync(writer);
  }

  assert.notEqual(result.status, 0, diagnostic(result));
  assert.match(result.stderr, /source set is in use/i, diagnostic(result));
  assert.equal(existsSync(fixture.quarantineRoot), false);
});

test('quarantine rejects reparse components and multiply linked source files', () => {
  const junctionFixture = newFixture();
  const realDataRoot = join(junctionFixture.sourceRoot, 'backend', 'real-data');
  renameSync(junctionFixture.dataRoot, realDataRoot);
  symlinkSync(realDataRoot, junctionFixture.dataRoot, 'junction');
  const junctionResult = runPowerShell(
    junctionFixture,
    repositoryQuarantineScript,
    [
      '-SourceRoot',
      junctionFixture.sourceRoot,
      '-QuarantineRoot',
      junctionFixture.quarantineRoot,
      '-Timestamp',
      '20260724T120000021Z',
    ]
  );
  assert.notEqual(junctionResult.status, 0, diagnostic(junctionResult));
  assert.match(junctionResult.stderr, /reparse|junction/i, diagnostic(junctionResult));
  assert.equal(existsSync(junctionFixture.quarantineRoot), false);

  const hardLinkFixture = newFixture();
  linkSync(
    join(hardLinkFixture.dataRoot, 'easy-rewind.db'),
    join(hardLinkFixture.dataRoot, 'easy-rewind.db-alias')
  );
  const hardLinkResult = runPowerShell(
    hardLinkFixture,
    repositoryQuarantineScript,
    [
      '-SourceRoot',
      hardLinkFixture.sourceRoot,
      '-QuarantineRoot',
      hardLinkFixture.quarantineRoot,
      '-Timestamp',
      '20260724T120000022Z',
    ]
  );
  assert.notEqual(hardLinkResult.status, 0, diagnostic(hardLinkResult));
  assert.match(hardLinkResult.stderr, /hard link|multiple links/i, diagnostic(hardLinkResult));
  assert.equal(existsSync(hardLinkFixture.quarantineRoot), false);
});

test('quarantine fails closed if any required legacy file is absent', () => {
  const results = requiredNames.map((name, index) => {
    const fixture = newFixture();
    rmSync(join(fixture.dataRoot, name));
    const result = runPowerShell(fixture, repositoryQuarantineScript, [
      '-SourceRoot',
      fixture.sourceRoot,
      '-QuarantineRoot',
      fixture.quarantineRoot,
      '-Timestamp',
      `20260724T12000000${index + 1}Z`,
    ]);
    return { fixture, name, result };
  });

  for (const { fixture, name, result } of results) {
    assert.notEqual(result.status, 0, diagnostic(result));
    assert.match(result.stderr, /required legacy file is missing/i, `${name}: ${diagnostic(result)}`);
    assert.equal(existsSync(fixture.quarantineRoot), false, `${name} created a destination`);
  }
});

test('manifest-bound purge refuses tampered backups and preserves every source', () => {
  const fixture = newFixture();
  const manifest = createManifestFixture(fixture, '20260724T120000010Z');
  assertManifestContainment(fixture, manifest);
  const tamperedEntry = manifest.files.at(-1);
  writeFileSync(
    resolve(manifest.quarantinePath, tamperedEntry.backupRelativePath),
    'tampered'
  );

  const purge = runPurgePowerShell(
    fixture,
    repositoryPurgeScript,
    manifest.manifestPath
  );

  assert.notEqual(purge.status, 0, diagnostic(purge));
  assert.match(purge.stderr, /backup checksum mismatch/i, diagnostic(purge));
  for (const [name, bytes] of fixture.files) {
    assert.deepEqual(readFileSync(join(fixture.dataRoot, name)), bytes);
  }
});

test('manifest-bound purge removes only verified source files', () => {
  const fixture = newFixture();
  const manifest = createManifestFixture(fixture, '20260724T120000011Z');
  assertManifestContainment(fixture, manifest);
  const sourceSentinel = join(fixture.dataRoot, 'keep-me.txt');
  const quarantineSentinel = join(manifest.quarantinePath, 'keep-me.txt');
  writeFileSync(sourceSentinel, 'keep');
  writeFileSync(quarantineSentinel, 'keep-quarantine');
  const backupBytes = new Map(
    manifest.files.map((entry) => [
      entry.name,
      readFileSync(resolve(manifest.quarantinePath, entry.backupRelativePath)),
    ])
  );

  const purge = runPurgePowerShell(
    fixture,
    repositoryPurgeScript,
    manifest.manifestPath
  );

  assert.equal(purge.status, 0, diagnostic(purge));
  for (const name of fixture.files.keys()) {
    assert.equal(existsSync(join(fixture.dataRoot, name)), false);
  }
  assert.equal(readFileSync(sourceSentinel, 'utf8'), 'keep');
  assert.equal(readFileSync(quarantineSentinel, 'utf8'), 'keep-quarantine');
  const persistedManifest = JSON.parse(readFileSync(manifest.manifestPath, 'utf8'));
  assert.deepEqual(persistedManifest, manifest);
  for (const entry of manifest.files) {
    const backup = readFileSync(resolve(manifest.quarantinePath, entry.backupRelativePath));
    assert.deepEqual(backup, backupBytes.get(entry.name));
    assert.equal(sha256(backup), entry.sha256);
  }
});

test('manifest-bound purge validates sensitivity metadata and BOM before deletion', () => {
  for (const mutation of ['warning', 'bom']) {
    const fixture = newFixture();
    const manifest = createManifestFixture(
      fixture,
      mutation === 'warning' ? '20260724T120000030Z' : '20260724T120000031Z'
    );
    if (mutation === 'warning') {
      manifest.warning = 'not the approved warning';
      writeFileSync(manifest.manifestPath, `${JSON.stringify(manifest)}\n`);
    } else {
      const bytes = readFileSync(manifest.manifestPath);
      writeFileSync(
        manifest.manifestPath,
        Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes])
      );
    }

    const purge = runPurgePowerShell(
      fixture,
      repositoryPurgeScript,
      manifest.manifestPath
    );
    assert.notEqual(purge.status, 0, `${mutation}: ${diagnostic(purge)}`);
    for (const [name, bytes] of fixture.files) {
      assert.deepEqual(readFileSync(join(fixture.dataRoot, name)), bytes);
    }
  }
});

test('manifest-bound purge uses one WhatIf decision and removes nothing', () => {
  const fixture = newFixture();
  const manifest = createManifestFixture(fixture, '20260724T120000032Z');
  const purge = runPurgePowerShell(
    fixture,
    repositoryPurgeScript,
    manifest.manifestPath,
    ['-WhatIf', '-Confirm:$false']
  );

  assert.equal(purge.status, 0, diagnostic(purge));
  assert.equal((purge.stdout.match(/What if:/g) ?? []).length, 1, purge.stdout);
  const result = JSON.parse(purge.stdout.trim().split(/\r?\n/).at(-1));
  assert.equal(result.purged, false);
  assert.deepEqual(result.removed, []);
  for (const [name, bytes] of fixture.files) {
    assert.deepEqual(readFileSync(join(fixture.dataRoot, name)), bytes);
  }
});
