# Git History Remediation

Perform this only after the containment and workspace gates pass and all
collaborators have coordinated a freeze. History remediation is a separate
Stage 1 external action required before the final PASS decision; it is not part
of quarantine, source purge, or workspace normalization. The exposed Gemini key
must still be revoked at its provider.

Run every block below in the same Windows PowerShell session. Install
`git-filter-repo` and Gitleaks first. Never enable a transcript, command echoing,
or debug tracing during this procedure.

## Affected paths

- `backend/.env`
- `backend/data/easy-rewind.db`
- `backend/data/easy-rewind.db-wal`
- `backend/data/easy-rewind.db-shm`
- `backend/data/settings.json`

## Prepare protected evidence and two mirrors

Start in the normal repository working copy. Set the remote URL to the
coordinated HTTPS repository URL. The script creates a repository-external,
non-synced incident directory under the current user's local application data,
rejects known synchronized roots, disables inherited permissions, and grants
access only to the current Windows user before retaining any backup data.

The protected pre-rewrite backup and the rewrite working mirror are separate.
Do not modify or run filtering commands against `$BackupMirror`.

```powershell
$ErrorActionPreference = 'Stop'
$RemoteUrl = 'https://github.com/OWNER/REPOSITORY.git'
$RemoteUri = $null
if (
  -not [Uri]::TryCreate($RemoteUrl, [UriKind]::Absolute, [ref]$RemoteUri) -or
  $RemoteUri.Scheme -ne [Uri]::UriSchemeHttps -or
  [string]::IsNullOrWhiteSpace($RemoteUri.Host) -or
  -not [string]::IsNullOrWhiteSpace($RemoteUri.UserInfo)
) {
  throw 'RemoteUrl must be an absolute HTTPS repository URL without embedded credentials.'
}
if (
  $RemoteUri.Host -eq 'github.com' -and
  $RemoteUri.AbsolutePath -eq '/OWNER/REPOSITORY.git'
) {
  throw 'Replace the sample RemoteUrl with the coordinated repository URL.'
}

$RepositoryRoot = (git rev-parse --show-toplevel).Trim()
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($RepositoryRoot)) {
  throw 'Run this procedure from the normal repository working copy.'
}
$RepositoryRoot = (Resolve-Path -LiteralPath $RepositoryRoot).Path
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
$UnexpectedRules = (Get-Acl -LiteralPath $IncidentRoot).Access |
  Where-Object { $_.IdentityReference -ne $Identity.User }
if (@($UnexpectedRules).Count -ne 0) {
  throw 'The protected incident directory has an unexpected access rule.'
}

$BackupMirror = Join-Path $IncidentRoot 'pre-rewrite-backup.git'
$RewriteMirror = Join-Path $IncidentRoot 'rewrite-working.git'
$BackupRefs = Join-Path $IncidentRoot 'pre-rewrite-refs.txt'
$BackupBundle = Join-Path $IncidentRoot 'pre-rewrite.bundle'
$BackupEvidence = Join-Path $IncidentRoot 'pre-rewrite-checksums.json'

git clone --mirror $RemoteUrl $BackupMirror
if ($LASTEXITCODE -ne 0) { throw 'Protected backup mirror clone failed.' }
git clone --mirror $RemoteUrl $RewriteMirror
if ($LASTEXITCODE -ne 0) { throw 'Rewrite working mirror clone failed.' }

git -C $BackupMirror show-ref | Set-Content -LiteralPath $BackupRefs -Encoding UTF8
if ($LASTEXITCODE -ne 0) { throw 'Could not record protected backup refs.' }
git -C $BackupMirror bundle create $BackupBundle --all
if ($LASTEXITCODE -ne 0) { throw 'Could not create the protected backup bundle.' }
Get-FileHash -Algorithm SHA256 -LiteralPath $BackupRefs, $BackupBundle |
  Select-Object Path, Algorithm, Hash |
  ConvertTo-Json |
  Set-Content -LiteralPath $BackupEvidence -Encoding UTF8
```

Keep the protected mirror, bundle, ref list, and checksum record until the
rewrite, post-push verification, downstream cleanup, and incident closeout all
finish.

## Rewrite only the working mirror

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
include any additional affected paths in the rewrite. Create
`$ReplacementFile` with a secure editor inside `$IncidentRoot`; do not paste the
value into a shell, ticket, chat, CI variable, or log. Run the following block
only when content replacement is required:

```powershell
$ReplacementFile = Join-Path $IncidentRoot 'replacements.txt'
if (-not (Test-Path -LiteralPath $ReplacementFile -PathType Leaf)) {
  throw 'Create the protected replacement file with a secure editor before continuing.'
}
try {
  git -C $RewriteMirror filter-repo --force --replace-text $ReplacementFile
  if ($LASTEXITCODE -ne 0) { throw 'Content-based history rewrite failed.' }
} finally {
  Remove-Item -LiteralPath $ReplacementFile -Force -ErrorAction SilentlyContinue
}
```

Never print or retain the replacement file. History rewriting and file deletion
are containment steps, not revocation.

## Validate all refs, push, and verify a fresh clone

The function below checks repository integrity, searches the names of files in
every rewritten ref for the five forbidden paths, and performs a redacted
Gitleaks scan over all refs. Scan output is discarded so secret contents cannot
enter logs. A failure stops the procedure with a generic message.

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
  Select-Object Path, Algorithm, Hash |
  ConvertTo-Json |
  Set-Content -LiteralPath $RewrittenEvidence -Encoding UTF8

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

Rollback is an emergency coordinated force-push, not a local checkout. Reinstate
the collaborator freeze and use only the untouched `$BackupMirror`. The block
revalidates its recorded refs and SHA-256 evidence before pushing, then confirms
the restored remote through another fresh mirror clone.

```powershell
$RecordedEvidence = @(Get-Content -Raw -LiteralPath $BackupEvidence | ConvertFrom-Json)
foreach ($Record in $RecordedEvidence) {
  $ActualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $Record.Path).Hash
  if ($ActualHash -ne $Record.Hash) {
    throw 'Protected backup checksum validation failed.'
  }
}

$RecordedBackupRefs = @(Get-Content -LiteralPath $BackupRefs)
$CurrentBackupRefs = @(git -C $BackupMirror show-ref)
if ($LASTEXITCODE -ne 0) { throw 'Could not revalidate protected backup refs.' }
if (@(Compare-Object $RecordedBackupRefs $CurrentBackupRefs).Count -ne 0) {
  throw 'The protected backup refs changed; do not roll back.'
}
git -C $BackupMirror fsck --full --strict *> $null
if ($LASTEXITCODE -ne 0) { throw 'Protected backup integrity validation failed.' }

git -C $BackupMirror push --force --mirror $RemoteUrl
if ($LASTEXITCODE -ne 0) { throw 'Protected-mirror rollback push failed.' }

$RollbackVerificationMirror = Join-Path $IncidentRoot 'rollback-verification.git'
git clone --mirror $RemoteUrl $RollbackVerificationMirror
if ($LASTEXITCODE -ne 0) { throw 'Fresh rollback-verification clone failed.' }
$RestoredRefs = @(git -C $RollbackVerificationMirror show-ref)
if ($LASTEXITCODE -ne 0) { throw 'Could not enumerate restored refs.' }
if (@(Compare-Object $RecordedBackupRefs $RestoredRefs).Count -ne 0) {
  throw 'The restored remote does not match the protected backup refs.'
}
```
