# Git History Remediation

Perform this only after the containment and workspace gates pass and all
collaborators have coordinated a freeze. History remediation is a separate
Stage 1 external action required before the final PASS decision; it is not part
of quarantine, source purge, or workspace normalization. The exposed Gemini key
must still be revoked at its provider.

Run the preparation through post-push blocks in the same Windows PowerShell
session. Install `git-filter-repo` and Gitleaks first. Never enable a transcript,
command echoing, or debug tracing during this procedure.

## Affected paths

- `backend/.env`
- `backend/data/easy-rewind.db`
- `backend/data/easy-rewind.db-wal`
- `backend/data/easy-rewind.db-shm`
- `backend/data/settings.json`

## Prepare one protected snapshot

Start in the normal repository working copy. Enter the expected repository
identity separately from the coordinated HTTPS remote URL. The script requires
that URL to match both the expected owner/repository slug and the working copy's
existing `origin`. It rejects credentials, query strings, fragments, and the
sample values.

The incident directory is repository-external and non-synced under the current
user's local application data. Known synchronized roots are rejected.
Inheritance is disabled and access is restricted to the current Windows user
before any backup data is retained.

```powershell
$ErrorActionPreference = 'Stop'
$ExpectedRepositorySlug = 'OWNER/REPOSITORY'
$RemoteUrl = 'https://github.com/OWNER/REPOSITORY.git'

function Get-ValidatedRepositoryRemote {
  param(
    [Parameter(Mandatory = $true)][string]$Url,
    [Parameter(Mandatory = $true)][string]$ExpectedSlug
  )

  if (
    $ExpectedSlug -eq 'OWNER/REPOSITORY' -or
    $ExpectedSlug -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'
  ) {
    throw 'Enter the expected repository slug as OWNER/REPOSITORY.'
  }
  $RemoteUri = $null
  if (
    -not [Uri]::TryCreate($Url, [UriKind]::Absolute, [ref]$RemoteUri) -or
    $RemoteUri.Scheme -ne [Uri]::UriSchemeHttps -or
    [string]::IsNullOrWhiteSpace($RemoteUri.Host) -or
    -not [string]::IsNullOrWhiteSpace($RemoteUri.UserInfo) -or
    -not [string]::IsNullOrWhiteSpace($RemoteUri.Query) -or
    -not [string]::IsNullOrWhiteSpace($RemoteUri.Fragment)
  ) {
    throw 'The repository remote must be absolute HTTPS without credentials, query, or fragment.'
  }

  $RemotePath = $RemoteUri.AbsolutePath.Trim('/')
  if ($RemotePath.EndsWith('.git', [StringComparison]::OrdinalIgnoreCase)) {
    $RemotePath = $RemotePath.Substring(0, $RemotePath.Length - 4)
  }
  if (-not $RemotePath.Equals($ExpectedSlug, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'The remote URL does not match the expected repository slug.'
  }

  $Builder = [UriBuilder]::new($RemoteUri)
  $Builder.Path = "/$ExpectedSlug.git"
  $Builder.Query = ''
  $Builder.Fragment = ''
  return $Builder.Uri.AbsoluteUri
}

$RepositoryRoot = (git rev-parse --show-toplevel).Trim()
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($RepositoryRoot)) {
  throw 'Run this procedure from the normal repository working copy.'
}
$RepositoryRoot = (Resolve-Path -LiteralPath $RepositoryRoot).Path
$OriginUrl = (git -C $RepositoryRoot remote get-url origin).Trim()
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($OriginUrl)) {
  throw 'The working copy must have a coordinated origin remote.'
}
$RemoteUrl = Get-ValidatedRepositoryRemote -Url $RemoteUrl -ExpectedSlug $ExpectedRepositorySlug
$NormalizedOrigin = Get-ValidatedRepositoryRemote -Url $OriginUrl -ExpectedSlug $ExpectedRepositorySlug
if (-not $RemoteUrl.Equals($NormalizedOrigin, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'The coordinated remote URL does not match the working copy origin.'
}
if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
  throw 'LOCALAPPDATA is required for the protected incident directory.'
}

$IncidentId = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssfffZ')
$IncidentRoot = Join-Path $env:LOCALAPPDATA "easy-rewind\security-incidents\history-$IncidentId"
$RepositoryFull = [IO.Path]::GetFullPath($RepositoryRoot).TrimEnd('\')
$IncidentFull = [IO.Path]::GetFullPath($IncidentRoot).TrimEnd('\')
if (
  $IncidentFull.Equals($RepositoryFull, [StringComparison]::OrdinalIgnoreCase) -or
  $IncidentFull.StartsWith("$RepositoryFull\", [StringComparison]::OrdinalIgnoreCase)
) {
  throw 'The incident directory must be outside the repository.'
}

$SyncRoots = @(
  $env:OneDrive,
  $env:OneDriveCommercial,
  $env:OneDriveConsumer,
  $env:Dropbox
) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
foreach ($SyncRoot in $SyncRoots) {
  $SyncFull = [IO.Path]::GetFullPath($SyncRoot).TrimEnd('\')
  if (
    $IncidentFull.Equals($SyncFull, [StringComparison]::OrdinalIgnoreCase) -or
    $IncidentFull.StartsWith("$SyncFull\", [StringComparison]::OrdinalIgnoreCase)
  ) {
    throw 'The incident directory must not be inside a synchronized location.'
  }
}
if (Test-Path -LiteralPath $IncidentRoot) {
  throw 'The timestamped incident directory already exists.'
}

$null = New-Item -ItemType Directory -Path $IncidentRoot
$Identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$Acl = [Security.AccessControl.DirectorySecurity]::new()
$Acl.SetOwner($Identity.User)
$Acl.SetAccessRuleProtection($true, $false)
$Rule = [Security.AccessControl.FileSystemAccessRule]::new(
  $Identity.User,
  [Security.AccessControl.FileSystemRights]::FullControl,
  [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit',
  [Security.AccessControl.PropagationFlags]::None,
  [Security.AccessControl.AccessControlType]::Allow
)
$Acl.AddAccessRule($Rule)
Set-Acl -LiteralPath $IncidentRoot -AclObject $Acl
$UnexpectedRules = (Get-Acl -LiteralPath $IncidentRoot).GetAccessRules(
  $true,
  $true,
  [Security.Principal.SecurityIdentifier]
) | Where-Object {
  $_.IdentityReference -ne $Identity.User -or
  $_.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow
}
if (@($UnexpectedRules).Count -ne 0) {
  throw 'The protected incident directory has an unexpected access rule.'
}

$IncidentManifest = Join-Path $IncidentRoot 'incident-manifest.json'
$IncidentManifestHash = Join-Path $IncidentRoot 'incident-manifest.sha256.json'
$BackupMirror = Join-Path $IncidentRoot 'pre-rewrite-backup.git'
$RewriteMirror = Join-Path $IncidentRoot 'rewrite-working.git'
$BackupRefs = Join-Path $IncidentRoot 'pre-rewrite-refs.txt'
$BackupBundle = Join-Path $IncidentRoot 'pre-rewrite.bundle'
$BackupEvidence = Join-Path $IncidentRoot 'pre-rewrite-checksums.json'

$ManifestRecord = [ordered]@{
  schemaVersion = 1
  remoteUrl = $RemoteUrl
  expectedRepositorySlug = $ExpectedRepositorySlug
  artifacts = [ordered]@{
    backupMirror = 'pre-rewrite-backup.git'
    backupRefs = 'pre-rewrite-refs.txt'
    backupBundle = 'pre-rewrite.bundle'
    backupEvidence = 'pre-rewrite-checksums.json'
  }
}
$ManifestRecord |
  ConvertTo-Json -Depth 4 |
  Set-Content -LiteralPath $IncidentManifest -Encoding UTF8
Get-FileHash -Algorithm SHA256 -LiteralPath $IncidentManifest |
  Select-Object Algorithm, Hash |
  ConvertTo-Json |
  Set-Content -LiteralPath $IncidentManifestHash -Encoding UTF8

git clone --mirror $RemoteUrl $BackupMirror
if ($LASTEXITCODE -ne 0) { throw 'Protected backup mirror clone failed.' }
git -C $BackupMirror show-ref | Set-Content -LiteralPath $BackupRefs -Encoding UTF8
if ($LASTEXITCODE -ne 0) { throw 'Could not record protected backup refs.' }
git -C $BackupMirror bundle create $BackupBundle --all
if ($LASTEXITCODE -ne 0) { throw 'Could not create the protected backup bundle.' }

$EvidenceRecords = @(
  [ordered]@{
    path = 'pre-rewrite-refs.txt'
    algorithm = 'SHA256'
    hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $BackupRefs).Hash
  },
  [ordered]@{
    path = 'pre-rewrite.bundle'
    algorithm = 'SHA256'
    hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $BackupBundle).Hash
  }
)
$EvidenceRecords |
  ConvertTo-Json |
  Set-Content -LiteralPath $BackupEvidence -Encoding UTF8

git clone --mirror $BackupMirror $RewriteMirror
if ($LASTEXITCODE -ne 0) { throw 'Snapshot-derived rewrite mirror clone failed.' }
$BackupStartingRefs = @(git -C $BackupMirror show-ref)
if ($LASTEXITCODE -ne 0) { throw 'Could not enumerate protected snapshot refs.' }
$RewriteStartingRefs = @(git -C $RewriteMirror show-ref)
if ($LASTEXITCODE -ne 0) { throw 'Could not enumerate rewrite starting refs.' }
if (@(Compare-Object $BackupStartingRefs $RewriteStartingRefs).Count -ne 0) {
  throw 'The rewrite mirror does not exactly match the protected snapshot.'
}
```

The protected mirror, bundle, ref list, checksum records, and incident manifest
remain untouched until post-push validation and incident closeout finish.

## Rewrite only the snapshot-derived working mirror

```powershell
git -C $RewriteMirror filter-repo --force --invert-paths `
  --path backend/.env `
  --path backend/data/easy-rewind.db `
  --path backend/data/easy-rewind.db-wal `
  --path backend/data/easy-rewind.db-shm `
  --path backend/data/settings.json
if ($LASTEXITCODE -ne 0) { throw 'Path-based history rewrite failed.' }
```

If the credential is discovered at another path or inside other file content,
add the affected path to the rewrite. Create `$ReplacementFile` with a secure
editor inside `$IncidentRoot`; do not paste its value into a shell, ticket,
chat, CI variable, or log. Run this block only when content replacement is
required:

```powershell
$ReplacementFile = Join-Path $IncidentRoot 'replacements.txt'
if (-not (Test-Path -LiteralPath $ReplacementFile -PathType Leaf)) {
  throw 'Create the protected replacement file with a secure editor before continuing.'
}
try {
  git -C $RewriteMirror filter-repo --force --replace-text $ReplacementFile
  if ($LASTEXITCODE -ne 0) { throw 'Content-based history rewrite failed.' }
} finally {
  try {
    Remove-Item -LiteralPath $ReplacementFile -Force -ErrorAction Stop
  } catch {
    throw 'Replacement-file cleanup failed; stop inside the protected session.'
  }
  if (Test-Path -LiteralPath $ReplacementFile) {
    throw 'Replacement-file cleanup failed; stop inside the protected session.'
  }
}
```

Ordinary deletion is not secure erasure. Keep the incident directory protected,
and apply the organization's approved media sanitization or cryptographic
erasure procedure at incident closeout.

## Validate, guard against drift, push, and verify

The function checks repository integrity, searches filenames in every rewritten
ref for all five forbidden paths, and performs a redacted Gitleaks scan over all
refs. Scan output is discarded so secret contents cannot enter logs.

The collaborator freeze must still be active immediately before the guarded
push. If anyone may have pushed after the snapshot, stop. The fresh guard mirror
must exactly match the recorded pre-rewrite refs; any drift aborts the operation.

```powershell
function Test-SanitizedMirror {
  param([Parameter(Mandatory = $true)][string]$MirrorPath)

  git -C $MirrorPath fsck --full --strict *> $null
  if ($LASTEXITCODE -ne 0) { throw 'Mirror integrity validation failed.' }

  $ForbiddenPattern = '^(backend/\.env|backend/data/easy-rewind\.db(?:-wal|-shm)?|backend/data/settings\.json)$'
  $AllRefPaths = @(git -C $MirrorPath log --all --name-only --format=)
  if ($LASTEXITCODE -ne 0) { throw 'All-ref path validation failed.' }
  if (@($AllRefPaths | Where-Object { $_ -match $ForbiddenPattern }).Count -ne 0) {
    throw 'A forbidden path remains in rewritten history.'
  }

  & gitleaks git --no-banner --redact --exit-code 1 --log-opts='--all' $MirrorPath *> $null
  if ($LASTEXITCODE -ne 0) {
    throw 'The redacted all-ref secret scan failed; inspect it only in the protected session.'
  }
}

Test-SanitizedMirror -MirrorPath $RewriteMirror
$RewrittenRefs = Join-Path $IncidentRoot 'rewritten-refs.txt'
$RewrittenEvidence = Join-Path $IncidentRoot 'rewritten-refs.sha256.json'
git -C $RewriteMirror show-ref | Set-Content -LiteralPath $RewrittenRefs -Encoding UTF8
if ($LASTEXITCODE -ne 0) { throw 'Could not record rewritten refs.' }
Get-FileHash -Algorithm SHA256 -LiteralPath $RewrittenRefs |
  Select-Object Algorithm, Hash |
  ConvertTo-Json |
  Set-Content -LiteralPath $RewrittenEvidence -Encoding UTF8

$FreezeConfirmation = Read-Host 'Type FREEZE CONFIRMED after every collaborator has stopped pushing'
if ($FreezeConfirmation -cne 'FREEZE CONFIRMED') {
  throw 'The collaborator freeze was not confirmed.'
}
$RemoteGuardMirror = Join-Path $IncidentRoot 'pre-push-remote-guard.git'
git clone --mirror $RemoteUrl $RemoteGuardMirror
if ($LASTEXITCODE -ne 0) { throw 'Fresh remote-drift guard clone failed.' }
$RecordedBackupRefs = @(Get-Content -LiteralPath $BackupRefs)
$GuardRemoteRefs = @(git -C $RemoteGuardMirror show-ref)
if ($LASTEXITCODE -ne 0) { throw 'Could not enumerate guarded remote refs.' }
if (@(Compare-Object $RecordedBackupRefs $GuardRemoteRefs).Count -ne 0) {
  throw 'The remote changed after the protected snapshot; abort without pushing.'
}
git -C $RewriteMirror push --force --mirror $RemoteUrl
if ($LASTEXITCODE -ne 0) { throw 'Coordinated mirror push failed.' }

$VerificationMirror = Join-Path $IncidentRoot 'post-push-verification.git'
git clone --mirror $RemoteUrl $VerificationMirror
if ($LASTEXITCODE -ne 0) { throw 'Fresh post-push mirror clone failed.' }
Test-SanitizedMirror -MirrorPath $VerificationMirror

$ExpectedRefs = @(git -C $RewriteMirror for-each-ref --format='%(refname) %(objectname)')
if ($LASTEXITCODE -ne 0) { throw 'Could not enumerate rewritten refs.' }
$ActualRefs = @(git -C $VerificationMirror for-each-ref --format='%(refname) %(objectname)')
if ($LASTEXITCODE -ne 0) { throw 'Could not enumerate post-push refs.' }
if (@(Compare-Object $ExpectedRefs $ActualRefs).Count -ne 0) {
  throw 'The fresh post-push clone does not match the rewritten refs.'
}
```

All collaborators must discard old clones and re-clone. Forks, caches, release
artifacts, pull-request refs, and external mirrors may require separate cleanup.
Repository hosts may require support requests for unreachable cached objects.

## Exact rollback from the protected mirror

Rollback is independently resumable in a new PowerShell session. Reinstate the
collaborator freeze, explicitly reselect the protected incident directory, and
separately re-enter the expected repository slug and coordinated remote URL.
The block revalidates the narrow root, protected ACL, incident manifest,
repository identity, artifact containment, SHA-256 records, backup refs, and Git
integrity before any force push.

```powershell
$ErrorActionPreference = 'Stop'
$IncidentRoot = Read-Host 'Enter the full protected IncidentRoot path'
$ExpectedRepositorySlug = Read-Host 'Enter the expected OWNER/REPOSITORY slug'
$EnteredRemoteUrl = Read-Host 'Enter the coordinated HTTPS repository URL'

function Get-ValidatedRollbackRemote {
  param(
    [Parameter(Mandatory = $true)][string]$Url,
    [Parameter(Mandatory = $true)][string]$ExpectedSlug
  )

  if ($ExpectedSlug -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') {
    throw 'The expected repository slug is invalid.'
  }
  $RemoteUri = $null
  if (
    -not [Uri]::TryCreate($Url, [UriKind]::Absolute, [ref]$RemoteUri) -or
    $RemoteUri.Scheme -ne [Uri]::UriSchemeHttps -or
    -not [string]::IsNullOrWhiteSpace($RemoteUri.UserInfo) -or
    -not [string]::IsNullOrWhiteSpace($RemoteUri.Query) -or
    -not [string]::IsNullOrWhiteSpace($RemoteUri.Fragment)
  ) {
    throw 'The rollback remote URL is invalid.'
  }
  $RemotePath = $RemoteUri.AbsolutePath.Trim('/')
  if ($RemotePath.EndsWith('.git', [StringComparison]::OrdinalIgnoreCase)) {
    $RemotePath = $RemotePath.Substring(0, $RemotePath.Length - 4)
  }
  if (-not $RemotePath.Equals($ExpectedSlug, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'The rollback remote does not match the expected repository slug.'
  }
  $Builder = [UriBuilder]::new($RemoteUri)
  $Builder.Path = "/$ExpectedSlug.git"
  $Builder.Query = ''
  $Builder.Fragment = ''
  return $Builder.Uri.AbsoluteUri
}

if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
  throw 'LOCALAPPDATA is required for rollback.'
}
$ExpectedParent = [IO.Path]::GetFullPath(
  (Join-Path $env:LOCALAPPDATA 'easy-rewind\security-incidents')
).TrimEnd('\')
$ExpectedParentItem = Get-Item -LiteralPath $ExpectedParent -Force
if (
  -not $ExpectedParentItem.PSIsContainer -or
  ($ExpectedParentItem.Attributes -band [IO.FileAttributes]::ReparsePoint)
) {
  throw 'The protected incident parent is invalid or reparse-linked.'
}
$IncidentFull = (Resolve-Path -LiteralPath $IncidentRoot).Path.TrimEnd('\')
$ResolvedParent = (Resolve-Path -LiteralPath (Split-Path -Parent $IncidentFull)).Path.TrimEnd('\')
$IncidentLeaf = Split-Path -Leaf $IncidentFull
if (
  -not $ResolvedParent.Equals($ExpectedParent, [StringComparison]::OrdinalIgnoreCase) -or
  $IncidentLeaf -notmatch '^history-\d{8}T\d{9}Z$'
) {
  throw 'IncidentRoot is not a direct timestamped incident directory.'
}
$IncidentItem = Get-Item -LiteralPath $IncidentFull -Force
if (
  -not $IncidentItem.PSIsContainer -or
  ($IncidentItem.Attributes -band [IO.FileAttributes]::ReparsePoint)
) {
  throw 'IncidentRoot must be an existing non-reparse directory.'
}
$CurrentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
$RootAcl = Get-Acl -LiteralPath $IncidentFull
if (-not $RootAcl.AreAccessRulesProtected) {
  throw 'IncidentRoot ACL inheritance is not protected.'
}
$RootOwner = $RootAcl.GetOwner([Security.Principal.SecurityIdentifier])
if ($RootOwner -ne $CurrentIdentity.User) {
  throw 'IncidentRoot is not owned by the current Windows user.'
}
$RootRules = $RootAcl.GetAccessRules(
  $true,
  $true,
  [Security.Principal.SecurityIdentifier]
)
$UnexpectedRootRules = @($RootRules | Where-Object {
  $_.IdentityReference -ne $CurrentIdentity.User -or
  $_.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow
})
if ($UnexpectedRootRules.Count -ne 0) {
  throw 'IncidentRoot is not restricted to the current Windows user.'
}

function Resolve-IncidentChild {
  param(
    [Parameter(Mandatory = $true)][string]$RootPath,
    [Parameter(Mandatory = $true)][string]$RelativePath
  )

  if (
    [IO.Path]::IsPathRooted($RelativePath) -or
    [IO.Path]::GetFileName($RelativePath) -ne $RelativePath -or
    $RelativePath -in @('.', '..')
  ) {
    throw 'The manifest contains an unsafe artifact path.'
  }
  $Candidate = [IO.Path]::GetFullPath((Join-Path $RootPath $RelativePath)).TrimEnd('\')
  if (-not $Candidate.StartsWith("$RootPath\", [StringComparison]::OrdinalIgnoreCase)) {
    throw 'A manifest artifact escapes IncidentRoot.'
  }
  $Resolved = (Resolve-Path -LiteralPath $Candidate).Path.TrimEnd('\')
  $Item = Get-Item -LiteralPath $Resolved -Force
  if (
    -not $Resolved.Equals($Candidate, [StringComparison]::OrdinalIgnoreCase) -or
    ($Item.Attributes -band [IO.FileAttributes]::ReparsePoint)
  ) {
    throw 'A manifest artifact is substituted or reparse-linked.'
  }
  return $Resolved
}

$IncidentManifest = Resolve-IncidentChild `
  -RootPath $IncidentFull `
  -RelativePath 'incident-manifest.json'
$IncidentManifestHash = Resolve-IncidentChild `
  -RootPath $IncidentFull `
  -RelativePath 'incident-manifest.sha256.json'
$ManifestHashRecord = Get-Content -Raw -LiteralPath $IncidentManifestHash | ConvertFrom-Json
$ActualManifestHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $IncidentManifest).Hash
if ($ActualManifestHash -ne $ManifestHashRecord.Hash) {
  throw 'The protected incident manifest checksum is invalid.'
}
$ManifestRecord = Get-Content -Raw -LiteralPath $IncidentManifest | ConvertFrom-Json
if (
  $ManifestRecord.schemaVersion -ne 1 -or
  $ManifestRecord.expectedRepositorySlug -ne $ExpectedRepositorySlug
) {
  throw 'The protected incident manifest repository identity is invalid.'
}
$RemoteUrl = Get-ValidatedRollbackRemote -Url $EnteredRemoteUrl -ExpectedSlug $ExpectedRepositorySlug
$ManifestRemoteUrl = Get-ValidatedRollbackRemote `
  -Url $ManifestRecord.remoteUrl `
  -ExpectedSlug $ExpectedRepositorySlug
if (-not $RemoteUrl.Equals($ManifestRemoteUrl, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'The re-entered remote does not match the protected incident manifest.'
}

$BackupMirror = Resolve-IncidentChild `
  -RootPath $IncidentFull `
  -RelativePath $ManifestRecord.artifacts.backupMirror
$BackupRefs = Resolve-IncidentChild `
  -RootPath $IncidentFull `
  -RelativePath $ManifestRecord.artifacts.backupRefs
$BackupBundle = Resolve-IncidentChild `
  -RootPath $IncidentFull `
  -RelativePath $ManifestRecord.artifacts.backupBundle
$BackupEvidence = Resolve-IncidentChild `
  -RootPath $IncidentFull `
  -RelativePath $ManifestRecord.artifacts.backupEvidence

$RecordedEvidence = @(Get-Content -Raw -LiteralPath $BackupEvidence | ConvertFrom-Json)
foreach ($Record in $RecordedEvidence) {
  $EvidencePath = Resolve-IncidentChild -RootPath $IncidentFull -RelativePath $Record.path
  $ActualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $EvidencePath).Hash
  if ($Record.algorithm -ne 'SHA256' -or $ActualHash -ne $Record.hash) {
    throw 'Protected backup checksum validation failed.'
  }
}
if (
  -not $BackupBundle.Equals(
    (Resolve-IncidentChild -RootPath $IncidentFull -RelativePath 'pre-rewrite.bundle'),
    [StringComparison]::OrdinalIgnoreCase
  )
) {
  throw 'The protected backup bundle path is invalid.'
}

$RecordedBackupRefs = @(Get-Content -LiteralPath $BackupRefs)
$CurrentBackupRefs = @(git -C $BackupMirror show-ref)
if ($LASTEXITCODE -ne 0) { throw 'Could not revalidate protected backup refs.' }
if (@(Compare-Object $RecordedBackupRefs $CurrentBackupRefs).Count -ne 0) {
  throw 'The protected backup refs changed; do not roll back.'
}
git -C $BackupMirror fsck --full --strict *> $null
if ($LASTEXITCODE -ne 0) { throw 'Protected backup integrity validation failed.' }

$RollbackConfirmation = Read-Host 'Type ROLLBACK CONFIRMED after reinstating the collaborator freeze'
if ($RollbackConfirmation -cne 'ROLLBACK CONFIRMED') {
  throw 'Rollback freeze was not confirmed.'
}
git -C $BackupMirror push --force --mirror $RemoteUrl
if ($LASTEXITCODE -ne 0) { throw 'Protected-mirror rollback push failed.' }

$RollbackVerificationMirror = Join-Path $IncidentFull 'rollback-verification.git'
git clone --mirror $RemoteUrl $RollbackVerificationMirror
if ($LASTEXITCODE -ne 0) { throw 'Fresh rollback-verification clone failed.' }
$RestoredRefs = @(git -C $RollbackVerificationMirror show-ref)
if ($LASTEXITCODE -ne 0) { throw 'Could not enumerate restored refs.' }
if (@(Compare-Object $RecordedBackupRefs $RestoredRefs).Count -ne 0) {
  throw 'The restored remote does not match the protected backup refs.'
}
```

## Protected incident closeout

Destroy the protected backup only after the repository owner confirms rollback
is no longer needed, post-push validation and downstream cleanup are complete,
and the private incident record is closed. This independent block reselects a
single direct timestamped child of the resolved
`%LOCALAPPDATA%\easy-rewind\security-incidents` directory, rejects reparse
substitution, revalidates the exact current-user ACL and manifest identity, and
requires an incident-specific confirmation before deletion.

```powershell
$ErrorActionPreference = 'Stop'
$IncidentRoot = Read-Host 'Enter the full protected IncidentRoot path to close'
$ExpectedRepositorySlug = Read-Host 'Enter the expected OWNER/REPOSITORY slug'
if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
  throw 'LOCALAPPDATA is required for incident closeout.'
}

$ExpectedParent = [IO.Path]::GetFullPath(
  (Join-Path $env:LOCALAPPDATA 'easy-rewind\security-incidents')
).TrimEnd('\')
$ExpectedParentItem = Get-Item -LiteralPath $ExpectedParent -Force
if (
  -not $ExpectedParentItem.PSIsContainer -or
  ($ExpectedParentItem.Attributes -band [IO.FileAttributes]::ReparsePoint)
) {
  throw 'The protected incident parent is invalid or reparse-linked.'
}
$IncidentFull = (Resolve-Path -LiteralPath $IncidentRoot).Path.TrimEnd('\')
$ResolvedParent = (Resolve-Path -LiteralPath (Split-Path -Parent $IncidentFull)).Path.TrimEnd('\')
$IncidentLeaf = Split-Path -Leaf $IncidentFull
if (
  -not $ResolvedParent.Equals($ExpectedParent, [StringComparison]::OrdinalIgnoreCase) -or
  $IncidentLeaf -notmatch '^history-\d{8}T\d{9}Z$'
) {
  throw 'Closeout target is not a direct timestamped incident directory.'
}
$IncidentItem = Get-Item -LiteralPath $IncidentFull -Force
if (
  -not $IncidentItem.PSIsContainer -or
  ($IncidentItem.Attributes -band [IO.FileAttributes]::ReparsePoint)
) {
  throw 'Closeout target must be a non-reparse directory.'
}

$CurrentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
$RootAcl = Get-Acl -LiteralPath $IncidentFull
if (-not $RootAcl.AreAccessRulesProtected) {
  throw 'Closeout target ACL inheritance is not protected.'
}
$RootOwner = $RootAcl.GetOwner([Security.Principal.SecurityIdentifier])
if ($RootOwner -ne $CurrentIdentity.User) {
  throw 'Closeout target is not owned by the current Windows user.'
}
$RootRules = $RootAcl.GetAccessRules(
  $true,
  $true,
  [Security.Principal.SecurityIdentifier]
)
$UnexpectedRootRules = @($RootRules | Where-Object {
  $_.IdentityReference -ne $CurrentIdentity.User -or
  $_.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow
})
if ($UnexpectedRootRules.Count -ne 0) {
  throw 'Closeout target is not restricted to the current Windows user.'
}

$IncidentManifest = Join-Path $IncidentFull 'incident-manifest.json'
$IncidentManifestHash = Join-Path $IncidentFull 'incident-manifest.sha256.json'
$ManifestHashRecord = Get-Content -Raw -LiteralPath $IncidentManifestHash | ConvertFrom-Json
$ActualManifestHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $IncidentManifest).Hash
$ManifestRecord = Get-Content -Raw -LiteralPath $IncidentManifest | ConvertFrom-Json
if (
  $ActualManifestHash -ne $ManifestHashRecord.Hash -or
  $ManifestRecord.schemaVersion -ne 1 -or
  $ManifestRecord.expectedRepositorySlug -ne $ExpectedRepositorySlug
) {
  throw 'Closeout manifest identity or checksum validation failed.'
}

$ExpectedConfirmation = "DESTROY $IncidentLeaf"
$CloseoutConfirmation = Read-Host "Type $ExpectedConfirmation to destroy the protected incident"
if ($CloseoutConfirmation -cne $ExpectedConfirmation) {
  throw 'Incident closeout was not confirmed.'
}
Remove-Item -LiteralPath $IncidentFull -Recurse -Force -ErrorAction Stop
if (Test-Path -LiteralPath $IncidentFull) {
  throw 'Protected incident deletion failed.'
}
```

Ordinary deletion is not secure erasure. Complete any required organizational
media sanitization, cryptographic erasure, or physical destruction of the media
that retained the protected backup, and record that disposition privately.
