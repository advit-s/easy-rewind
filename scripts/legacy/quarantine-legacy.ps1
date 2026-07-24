[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$SourceRoot,
  [string]$QuarantineRoot,
  [string]$Timestamp = ([DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ'))
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'legacy-handle-safety.ps1')

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
$isWindowsPlatform = [System.Environment]::OSVersion.Platform -eq [System.PlatformID]::Win32NT

function Get-CanonicalPath {
  param([Parameter(Mandatory=$true)][string]$Path)

  return [System.IO.Path]::GetFullPath($Path)
}

function Get-CanonicalExistingDirectory {
  param([Parameter(Mandatory=$true)][string]$Path)

  $item = Get-Item -LiteralPath $Path -Force
  if (-not ($item -is [System.IO.DirectoryInfo])) {
    throw "Directory does not exist: $Path"
  }
  return Get-CanonicalPath -Path $item.FullName
}

function Test-PathEqual {
  param(
    [Parameter(Mandatory=$true)][string]$Left,
    [Parameter(Mandatory=$true)][string]$Right
  )

  return [string]::Equals($Left, $Right, $pathComparison)
}

function Test-ExecutableReferencesSourceRoot {
  param(
    [Parameter(Mandatory=$true)][AllowEmptyString()][string]$ExecutablePath,
    [Parameter(Mandatory=$true)][string]$ResolvedSourceRoot
  )

  if ([string]::IsNullOrWhiteSpace($ExecutablePath)) {
    return $false
  }
  try {
    $canonicalExecutablePath = Get-CanonicalPath -Path $ExecutablePath
  } catch {
    return $false
  }
  if (Test-PathEqual -Left $canonicalExecutablePath -Right $ResolvedSourceRoot) {
    return $true
  }

  $trimmedSourceRoot = $ResolvedSourceRoot.TrimEnd([char[]]@('\', '/'))
  $sourceDescendantPrefix = (
    $trimmedSourceRoot + [System.IO.Path]::DirectorySeparatorChar
  )
  return $canonicalExecutablePath.StartsWith(
    $sourceDescendantPrefix,
    $pathComparison
  )
}

function Test-CommandLineReferencesSourceRoot {
  param(
    [Parameter(Mandatory=$true)][AllowEmptyString()][string]$CommandLine,
    [Parameter(Mandatory=$true)][string]$ResolvedSourceRoot
  )

  if ([string]::IsNullOrWhiteSpace($CommandLine)) {
    return $false
  }

  $trimmedSourceRoot = $ResolvedSourceRoot.TrimEnd([char[]]@('\', '/'))
  $sourceRootForms = @($trimmedSourceRoot)
  if ($trimmedSourceRoot.Contains('\')) {
    $sourceRootForms += $trimmedSourceRoot.Replace('\', '/')
  }
  foreach ($sourceRootForm in @($sourceRootForms | Select-Object -Unique)) {
    $escapedSourceRoot = [System.Text.RegularExpressions.Regex]::Escape(
      $sourceRootForm
    )
    $sourceTokenPattern = (
      '(?:^|[\s"''=])' +
      $escapedSourceRoot +
      '(?:[\\/"''\s]|$)'
    )
    if ([System.Text.RegularExpressions.Regex]::IsMatch(
        $CommandLine,
        $sourceTokenPattern,
        [System.Text.RegularExpressions.RegexOptions]::IgnoreCase
      )) {
      return $true
    }
  }
  return $false
}

function Get-EasyRewindProcessClassification {
  param(
    [Parameter(Mandatory=$true)][object[]]$Processes,
    [Parameter(Mandatory=$true)][AllowEmptyCollection()][int[]]$ListeningPids,
    [Parameter(Mandatory=$true)][string]$ResolvedSourceRoot
  )

  $confirmedCandidates = [System.Collections.Generic.HashSet[int]]::new()
  $verificationFailures = [System.Collections.Generic.HashSet[int]]::new()
  foreach ($process in $Processes) {
    $name = [string]$process.Name
    $processId = [int]$process.ProcessId
    $executablePath = [string]$process.ExecutablePath
    $commandLine = [string]$process.CommandLine
    $isProductExecutable = $name -match '^(?i:easy[ -]?rewind)(?:\.exe)?$'
    if ($isProductExecutable) {
      $null = $confirmedCandidates.Add($processId)
      continue
    }

    $isGenericRuntime = $name -match '^(?i:node|electron)(?:\.exe)?$'
    if (-not $isGenericRuntime) {
      continue
    }

    $hasExecutableMetadata = -not [string]::IsNullOrWhiteSpace($executablePath)
    $hasCommandLineMetadata = -not [string]::IsNullOrWhiteSpace($commandLine)
    $referencesSource = (
      ($hasExecutableMetadata -and
        (Test-ExecutableReferencesSourceRoot `
          -ExecutablePath $executablePath `
          -ResolvedSourceRoot $ResolvedSourceRoot)) -or
      ($hasCommandLineMetadata -and
        (Test-CommandLineReferencesSourceRoot `
          -CommandLine $commandLine `
          -ResolvedSourceRoot $ResolvedSourceRoot))
    )
    $isPortServer = (
      $name -match '^(?i:node)(?:\.exe)?$' -and
      $hasCommandLineMetadata -and
      $commandLine -match '(?i)(?:^|[\\/"\s])server\.js(?:["\s]|$)' -and
      $ListeningPids -contains $processId
    )

    if ($referencesSource -or $isPortServer) {
      $null = $confirmedCandidates.Add($processId)
    } elseif (-not $hasExecutableMetadata -or -not $hasCommandLineMetadata) {
      $null = $verificationFailures.Add($processId)
    }
  }

  return [pscustomobject][ordered]@{
    confirmedCandidates = [int[]]@($confirmedCandidates | Sort-Object)
    verificationFailures = [int[]]@($verificationFailures | Sort-Object)
  }
}

function Assert-NoEasyRewindProcess {
  param([Parameter(Mandatory=$true)][string]$ResolvedSourceRoot)

  if (-not $isWindowsPlatform) {
    return
  }

  $listeningPids = @()
  $tcpQuerySucceeded = $false
  $tcpCommand = Get-Command -Name Get-NetTCPConnection -ErrorAction SilentlyContinue
  if ($null -ne $tcpCommand) {
    try {
      $listeningPids = @(
        Get-NetTCPConnection -State Listen -LocalPort 5000 -ErrorAction Stop |
          Select-Object -ExpandProperty OwningProcess -Unique
      )
      $tcpQuerySucceeded = $true
    } catch {
      $tcpQuerySucceeded = $false
    }
  }
  if (-not $tcpQuerySucceeded) {
    $netstatPath = Join-Path (
      [System.Environment]::GetFolderPath([System.Environment+SpecialFolder]::Windows)
    ) 'System32\netstat.exe'
    if (-not (Test-Path -LiteralPath $netstatPath -PathType Leaf)) {
      throw 'Cannot verify whether port 5000 is in use.'
    }
    $netstatLines = @(& $netstatPath -ano -p TCP 2>$null)
    if ($LASTEXITCODE -ne 0) {
      throw 'Cannot verify whether port 5000 is in use.'
    }
    foreach ($netstatLine in $netstatLines) {
      if ([string]$netstatLine -match
          '^\s*TCP\s+\S+:5000\s+\S+\s+LISTENING\s+(\d+)\s*$') {
        $listeningPids += [int]$matches[1]
      }
    }
    $listeningPids = @($listeningPids | Select-Object -Unique)
  }

  $processes = @()
  try {
    $processes = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop)
  } catch {
    if ($null -eq ('EasyRewind.NativeProcessQuery' -as [type])) {
      $nativeProcessQuery = @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

namespace EasyRewind {
  public static class NativeProcessQuery {
    private const uint QueryLimitedInformation = 0x1000;
    private const int ProcessCommandLineInformation = 60;

    [StructLayout(LayoutKind.Sequential)]
    private struct UnicodeString {
      public ushort Length;
      public ushort MaximumLength;
      public IntPtr Buffer;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(
      uint desiredAccess,
      bool inheritHandle,
      int processId
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool QueryFullProcessImageName(
      IntPtr processHandle,
      int flags,
      StringBuilder executablePath,
      ref int size
    );

    [DllImport("ntdll.dll")]
    private static extern int NtQueryInformationProcess(
      IntPtr processHandle,
      int informationClass,
      IntPtr information,
      int informationLength,
      out int returnLength
    );

    private static IntPtr Open(int processId) {
      IntPtr handle = OpenProcess(QueryLimitedInformation, false, processId);
      if (handle == IntPtr.Zero) {
        throw new Win32Exception(Marshal.GetLastWin32Error());
      }
      return handle;
    }

    public static string GetExecutablePath(int processId) {
      IntPtr handle = Open(processId);
      try {
        int size = 32768;
        StringBuilder result = new StringBuilder(size);
        if (!QueryFullProcessImageName(handle, 0, result, ref size)) {
          throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        return result.ToString();
      } finally {
        CloseHandle(handle);
      }
    }

    public static string GetCommandLine(int processId) {
      IntPtr handle = Open(processId);
      try {
        int requiredLength;
        NtQueryInformationProcess(
          handle,
          ProcessCommandLineInformation,
          IntPtr.Zero,
          0,
          out requiredLength
        );
        if (requiredLength <= 0) {
          throw new InvalidOperationException("Command line length is unavailable.");
        }

        IntPtr buffer = Marshal.AllocHGlobal(requiredLength);
        try {
          int returnedLength;
          int status = NtQueryInformationProcess(
            handle,
            ProcessCommandLineInformation,
            buffer,
            requiredLength,
            out returnedLength
          );
          if (status != 0) {
            throw new InvalidOperationException(
              "Command line query failed with status " + status + "."
            );
          }
          UnicodeString value = (UnicodeString)Marshal.PtrToStructure(
            buffer,
            typeof(UnicodeString)
          );
          return value.Buffer == IntPtr.Zero
            ? String.Empty
            : Marshal.PtrToStringUni(value.Buffer, value.Length / 2);
        } finally {
          Marshal.FreeHGlobal(buffer);
        }
      } finally {
        CloseHandle(handle);
      }
    }
  }
}
'@
      $null = Add-Type -TypeDefinition $nativeProcessQuery -Language CSharp
    }

    $processes = @(
      Get-Process -ErrorAction Stop | ForEach-Object {
        $nativeExecutablePath = ''
        $nativeCommandLine = ''
        try {
          $nativeExecutablePath = [EasyRewind.NativeProcessQuery]::GetExecutablePath(
            [int]$_.Id
          )
        } catch {
          $nativeExecutablePath = ''
        }
        try {
          $nativeCommandLine = [EasyRewind.NativeProcessQuery]::GetCommandLine(
            [int]$_.Id
          )
        } catch {
          $nativeCommandLine = ''
        }
        [pscustomobject]@{
          Name = [string]$_.ProcessName
          ExecutablePath = $nativeExecutablePath
          CommandLine = $nativeCommandLine
          ProcessId = [int]$_.Id
        }
      }
    )
  }
  if ($processes.Count -eq 0) {
    throw 'Unable to enumerate Windows processes.'
  }
  $classification = Get-EasyRewindProcessClassification `
    -Processes $processes `
    -ListeningPids $listeningPids `
    -ResolvedSourceRoot $ResolvedSourceRoot
  if ($classification.verificationFailures.Count -gt 0) {
    $pids = @($classification.verificationFailures)
    throw "Unable to verify Node/Electron process metadata for PIDs: $($pids -join ', ')"
  }
  if ($classification.confirmedCandidates.Count -gt 0) {
    $pids = @($classification.confirmedCandidates)
    throw "Easy Rewind processes are still running. PIDs: $($pids -join ', ')"
  }
}

function Set-AndVerifyPrivateDirectoryAcl {
  param(
    [Parameter(Mandatory=$true)][string]$Path,
    [Parameter(Mandatory=$true)]
    [EasyRewind.NativeDirectoryHandle]$NativeHandle
  )

  if (-not $isWindowsPlatform) {
    return
  }
  $currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  $security = New-Object System.Security.AccessControl.DirectorySecurity
  $security.SetOwner($currentSid)
  $security.SetAccessRuleProtection($true, $false)
  $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
    $currentSid,
    [System.Security.AccessControl.FileSystemRights]::FullControl,
    (
      [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
      [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
    ),
    [System.Security.AccessControl.PropagationFlags]::None,
    [System.Security.AccessControl.AccessControlType]::Allow
  )
  $null = $security.AddAccessRule($rule)
  $NativeHandle.ApplySecurityDescriptor(
    $security.GetSecurityDescriptorBinaryForm()
  )
  $accessSecurity = New-Object System.Security.AccessControl.DirectorySecurity
  $accessSecurity.SetAccessRuleProtection($true, $false)
  $null = $accessSecurity.AddAccessRule($rule)
  $directory = Get-Item -LiteralPath $Path -Force
  if ($PSVersionTable.PSEdition -eq 'Core') {
    [System.IO.FileSystemAclExtensions]::SetAccessControl(
      [System.IO.DirectoryInfo]$directory,
      $accessSecurity
    )
  } else {
    $directory.SetAccessControl($accessSecurity)
  }
  Assert-ExactPrivateAcl -Path $Path -IsDirectory $true -CurrentSid $currentSid
}

function Set-AndVerifyPrivateFileAcl {
  param(
    [Parameter(Mandatory=$true)][string]$Path,
    [Parameter(Mandatory=$true)]
    [EasyRewind.NativeHandleFile]$NativeHandle
  )

  if (-not $isWindowsPlatform) {
    return
  }
  $currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  $security = New-Object System.Security.AccessControl.FileSecurity
  $security.SetOwner($currentSid)
  $security.SetAccessRuleProtection($true, $false)
  $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
    $currentSid,
    [System.Security.AccessControl.FileSystemRights]::FullControl,
    [System.Security.AccessControl.AccessControlType]::Allow
  )
  $null = $security.AddAccessRule($rule)
  $NativeHandle.ApplySecurityDescriptor(
    $security.GetSecurityDescriptorBinaryForm()
  )
  $accessSecurity = New-Object System.Security.AccessControl.FileSecurity
  $accessSecurity.SetAccessRuleProtection($true, $false)
  $null = $accessSecurity.AddAccessRule($rule)
  $file = Get-Item -LiteralPath $Path -Force
  if ($PSVersionTable.PSEdition -eq 'Core') {
    [System.IO.FileSystemAclExtensions]::SetAccessControl(
      [System.IO.FileInfo]$file,
      $accessSecurity
    )
  } else {
    $file.SetAccessControl($accessSecurity)
  }
  Assert-ExactPrivateAcl -Path $Path -IsDirectory $false -CurrentSid $currentSid
}

function Assert-ExactPrivateAcl {
  param(
    [Parameter(Mandatory=$true)][string]$Path,
    [Parameter(Mandatory=$true)][bool]$IsDirectory,
    [Parameter(Mandatory=$true)]
    [System.Security.Principal.SecurityIdentifier]$CurrentSid
  )

  $verified = Get-Acl -LiteralPath $Path
  if (-not $verified.AreAccessRulesProtected) {
    throw "Quarantine ACL inheritance is not protected: $Path"
  }

  $ownerSid = (New-Object System.Security.Principal.NTAccount($verified.Owner)).
    Translate([System.Security.Principal.SecurityIdentifier])
  if ($ownerSid.Value -ne $CurrentSid.Value) {
    throw "Quarantine owner is not the current user: $Path"
  }
  $accessRules = @($verified.GetAccessRules(
    $true,
    $true,
    [System.Security.Principal.SecurityIdentifier]
  ))
  if ($accessRules.Count -ne 1) {
    throw "Quarantine ACL must contain exactly one access rule: $Path"
  }
  $accessRule = $accessRules[0]
  $expectedInheritance = if ($IsDirectory) {
    (
      [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
      [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
    )
  } else {
    [System.Security.AccessControl.InheritanceFlags]::None
  }
  if ($accessRule.IdentityReference.Value -ne $CurrentSid.Value -or
      $accessRule.AccessControlType -ne
        [System.Security.AccessControl.AccessControlType]::Allow -or
      $accessRule.FileSystemRights -ne
        [System.Security.AccessControl.FileSystemRights]::FullControl -or
      $accessRule.InheritanceFlags -ne $expectedInheritance -or
      $accessRule.PropagationFlags -ne
        [System.Security.AccessControl.PropagationFlags]::None -or
      $accessRule.IsInherited) {
    throw "Quarantine ACL is not exact current-user FullControl: $Path"
  }
}

function Open-LockedDirectoryChain {
  param(
    [Parameter(Mandatory=$true)][string]$Root,
    [string[]]$RelativeComponents = @()
  )

  $handles = [System.Collections.Generic.List[EasyRewind.NativeDirectoryHandle]]::new()
  try {
    $current = Get-CanonicalPath -Path $Root
    $handles.Add([EasyRewind.NativeDirectoryHandle]::OpenExisting($current))
    foreach ($component in $RelativeComponents) {
      $current = Get-CanonicalPath -Path (Join-Path $current $component)
      $handles.Add([EasyRewind.NativeDirectoryHandle]::OpenExisting($current))
    }
    return $handles
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

function Remove-TrackedQuarantineArtifacts {
  param(
    [Parameter(Mandatory=$true)][string]$Destination,
    [Parameter(Mandatory=$true)][string]$ExpectedRoot,
    [Parameter(Mandatory=$true)][string]$ExpectedTimestamp,
    [string[]]$CreatedBackupPaths = @(),
    [string]$ManifestPath,
    [bool]$ManifestCreated
  )

  $cleanupTarget = Get-CanonicalPath -Path $Destination
  $cleanupParent = [System.IO.Directory]::GetParent($cleanupTarget).FullName
  if (-not (Test-PathEqual -Left $cleanupTarget -Right $Destination) -or
      -not (Test-PathEqual -Left $cleanupParent -Right $ExpectedRoot) -or
      [System.IO.Path]::GetFileName($cleanupTarget) -cne $ExpectedTimestamp) {
    throw 'Refusing to clean up an unexpected quarantine path.'
  }
  foreach ($backupPath in $CreatedBackupPaths) {
    $resolvedBackup = Get-CanonicalPath -Path $backupPath
    if (-not (Test-PathEqual `
        -Left ([System.IO.Directory]::GetParent($resolvedBackup).FullName) `
        -Right $cleanupTarget)) {
      throw 'Refusing to clean up an unexpected backup path.'
    }
    if (Test-Path -LiteralPath $resolvedBackup -PathType Leaf) {
      Remove-Item -LiteralPath $resolvedBackup -Force
    }
  }
  if ($ManifestCreated -and -not [string]::IsNullOrWhiteSpace($ManifestPath)) {
    $resolvedManifest = Get-CanonicalPath -Path $ManifestPath
    if (-not (Test-PathEqual `
        -Left ([System.IO.Directory]::GetParent($resolvedManifest).FullName) `
        -Right $cleanupTarget) -or
        [System.IO.Path]::GetFileName($resolvedManifest) -cne 'manifest.json') {
      throw 'Refusing to clean up an unexpected manifest path.'
    }
    if (Test-Path -LiteralPath $resolvedManifest -PathType Leaf) {
      Remove-Item -LiteralPath $resolvedManifest -Force
    }
  }
  if (Test-Path -LiteralPath $cleanupTarget) {
    Remove-Item -LiteralPath $cleanupTarget -Force
  }
}

function Assert-StableSnapshot {
  param(
    [Parameter(Mandatory=$true)]
    [EasyRewind.NativeFileSnapshot]$Expected,
    [Parameter(Mandatory=$true)]
    [EasyRewind.NativeFileSnapshot]$Actual,
    [Parameter(Mandatory=$true)][string]$Label
  )

  if (-not $Expected.HasSameIdentity($Actual) -or
      $Expected.Size -ne $Actual.Size -or
      $Expected.Sha256 -cne $Actual.Sha256 -or
      $Expected.LinkCount -ne 1 -or
      $Actual.LinkCount -ne 1) {
    throw "Stable file validation failed for $Label."
  }
}

$resolvedSourceRoot = Get-CanonicalExistingDirectory -Path $SourceRoot
Assert-NoEasyRewindProcess -ResolvedSourceRoot $resolvedSourceRoot

if ([string]::IsNullOrWhiteSpace($QuarantineRoot)) {
  if ([string]::IsNullOrWhiteSpace([System.Environment]::GetEnvironmentVariable('LOCALAPPDATA'))) {
    throw 'LOCALAPPDATA is required when QuarantineRoot is omitted.'
  }
  $QuarantineRoot = Join-Path (
    [System.Environment]::GetEnvironmentVariable('LOCALAPPDATA')
  ) 'easy-rewind\legacy-backup'
}
$resolvedQuarantineRoot = Get-CanonicalPath -Path $QuarantineRoot

$parsedTimestamp = [DateTime]::MinValue
$timestampIsValid = (
  $Timestamp -match '^\d{8}T\d{9}Z$' -and
  [DateTime]::TryParseExact(
    $Timestamp,
    'yyyyMMddTHHmmssfffZ',
    [System.Globalization.CultureInfo]::InvariantCulture,
    (
      [System.Globalization.DateTimeStyles]::AssumeUniversal -bor
      [System.Globalization.DateTimeStyles]::AdjustToUniversal
    ),
    [ref]$parsedTimestamp
  ) -and
  $parsedTimestamp.ToUniversalTime().ToString(
    'yyyyMMddTHHmmssfffZ',
    [System.Globalization.CultureInfo]::InvariantCulture
  ) -ceq $Timestamp
)
if (-not $timestampIsValid) {
  throw "Timestamp must be a safe UTC leaf in yyyyMMddTHHmmssfffZ format: $Timestamp"
}

$destination = Get-CanonicalPath -Path (
  Join-Path $resolvedQuarantineRoot $Timestamp
)
if (-not (Test-PathEqual -Left ([System.IO.Directory]::GetParent($destination).FullName) `
    -Right $resolvedQuarantineRoot) -or
    [System.IO.Path]::GetFileName($destination) -cne $Timestamp) {
  throw 'Quarantine destination is not the expected direct timestamp child.'
}
if (Test-Path -LiteralPath $destination) {
  throw "Quarantine destination already exists: $destination"
}

$sourceFiles = @()
foreach ($name in $requiredNames) {
  $sourcePath = Get-CanonicalPath -Path (
    Join-Path (Join-Path (Join-Path $resolvedSourceRoot 'backend') 'data') $name
  )
  if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
    throw "Required legacy file is missing: $sourcePath"
  }
  $sourceItem = Get-Item -LiteralPath $sourcePath -Force
  if (-not ($sourceItem -is [System.IO.FileInfo]) -or
      (($sourceItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)) {
    throw "Required legacy file is missing: $sourcePath"
  }
  $sourceFiles += [pscustomobject]@{
    Name = $name
    Path = $sourcePath
  }
}

$sourceDirectoryHandles = $null
$quarantineRootHandles = $null
$destinationHandle = $null
$sourceHandles = [System.Collections.Generic.List[EasyRewind.NativeHandleFile]]::new()
$backupHandles = [System.Collections.Generic.List[EasyRewind.NativeHandleFile]]::new()
$manifestHandle = $null
$sourceInitial = @{}
$backupInitial = @{}
$createdBackupPaths = @()
$manifestPath = Get-CanonicalPath -Path (Join-Path $destination 'manifest.json')
$manifestCreated = $false
$destinationCreated = $false
$manifestJson = $null
$failure = $null

try {
  # Process metadata is supplemental. These raw handles are the authoritative
  # gate for relative launches, startup-before-listen, and custom ports.
  $sourceDirectoryHandles = Open-LockedDirectoryChain `
    -Root $resolvedSourceRoot `
    -RelativeComponents @('backend', 'data')
  foreach ($sourceFile in $sourceFiles) {
    try {
      $sourceHandle = [EasyRewind.NativeHandleFile]::OpenQuarantineSource(
        $sourceFile.Path
      )
    } catch {
      if ($_.Exception.Message -match 'source set is in use') {
        throw "Source set is in use: $($sourceFile.Path)"
      }
      throw
    }
    $sourceHandles.Add($sourceHandle)
    $sourceInitial[$sourceFile.Name] = $sourceHandle.Snapshot()
  }

  if (Test-Path -LiteralPath $resolvedQuarantineRoot) {
    if (-not (Test-Path -LiteralPath $resolvedQuarantineRoot -PathType Container)) {
      throw "QuarantineRoot is not a directory: $resolvedQuarantineRoot"
    }
  } else {
    $null = [System.IO.Directory]::CreateDirectory($resolvedQuarantineRoot)
  }
  $quarantineRootHandles = Open-LockedDirectoryChain -Root $resolvedQuarantineRoot
  $destinationHandle = [EasyRewind.NativeDirectoryHandle]::CreateNew($destination)
  $destinationCreated = $true
  Set-AndVerifyPrivateDirectoryAcl `
    -Path $destination `
    -NativeHandle $destinationHandle

  $manifestEntries = @()
  for ($index = 0; $index -lt $sourceFiles.Count; $index++) {
    $sourceFile = $sourceFiles[$index]
    $sourceHandle = $sourceHandles[$index]
    $backupPath = Get-CanonicalPath -Path (
      Join-Path $destination $sourceFile.Name
    )
    $backupHandle = [EasyRewind.NativeHandleOperations]::CopyToCreateNew(
      $sourceHandle,
      $backupPath
    )
    $backupHandles.Add($backupHandle)
    $createdBackupPaths += $backupPath
    Set-AndVerifyPrivateFileAcl `
      -Path $backupPath `
      -NativeHandle $backupHandle
    $backupSnapshot = $backupHandle.Snapshot()
    $backupInitial[$sourceFile.Name] = $backupSnapshot
    $sourceSnapshot = $sourceInitial[$sourceFile.Name]
    if ($sourceSnapshot.Size -ne $backupSnapshot.Size -or
        $sourceSnapshot.Sha256 -cne $backupSnapshot.Sha256) {
      throw "Backup copy does not match held source: $($sourceFile.Path)"
    }
    $manifestEntries += [ordered]@{
      name = $sourceFile.Name
      originalPath = $sourceFile.Path
      backupRelativePath = $sourceFile.Name
      size = [long]$sourceSnapshot.Size
      sha256 = $sourceSnapshot.Sha256
    }
  }

  $manifest = [ordered]@{
    schemaVersion = 1
    sensitive = $true
    warning = 'Contains sensitive personal legacy data and is not secure credential storage.'
    backupTimeUtc = [DateTime]::UtcNow.ToString(
      'o',
      [System.Globalization.CultureInfo]::InvariantCulture
    )
    sqliteOpened = $false
    sourceRoot = $resolvedSourceRoot
    quarantinePath = $destination
    manifestPath = $manifestPath
    files = $manifestEntries
  }
  $manifestJson = $manifest | ConvertTo-Json -Depth 6 -Compress
  $utf8WithoutBom = New-Object System.Text.UTF8Encoding($false)
  $manifestHandle = [EasyRewind.NativeHandleFile]::CreateNew($manifestPath)
  $manifestCreated = $true
  $manifestHandle.WriteAllBytes(
    $utf8WithoutBom.GetBytes($manifestJson + [System.Environment]::NewLine)
  )
  Set-AndVerifyPrivateFileAcl `
    -Path $manifestPath `
    -NativeHandle $manifestHandle

  Set-AndVerifyPrivateDirectoryAcl `
    -Path $destination `
    -NativeHandle $destinationHandle
  for ($index = 0; $index -lt $createdBackupPaths.Count; $index++) {
    Set-AndVerifyPrivateFileAcl `
      -Path $createdBackupPaths[$index] `
      -NativeHandle $backupHandles[$index]
  }
  Set-AndVerifyPrivateFileAcl `
    -Path $manifestPath `
    -NativeHandle $manifestHandle

  for ($index = 0; $index -lt $sourceFiles.Count; $index++) {
    $sourceFile = $sourceFiles[$index]
    $sourceFinal = $sourceHandles[$index].Snapshot()
    Assert-StableSnapshot `
      -Expected $sourceInitial[$sourceFile.Name] `
      -Actual $sourceFinal `
      -Label $sourceFile.Path
    $backupFinal = $backupHandles[$index].Snapshot()
    Assert-StableSnapshot `
      -Expected $backupInitial[$sourceFile.Name] `
      -Actual $backupFinal `
      -Label (Join-Path $destination $sourceFile.Name)
    if ($sourceFinal.Size -ne $backupFinal.Size -or
        $sourceFinal.Sha256 -cne $backupFinal.Sha256) {
      throw "Complete-set backup validation failed: $($sourceFile.Name)"
    }
  }
} catch {
  $failure = $_
} finally {
  if ($null -ne $manifestHandle) {
    $manifestHandle.Dispose()
  }
  Close-HandleCollection -Handles $backupHandles
  Close-HandleCollection -Handles $sourceHandles
  if ($null -ne $destinationHandle) {
    $destinationHandle.Dispose()
  }
  Close-HandleCollection -Handles $quarantineRootHandles
  Close-HandleCollection -Handles $sourceDirectoryHandles
}

if ($null -ne $failure) {
  if ($destinationCreated) {
    try {
      Remove-TrackedQuarantineArtifacts `
        -Destination $destination `
        -ExpectedRoot $resolvedQuarantineRoot `
        -ExpectedTimestamp $Timestamp `
        -CreatedBackupPaths $createdBackupPaths `
        -ManifestPath $manifestPath `
        -ManifestCreated $manifestCreated
    } catch {
      throw "Quarantine failed and exact non-recursive cleanup also failed: $($_.Exception.Message)"
    }
  }
  throw $failure
}

Write-Output $manifestJson
