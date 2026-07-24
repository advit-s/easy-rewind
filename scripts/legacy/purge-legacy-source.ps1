[CmdletBinding(SupportsShouldProcess=$true, ConfirmImpact='High')]
param([Parameter(Mandatory=$true)][string]$ManifestPath)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'legacy-handle-safety.ps1')

$requiredNames = @(
  'easy-rewind.db',
  'easy-rewind.db-wal',
  'easy-rewind.db-shm',
  'settings.json'
)
$sensitivityWarning =
  'Contains sensitive personal legacy data and is not secure credential storage.'
$pathComparison = if ([System.Environment]::OSVersion.Platform -eq
    [System.PlatformID]::Win32NT) {
  [System.StringComparison]::OrdinalIgnoreCase
} else {
  [System.StringComparison]::Ordinal
}

function Get-CanonicalPath {
  param([Parameter(Mandatory=$true)][string]$Path)
  return [EasyRewind.NativePathSafety]::CanonicalizeLocalDrivePath($Path)
}

function Test-PathEqual {
  param(
    [Parameter(Mandatory=$true)][string]$Left,
    [Parameter(Mandatory=$true)][string]$Right
  )
  return [string]::Equals($Left, $Right, $pathComparison)
}

function Assert-StringProperty {
  param(
    [Parameter(Mandatory=$true)][psobject]$Object,
    [Parameter(Mandatory=$true)][string]$Name
  )
  $property = $Object.PSObject.Properties[$Name]
  if ($null -eq $property -or
      -not ($property.Value -is [string]) -or
      [string]::IsNullOrWhiteSpace([string]$property.Value)) {
    throw "Manifest property must be a non-empty string: $Name"
  }
}

function Assert-ManifestInteger {
  param(
    [Parameter(Mandatory=$true)]$Value,
    [Parameter(Mandatory=$true)][string]$Label
  )
  if (-not (
      $Value -is [byte] -or
      $Value -is [sbyte] -or
      $Value -is [int16] -or
      $Value -is [uint16] -or
      $Value -is [int32] -or
      $Value -is [uint32] -or
      $Value -is [int64] -or
      $Value -is [uint64]
    )) {
    throw "Manifest value must be an integer: $Label"
  }
}

function Open-LockedLocalDirectoryPath {
  param(
    [Parameter(Mandatory=$true)][string]$Path
  )
  $handles = [System.Collections.Generic.List[EasyRewind.NativeDirectoryHandle]]::new()
  try {
    $canonicalPath = Get-CanonicalPath -Path $Path
    $volumeRoot = [System.IO.Path]::GetPathRoot($canonicalPath)
    $currentHandle = [EasyRewind.NativeDirectoryHandle]::OpenLocalVolumeRoot(
      $canonicalPath
    )
    $handles.Add($currentHandle)
    $relativePath = $canonicalPath.Substring($volumeRoot.Length)
    $components = @(
      $relativePath.Split(
        [char[]]@('\', '/'),
        [System.StringSplitOptions]::RemoveEmptyEntries
      )
    )
    foreach ($component in $components) {
      $currentHandle = [EasyRewind.NativeDirectoryHandle]::OpenExisting(
        $currentHandle,
        [string]$component
      )
      $handles.Add($currentHandle)
    }
    return [pscustomobject]@{
      Handles = $handles
      Leaf = $currentHandle
      Path = $canonicalPath
    }
  } catch {
    foreach ($handle in $handles) {
      $handle.Dispose()
    }
    throw
  }
}

function Close-HandleCollection {
  param([AllowNull()]$Handles)
  if ($null -eq $Handles) {
    return
  }
  foreach ($handle in $Handles) {
    if ($null -ne $handle) {
      $handle.Dispose()
    }
  }
}

function Assert-SnapshotMatchesManifest {
  param(
    [Parameter(Mandatory=$true)]
    [EasyRewind.NativeFileSnapshot]$Snapshot,
    [Parameter(Mandatory=$true)][long]$ExpectedSize,
    [Parameter(Mandatory=$true)][string]$ExpectedHash,
    [Parameter(Mandatory=$true)][ValidateSet('Source', 'Backup')]
    [string]$Kind,
    [Parameter(Mandatory=$true)][string]$Path
  )
  if ($Snapshot.LinkCount -ne 1 -or
      $Snapshot.Size -ne $ExpectedSize -or
      $Snapshot.Sha256 -cne $ExpectedHash) {
    if ($Kind -eq 'Source') {
      throw "Source changed since quarantine: $Path"
    }
    throw "Backup checksum mismatch: $Path"
  }
}

$resolvedManifestPath = Get-CanonicalPath -Path $ManifestPath
$manifestParent = [System.IO.Directory]::GetParent($resolvedManifestPath)
if ($null -eq $manifestParent -or
    [System.IO.Path]::GetFileName($resolvedManifestPath) -cne 'manifest.json') {
  throw 'Manifest must be direct manifest.json in the quarantine directory.'
}
$manifestHandle = $null
$sourceDirectoryHandles = $null
$quarantineDirectoryHandles = $null
$sourceHandles = [System.Collections.Generic.List[EasyRewind.NativeHandleFile]]::new()
$backupHandles = [System.Collections.Generic.List[EasyRewind.NativeHandleFile]]::new()
$failure = $null
$resultJson = $null

try {
  $quarantineDirectoryChain = Open-LockedLocalDirectoryPath `
    -Path $manifestParent.FullName
  $quarantineDirectoryHandles = $quarantineDirectoryChain.Handles
  $quarantineDirectoryHandle = $quarantineDirectoryChain.Leaf
  $manifestHandle = [EasyRewind.NativeHandleFile]::OpenBackupRead(
    $quarantineDirectoryHandle,
    'manifest.json'
  )
  $manifestBytes = $manifestHandle.ReadAllBytes()
  if ($manifestBytes.Length -ge 3 -and
      $manifestBytes[0] -eq 0xEF -and
      $manifestBytes[1] -eq 0xBB -and
      $manifestBytes[2] -eq 0xBF) {
    throw 'Manifest must be UTF-8 without BOM.'
  }
  try {
    $strictUtf8 = New-Object System.Text.UTF8Encoding($false, $true)
    $manifestText = $strictUtf8.GetString($manifestBytes)
    $manifest = $manifestText | ConvertFrom-Json
  } catch {
    throw "Manifest is not valid BOM-free UTF-8 JSON: $resolvedManifestPath"
  }
  if ($null -eq $manifest -or -not ($manifest -is [psobject])) {
    throw 'Manifest must be a JSON object.'
  }

  $schemaProperty = $manifest.PSObject.Properties['schemaVersion']
  if ($null -eq $schemaProperty) {
    throw 'Manifest schemaVersion must be integer 1.'
  }
  Assert-ManifestInteger -Value $schemaProperty.Value -Label 'schemaVersion'
  if ([long]$schemaProperty.Value -ne 1) {
    throw 'Manifest schemaVersion must be integer 1.'
  }
  $sensitiveProperty = $manifest.PSObject.Properties['sensitive']
  if ($null -eq $sensitiveProperty -or
      -not ($sensitiveProperty.Value -is [bool]) -or
      $sensitiveProperty.Value -ne $true) {
    throw 'Manifest sensitive must be true.'
  }
  $sqliteProperty = $manifest.PSObject.Properties['sqliteOpened']
  if ($null -eq $sqliteProperty -or
      -not ($sqliteProperty.Value -is [bool]) -or
      $sqliteProperty.Value -ne $false) {
    throw 'Manifest sqliteOpened must be false.'
  }
  Assert-StringProperty -Object $manifest -Name 'warning'
  if ([string]$manifest.warning -cne $sensitivityWarning) {
    throw 'Manifest warning does not match the required sensitivity warning.'
  }
  Assert-StringProperty -Object $manifest -Name 'backupTimeUtc'
  $backupTime = [DateTimeOffset]::MinValue
  if ([string]$manifest.backupTimeUtc -cnotmatch 'Z$' -or
      -not [DateTimeOffset]::TryParse(
        [string]$manifest.backupTimeUtc,
        [System.Globalization.CultureInfo]::InvariantCulture,
        (
          [System.Globalization.DateTimeStyles]::AssumeUniversal -bor
          [System.Globalization.DateTimeStyles]::AdjustToUniversal
        ),
        [ref]$backupTime
      ) -or
      $backupTime.Offset -ne [TimeSpan]::Zero) {
    throw 'Manifest backupTimeUtc must be parseable UTC ending in Z.'
  }

  Assert-StringProperty -Object $manifest -Name 'sourceRoot'
  Assert-StringProperty -Object $manifest -Name 'quarantinePath'
  Assert-StringProperty -Object $manifest -Name 'manifestPath'
  $filesProperty = $manifest.PSObject.Properties['files']
  if ($null -eq $filesProperty) {
    throw 'Manifest files must contain exactly four entries.'
  }
  $entries = @($filesProperty.Value)
  if ($entries.Count -ne 4) {
    throw 'Manifest files must contain exactly four entries.'
  }

  $declaredSourceRoot = [string]$manifest.sourceRoot
  $canonicalSourceRoot = Get-CanonicalPath -Path $declaredSourceRoot
  if (-not (Test-PathEqual -Left $declaredSourceRoot -Right $canonicalSourceRoot)) {
    throw 'Manifest sourceRoot is not canonical.'
  }
  $declaredQuarantinePath = [string]$manifest.quarantinePath
  $resolvedQuarantinePath = Get-CanonicalPath -Path $declaredQuarantinePath
  if (-not (Test-PathEqual `
      -Left $declaredQuarantinePath `
      -Right $resolvedQuarantinePath) -or
      -not (Test-PathEqual `
        -Left $quarantineDirectoryHandle.Path `
        -Right $resolvedQuarantinePath)) {
    throw 'Manifest quarantinePath is not canonical.'
  }
  $declaredManifestPath = [string]$manifest.manifestPath
  $canonicalDeclaredManifest = Get-CanonicalPath -Path $declaredManifestPath
  if (-not (Test-PathEqual `
      -Left $declaredManifestPath `
      -Right $canonicalDeclaredManifest) -or
      -not (Test-PathEqual `
        -Left $resolvedManifestPath `
        -Right $canonicalDeclaredManifest)) {
    throw 'Supplied manifest does not match its declared manifestPath.'
  }
  if (-not (Test-PathEqual `
        -Left $manifestParent.FullName `
        -Right $resolvedQuarantinePath) -or
      [System.IO.Path]::GetFileName($resolvedManifestPath) -cne 'manifest.json') {
    throw 'Manifest must be direct manifest.json in the quarantine directory.'
  }

  $entriesByName = @{}
  foreach ($entry in $entries) {
    if ($null -eq $entry -or -not ($entry -is [psobject])) {
      throw 'Every manifest file entry must be an object.'
    }
    Assert-StringProperty -Object $entry -Name 'name'
    Assert-StringProperty -Object $entry -Name 'originalPath'
    Assert-StringProperty -Object $entry -Name 'backupRelativePath'
    Assert-StringProperty -Object $entry -Name 'sha256'
    $name = [string]$entry.name
    if ($requiredNames -cnotcontains $name) {
      throw "Manifest contains an unexpected file entry: $name"
    }
    if ($entriesByName.ContainsKey($name)) {
      throw "Manifest contains a duplicate file entry: $name"
    }
    $entriesByName.Add($name, $entry)
  }
  foreach ($name in $requiredNames) {
    if (-not $entriesByName.ContainsKey($name)) {
      throw "Manifest is missing required file entry: $name"
    }
  }

  $validatedFiles = @()
  foreach ($name in $requiredNames) {
    $entry = $entriesByName[$name]
    if ([string]$entry.backupRelativePath -cne $name -or
        [System.IO.Path]::IsPathRooted([string]$entry.backupRelativePath)) {
      throw "Manifest backupRelativePath must equal its exact file name: $name"
    }
    $expectedOriginal = Get-CanonicalPath -Path (
      Join-Path (Join-Path (Join-Path $canonicalSourceRoot 'backend') 'data') $name
    )
    if (-not (Test-PathEqual `
        -Left ([string]$entry.originalPath) `
        -Right $expectedOriginal) -or
        -not (Test-PathEqual `
          -Left ([string]$entry.originalPath) `
          -Right (Get-CanonicalPath -Path ([string]$entry.originalPath)))) {
      throw "Manifest originalPath is not exact for: $name"
    }
    $expectedBackup = Get-CanonicalPath -Path (
      Join-Path $resolvedQuarantinePath $name
    )
    if (-not (Test-PathEqual `
        -Left ([System.IO.Directory]::GetParent($expectedBackup).FullName) `
        -Right $resolvedQuarantinePath)) {
      throw "Manifest backup path is not exact for: $name"
    }
    $sizeProperty = $entry.PSObject.Properties['size']
    if ($null -eq $sizeProperty) {
      throw "Manifest size is missing for: $name"
    }
    Assert-ManifestInteger -Value $sizeProperty.Value -Label "$name size"
    $expectedSize = [long]$sizeProperty.Value
    if ($expectedSize -lt 0) {
      throw "Manifest size cannot be negative for: $name"
    }
    $expectedHash = [string]$entry.sha256
    if ($expectedHash -cnotmatch '^[0-9A-F]{64}$') {
      throw "Manifest SHA-256 must be uppercase hexadecimal for: $name"
    }
    $validatedFiles += [pscustomobject]@{
      Name = $name
      SourcePath = $expectedOriginal
      BackupPath = $expectedBackup
      Size = $expectedSize
      Hash = $expectedHash
    }
  }

  # Supplemental metadata is rerun immediately before the authoritative locks.
  Invoke-EasyRewindSupplementalProcessVerification `
    -ResolvedSourceRoot $canonicalSourceRoot
  $sourceDataPath = Get-CanonicalPath -Path (
    Join-Path (Join-Path $canonicalSourceRoot 'backend') 'data'
  )
  $sourceDirectoryChain = Open-LockedLocalDirectoryPath -Path $sourceDataPath
  $sourceDirectoryHandles = $sourceDirectoryChain.Handles
  $sourceDataHandle = $sourceDirectoryChain.Leaf

  foreach ($validatedFile in $validatedFiles) {
    try {
      $sourceHandle = [EasyRewind.NativeHandleFile]::OpenPurgeSource(
        $sourceDataHandle,
        $validatedFile.Name
      )
    } catch {
      throw "Source changed or source set is in use: $($validatedFile.SourcePath)"
    }
    $sourceHandles.Add($sourceHandle)
    try {
      $backupHandle = [EasyRewind.NativeHandleFile]::OpenBackupRead(
        $quarantineDirectoryHandle,
        $validatedFile.Name
      )
    } catch {
      throw "Backup checksum mismatch or backup is in use: $($validatedFile.BackupPath)"
    }
    $backupHandles.Add($backupHandle)
  }

  $sourceSnapshots = @()
  $backupSnapshots = @()
  for ($index = 0; $index -lt $validatedFiles.Count; $index++) {
    $validatedFile = $validatedFiles[$index]
    $sourceSnapshot = $sourceHandles[$index].Snapshot()
    $backupSnapshot = $backupHandles[$index].Snapshot()
    Assert-SnapshotMatchesManifest `
      -Snapshot $sourceSnapshot `
      -ExpectedSize $validatedFile.Size `
      -ExpectedHash $validatedFile.Hash `
      -Kind Source `
      -Path $validatedFile.SourcePath
    Assert-SnapshotMatchesManifest `
      -Snapshot $backupSnapshot `
      -ExpectedSize $validatedFile.Size `
      -ExpectedHash $validatedFile.Hash `
      -Kind Backup `
      -Path $validatedFile.BackupPath
    $sourceSnapshots += $sourceSnapshot
    $backupSnapshots += $backupSnapshot
  }

  # A second complete-set pass immediately precedes the single destructive gate.
  for ($index = 0; $index -lt $validatedFiles.Count; $index++) {
    $sourceAgain = $sourceHandles[$index].Snapshot()
    $backupAgain = $backupHandles[$index].Snapshot()
    if (-not $sourceSnapshots[$index].HasSameIdentity($sourceAgain) -or
        $sourceSnapshots[$index].Sha256 -cne $sourceAgain.Sha256 -or
        -not $backupSnapshots[$index].HasSameIdentity($backupAgain) -or
        $backupSnapshots[$index].Sha256 -cne $backupAgain.Sha256) {
      throw "Held complete-set identity changed: $($validatedFiles[$index].Name)"
    }
  }

  $decisionTarget = (
    'four exact manifest-verified legacy source files under ' +
    $canonicalSourceRoot
  )
  # This is intentionally one set-level decision: per-file confirmation can
  # authorize only part of the coherent SQLite set. Deletion is intentionally
  # committed through the already-verified handles below; reopening paths could
  # delete replacement bytes that were never matched to the backup manifest.
  if (-not $PSCmdlet.ShouldProcess(
      $decisionTarget,
      'Purge the complete verified legacy source set'
    )) {
    $resultJson = ([ordered]@{
      purged = $false
      manifestPath = $resolvedManifestPath
      removed = @()
    } | ConvertTo-Json -Depth 4 -Compress)
  } else {
    [EasyRewind.NativeHandleOperations]::MarkDeletePendingAll(
      $sourceHandles.ToArray(),
      -1
    )
    Close-HandleCollection -Handles $sourceHandles
    $sourceHandles.Clear()
    $resultJson = ([ordered]@{
      purged = $true
      manifestPath = $resolvedManifestPath
      removed = @($validatedFiles | ForEach-Object { $_.SourcePath })
    } | ConvertTo-Json -Depth 4 -Compress)
  }
} catch {
  $failure = $_
} finally {
  Close-HandleCollection -Handles $sourceHandles
  Close-HandleCollection -Handles $backupHandles
  Close-HandleCollection -Handles $quarantineDirectoryHandles
  Close-HandleCollection -Handles $sourceDirectoryHandles
  if ($null -ne $manifestHandle) {
    $manifestHandle.Dispose()
  }
}

if ($null -ne $failure) {
  throw $failure
}
Write-Output $resultJson
