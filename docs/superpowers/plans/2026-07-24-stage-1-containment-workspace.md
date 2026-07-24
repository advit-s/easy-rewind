# Stage 1 Credential Containment and Workspace Normalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve one verified, current-user-only quarantine copy of the coherent legacy SQLite set, remove sensitive/generated material from the repository, and establish a reproducible Node 24 npm workspace with secret and repository-hygiene gates.

**Architecture:** PowerShell containment tools perform Windows process discovery, immutable quarantine copying, ACL restriction, checksumming, manifest generation, verification, and source purging without opening SQLite. Node-based tests exercise those tools against byte fixtures, and a Node hygiene checker enforces repository and artifact exclusions. A root npm workspace and lockfile become the only dependency installation path while domain and migration behavior remain unchanged until Stage 2.

**Tech Stack:** PowerShell 7/Windows PowerShell 5.1-compatible scripts, Node.js 24.18.0 LTS, npm 11.6.2, npm workspaces, Node test runner, Secretlint 13.0.4, Jest 30.4.2, ESLint 10.7.0, Prettier 3.9.6, Electron 43.2.0, Electron Builder 26.15.3, `better-sqlite3` 13.0.1, GitHub Actions.

---

## Scope and safety boundary

Stage 1 may inventory, quarantine, verify, purge, normalize the workspace, and
add read-only legacy inspection support. It must not:

- open the preserved database through SQLite
- checkpoint or merge the WAL
- import or convert legacy rows
- treat the quarantine as credential storage
- print the exposed Gemini key
- rewrite shared Git history while other Stage 1 work is unverified

The exact legacy source set is:

- `backend/data/easy-rewind.db`
- `backend/data/easy-rewind.db-wal`
- `backend/data/easy-rewind.db-shm`
- `backend/data/settings.json`

The real `backend/.env` is deleted after containment verification but is not
copied to quarantine because the exposed Gemini key must be revoked, not
preserved as a usable secret.

The preserved destination is:

`%LOCALAPPDATA%\easy-rewind\legacy-backup\<UTC timestamp>\`

Execution must stop if `%LOCALAPPDATA%` is absent, if any expected source file is
missing, if an Easy Rewind process is still running, if the destination already
exists, if ACL restriction fails, or if any size/hash comparison fails.

## File map

### Create

- `package.json` — root workspace, authoritative version, root verification scripts
- `package-lock.json` — only dependency lockfile
- `.nvmrc` — exact development/CI Node version
- `.npmrc` — engine enforcement and reproducible npm behavior
- `.secretlintrc.json` — recommended secret rules
- `.secretlintignore` — generated/sensitive location exclusions without weakening tracked-source scanning
- `scripts/legacy/quarantine-legacy.ps1` — stop-check, coherent copy, ACL, hashes, manifest, verification
- `scripts/legacy/purge-legacy-source.ps1` — manifest-bound re-verification and exact source deletion
- `scripts/legacy/quarantine-legacy.test.mjs` — byte-level quarantine and purge regression tests
- `scripts/hygiene/check-repository.mjs` — forbidden tracked/runtime/generated file enforcement
- `scripts/hygiene/check-repository.test.mjs` — hygiene checker regression tests
- `scripts/testing/run-legacy-backend-tests.mjs` — disposable-copy wrapper for the pre-Stage-2 backend suite
- `scripts/validation/validate-extension.mjs` — baseline MV3 manifest and referenced-file validation
- `docs/release/requirements-evidence.md` — maintained requirement-to-evidence matrix
- `docs/release/stage-1-verification.md` — commands, outputs, recovery evidence, and gate decision
- `docs/security/credential-response.md` — Gemini revocation and quarantine sensitivity procedure
- `docs/security/git-history-remediation.md` — separate mirror-clone history purge procedure
- `SECURITY.md` — repository security and disclosure policy

### Modify

- `.gitignore` — complete secrets, runtime, native, build, test, log, and export exclusions
- `.prettierignore` — exclude generated and quarantined material from formatting
- `backend/package.json` — workspace version, exact dependencies, local binaries, Node engine
- `desktop/package.json` — workspace version, exact Electron/build tooling, Node engine
- `backend/.env.example` — placeholder-only configuration, no key-like example
- `.github/workflows/ci.yml` — Node 24 clean install, secret scan, hygiene, lint, format, and tests
- `README.md` — point to the supported Node/workspace workflow and remove dependency-install ambiguity

### Delete after verified quarantine

- `backend/.env`
- `backend/data/easy-rewind.db`
- `backend/data/easy-rewind.db-wal`
- `backend/data/easy-rewind.db-shm`
- `backend/data/settings.json`
- `backend/.git/`
- `backend/node_modules/`
- `backend/package-lock.json`
- `tmp_test.js`

No `backend/data/.gitkeep` is needed: the backend already creates its runtime
directory, and Stage 2 will move the default outside the repository.

### Preserve untouched

Pre-existing unrelated `.agents` and `.claude` worktree changes are user-owned.
Every `git add` command below names Stage 1 paths explicitly.

## Compatibility matrix

Stage 1 pins versions without performing the Stage 3 AI SDK migration or the
Stage 6 Electron lifecycle/package repair.

| Component | Pin | Stage 1 rationale |
|---|---:|---|
| Node.js | 24.18.0 | selected LTS for development, CI, standalone |
| npm | 11.6.2 | one documented package manager |
| Electron | 43.2.0 | selected packaged runtime; verified with native modules in Stage 6 |
| Electron Builder | 26.15.3 | current stable builder line |
| `@electron/rebuild` | 4.2.0 | explicit native ABI rebuild tool |
| `better-sqlite3` | 13.0.1 | supported Node line; Electron ABI verification deferred to Stage 6 |
| Jest | 30.4.2 | existing test major, exact pin |
| ESLint | 10.7.0 | Node 24-compatible exact pin |
| Prettier | 3.9.6 | exact formatting tool |
| Secretlint and preset | 13.0.4 | local and CI secret scan |

`@google/generative-ai` remains pinned at `0.24.1` only long enough to preserve
current behavior; Stage 3 replaces it with `@google/genai` behind the provider
boundary.

### Task 1: Establish the Stage 1 evidence ledger

**Files:**
- Create: `docs/release/requirements-evidence.md`
- Create: `docs/release/stage-1-verification.md`

- [ ] **Step 1: Create the requirement-to-evidence matrix**

Create `docs/release/requirements-evidence.md` with this initial content:

```markdown
# Easy Rewind Requirement-to-Evidence Matrix

Statuses: `not-started`, `failing`, `implemented`, `verified`, `blocked`.

| ID | Requirement | Stage | Status | Implementation | Test/command | Evidence | Recovery |
|---|---|---:|---|---|---|---|---|
| S1-01 | Stop only Easy Rewind backend/Electron processes before backup | 1 | not-started | `scripts/legacy/quarantine-legacy.ps1` | `npm run test:containment` | Stage 1 report | Relaunch only after purge |
| S1-02 | Copy DB/WAL/SHM/settings together before opening SQLite | 1 | not-started | containment script | fixture and live manifest checks | quarantine manifest | Preserve quarantine |
| S1-03 | Restrict quarantine to current Windows user | 1 | not-started | containment script | ACL assertion and `Get-Acl` | Stage 1 report | Abort before purge |
| S1-04 | Record UTC backup time, source paths, sizes, and SHA-256 | 1 | not-started | containment script | manifest assertions | `manifest.json` | Regenerate before purge |
| S1-05 | Exclude sensitive/runtime data from Git, builds, exports, logs, tests | 1 | not-started | ignores and hygiene checker | `npm run check:hygiene` | Stage 1 report | Restore ignore rules |
| S1-06 | Purge DB/WAL/SHM/settings and real `.env` from worktree | 1 | not-started | purge script and exact removal | source absence assertions | Stage 1 report | Restore only from quarantine copy |
| S1-07 | Remove nested Git repository and generated dependencies | 1 | not-started | exact cleanup commands | hygiene checker | Stage 1 report | Reinstall with `npm ci` |
| S1-08 | Add placeholder-only `.env.example` | 1 | not-started | `backend/.env.example` | Secretlint | Stage 1 report | Recreate from tracked example |
| S1-09 | Select Node LTS, engines, exact dependency pins, one lockfile | 1 | not-started | workspace manifests | `npm ci`; version checks | Stage 1 report | Revert manifests/lock together |
| S1-10 | Root scripts install, develop, lint, format, unit/integration test, validate extension, build, package Windows, verify, and scan | 1 | not-started | root `package.json` | `npm run verify` | Stage 1 report | Run component commands directly |
| S1-11 | Add CI secret scanning and repository hygiene | 1 | not-started | `.github/workflows/ci.yml` | workflow lint/readback | CI run URL | Revert CI separately |
| S1-12 | Document Git-history purge separately | 1 | not-started | history guide | command review | Stage 1 report | Mirror backup before rewrite |
| S1-13 | Require Gemini key revocation and replacement | 1 | not-started | credential response guide | manual confirmation | user-controlled evidence | Revoke again if uncertain |
| S1-14 | Never migrate or import during Stage 1 | 1 | not-started | design and containment boundary | source inspection | Stage 1 report | Stop and discard working copy |
```

- [ ] **Step 2: Create the verification report template**

Create `docs/release/stage-1-verification.md`:

```markdown
# Stage 1 Verification Report

Date:
Operator:
Repository commit:
Node:
npm:

## Safety preflight

- [ ] Exact repository root recorded
- [ ] Matching Easy Rewind processes identified and stopped
- [ ] No unrelated Node/Electron process stopped
- [ ] SQLite database has not been opened by Stage 1 tooling

## Quarantine evidence

- Quarantine directory:
- Manifest path:
- Backup UTC:
- Source file count:
- Hash/size verification:
- Owner:
- Inheritance disabled:
- Unexpected ACL entries:

## Purge evidence

- [ ] Legacy DB absent from repository
- [ ] WAL absent from repository
- [ ] SHM absent from repository
- [ ] Legacy settings absent from repository
- [ ] Real `.env` absent from repository
- [ ] Nested `backend/.git` absent
- [ ] Repository `node_modules` absent before clean install
- [ ] Obsolete temporary script absent

## Workspace evidence

| Command | Exit | Evidence summary |
|---|---:|---|
| `node --version` |  |  |
| `npm --version` |  |  |
| `npm ci` |  |  |
| `npm run scan:secrets` |  |  |
| `npm run check:hygiene` |  |  |
| `npm run lint` |  |  |
| `npm run format:check` |  |  |
| `npm test` |  |  |
| `npm run verify` |  |  |

## Recovery rehearsal

- [ ] Quarantine manifest re-verifies
- [ ] A separate disposable copy can be created without opening the preserved copy
- [ ] The only preserved copy was not modified
- [ ] Recovery procedure is documented

## External actions

- [ ] Exposed Gemini key revoked
- [ ] Replacement key not stored in repository or quarantine
- [ ] Git-history rewrite scheduled/performed separately

## Exit gate

- Tests:
- Verification evidence:
- Release blockers in Stage 1 scope:
- Rollback/recovery:
- Requirement matrix updated:
- Decision: `PASS` / `FAIL`
```

- [ ] **Step 3: Verify the ledger covers every Stage 1 design requirement**

Run:

```powershell
rg -n "S1-0[1-9]|S1-1[0-4]|Quarantine evidence|Exit gate" docs/release
```

Expected: all 14 identifiers and both verification sections are listed.

- [ ] **Step 4: Commit only the evidence scaffolding**

```powershell
git add docs/release/requirements-evidence.md docs/release/stage-1-verification.md
git commit -m "docs: add stage one evidence ledger"
```

### Task 2: Add failing containment regression tests

**Files:**
- Create: `scripts/legacy/quarantine-legacy.test.mjs`
- Test: `scripts/legacy/quarantine-legacy.test.mjs`

- [ ] **Step 1: Write the byte-preservation and manifest tests**

Create `scripts/legacy/quarantine-legacy.test.mjs`:

```js
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import {
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
import { createHash } from 'node:crypto';

const repositoryRoot = resolve(import.meta.dirname, '..', '..');
const quarantineScript = join(
  repositoryRoot,
  'scripts',
  'legacy',
  'quarantine-legacy.ps1'
);
const purgeScript = join(
  repositoryRoot,
  'scripts',
  'legacy',
  'purge-legacy-source.ps1'
);
const tempRoots = [];

function newFixture() {
  const root = mkdtempSync(join(tmpdir(), 'easy-rewind-containment-'));
  tempRoots.push(root);
  const sourceRoot = join(root, 'repo');
  const dataRoot = join(sourceRoot, 'backend', 'data');
  const quarantineRoot = join(root, 'local-app-data', 'easy-rewind', 'legacy-backup');
  mkdirSync(dataRoot, { recursive: true });

  const files = new Map([
    ['easy-rewind.db', Buffer.from([0x53, 0x51, 0x4c, 0x69, 0x74, 0x65])],
    ['easy-rewind.db-wal', Buffer.from([0x37, 0x7f, 0x06, 0x82, 0x01])],
    ['easy-rewind.db-shm', Buffer.from([0x18, 0xe2, 0x2d, 0x00])],
    ['settings.json', Buffer.from('{"legacy":true}\\n', 'utf8')],
  ]);

  for (const [name, bytes] of files) {
    writeFileSync(join(dataRoot, name), bytes);
  }

  return { root, sourceRoot, dataRoot, quarantineRoot, files };
}

function runPowerShell(script, args) {
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...args],
    { cwd: repositoryRoot, encoding: 'utf8' }
  );
  return result;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex').toUpperCase();
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

test('quarantine copies the coherent set byte-for-byte and writes a safe manifest', () => {
  const fixture = newFixture();
  const result = runPowerShell(quarantineScript, [
    '-SourceRoot',
    fixture.sourceRoot,
    '-QuarantineRoot',
    fixture.quarantineRoot,
    '-Timestamp',
    '20260724T120000000Z',
  ]);

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.sensitive, true);
  assert.equal(output.files.length, 4);
  assert.match(output.backupTimeUtc, /Z$/);
  assert.equal(output.sqliteOpened, false);
  assert.equal(basename(output.quarantinePath), '20260724T120000000Z');

  for (const entry of output.files) {
    const original = fixture.files.get(entry.name);
    assert.ok(original, `unexpected manifest entry ${entry.name}`);
    assert.equal(entry.size, original.byteLength);
    assert.equal(entry.sha256, sha256(original));
    assert.deepEqual(
      readFileSync(join(output.quarantinePath, entry.backupRelativePath)),
      original
    );
  }

  assert.equal(existsSync(output.manifestPath), true);
});

test('quarantine fails closed if any SQLite companion is absent', () => {
  const fixture = newFixture();
  rmSync(join(fixture.dataRoot, 'easy-rewind.db-wal'));

  const result = runPowerShell(quarantineScript, [
    '-SourceRoot',
    fixture.sourceRoot,
    '-QuarantineRoot',
    fixture.quarantineRoot,
    '-Timestamp',
    '20260724T120000001Z',
  ]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /required legacy file is missing/i);
  assert.equal(existsSync(fixture.quarantineRoot), false);
});

test('manifest-bound purge refuses tampered backups and preserves every source', () => {
  const fixture = newFixture();
  const backup = runPowerShell(quarantineScript, [
    '-SourceRoot',
    fixture.sourceRoot,
    '-QuarantineRoot',
    fixture.quarantineRoot,
    '-Timestamp',
    '20260724T120000002Z',
  ]);
  assert.equal(backup.status, 0, backup.stderr);
  const manifest = JSON.parse(backup.stdout);
  writeFileSync(
    join(manifest.quarantinePath, manifest.files[0].backupRelativePath),
    'tampered'
  );

  const purge = runPowerShell(purgeScript, [
    '-ManifestPath',
    manifest.manifestPath,
    '-Confirm:$false',
  ]);

  assert.notEqual(purge.status, 0);
  assert.match(purge.stderr, /backup checksum mismatch/i);
  for (const name of fixture.files.keys()) {
    assert.equal(existsSync(join(fixture.dataRoot, name)), true);
  }
});

test('manifest-bound purge removes only verified source files', () => {
  const fixture = newFixture();
  const unrelated = join(fixture.dataRoot, 'keep-me.txt');
  writeFileSync(unrelated, 'keep');
  const backup = runPowerShell(quarantineScript, [
    '-SourceRoot',
    fixture.sourceRoot,
    '-QuarantineRoot',
    fixture.quarantineRoot,
    '-Timestamp',
    '20260724T120000003Z',
  ]);
  assert.equal(backup.status, 0, backup.stderr);
  const manifest = JSON.parse(backup.stdout);

  const purge = runPowerShell(purgeScript, [
    '-ManifestPath',
    manifest.manifestPath,
    '-Confirm:$false',
  ]);

  assert.equal(purge.status, 0, purge.stderr);
  for (const name of fixture.files.keys()) {
    assert.equal(existsSync(join(fixture.dataRoot, name)), false);
  }
  assert.equal(readFileSync(unrelated, 'utf8'), 'keep');
});
```

- [ ] **Step 2: Run the tests and verify they fail because the scripts do not exist**

Run:

```powershell
node --test scripts/legacy/quarantine-legacy.test.mjs
```

Expected: four failed tests with PowerShell reporting that
`quarantine-legacy.ps1` or `purge-legacy-source.ps1` does not exist.

- [ ] **Step 3: Commit the red tests**

```powershell
git add scripts/legacy/quarantine-legacy.test.mjs
git commit -m "test: specify legacy containment guarantees"
```

### Task 3: Implement fail-closed quarantine and manifest-bound purge

**Files:**
- Create: `scripts/legacy/quarantine-legacy.ps1`
- Create: `scripts/legacy/purge-legacy-source.ps1`
- Test: `scripts/legacy/quarantine-legacy.test.mjs`

- [ ] **Step 1: Implement the quarantine tool**

Create `scripts/legacy/quarantine-legacy.ps1`:

```powershell
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$SourceRoot,

    [string]$QuarantineRoot,

    [string]$Timestamp = ([DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ'))
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Resolve-ExistingDirectory([string]$Path, [string]$Label) {
    if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
        throw "$Label directory does not exist: $Path"
    }
    return (Resolve-Path -LiteralPath $Path).Path
}

function Assert-NoEasyRewindProcess([string]$ResolvedSourceRoot) {
    if ($PSVersionTable.PSEdition -eq 'Core' -and -not $IsWindows) {
        return
    }

    $backendListenerPids = @(
        Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
            Where-Object { $_.LocalPort -eq 5000 } |
            Select-Object -ExpandProperty OwningProcess -Unique
    )
    $candidates = Get-CimInstance Win32_Process | Where-Object {
        $name = [string]$_.Name
        $commandLine = [string]$_.CommandLine
        $executablePath = [string]$_.ExecutablePath
        $isProductExecutable = $name -match '^easy[- ]?rewind.*\.exe$'
        $isGenericRuntime = $name -match '^(node|electron).*\.exe$'
        $isBackendListener =
            $name -match '^node.*\.exe$' -and
            $_.ProcessId -in $backendListenerPids -and
            $commandLine -match '(^|[\\/" ])server\.js([" ]|$)'
        $referencesRepository =
            $commandLine.IndexOf($ResolvedSourceRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0 -or
            $executablePath.IndexOf($ResolvedSourceRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0
        $isProductExecutable -or $isBackendListener -or ($isGenericRuntime -and $referencesRepository)
    }

    if ($candidates) {
        $ids = ($candidates | ForEach-Object { [string]$_.ProcessId }) -join ', '
        throw "Easy Rewind processes are still running (PIDs: $ids). Stop them before quarantine."
    }
}

function Set-CurrentUserOnlyAcl([string]$Path) {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $userSid = $identity.User
    if (-not $userSid) {
        throw 'Could not resolve the current Windows user SID.'
    }

    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetOwner($userSid)
    $acl.SetAccessRuleProtection($true, $false)
    $rule = New-Object Security.AccessControl.FileSystemAccessRule(
        $userSid,
        [Security.AccessControl.FileSystemRights]::FullControl,
        [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit',
        [Security.AccessControl.PropagationFlags]::None,
        [Security.AccessControl.AccessControlType]::Allow
    )
    [void]$acl.AddAccessRule($rule)
    Set-Acl -LiteralPath $Path -AclObject $acl

    $verified = Get-Acl -LiteralPath $Path
    $unexpected = @($verified.Access | Where-Object {
        $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -ne $userSid.Value
    })
    if (-not $verified.AreAccessRulesProtected -or $unexpected.Count -ne 0) {
        throw "Failed to restrict quarantine ACL to current user: $Path"
    }
}

$source = Resolve-ExistingDirectory $SourceRoot 'Source root'
Assert-NoEasyRewindProcess $source

if (-not $QuarantineRoot) {
    if (-not $env:LOCALAPPDATA) {
        throw 'LOCALAPPDATA is required when QuarantineRoot is not supplied.'
    }
    $QuarantineRoot = Join-Path $env:LOCALAPPDATA 'easy-rewind\legacy-backup'
}

$dataRoot = Join-Path $source 'backend\data'
$requiredNames = @(
    'easy-rewind.db',
    'easy-rewind.db-wal',
    'easy-rewind.db-shm',
    'settings.json'
)

$sourceFiles = foreach ($name in $requiredNames) {
    $path = Join-Path $dataRoot $name
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Required legacy file is missing: $path"
    }
    Get-Item -LiteralPath $path
}

$destination = Join-Path ([IO.Path]::GetFullPath($QuarantineRoot)) $Timestamp
if (Test-Path -LiteralPath $destination) {
    throw "Quarantine destination already exists: $destination"
}

$null = New-Item -ItemType Directory -Path $destination
try {
    Set-CurrentUserOnlyAcl $destination
    $entries = @()

    foreach ($sourceFile in $sourceFiles) {
        $backupName = $sourceFile.Name
        $backupPath = Join-Path $destination $backupName
        Copy-Item -LiteralPath $sourceFile.FullName -Destination $backupPath

        $sourceHash = (Get-FileHash -LiteralPath $sourceFile.FullName -Algorithm SHA256).Hash
        $backupHash = (Get-FileHash -LiteralPath $backupPath -Algorithm SHA256).Hash
        $backupFile = Get-Item -LiteralPath $backupPath

        if ($sourceFile.Length -ne $backupFile.Length) {
            throw "Backup size mismatch for $($sourceFile.FullName)"
        }
        if ($sourceHash -ne $backupHash) {
            throw "Backup checksum mismatch for $($sourceFile.FullName)"
        }

        $entries += [ordered]@{
            name = $sourceFile.Name
            originalPath = $sourceFile.FullName
            backupRelativePath = $backupName
            size = [long]$backupFile.Length
            sha256 = $backupHash
        }
    }

    $manifestPath = Join-Path $destination 'manifest.json'
    $manifest = [ordered]@{
        schemaVersion = 1
        sensitive = $true
        warning = 'Contains sensitive personal legacy data. Not secure credential storage.'
        backupTimeUtc = [DateTime]::UtcNow.ToString('o')
        sqliteOpened = $false
        sourceRoot = $source
        quarantinePath = $destination
        manifestPath = $manifestPath
        files = $entries
    }
    $manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $manifestPath -Encoding UTF8
    Set-CurrentUserOnlyAcl $destination

    $manifest | ConvertTo-Json -Depth 6
}
catch {
    if (Test-Path -LiteralPath $destination) {
        Remove-Item -LiteralPath $destination -Recurse -Force
    }
    throw
}
```

- [ ] **Step 2: Implement manifest-bound purge**

Create `scripts/legacy/purge-legacy-source.ps1`:

```powershell
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
    [Parameter(Mandatory = $true)]
    [string]$ManifestPath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$resolvedManifest = (Resolve-Path -LiteralPath $ManifestPath).Path
$manifest = Get-Content -Raw -LiteralPath $resolvedManifest | ConvertFrom-Json

if ($manifest.schemaVersion -ne 1 -or $manifest.sensitive -ne $true) {
    throw 'The supplied file is not a supported sensitive quarantine manifest.'
}
if ($manifest.sqliteOpened -ne $false) {
    throw 'The quarantine manifest does not prove that SQLite remained unopened.'
}

$quarantinePath = (Resolve-Path -LiteralPath $manifest.quarantinePath).Path
if (-not $resolvedManifest.StartsWith(
    $quarantinePath + [IO.Path]::DirectorySeparatorChar,
    [StringComparison]::OrdinalIgnoreCase
)) {
    throw 'Manifest path is outside its declared quarantine directory.'
}

$allowedNames = @(
    'easy-rewind.db',
    'easy-rewind.db-wal',
    'easy-rewind.db-shm',
    'settings.json'
)
$entries = @($manifest.files)
if ($entries.Count -ne 4) {
    throw 'The quarantine manifest must contain exactly four legacy files.'
}

foreach ($entry in $entries) {
    if ($entry.name -notin $allowedNames) {
        throw "Unexpected manifest entry: $($entry.name)"
    }

    $sourcePath = [IO.Path]::GetFullPath([string]$entry.originalPath)
    $backupPath = [IO.Path]::GetFullPath(
        (Join-Path $quarantinePath ([string]$entry.backupRelativePath))
    )
    $expectedSourceRoot = [IO.Path]::GetFullPath(
        (Join-Path ([string]$manifest.sourceRoot) 'backend\data')
    )
    if (-not $sourcePath.StartsWith(
        $expectedSourceRoot + [IO.Path]::DirectorySeparatorChar,
        [StringComparison]::OrdinalIgnoreCase
    )) {
        throw "Source path escapes backend data root: $sourcePath"
    }
    if (-not $backupPath.StartsWith(
        $quarantinePath + [IO.Path]::DirectorySeparatorChar,
        [StringComparison]::OrdinalIgnoreCase
    )) {
        throw "Backup path escapes quarantine root: $backupPath"
    }
    if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
        throw "Source file is missing before purge: $sourcePath"
    }
    if (-not (Test-Path -LiteralPath $backupPath -PathType Leaf)) {
        throw "Backup file is missing before purge: $backupPath"
    }

    $sourceFile = Get-Item -LiteralPath $sourcePath
    $backupFile = Get-Item -LiteralPath $backupPath
    $backupHash = (Get-FileHash -LiteralPath $backupPath -Algorithm SHA256).Hash
    $sourceHash = (Get-FileHash -LiteralPath $sourcePath -Algorithm SHA256).Hash
    if ($backupFile.Length -ne [long]$entry.size -or $backupHash -ne $entry.sha256) {
        throw "Backup checksum mismatch for $backupPath"
    }
    if ($sourceFile.Length -ne [long]$entry.size -or $sourceHash -ne $entry.sha256) {
        throw "Source changed after quarantine: $sourcePath"
    }
}

foreach ($entry in $entries) {
    $sourcePath = [IO.Path]::GetFullPath([string]$entry.originalPath)
    if ($PSCmdlet.ShouldProcess($sourcePath, 'Remove verified legacy source file')) {
        Remove-Item -LiteralPath $sourcePath -Force
    }
}

[ordered]@{
    purged = $true
    manifestPath = $resolvedManifest
    removed = @($entries | ForEach-Object { $_.originalPath })
} | ConvertTo-Json -Depth 4
```

- [ ] **Step 3: Run the containment regression tests**

Run:

```powershell
node --test scripts/legacy/quarantine-legacy.test.mjs
```

Expected: four tests pass. No test path points at the repository database or
`%LOCALAPPDATA%`.

- [ ] **Step 4: Review the scripts for prohibited SQLite access**

Run:

```powershell
rg -n "better-sqlite3|sqlite3|Database\\(|journal_mode|wal_checkpoint|ATTACH|VACUUM" scripts/legacy
```

Expected: no matches.

- [ ] **Step 5: Commit the green containment tools**

```powershell
git add scripts/legacy/quarantine-legacy.ps1 scripts/legacy/purge-legacy-source.ps1
git commit -m "feat: add verified legacy quarantine workflow"
```

### Task 4: Execute quarantine before repository purge

**Files:**
- Read only: `backend/data/easy-rewind.db`
- Read only: `backend/data/easy-rewind.db-wal`
- Read only: `backend/data/easy-rewind.db-shm`
- Read only: `backend/data/settings.json`
- External create: `%LOCALAPPDATA%\easy-rewind\legacy-backup\<timestamp>\`
- Modify: `docs/release/stage-1-verification.md`
- Modify: `docs/release/requirements-evidence.md`

- [ ] **Step 1: Record exact candidate processes without exposing command-line secrets**

Run:

```powershell
$repo = (Resolve-Path '.').Path
$backendListenerPids = @(
  Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
    Where-Object { $_.LocalPort -eq 5000 } |
    Select-Object -ExpandProperty OwningProcess -Unique
)
Get-CimInstance Win32_Process |
  Where-Object {
    $_.Name -match '^easy[- ]?rewind.*\.exe$' -or
    (
      $_.Name -match '^node.*\.exe$' -and
      $_.ProcessId -in $backendListenerPids -and
      ([string]$_.CommandLine) -match '(^|[\\/" ])server\.js([" ]|$)'
    ) -or
    (
      $_.Name -match '^(node|electron).*\.exe$' -and
      (
        ([string]$_.CommandLine).IndexOf($repo, [StringComparison]::OrdinalIgnoreCase) -ge 0 -or
        ([string]$_.ExecutablePath).IndexOf($repo, [StringComparison]::OrdinalIgnoreCase) -ge 0
      )
    )
  } |
  Select-Object ProcessId, Name, ExecutablePath
```

Expected: only Easy Rewind-associated candidates. Do not print `CommandLine`.

- [ ] **Step 2: Stop only the reviewed Easy Rewind candidates**

Run the same filter and stop its resolved PIDs:

```powershell
$repo = (Resolve-Path '.').Path
$backendListenerPids = @(
  Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
    Where-Object { $_.LocalPort -eq 5000 } |
    Select-Object -ExpandProperty OwningProcess -Unique
)
$easyRewindProcesses = @(
  Get-CimInstance Win32_Process |
    Where-Object {
      $_.Name -match '^easy[- ]?rewind.*\.exe$' -or
      (
        $_.Name -match '^node.*\.exe$' -and
        $_.ProcessId -in $backendListenerPids -and
        ([string]$_.CommandLine) -match '(^|[\\/" ])server\.js([" ]|$)'
      ) -or
      (
        $_.Name -match '^(node|electron).*\.exe$' -and
        (
          ([string]$_.CommandLine).IndexOf($repo, [StringComparison]::OrdinalIgnoreCase) -ge 0 -or
          ([string]$_.ExecutablePath).IndexOf($repo, [StringComparison]::OrdinalIgnoreCase) -ge 0
        )
      )
    }
)
$easyRewindProcesses | ForEach-Object {
  Stop-Process -Id $_.ProcessId -ErrorAction Stop
}
```

Expected: command succeeds. Re-run Step 1 and expect no rows. Never use
`taskkill /IM node.exe` or terminate unrelated Node/Electron processes.

- [ ] **Step 3: Run quarantine with the default protected destination**

This command writes outside the repository and therefore requires the explicit
filesystem approval presented by the execution environment:

```powershell
$sourceRoot = (Resolve-Path '.').Path
$quarantineJson = & .\scripts\legacy\quarantine-legacy.ps1 -SourceRoot $sourceRoot
$quarantine = $quarantineJson | ConvertFrom-Json
$quarantinePointer = Join-Path $env:TEMP 'easy-rewind-quarantine-manifest-path.txt'
$quarantine.manifestPath | Set-Content -LiteralPath $quarantinePointer -Encoding UTF8
$quarantine.manifestPath
```

Expected: an absolute path matching
`%LOCALAPPDATA%\easy-rewind\legacy-backup\<timestamp>\manifest.json`.

- [ ] **Step 4: Independently verify owner, ACL, sizes, and hashes**

Run:

```powershell
$quarantinePointer = Join-Path $env:TEMP 'easy-rewind-quarantine-manifest-path.txt'
$manifestPath = (Get-Content -Raw -LiteralPath $quarantinePointer).Trim()
$manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
$acl = Get-Acl -LiteralPath $manifest.quarantinePath
$currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$unexpectedAcl = @(
  $acl.Access | Where-Object {
    $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -ne $currentSid
  }
)
if (-not $acl.AreAccessRulesProtected) { throw 'Quarantine ACL inheritance is enabled.' }
if ($unexpectedAcl.Count -ne 0) { throw 'Quarantine has unexpected ACL entries.' }
foreach ($entry in $manifest.files) {
  $backup = Join-Path $manifest.quarantinePath $entry.backupRelativePath
  $item = Get-Item -LiteralPath $backup
  $hash = (Get-FileHash -LiteralPath $backup -Algorithm SHA256).Hash
  if ($item.Length -ne $entry.size -or $hash -ne $entry.sha256) {
    throw "Verification failed: $backup"
  }
}
'QUARANTINE_VERIFIED'
```

Expected: `QUARANTINE_VERIFIED`.

- [ ] **Step 5: Purge only the manifest-bound legacy source set**

Run:

```powershell
$quarantinePointer = Join-Path $env:TEMP 'easy-rewind-quarantine-manifest-path.txt'
$manifestPath = (Get-Content -Raw -LiteralPath $quarantinePointer).Trim()
& .\scripts\legacy\purge-legacy-source.ps1 -ManifestPath $manifestPath -Confirm:$false
```

Expected: JSON with `"purged": true` and exactly four removed source paths.

- [ ] **Step 6: Verify the quarantine remains and all four sources are absent**

Run:

```powershell
$quarantinePointer = Join-Path $env:TEMP 'easy-rewind-quarantine-manifest-path.txt'
$manifestPath = (Get-Content -Raw -LiteralPath $quarantinePointer).Trim()
$manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
foreach ($entry in $manifest.files) {
  if (Test-Path -LiteralPath $entry.originalPath) {
    throw "Legacy source still exists: $($entry.originalPath)"
  }
  $backup = Join-Path $manifest.quarantinePath $entry.backupRelativePath
  if (-not (Test-Path -LiteralPath $backup -PathType Leaf)) {
    throw "Quarantine backup is missing: $backup"
  }
}
'SOURCE_PURGED_BACKUP_PRESERVED'
```

Expected: `SOURCE_PURGED_BACKUP_PRESERVED`.

- [ ] **Step 7: Update S1-01 through S1-06 and the verification report**

Record only the quarantine directory and non-sensitive aggregate evidence.
Never paste settings contents, browsing data, note text, or the old key.

- [ ] **Step 8: Commit the evidence update**

```powershell
git add docs/release/requirements-evidence.md docs/release/stage-1-verification.md
git commit -m "docs: record verified legacy containment"
```

### Task 5: Enforce repository hygiene and purge generated/sensitive material

**Files:**
- Create: `scripts/hygiene/check-repository.test.mjs`
- Create: `scripts/hygiene/check-repository.mjs`
- Modify: `.gitignore`
- Create: `.prettierignore`
- Delete: `backend/.env`
- Delete: `backend/.git/`
- Delete: `backend/node_modules/`
- Delete: `tmp_test.js`
- Test: `scripts/hygiene/check-repository.test.mjs`

- [ ] **Step 1: Write the failing hygiene tests**

Create `scripts/hygiene/check-repository.test.mjs`:

```js
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const checker = new URL('./check-repository.mjs', import.meta.url).pathname.slice(1);
const roots = [];

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'easy-rewind-hygiene-'));
  roots.push(root);
  for (const [relativePath, value] of Object.entries(files)) {
    const path = join(root, relativePath);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, value);
  }
  return root;
}

function check(root) {
  return spawnSync(process.execPath, [checker, '--root', root, '--filesystem'], {
    encoding: 'utf8',
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

test('accepts placeholder examples and source files', () => {
  const root = fixture({
    'backend/.env.example': 'GEMINI_API_KEY=replace-with-your-key\\n',
    'backend/server.js': 'export const ok = true;\\n',
  });
  assert.equal(check(root).status, 0);
});

for (const forbidden of [
  'backend/.env',
  'backend/data/easy-rewind.db',
  'backend/data/easy-rewind.db-wal',
  'backend/data/easy-rewind.db-shm',
  'backend/data/settings.json',
  'backend/.git/config',
  'backend/node_modules/example/index.js',
  'dist/personal-export.json',
  'logs/backend.log',
]) {
  test(`rejects ${forbidden}`, () => {
    const root = fixture({ [forbidden]: 'sensitive-or-generated' });
    const result = check(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(forbidden.replaceAll('/', '[\\\\\\\\/]')));
  });
}
```

- [ ] **Step 2: Run the tests and verify they fail**

Run:

```powershell
node --test scripts/hygiene/check-repository.test.mjs
```

Expected: failures because `check-repository.mjs` does not exist.

- [ ] **Step 3: Implement the hygiene checker**

Create `scripts/hygiene/check-repository.mjs`:

```js
import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const rootIndex = process.argv.indexOf('--root');
const root = resolve(rootIndex >= 0 ? process.argv[rootIndex + 1] : '.');
const filesystemMode = process.argv.includes('--filesystem');

const forbiddenExact = new Set([
  '.env',
  'backend/.env',
  'backend/data/easy-rewind.db',
  'backend/data/easy-rewind.db-wal',
  'backend/data/easy-rewind.db-shm',
  'backend/data/settings.json',
  'tmp_test.js',
]);
const forbiddenSegments = new Set([
  'node_modules',
  'dist',
  'build',
  'logs',
  'exports',
  'legacy-backup',
]);
const forbiddenSuffixes = [
  '.db',
  '.db-wal',
  '.db-shm',
  '.sqlite',
  '.sqlite-wal',
  '.sqlite-shm',
  '.log',
  '.node',
];

function normalize(path) {
  return path.split(sep).join('/');
}

function isForbidden(relativePath) {
  const normalized = normalize(relativePath);
  const segments = normalized.split('/');
  if (forbiddenExact.has(normalized)) return true;
  if (segments.some(segment => forbiddenSegments.has(segment))) return true;
  if (segments.includes('.git') && normalized !== '.git') return true;
  if (
    basename(normalized).startsWith('.env') &&
    !normalized.endsWith('.env.example')
  ) {
    return true;
  }
  return forbiddenSuffixes.some(suffix => normalized.endsWith(suffix));
}

function walk(directory) {
  const results = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === '.git' && directory === root) continue;
    const absolute = join(directory, entry.name);
    const rel = relative(root, absolute);
    results.push(rel);
    if (entry.isDirectory()) results.push(...walk(absolute));
  }
  return results;
}

let candidates;
if (filesystemMode || !existsSync(join(root, '.git'))) {
  candidates = walk(root);
} else {
  const git = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
    cwd: root,
    encoding: 'utf8',
  });
  if (git.status !== 0) {
    process.stderr.write(git.stderr);
    process.exit(git.status ?? 1);
  }
  candidates = git.stdout.split(/\r?\n/).filter(Boolean);
}

const violations = candidates
  .filter(isForbidden)
  .filter(path => {
    const absolute = join(root, path);
    return existsSync(absolute) && statSync(absolute).isFile();
  })
  .sort();

if (violations.length > 0) {
  process.stderr.write(
    `Forbidden repository material detected:\n${violations.join('\n')}\n`
  );
  process.exit(1);
}

process.stdout.write('Repository hygiene check passed.\n');
```

- [ ] **Step 4: Run the hygiene tests**

Run:

```powershell
node --test scripts/hygiene/check-repository.test.mjs
```

Expected: ten tests pass.

- [ ] **Step 5: Replace `.gitignore` with comprehensive exclusions**

Use this exact `.gitignore`:

```gitignore
# Dependencies and package-manager caches
node_modules/
.npm/
.npm-cache/
.yarn/
.pnpm-store/

# Credentials and local configuration
.env
.env.*
!.env.example
**/.env
**/.env.*
!**/.env.example
**/settings.json
**/secrets.json
**/credentials.json

# Runtime databases and SQLite companions
*.db
*.db-wal
*.db-shm
*.sqlite
*.sqlite-wal
*.sqlite-shm
**/data/*
!**/data/.gitkeep

# Sensitive quarantine and migration working copies
legacy-backup/
**/legacy-backup/
quarantine/
**/quarantine/
migration-work/
**/migration-work/

# Logs, diagnostics, exports, coverage, and temporary test data
*.log
logs/
diagnostics/
exports/
coverage/
.nyc_output/
test-results/
playwright-report/
tmp/
temp/
*.tmp

# Build and release outputs
dist/
build/
out/
release/
artifacts/
*.zip
*.7z
*.tar
*.tar.gz
*.exe
*.msi
*.appx
*.blockmap
*.node

# Native build intermediates
**/build/Release/
**/prebuilds/
*.obj
*.pdb

# Nested repositories
**/.git/
!.git/

# Operating-system and editor files
.DS_Store
Thumbs.db
desktop.ini
.vscode/
.idea/
*.swp
*.swo
```

- [ ] **Step 6: Add `.prettierignore`**

```text
node_modules
dist
build
out
release
artifacts
coverage
logs
exports
legacy-backup
quarantine
migration-work
backend/data
package-lock.json
```

- [ ] **Step 7: Remove only the approved sensitive/generated targets**

First verify resolved paths:

```powershell
$repo = (Resolve-Path '.').Path
$targets = @(
  'backend\.env',
  'backend\.git',
  'backend\node_modules',
  'tmp_test.js'
)
foreach ($relative in $targets) {
  $candidate = [IO.Path]::GetFullPath((Join-Path $repo $relative))
  if (-not $candidate.StartsWith($repo + [IO.Path]::DirectorySeparatorChar)) {
    throw "Target escapes repository: $candidate"
  }
  [pscustomobject]@{ Relative = $relative; Resolved = $candidate; Exists = Test-Path -LiteralPath $candidate }
}
```

After verifying the table, remove the exact targets in PowerShell:

```powershell
$repo = (Resolve-Path '.').Path
foreach ($relative in @('backend\.env', 'backend\.git', 'backend\node_modules', 'tmp_test.js')) {
  $candidate = [IO.Path]::GetFullPath((Join-Path $repo $relative))
  if (-not $candidate.StartsWith($repo + [IO.Path]::DirectorySeparatorChar)) {
    throw "Target escapes repository: $candidate"
  }
  if (Test-Path -LiteralPath $candidate) {
    Remove-Item -LiteralPath $candidate -Recurse -Force
  }
}
```

Expected: the four targets are absent. The root `.git` remains present.

- [ ] **Step 8: Run the repository hygiene checker**

Run:

```powershell
node scripts/hygiene/check-repository.mjs
```

Expected: `Repository hygiene check passed.`

- [ ] **Step 9: Commit only hygiene files and approved deletions**

```powershell
git add .gitignore .prettierignore scripts/hygiene/check-repository.mjs scripts/hygiene/check-repository.test.mjs
git add -A -- backend/data tmp_test.js
git commit -m "chore: enforce repository hygiene"
```

The untracked ignored `.env`, nested `.git`, and `node_modules` deletions do not
appear in the commit; their absence is recorded in verification evidence.

### Task 6: Normalize the npm workspace and exact dependency graph

**Files:**
- Create: `package.json`
- Create: `.nvmrc`
- Create: `.npmrc`
- Create: `.secretlintrc.json`
- Create: `.secretlintignore`
- Create: `scripts/testing/run-legacy-backend-tests.mjs`
- Create: `scripts/validation/validate-extension.mjs`
- Modify: `backend/package.json`
- Modify: `desktop/package.json`
- Modify: `backend/.env.example`
- Delete: `backend/package-lock.json`
- Create: `package-lock.json`

- [ ] **Step 1: Add the root workspace manifest**

Create `package.json`:

```json
{
  "name": "easy-rewind",
  "version": "2.0.0",
  "private": true,
  "description": "Local-first learning assistant for Chrome and Windows",
  "engines": {
    "node": ">=24.18.0 <25",
    "npm": ">=11.6.2 <12"
  },
  "packageManager": "npm@11.6.2",
  "workspaces": [
    "backend",
    "desktop"
  ],
  "scripts": {
    "install:clean": "npm ci",
    "start": "npm run start --workspace=easy-rewind-backend",
    "dev": "npm run dev --workspace=easy-rewind-backend",
    "lint": "npm run lint --workspaces --if-present",
    "format": "prettier --write package.json .github backend/package.json desktop/package.json scripts docs README.md SECURITY.md",
    "format:check": "prettier --check package.json .github backend/package.json desktop/package.json scripts docs README.md SECURITY.md",
    "test": "npm run test:unit && npm run test:integration",
    "test:unit": "npm run test:containment && npm run test:hygiene",
    "test:integration": "npm run test:backend:legacy-safe",
    "test:containment": "node --test scripts/legacy/quarantine-legacy.test.mjs",
    "test:hygiene": "node --test scripts/hygiene/check-repository.test.mjs",
    "test:backend:legacy-safe": "node scripts/testing/run-legacy-backend-tests.mjs",
    "validate:extension": "node scripts/validation/validate-extension.mjs",
    "scan:secrets": "secretlint \"**/*\"",
    "check:hygiene": "node scripts/hygiene/check-repository.mjs",
    "build": "npm run validate:extension && node --check backend/server.js && node --check desktop/main.js",
    "verify": "npm run verify:stage1",
    "verify:stage1": "npm run scan:secrets && npm run check:hygiene && npm run lint && npm run format:check && npm test && npm run build",
    "desktop:dev": "npm run dev --workspace=easy-rewind-desktop",
    "desktop:build": "npm run build --workspace=easy-rewind-desktop",
    "package:windows": "npm run desktop:build"
  },
  "devDependencies": {
    "@secretlint/secretlint-rule-preset-recommend": "13.0.4",
    "prettier": "3.9.6",
    "secretlint": "13.0.4"
  }
}
```

- [ ] **Step 2: Pin the runtime and npm behavior**

Create `.nvmrc`:

```text
24.18.0
```

Create `.npmrc`:

```ini
engine-strict=true
fund=false
audit=true
save-exact=true
```

- [ ] **Step 3: Configure Secretlint**

Create `.secretlintrc.json`:

```json
{
  "rules": [
    {
      "id": "@secretlint/secretlint-rule-preset-recommend"
    }
  ]
}
```

Create `.secretlintignore`:

```text
node_modules/**
dist/**
build/**
out/**
release/**
artifacts/**
coverage/**
backend/data/**
legacy-backup/**
quarantine/**
migration-work/**
package-lock.json
```

- [ ] **Step 4: Replace the backend manifest with exact compatible pins**

Replace `backend/package.json`:

```json
{
  "name": "easy-rewind-backend",
  "version": "2.0.0",
  "private": true,
  "description": "Electron-independent local API and services for Easy Rewind",
  "main": "server.js",
  "engines": {
    "node": ">=24.18.0 <25",
    "npm": ">=11.6.2 <12"
  },
  "scripts": {
    "start": "node server.js",
    "dev": "nodemon server.js",
    "test": "node --experimental-vm-modules ../node_modules/jest/bin/jest.js --forceExit --detectOpenHandles",
    "test:watch": "node --experimental-vm-modules ../node_modules/jest/bin/jest.js --watch --forceExit",
    "lint": "eslint . --ignore-pattern node_modules/ --ignore-pattern tests/",
    "format": "prettier --write \"**/*.{js,json,css,html}\"",
    "format:check": "prettier --check \"**/*.{js,json,css,html}\""
  },
  "dependencies": {
    "@google/generative-ai": "0.24.1",
    "axios": "1.18.1",
    "better-sqlite3": "13.0.1",
    "cors": "2.8.6",
    "dotenv": "16.6.1",
    "express": "4.22.2",
    "express-rate-limit": "7.5.1",
    "nodemailer": "6.10.1"
  },
  "devDependencies": {
    "eslint": "10.7.0",
    "jest": "30.4.2",
    "nodemon": "3.1.14",
    "supertest": "7.2.2"
  }
}
```

The temporary `--forceExit` remains visible as a Stage 2 lifecycle defect; it is
not hidden by Stage 1. Stage 2 removes it after listener, interval, and database
handles become injectable and closeable.

- [ ] **Step 5: Add a disposable-copy runner for the legacy backend tests**

Create `scripts/testing/run-legacy-backend-tests.mjs`:

```js
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const repositoryRoot = resolve(import.meta.dirname, '..', '..');
const sourceBackend = join(repositoryRoot, 'backend');
const temporaryRoot = mkdtempSync(join(tmpdir(), 'easy-rewind-legacy-tests-'));
const temporaryBackend = join(temporaryRoot, 'backend');
const forbiddenSourcePaths = [
  join(sourceBackend, 'data', 'easy-rewind.db'),
  join(sourceBackend, 'data', 'easy-rewind.db-wal'),
  join(sourceBackend, 'data', 'easy-rewind.db-shm'),
  join(sourceBackend, 'data', 'settings.json'),
];

try {
  cpSync(sourceBackend, temporaryBackend, {
    recursive: true,
    filter(source) {
      const relative = source.slice(sourceBackend.length).replaceAll('\\', '/');
      return ![
        '/node_modules',
        '/.git',
        '/.env',
        '/data',
      ].some(excluded => relative === excluded || relative.startsWith(`${excluded}/`));
    },
  });

  const jest = join(repositoryRoot, 'node_modules', 'jest', 'bin', 'jest.js');
  const result = spawnSync(
    process.execPath,
    [
      '--experimental-vm-modules',
      jest,
      '--forceExit',
      '--detectOpenHandles',
      '--runInBand',
    ],
    {
      cwd: temporaryBackend,
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_ENV: 'test',
        NODE_PATH: [
          join(repositoryRoot, 'node_modules'),
          process.env.NODE_PATH,
        ].filter(Boolean).join(delimiter),
        DATABASE_PATH: join(temporaryRoot, 'runtime', 'test.db'),
        GEMINI_API_KEY: '',
        ALLOWED_ORIGINS: 'http://127.0.0.1:5000',
      },
    }
  );

  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');

  const leaked = forbiddenSourcePaths.filter(existsSync);
  if (leaked.length > 0) {
    process.stderr.write(
      `Legacy tests wrote into the repository:\n${leaked.join('\n')}\n`
    );
    process.exitCode = 1;
  } else {
    process.exitCode = result.status ?? 1;
  }
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
```

This wrapper records, but does not conceal, the existing listener/timer
open-handle output. It guarantees that the pre-Stage-2 suite can create files
only inside a disposable temporary copy.

- [ ] **Step 6: Add baseline extension validation**

Create `scripts/validation/validate-extension.mjs`:

```js
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const repositoryRoot = resolve(import.meta.dirname, '..', '..');
const extensionRoot = join(repositoryRoot, 'extension');
const manifestPath = join(extensionRoot, 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

assert.equal(manifest.manifest_version, 3, 'extension must use Manifest V3');
assert.equal(
  typeof manifest.background?.service_worker,
  'string',
  'manifest must declare a service worker'
);
assert.equal(
  typeof manifest.action?.default_popup,
  'string',
  'manifest must declare an action popup'
);

const referencedFiles = [
  manifest.background.service_worker,
  manifest.action.default_popup,
  ...(manifest.content_scripts ?? []).flatMap(script => script.js ?? []),
  ...Object.values(manifest.icons ?? {}),
  ...Object.values(manifest.action.icons ?? {}),
];

const missing = [...new Set(referencedFiles)].filter(
  relativePath => !existsSync(join(extensionRoot, relativePath))
);
assert.deepEqual(missing, [], `manifest references missing files: ${missing.join(', ')}`);

process.stdout.write(
  `Extension baseline validation passed (${referencedFiles.length} references).\n`
);
```

This is a structural Stage 1 gate only. Permission reduction, privacy controls,
service-worker recovery, and Chrome runtime validation remain Stage 4 work.

- [ ] **Step 7: Replace the desktop manifest with selected Electron pins**

Replace `desktop/package.json`:

```json
{
  "name": "easy-rewind-desktop",
  "version": "2.0.0",
  "private": true,
  "description": "Easy Rewind Windows tray and overlay lifecycle adapter",
  "main": "main.js",
  "engines": {
    "node": ">=24.18.0 <25",
    "npm": ">=11.6.2 <12"
  },
  "scripts": {
    "start": "electron .",
    "dev": "electron . --dev",
    "rebuild:native": "electron-rebuild -f -w better-sqlite3",
    "build": "npm run rebuild:native && electron-builder --win --config build.config.json"
  },
  "dependencies": {},
  "devDependencies": {
    "@electron/rebuild": "4.2.0",
    "electron": "43.2.0",
    "electron-builder": "26.15.3"
  }
}
```

- [ ] **Step 8: Make the environment example placeholder-only**

Replace `backend/.env.example`:

```dotenv
# Standalone development only. Packaged Electron supplies configuration directly.
HOST=127.0.0.1
PORT=5000
NODE_ENV=development
DATABASE_PATH=

# Optional. Leave empty to run without AI.
GEMINI_API_KEY=

# Comma-separated explicit development origins. Wildcards are not supported.
ALLOWED_ORIGINS=http://127.0.0.1:5000
```

- [ ] **Step 9: Remove the component lock and generate the root lock**

Run:

```powershell
Remove-Item -LiteralPath 'backend\package-lock.json'
npm.cmd install --package-lock-only
```

Expected: root `package-lock.json` is created, no component lock remains, and no
package manifest contains a caret or tilde dependency range.

- [ ] **Step 10: Perform a clean install from the root**

Run:

```powershell
if (Test-Path -LiteralPath 'node_modules') {
  Remove-Item -LiteralPath 'node_modules' -Recurse -Force
}
npm.cmd ci
```

Expected: exit 0 on Node 24.18.0/npm 11.6.2, with workspace dependencies
installed from the root lock.

- [ ] **Step 11: Verify dependency and version invariants**

Run:

```powershell
node --version
npm.cmd --version
npm.cmd ls --depth=0
node -e "const r=require('./package.json'); const b=require('./backend/package.json'); const d=require('./desktop/package.json'); if(new Set([r.version,b.version,d.version]).size!==1) process.exit(1)"
rg -n '\"[~^][0-9]' package.json backend/package.json desktop/package.json
```

Expected:

- Node prints `v24.18.0`
- npm prints `11.6.2`
- dependency tree exits 0 without extraneous packages
- version check exits 0
- `rg` returns no dependency-range matches

- [ ] **Step 12: Run the Stage 1 focused tests**

Run:

```powershell
npm.cmd run test:containment
npm.cmd run test:hygiene
npm.cmd run test:backend:legacy-safe
npm.cmd run validate:extension
npm.cmd run scan:secrets
npm.cmd run check:hygiene
npm.cmd run build
```

Expected: all commands exit 0.

- [ ] **Step 13: Commit workspace normalization**

```powershell
git add package.json package-lock.json .nvmrc .npmrc .secretlintrc.json .secretlintignore backend/package.json desktop/package.json backend/.env.example backend/package-lock.json scripts/testing/run-legacy-backend-tests.mjs scripts/validation/validate-extension.mjs
git commit -m "build: normalize npm workspace and toolchain"
```

### Task 7: Add Stage 1 CI and security-response documentation

**Files:**
- Modify: `.github/workflows/ci.yml`
- Create: `SECURITY.md`
- Create: `docs/security/credential-response.md`
- Create: `docs/security/git-history-remediation.md`
- Modify: `README.md`

- [ ] **Step 1: Replace CI with a repository-wide Stage 1 gate**

Replace `.github/workflows/ci.yml`:

```yaml
name: CI

on:
  push:
    branches: [main, master, develop]
  pull_request:
    branches: [main, master]
  workflow_dispatch:

permissions:
  contents: read

jobs:
  stage-1:
    name: Stage 1 hygiene and workspace
    runs-on: windows-latest
    timeout-minutes: 20

    steps:
      - name: Check out source
        uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 24.18.0
          cache: npm
          cache-dependency-path: package-lock.json

      - name: Verify toolchain
        shell: pwsh
        run: |
          if ((node --version) -ne 'v24.18.0') { throw 'Unexpected Node version' }
          npm --version

      - name: Install exact dependencies
        run: npm ci

      - name: Scan tracked source for secrets
        run: npm run scan:secrets

      - name: Check repository hygiene
        run: npm run check:hygiene

      - name: Run containment and hygiene tests
        run: |
          npm run test:containment
          npm run test:hygiene

      - name: Lint
        run: npm run lint

      - name: Check formatting
        run: npm run format:check

      - name: Run existing backend regression suite
        run: npm run test:backend:legacy-safe

      - name: Run Stage 1 build validation
        run: npm run build
```

The existing backend suite temporarily retains `--forceExit`; its lifecycle
repair and Linux/Windows matrix belong to Stage 2 and Stage 7 respectively.
Lint is no longer allowed to continue on error.

- [ ] **Step 2: Add the security policy**

Create `SECURITY.md`:

```markdown
# Security Policy

Easy Rewind stores browsing-derived and user-authored data locally. Treat
runtime databases, WAL/SHM files, settings, logs, exports, diagnostics,
migration copies, and quarantine backups as sensitive personal data.

Do not commit credentials or personal runtime data. Report a suspected exposure
privately to the repository owner and include file paths and commit identifiers,
not the secret value or personal record contents.

An exposed credential must be revoked at its provider. Deleting it from the
working tree or rewriting Git history does not revoke it.

The legacy quarantine under
`%LOCALAPPDATA%\easy-rewind\legacy-backup\` is recovery data, not credential
storage. It is excluded from source, builds, tests, logs, diagnostics, exports,
and release artifacts.
```

- [ ] **Step 3: Document credential response without reproducing the key**

Create `docs/security/credential-response.md`:

```markdown
# Exposed Gemini Credential Response

1. Sign in to the Google AI Studio or Google Cloud project that owns the exposed
   Gemini API key.
2. Identify the key by project and creation metadata. Do not paste it into
   tickets, chat, logs, commands, or this repository.
3. Revoke or delete the exposed key.
4. Review provider usage and billing logs from the earliest affected commit.
5. Create a replacement only if Gemini remains enabled.
6. Store the replacement through the repaired backend-only protected
   configuration flow after Stage 3. Do not put it in the extension, dashboard,
   Electron JSON settings, `.env` committed to Git, or the quarantine.
7. Record revocation time and operator confirmation in a private incident
   record. The public verification report records only `revoked: yes/no`.

History rewriting and file deletion are containment steps, not revocation.
```

- [ ] **Step 4: Document the separate history rewrite**

Create `docs/security/git-history-remediation.md`:

```markdown
# Git History Remediation

Perform this only after Stage 1 passes and all collaborators have coordinated a
freeze. Work from a fresh mirror clone outside the normal working copy and keep
an offline mirror backup until validation finishes.

Affected paths:

- `backend/.env`
- `backend/data/easy-rewind.db`
- `backend/data/easy-rewind.db-wal`
- `backend/data/easy-rewind.db-shm`
- `backend/data/settings.json`

Install `git-filter-repo`, then run:

```powershell
git clone --mirror <REMOTE-URL> easy-rewind-sanitized.git
Set-Location easy-rewind-sanitized.git
git filter-repo --force --invert-paths `
  --path backend/.env `
  --path backend/data/easy-rewind.db `
  --path backend/data/easy-rewind.db-wal `
  --path backend/data/easy-rewind.db-shm `
  --path backend/data/settings.json
```

Scan all rewritten refs for secrets and forbidden paths before pushing. If the
credential appeared at any other path or inside other file content, create a
local `replacements.txt` containing the old value and use:

```powershell
git filter-repo --force --replace-text .\replacements.txt
```

Never commit, upload, quote, or retain `replacements.txt`; securely delete it
after verification. Do not put the old value in shell history or CI variables.

After validation:

```powershell
git push --force --mirror
```

All collaborators must discard old clones and re-clone. Forks, caches, release
artifacts, pull-request refs, and external mirrors may require separate cleanup.
The Gemini key must still be revoked.
```

- [ ] **Step 5: Update the README setup entry point**

Replace the dependency/start instructions with:

```markdown
## Development prerequisites

- Windows 10/11 for the desktop application and containment tooling
- Node.js 24.18.0 LTS
- npm 11.6.2

Install all workspace dependencies from the repository root:

```powershell
npm ci
```

Run the current standalone backend:

```powershell
npm start
```

Run the canonical verification gate:

```powershell
npm run verify
```

Do not place credentials, databases, WAL/SHM files, settings, logs, exports, or
personal data in the repository. Packaged Electron uses Electron's embedded Node
runtime; native-module compatibility is verified separately during desktop
packaging.
```

Retain product feature documentation, but remove Android claims and any
instructions that direct users to install separately inside `backend` or store
keys in multiple clients.

- [ ] **Step 6: Run focused documentation and CI checks**

Run:

```powershell
rg -n "node-version: 24.18.0|npm ci|scan:secrets|check:hygiene" .github/workflows/ci.yml README.md
rg -n "revoke|not revocation|legacy-backup|filter-repo" SECURITY.md docs/security
npm.cmd run scan:secrets
npm.cmd run check:hygiene
```

Expected: required controls are found and both npm checks exit 0.

- [ ] **Step 7: Commit CI and security documentation**

```powershell
git add .github/workflows/ci.yml README.md SECURITY.md docs/security/credential-response.md docs/security/git-history-remediation.md
git commit -m "ci: add containment and secret gates"
```

### Task 8: Run the complete Stage 1 exit gate

**Files:**
- Modify: `docs/release/requirements-evidence.md`
- Modify: `docs/release/stage-1-verification.md`

- [ ] **Step 1: Verify sensitive and generated targets are absent**

Run:

```powershell
$forbidden = @(
  'backend\.env',
  'backend\data\easy-rewind.db',
  'backend\data\easy-rewind.db-wal',
  'backend\data\easy-rewind.db-shm',
  'backend\data\settings.json',
  'backend\.git',
  'backend\package-lock.json',
  'tmp_test.js'
)
$present = @($forbidden | Where-Object { Test-Path -LiteralPath $_ })
if ($present.Count -ne 0) { throw "Forbidden targets remain: $($present -join ', ')" }
$trackedDependencies = @(git ls-files '*node_modules*')
if ($trackedDependencies.Count -ne 0) {
  throw "Generated dependencies are tracked: $($trackedDependencies -join ', ')"
}
'WORKTREE_PURGE_VERIFIED'
```

Expected: `WORKTREE_PURGE_VERIFIED`.

- [ ] **Step 2: Re-verify the preserved quarantine without opening SQLite**

Run the independent ACL, byte-size, and SHA-256 block from Task 4 Step 4.

Expected: `QUARANTINE_VERIFIED`.

- [ ] **Step 3: Verify a clean dependency reinstall**

Resolve and verify the exact root target before deletion:

```powershell
$repo = (Resolve-Path '.').Path
$rootModules = [IO.Path]::GetFullPath((Join-Path $repo 'node_modules'))
if ($rootModules -ne (Join-Path $repo 'node_modules')) {
  throw "Unexpected node_modules path: $rootModules"
}
if (Test-Path -LiteralPath $rootModules) {
  Remove-Item -LiteralPath $rootModules -Recurse -Force
}
npm.cmd ci
```

Expected: exit 0 with no component `node_modules` required.

- [ ] **Step 4: Run the full Stage 1 verification command**

Run:

```powershell
npm.cmd run verify
```

Expected:

- Secretlint passes
- repository hygiene passes
- lint exits 0
- format check exits 0
- containment tests pass
- hygiene tests pass
- existing backend tests pass
- the existing backend lifecycle defect remains explicitly recorded for Stage 2

If lint or format reveals pre-existing violations, fix only deterministic
formatting/lint issues needed for this gate and rerun the complete command.

- [ ] **Step 5: Inspect the dependency tree and repository diff**

Run:

```powershell
npm.cmd ls --all
git diff --check
git status --short
git diff --stat
```

Expected: dependency tree exits 0, no whitespace errors, and no unrelated
`.agents`/`.claude` changes are staged or modified by Stage 1.

- [ ] **Step 6: Rehearse recovery using a disposable copy only**

Create a new temporary directory outside the quarantine and copy the four
quarantined files into it. Compare hashes to the manifest, then delete only the
disposable directory. Do not open either copy through SQLite in Stage 1.

```powershell
$quarantinePointer = Join-Path $env:TEMP 'easy-rewind-quarantine-manifest-path.txt'
$manifestPath = (Get-Content -Raw -LiteralPath $quarantinePointer).Trim()
$manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
$recoveryCopy = Join-Path ([IO.Path]::GetTempPath()) ("easy-rewind-recovery-" + [Guid]::NewGuid())
New-Item -ItemType Directory -Path $recoveryCopy | Out-Null
try {
  foreach ($entry in $manifest.files) {
    $source = Join-Path $manifest.quarantinePath $entry.backupRelativePath
    $target = Join-Path $recoveryCopy $entry.backupRelativePath
    Copy-Item -LiteralPath $source -Destination $target
    if ((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash -ne $entry.sha256) {
      throw "Recovery-copy hash mismatch: $target"
    }
  }
  'DISPOSABLE_RECOVERY_COPY_VERIFIED'
}
finally {
  $resolvedRecovery = [IO.Path]::GetFullPath($recoveryCopy)
  $resolvedTemp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
  if (-not $resolvedRecovery.StartsWith($resolvedTemp, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Recovery cleanup target escapes temp: $resolvedRecovery"
  }
  Remove-Item -LiteralPath $resolvedRecovery -Recurse -Force
}
```

Expected: `DISPOSABLE_RECOVERY_COPY_VERIFIED`; quarantine hashes still pass
afterward.

Remove the temporary manifest pointer only after the report contains the
verified manifest path:

```powershell
Remove-Item -LiteralPath $quarantinePointer -Force
```

- [ ] **Step 7: Update all Stage 1 evidence records**

Mark S1-01 through S1-14 `verified` only when their evidence exists. Record:

- exact commands and exit codes
- test counts
- quarantine path and manifest path, but no file contents
- ACL result
- clean-install result
- any pre-existing Stage 2 lifecycle limitation
- Gemini revocation as pending external action if not yet confirmed
- history rewrite as a separate pending coordinated operation if not yet run

An external action may remain explicitly pending only if it is not falsely
reported as complete and the Stage 1 release gate remains `FAIL` until the user
confirms it.

- [ ] **Step 8: Commit final Stage 1 evidence**

```powershell
git add docs/release/requirements-evidence.md docs/release/stage-1-verification.md
git commit -m "docs: record stage one verification evidence"
```

- [ ] **Step 9: Make the exit-gate decision**

Stage 1 passes only when:

- all Stage 1 tests and checks pass
- quarantine verification passes before and after purge
- no sensitive/generated source remains
- clean `npm ci` succeeds
- no Stage 1 release blocker remains
- recovery-copy rehearsal passes
- requirement evidence is current
- Gemini revocation is confirmed
- Git-history remediation is either verified complete or explicitly held as a
  blocking, separately coordinated operation

Do not begin the Stage 2 implementation plan or schema work while this decision
is `FAIL`.
