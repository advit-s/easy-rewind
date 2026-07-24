# Git History Remediation

Perform this only after the containment and workspace gates pass and all
collaborators have coordinated a freeze. History remediation is a separate
Stage 1 external action required before the final PASS decision; it is not part
of quarantine, source purge, or workspace normalization. The exposed Gemini key
must still be revoked at its provider.

Run the preparation through post-push blocks in the same Windows PowerShell
session. Install Gitleaks and a `git-filter-repo` release with the
`--sensitive-data-removal` capability (version 2.47 or newer) first. Never enable
a transcript, command echoing, or debug tracing during this procedure.

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
$FilterRepoHelp = @(& git filter-repo -h 2>&1)
if (
  $LASTEXITCODE -ne 0 -or
  -not ($FilterRepoHelp -match '--sensitive-data-removal')
) {
  throw 'git-filter-repo 2.47 or newer with sensitive-data-removal support is required.'
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
$ProviderSupportEvidence = Join-Path $IncidentRoot 'provider-support-evidence.json'
$ProviderSupportEvidenceHash = Join-Path $IncidentRoot 'provider-support-evidence.sha256.json'
$PostRewriteRefs = Join-Path $IncidentRoot 'post-rewrite-refs.txt'
$PostRewriteEvidence = Join-Path $IncidentRoot 'post-rewrite-checksums.json'

$ManifestRecord = [ordered]@{
  schemaVersion = 1
  status = 'prepared'
  remoteUrl = $RemoteUrl
  expectedRepositorySlug = $ExpectedRepositorySlug
  artifacts = [ordered]@{
    backupMirror = 'pre-rewrite-backup.git'
    backupRefs = 'pre-rewrite-refs.txt'
    backupBundle = 'pre-rewrite.bundle'
    backupEvidence = 'pre-rewrite-checksums.json'
    providerSupportEvidence = 'provider-support-evidence.json'
    providerSupportEvidenceHash = 'provider-support-evidence.sha256.json'
    postRewriteRefs = 'post-rewrite-refs.txt'
    postRewriteEvidence = 'post-rewrite-checksums.json'
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

git clone --mirror --no-local $BackupMirror $RewriteMirror
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
git -C $RewriteMirror filter-repo --force --sensitive-data-removal --invert-paths `
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
  git -C $RewriteMirror filter-repo --force --sensitive-data-removal `
    --replace-text $ReplacementFile
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

Before validation, record the non-secret support facts generated by
`git-filter-repo`: changed pull-request refs and count, first changed commits,
and any orphaned LFS object report. These artifacts stay in the protected
incident directory and must not enter public logs.

The remote update is one atomic mirror transaction. If the provider does not
support atomic pushes, or protected or read-only provider refs reject the
transaction, stop. Never retry non-atomically: an atomic failure is a release
blocker, not permission to partially update refs.

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

$FilterRepoMetadata = Join-Path $RewriteMirror 'filter-repo'
$ChangedRefsMetadata = Join-Path $FilterRepoMetadata 'changed-refs'
$FirstChangedMetadata = Join-Path $FilterRepoMetadata 'first-changed-commits'
$OrphanedLfsMetadata = Join-Path $FilterRepoMetadata 'orphaned_lfs_objects'
if (
  -not (Test-Path -LiteralPath $ChangedRefsMetadata -PathType Leaf) -or
  -not (Test-Path -LiteralPath $FirstChangedMetadata -PathType Leaf)
) {
  throw 'Required sensitive-data-removal metadata is missing.'
}
$ChangedRefs = @(Get-Content -LiteralPath $ChangedRefsMetadata)
$ChangedPullRequestRefs = @($ChangedRefs | Where-Object {
  $_ -match '^refs/pull/[^/]+/head$'
})
$FirstChangedCommits = @(Get-Content -LiteralPath $FirstChangedMetadata)
$OrphanedLfsObjects = @()
if (Test-Path -LiteralPath $OrphanedLfsMetadata -PathType Leaf) {
  $OrphanedLfsObjects = @(Get-Content -LiteralPath $OrphanedLfsMetadata)
}
$ProviderSupportRecord = [ordered]@{
  schemaVersion = 1
  changedPullRequestRefs = $ChangedPullRequestRefs
  changedPullRequestCount = $ChangedPullRequestRefs.Count
  firstChangedCommits = $FirstChangedCommits
  orphanedLfsObjects = $OrphanedLfsObjects
}
$ProviderSupportRecord |
  ConvertTo-Json -Depth 4 |
  Set-Content -LiteralPath $ProviderSupportEvidence -Encoding UTF8
Get-FileHash -Algorithm SHA256 -LiteralPath $ProviderSupportEvidence |
  Select-Object Algorithm, Hash |
  ConvertTo-Json |
  Set-Content -LiteralPath $ProviderSupportEvidenceHash -Encoding UTF8

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
$ForwardPushStatus = Join-Path $IncidentRoot 'forward-atomic-push-status.txt'
$ForwardPushOutput = @(& git -C $RewriteMirror push --atomic --force --mirror $RemoteUrl 2>&1)
$ForwardPushExit = $LASTEXITCODE
$ForwardPushOutput | Set-Content -LiteralPath $ForwardPushStatus -Encoding UTF8
if ($ForwardPushExit -ne 0) {
  throw 'Atomic mirror push failed; stop for provider support and do not retry non-atomically.'
}

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

$ActualRefs | Set-Content -LiteralPath $PostRewriteRefs -Encoding UTF8
$PostRewriteRecord = [ordered]@{
  path = 'post-rewrite-refs.txt'
  algorithm = 'SHA256'
  hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $PostRewriteRefs).Hash
}
$PostRewriteRecord |
  ConvertTo-Json |
  Set-Content -LiteralPath $PostRewriteEvidence -Encoding UTF8

$ManifestRecord.status = 'post-rewrite-verified'
$ManifestRecord.postRewriteCapturedAtUtc = (Get-Date).ToUniversalTime().ToString('o')
$ManifestRecord |
  ConvertTo-Json -Depth 5 |
  Set-Content -LiteralPath $IncidentManifest -Encoding UTF8
Get-FileHash -Algorithm SHA256 -LiteralPath $IncidentManifest |
  Select-Object Algorithm, Hash |
  ConvertTo-Json |
  Set-Content -LiteralPath $IncidentManifestHash -Encoding UTF8
```

All collaborators must discard old clones and re-clone. Forks, caches, release
artifacts, pull-request refs, and external mirrors require separate verification
and cleanup.

Provider support completion is a blocking exit item before final PASS. For
GitHub, `refs/pull/*` are read-only and can reject the required atomic mirror
push; stop rather than retrying without `--atomic`. Using the protected
`provider-support-evidence.json`, obtain GitHub Support confirmation that
affected pull-request refs were dereferenced or deleted, cached views were
removed, server garbage collection completed, and orphaned LFS objects were
purged when applicable. Record support confirmation privately; do not print the
support evidence or tool output in CI, issues, or other public logs.

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
  $ManifestRecord.expectedRepositorySlug -ne $ExpectedRepositorySlug -or
  $ManifestRecord.status -ne 'post-rewrite-verified' -or
  [string]::IsNullOrWhiteSpace($ManifestRecord.postRewriteCapturedAtUtc)
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
$PostRewriteRefs = Resolve-IncidentChild `
  -RootPath $IncidentFull `
  -RelativePath $ManifestRecord.artifacts.postRewriteRefs
$PostRewriteEvidence = Resolve-IncidentChild `
  -RootPath $IncidentFull `
  -RelativePath $ManifestRecord.artifacts.postRewriteEvidence

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

$PostRewriteRecord = Get-Content -Raw -LiteralPath $PostRewriteEvidence | ConvertFrom-Json
$ActualPostRewriteHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $PostRewriteRefs).Hash
if (
  $PostRewriteRecord.path -ne $ManifestRecord.artifacts.postRewriteRefs -or
  $PostRewriteRecord.algorithm -ne 'SHA256' -or
  $ActualPostRewriteHash -ne $PostRewriteRecord.hash
) {
  throw 'Protected post-rewrite ref evidence is invalid.'
}

$PreRollbackMirror = Join-Path $IncidentFull 'pre-rollback-current.git'
$PreRollbackRefs = Join-Path $IncidentFull 'pre-rollback-current-refs.txt'
$PreRollbackBundle = Join-Path $IncidentFull 'pre-rollback-current.bundle'
$PreRollbackEvidence = Join-Path $IncidentFull 'pre-rollback-current-checksums.json'
foreach ($Candidate in @(
  $PreRollbackMirror,
  $PreRollbackRefs,
  $PreRollbackBundle,
  $PreRollbackEvidence
)) {
  if (Test-Path -LiteralPath $Candidate) {
    throw 'A pre-rollback preservation artifact already exists; stop without overwriting it.'
  }
}

git clone --mirror $RemoteUrl $PreRollbackMirror
if ($LASTEXITCODE -ne 0) { throw 'Protected pre-rollback mirror clone failed.' }
$CurrentRemoteRefs = @(git -C $PreRollbackMirror for-each-ref --format='%(refname) %(objectname)')
if ($LASTEXITCODE -ne 0) { throw 'Could not record current remote refs before rollback.' }
$CurrentRemoteRefs | Set-Content -LiteralPath $PreRollbackRefs -Encoding UTF8
git -C $PreRollbackMirror bundle create $PreRollbackBundle --all
if ($LASTEXITCODE -ne 0) { throw 'Could not create the protected pre-rollback bundle.' }
$PreRollbackRecords = @(
  [ordered]@{
    path = 'pre-rollback-current-refs.txt'
    algorithm = 'SHA256'
    hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $PreRollbackRefs).Hash
  },
  [ordered]@{
    path = 'pre-rollback-current.bundle'
    algorithm = 'SHA256'
    hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $PreRollbackBundle).Hash
  }
)
$PreRollbackRecords |
  ConvertTo-Json |
  Set-Content -LiteralPath $PreRollbackEvidence -Encoding UTF8
git -C $PreRollbackMirror fsck --full --strict *> $null
if ($LASTEXITCODE -ne 0) { throw 'Protected pre-rollback mirror validation failed.' }

$RecordedPostRewriteRefs = @(Get-Content -LiteralPath $PostRewriteRefs)
if (@(Compare-Object $RecordedPostRewriteRefs $CurrentRemoteRefs).Count -ne 0) {
  throw 'The remote drifted after post-rewrite verification; preserve current work and abort rollback.'
}

$RollbackPushStatus = Join-Path $IncidentFull 'rollback-atomic-push-status.txt'
$RollbackPushOutput = @(& git -C $BackupMirror push --atomic --force --mirror $RemoteUrl 2>&1)
$RollbackPushExit = $LASTEXITCODE
$RollbackPushOutput | Set-Content -LiteralPath $RollbackPushStatus -Encoding UTF8
if ($RollbackPushExit -ne 0) {
  throw 'Atomic rollback failed; preserve the pre-rollback mirror and never retry non-atomically.'
}

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

# BEGIN TESTED NON-FOLLOWING REPARSE TRAVERSAL
function Assert-NoReparseDescendants {
  param([Parameter(Mandatory = $true)][string]$RootPath)

  try {
    $RootDirectory = Get-Item -LiteralPath $RootPath -Force -ErrorAction Stop
    if (
      -not $RootDirectory.PSIsContainer -or
      ($RootDirectory.Attributes -band [IO.FileAttributes]::ReparsePoint)
    ) {
      throw 'unsafe root'
    }

    $PendingDirectories = [Collections.Generic.Stack[IO.DirectoryInfo]]::new()
    $PendingDirectories.Push($RootDirectory)
    while ($PendingDirectories.Count -gt 0) {
      $CurrentDirectory = $PendingDirectories.Pop()
      foreach ($Entry in $CurrentDirectory.EnumerateFileSystemInfos()) {
        $EntryAttributes = $Entry.Attributes
        if ($EntryAttributes -band [IO.FileAttributes]::ReparsePoint) {
          throw 'unsafe descendant'
        }
        if ($EntryAttributes -band [IO.FileAttributes]::Directory) {
          $PendingDirectories.Push([IO.DirectoryInfo]$Entry)
        }
      }
    }
  } catch {
    throw 'Incident descendant validation failed; stop without deleting anything.'
  }
}
# END TESTED NON-FOLLOWING REPARSE TRAVERSAL

Assert-NoReparseDescendants -RootPath $IncidentFull

# Re-resolve and revalidate the root immediately before the destructive call.
$PreDeleteIncident = (Resolve-Path -LiteralPath $IncidentFull).Path.TrimEnd('\')
$PreDeleteParent = (Resolve-Path -LiteralPath (Split-Path -Parent $PreDeleteIncident)).Path.TrimEnd('\')
$PreDeleteItem = Get-Item -LiteralPath $PreDeleteIncident -Force
$PreDeleteAcl = Get-Acl -LiteralPath $PreDeleteIncident
$PreDeleteOwner = $PreDeleteAcl.GetOwner([Security.Principal.SecurityIdentifier])
if (
  -not $PreDeleteIncident.Equals($IncidentFull, [StringComparison]::OrdinalIgnoreCase) -or
  -not $PreDeleteParent.Equals($ExpectedParent, [StringComparison]::OrdinalIgnoreCase) -or
  -not $PreDeleteItem.PSIsContainer -or
  ($PreDeleteItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
  -not $PreDeleteAcl.AreAccessRulesProtected -or
  $PreDeleteOwner -ne $CurrentIdentity.User
) {
  throw 'Closeout target changed after validation; stop without deleting anything.'
}
Remove-Item -LiteralPath $IncidentFull -Recurse -Force -ErrorAction Stop
if (Test-Path -LiteralPath $IncidentFull) {
  throw 'Protected incident deletion failed.'
}
```

Ordinary deletion is not secure erasure. Complete any required organizational
media sanitization, cryptographic erasure, or physical destruction of the media
that retained the protected backup, and record that disposition privately.
