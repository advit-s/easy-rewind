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

  return [EasyRewind.NativePathSafety]::CanonicalizeLocalDrivePath($Path)
}

function Assert-SafePublicPathForm {
  param([Parameter(Mandatory=$true)][string]$Path)

  if ([string]::IsNullOrWhiteSpace($Path) -or
      $Path -match '^(?:\\\\|//|\\\?\?\\)' -or
      $Path -match '^[A-Za-z]:[^\\/]' -or
      $Path -match '^[^\\/:]+::') {
    throw "Public path form is not allowed: $Path"
  }
}

function Resolve-PublicExistingLocalPath {
  param([Parameter(Mandatory=$true)][string]$Path)

  Assert-SafePublicPathForm -Path $Path
  $resolved = Resolve-Path -LiteralPath $Path -ErrorAction Stop
  $providerPath = [string]$resolved.ProviderPath
  if ([string]::IsNullOrWhiteSpace($providerPath)) {
    $providerPath = [string]$resolved.Path
  }
  return Get-CanonicalPath -Path (
    [System.IO.Path]::GetFullPath($providerPath)
  )
}

function Resolve-PublicLocalPath {
  param([Parameter(Mandatory=$true)][string]$Path)

  Assert-SafePublicPathForm -Path $Path
  return Get-CanonicalPath -Path ([System.IO.Path]::GetFullPath($Path))
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

  $verified = (Get-Item -LiteralPath $Path -Force).GetAccessControl()
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

function Open-LockedLocalDirectoryPath {
  param(
    [Parameter(Mandatory=$true)][string]$Path,
    [switch]$CreateMissing
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
      if ($CreateMissing) {
        $currentHandle = [EasyRewind.NativeDirectoryHandle]::OpenOrCreate(
          $currentHandle,
          [string]$component
        )
      } else {
        $currentHandle = [EasyRewind.NativeDirectoryHandle]::OpenExisting(
          $currentHandle,
          [string]$component
        )
      }
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

$resolvedSourceRoot = Resolve-PublicExistingLocalPath -Path $SourceRoot
Assert-NoEasyRewindProcess -ResolvedSourceRoot $resolvedSourceRoot

if ([string]::IsNullOrWhiteSpace($QuarantineRoot)) {
  if ([string]::IsNullOrWhiteSpace([System.Environment]::GetEnvironmentVariable('LOCALAPPDATA'))) {
    throw 'LOCALAPPDATA is required when QuarantineRoot is omitted.'
  }
  $QuarantineRoot = Join-Path (
    [System.Environment]::GetEnvironmentVariable('LOCALAPPDATA')
  ) 'easy-rewind\legacy-backup'
}
$resolvedQuarantineRoot = Resolve-PublicLocalPath -Path $QuarantineRoot

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
$sourceFiles = @()
foreach ($name in $requiredNames) {
  $sourcePath = Get-CanonicalPath -Path (
    Join-Path (Join-Path (Join-Path $resolvedSourceRoot 'backend') 'data') $name
  )
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
$manifestJson = $null
$failure = $null
$cleanupFailure = $null

try {
  # Process metadata is supplemental. These raw handles are the authoritative
  # gate for relative launches, startup-before-listen, and custom ports.
  $sourceDataPath = Get-CanonicalPath -Path (
    Join-Path (Join-Path $resolvedSourceRoot 'backend') 'data'
  )
  $sourceDirectoryChain = Open-LockedLocalDirectoryPath -Path $sourceDataPath
  $sourceDirectoryHandles = $sourceDirectoryChain.Handles
  $sourceDataHandle = $sourceDirectoryChain.Leaf
  foreach ($sourceFile in $sourceFiles) {
    try {
      $sourceHandle = [EasyRewind.NativeHandleFile]::OpenQuarantineSource(
        $sourceDataHandle,
        $sourceFile.Name
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

  $quarantineRootChain = Open-LockedLocalDirectoryPath `
    -Path $resolvedQuarantineRoot `
    -CreateMissing
  $quarantineRootHandles = $quarantineRootChain.Handles
  $quarantineRootHandle = $quarantineRootChain.Leaf
  $destinationHandle = [EasyRewind.NativeDirectoryHandle]::CreateNew(
    $quarantineRootHandle,
    $Timestamp
  )
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
      $destinationHandle,
      $sourceFile.Name
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
  $manifestHandle = [EasyRewind.NativeHandleFile]::CreateNew(
    $destinationHandle,
    'manifest.json'
  )
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
  if ($null -ne $failure -and $null -ne $destinationHandle) {
    $createdFileHandles = [System.Collections.Generic.List[
      EasyRewind.NativeHandleFile
    ]]::new()
    foreach ($backupHandle in $backupHandles) {
      $createdFileHandles.Add($backupHandle)
    }
    if ($null -ne $manifestHandle) {
      $createdFileHandles.Add($manifestHandle)
    }

    try {
      # Decide deletion against every exact create-new file handle as one
      # transaction. The helper rolls all earlier dispositions back if any
      # later disposition fails.
      [EasyRewind.NativeHandleOperations]::MarkDeletePendingAll(
        $createdFileHandles.ToArray(),
        -1
      )
    } catch {
      $cleanupFailure = $_
    }

    if ($null -eq $cleanupFailure) {
      # The exact child deletion decisions are complete. Closing them commits
      # those decisions before the still-held directory is tested for an
      # exact, nonrecursive delete. Untracked content makes that attempt return
      # false and is deliberately preserved with the destination directory.
      if ($null -ne $manifestHandle) {
        $manifestHandle.Dispose()
        $manifestHandle = $null
      }
      Close-HandleCollection -Handles $backupHandles
      $backupHandles.Clear()
      try {
        $null = $destinationHandle.TrySetDeletePending()
      } catch {
        $cleanupFailure = $_
      }
    }
  }

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
  if ($null -ne $cleanupFailure) {
    throw (
      "Quarantine failed: $($failure.Exception.Message) " +
      "Exact held-handle cleanup also failed: " +
      $cleanupFailure.Exception.Message
    )
  }
  throw $failure
}

Write-Output $manifestJson
