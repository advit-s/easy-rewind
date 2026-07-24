[CmdletBinding(SupportsShouldProcess=$true, ConfirmImpact='High')]
param([Parameter(Mandatory=$true)][string]$ManifestPath)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$requiredNames = @(
  'easy-rewind.db',
  'easy-rewind.db-wal',
  'easy-rewind.db-shm',
  'settings.json'
)
$pathComparison = if ([System.Environment]::OSVersion.Platform -eq [System.PlatformID]::Win32NT) {
  [System.StringComparison]::OrdinalIgnoreCase
} else {
  [System.StringComparison]::Ordinal
}

function Get-CanonicalPath {
  param([Parameter(Mandatory=$true)][string]$Path)

  return [System.IO.Path]::GetFullPath($Path)
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

function Get-VerifiedOrdinaryFile {
  param(
    [Parameter(Mandatory=$true)][string]$Path,
    [ValidateSet('Manifest', 'Source', 'Backup')][string]$Kind = 'Manifest'
  )

  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    if ($Kind -eq 'Source') {
      throw "Source changed since quarantine: $Path"
    }
    if ($Kind -eq 'Backup') {
      throw "Backup checksum mismatch: $Path"
    }
    throw "Required verified file is missing: $Path"
  }
  $item = Get-Item -LiteralPath $Path -Force
  if (-not ($item -is [System.IO.FileInfo]) -or
      (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)) {
    if ($Kind -eq 'Source') {
      throw "Source changed since quarantine: $Path"
    }
    if ($Kind -eq 'Backup') {
      throw "Backup checksum mismatch: $Path"
    }
    throw "Required verified path is not an ordinary file: $Path"
  }
  return $item
}

$manifestItem = Get-VerifiedOrdinaryFile -Path $ManifestPath
$resolvedManifestPath = Get-CanonicalPath -Path $manifestItem.FullName

try {
  $manifest = Get-Content -LiteralPath $resolvedManifestPath -Raw -Encoding UTF8 |
    ConvertFrom-Json
} catch {
  throw "Manifest is not valid JSON: $resolvedManifestPath"
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
$quarantineItem = Get-Item -LiteralPath $declaredQuarantinePath -Force
if (-not ($quarantineItem -is [System.IO.DirectoryInfo])) {
  throw 'Manifest quarantinePath is not an existing directory.'
}
$resolvedQuarantinePath = Get-CanonicalPath -Path $quarantineItem.FullName
if (-not (Test-PathEqual -Left $declaredQuarantinePath -Right $resolvedQuarantinePath)) {
  throw 'Manifest quarantinePath is not canonical.'
}

$declaredManifestPath = [string]$manifest.manifestPath
$canonicalDeclaredManifestPath = Get-CanonicalPath -Path $declaredManifestPath
if (-not (Test-PathEqual -Left $declaredManifestPath -Right $canonicalDeclaredManifestPath) -or
    -not (Test-PathEqual -Left $resolvedManifestPath -Right $canonicalDeclaredManifestPath)) {
  throw 'Supplied manifest does not match its declared manifestPath.'
}
$manifestParent = [System.IO.Directory]::GetParent($resolvedManifestPath)
if ($null -eq $manifestParent -or
    -not (Test-PathEqual -Left $manifestParent.FullName -Right $resolvedQuarantinePath) -or
    [System.IO.Path]::GetFileName($resolvedManifestPath) -cne 'manifest.json') {
  throw 'Manifest must be a direct manifest.json file in the declared quarantine directory.'
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
foreach ($requiredName in $requiredNames) {
  if (-not $entriesByName.ContainsKey($requiredName)) {
    throw "Manifest is missing required file entry: $requiredName"
  }
}

$validatedFiles = @()
foreach ($name in $requiredNames) {
  $entry = $entriesByName[$name]
  if ([string]$entry.backupRelativePath -cne $name -or
      [System.IO.Path]::IsPathRooted([string]$entry.backupRelativePath)) {
    throw "Manifest backupRelativePath must equal its exact file name: $name"
  }

  $expectedOriginalPath = Get-CanonicalPath -Path (
    Join-Path (Join-Path (Join-Path $canonicalSourceRoot 'backend') 'data') $name
  )
  $declaredOriginalPath = [string]$entry.originalPath
  if (-not (Test-PathEqual -Left $declaredOriginalPath -Right $expectedOriginalPath) -or
      -not (Test-PathEqual -Left $declaredOriginalPath `
        -Right (Get-CanonicalPath -Path $declaredOriginalPath))) {
    throw "Manifest originalPath is not the exact source path for: $name"
  }

  $expectedBackupPath = Get-CanonicalPath -Path (
    Join-Path $resolvedQuarantinePath $name
  )
  $declaredBackupPath = Get-CanonicalPath -Path (
    Join-Path $resolvedQuarantinePath ([string]$entry.backupRelativePath)
  )
  if (-not (Test-PathEqual -Left $declaredBackupPath -Right $expectedBackupPath) -or
      -not (Test-PathEqual -Left ([System.IO.Directory]::GetParent($declaredBackupPath).FullName) `
        -Right $resolvedQuarantinePath)) {
    throw "Manifest backup path is not the exact quarantine path for: $name"
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
    SourcePath = $expectedOriginalPath
    BackupPath = $expectedBackupPath
    Size = $expectedSize
    Hash = $expectedHash
  }
}

# Complete the full source-and-backup validation pass before removing any source.
foreach ($validatedFile in $validatedFiles) {
  $sourceItem = Get-VerifiedOrdinaryFile -Path $validatedFile.SourcePath -Kind Source
  if ([long]$sourceItem.Length -ne $validatedFile.Size) {
    throw "Source changed since quarantine: $($validatedFile.SourcePath)"
  }
  $sourceHash = (Get-FileHash -LiteralPath $validatedFile.SourcePath -Algorithm SHA256).
    Hash.ToUpperInvariant()
  if ($sourceHash -cne $validatedFile.Hash) {
    throw "Source changed since quarantine: $($validatedFile.SourcePath)"
  }

  $backupItem = Get-VerifiedOrdinaryFile -Path $validatedFile.BackupPath -Kind Backup
  if ([long]$backupItem.Length -ne $validatedFile.Size) {
    throw "Backup checksum mismatch: $($validatedFile.BackupPath)"
  }
  $backupHash = (Get-FileHash -LiteralPath $validatedFile.BackupPath -Algorithm SHA256).
    Hash.ToUpperInvariant()
  if ($backupHash -cne $validatedFile.Hash) {
    throw "Backup checksum mismatch: $($validatedFile.BackupPath)"
  }
}

$removedPaths = @()
foreach ($validatedFile in $validatedFiles) {
  if ($PSCmdlet.ShouldProcess($validatedFile.SourcePath, 'Purge verified legacy source file')) {
    Remove-Item -LiteralPath $validatedFile.SourcePath -Force
    $removedPaths += $validatedFile.SourcePath
  }
}

$result = [ordered]@{
  purged = ($removedPaths.Count -eq 4)
  manifestPath = $resolvedManifestPath
  removed = $removedPaths
}
Write-Output ($result | ConvertTo-Json -Depth 4 -Compress)
