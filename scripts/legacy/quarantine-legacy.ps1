[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$SourceRoot,
  [string]$QuarantineRoot,
  [string]$Timestamp = ([DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ'))
)

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

function Get-OrdinaryFileState {
  param([Parameter(Mandatory=$true)][string]$Path)

  $item = Get-Item -LiteralPath $Path -Force
  if (-not ($item -is [System.IO.FileInfo]) -or
      (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)) {
    throw "Required path is not an ordinary file: $Path"
  }

  $hash = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToUpperInvariant()
  return [pscustomobject]@{
    Size = [long]$item.Length
    Hash = $hash
  }
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

  $matchingPids = [System.Collections.Generic.HashSet[int]]::new()
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
  foreach ($process in $processes) {
    $name = [string]$process.Name
    $executablePath = [string]$process.ExecutablePath
    $commandLine = [string]$process.CommandLine
    $isProductExecutable = $name -match '^(?i:easy[ -]?rewind)(?:\.exe)?$'
    $isGenericRuntime = $name -match '^(?i:node|electron)(?:\.exe)?$'
    $referencesSource = (
      (Test-ExecutableReferencesSourceRoot `
        -ExecutablePath $executablePath `
        -ResolvedSourceRoot $ResolvedSourceRoot) -or
      (Test-CommandLineReferencesSourceRoot `
        -CommandLine $commandLine `
        -ResolvedSourceRoot $ResolvedSourceRoot)
    )
    $isPortServer = (
      $name -match '^(?i:node)(?:\.exe)?$' -and
      $commandLine -match '(?i)(?:^|[\\/"\s])server\.js(?:["\s]|$)' -and
      $listeningPids -contains [int]$process.ProcessId
    )

    if ($isProductExecutable -or
        ($isGenericRuntime -and $referencesSource) -or
        $isPortServer) {
      $null = $matchingPids.Add([int]$process.ProcessId)
    }
  }

  if ($matchingPids.Count -gt 0) {
    $pids = @($matchingPids) | Sort-Object
    throw "Easy Rewind processes are still running. PIDs: $($pids -join ', ')"
  }
}

function Set-AndVerifyPrivateDirectoryAcl {
  param([Parameter(Mandatory=$true)][string]$Path)

  if (-not $isWindowsPlatform) {
    return
  }

  $currentIdentity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
  $currentSid = $currentIdentity.User
  if ($null -eq $currentSid) {
    throw 'Cannot determine the current Windows user SID.'
  }

  $existingSecurity = Get-Acl -LiteralPath $Path
  $existingOwnerSid = (New-Object System.Security.Principal.NTAccount(
    $existingSecurity.Owner
  )).
    Translate([System.Security.Principal.SecurityIdentifier])
  if ($existingOwnerSid.Value -ne $currentSid.Value) {
    $existingSecurity.SetOwner($currentSid)
  }
  $existingSecurity.SetAccessRuleProtection($true, $false)
  $currentUserRule = New-Object System.Security.AccessControl.FileSystemAccessRule(
    $currentSid,
    [System.Security.AccessControl.FileSystemRights]::FullControl,
    (
      [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
      [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
    ),
    [System.Security.AccessControl.PropagationFlags]::None,
    [System.Security.AccessControl.AccessControlType]::Allow
  )
  $existingSecurity.ResetAccessRule($currentUserRule)
  $directory = Get-Item -LiteralPath $Path -Force
  if ($PSVersionTable.PSEdition -eq 'Core') {
    [System.IO.FileSystemAclExtensions]::SetAccessControl(
      [System.IO.DirectoryInfo]$directory,
      [System.Security.AccessControl.DirectorySecurity]$existingSecurity
    )
  } else {
    $directory.SetAccessControl($existingSecurity)
  }

  $verified = Get-Acl -LiteralPath $Path
  if (-not $verified.AreAccessRulesProtected) {
    throw "Quarantine ACL inheritance is not protected: $Path"
  }

  $ownerSid = (New-Object System.Security.Principal.NTAccount($verified.Owner)).
    Translate([System.Security.Principal.SecurityIdentifier])
  if ($ownerSid.Value -ne $currentSid.Value) {
    throw "Quarantine owner is not the current user: $Path"
  }

  $hasExclusiveFullControl = $false
  $accessRules = $verified.GetAccessRules(
    $true,
    $true,
    [System.Security.Principal.SecurityIdentifier]
  )
  foreach ($accessRule in $accessRules) {
    if ($accessRule.IdentityReference.Value -ne $currentSid.Value) {
      throw "Quarantine ACL contains access for another SID: $Path"
    }
    $requiredInheritance = (
      [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
      [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
    )
    if ($accessRule.AccessControlType -eq
          [System.Security.AccessControl.AccessControlType]::Allow -and
        (($accessRule.FileSystemRights -band
            [System.Security.AccessControl.FileSystemRights]::FullControl) -eq
          [System.Security.AccessControl.FileSystemRights]::FullControl) -and
        (($accessRule.InheritanceFlags -band $requiredInheritance) -eq
          $requiredInheritance)) {
      $hasExclusiveFullControl = $true
    }
  }
  if (-not $hasExclusiveFullControl) {
    throw "Quarantine ACL does not grant exclusive inherited FullControl: $Path"
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

$destinationCreated = $false
try {
  $null = [System.IO.Directory]::CreateDirectory($resolvedQuarantineRoot)
  $null = New-Item -ItemType Directory -Path $destination
  $destinationCreated = $true
  Set-AndVerifyPrivateDirectoryAcl -Path $destination

  $manifestEntries = @()
  foreach ($sourceFile in $sourceFiles) {
    $backupPath = Get-CanonicalPath -Path (
      Join-Path $destination $sourceFile.Name
    )
    $initialSource = Get-OrdinaryFileState -Path $sourceFile.Path
    Copy-Item -LiteralPath $sourceFile.Path -Destination $backupPath
    $finalSource = Get-OrdinaryFileState -Path $sourceFile.Path
    $backup = Get-OrdinaryFileState -Path $backupPath
    if ($initialSource.Size -ne $finalSource.Size -or
        $initialSource.Hash -cne $finalSource.Hash -or
        $initialSource.Size -ne $backup.Size -or
        $initialSource.Hash -cne $backup.Hash) {
      throw "Legacy source changed during quarantine copy: $($sourceFile.Path)"
    }

    $manifestEntries += [ordered]@{
      name = $sourceFile.Name
      originalPath = $sourceFile.Path
      backupRelativePath = $sourceFile.Name
      size = [long]$backup.Size
      sha256 = $backup.Hash
    }
  }

  $manifestPath = Get-CanonicalPath -Path (Join-Path $destination 'manifest.json')
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
  [System.IO.File]::WriteAllText(
    $manifestPath,
    $manifestJson + [System.Environment]::NewLine,
    $utf8WithoutBom
  )

  Set-AndVerifyPrivateDirectoryAcl -Path $destination
  Write-Output $manifestJson
} catch {
  $failure = $_
  if ($destinationCreated) {
    try {
      $cleanupTarget = Get-CanonicalPath -Path $destination
      $cleanupParent = [System.IO.Directory]::GetParent($cleanupTarget).FullName
      if (-not (Test-PathEqual -Left $cleanupTarget -Right $destination) -or
          -not (Test-PathEqual -Left $cleanupParent -Right $resolvedQuarantineRoot) -or
          [System.IO.Path]::GetFileName($cleanupTarget) -cne $Timestamp) {
        throw 'Refusing to clean up an unexpected quarantine path.'
      }
      if (Test-Path -LiteralPath $cleanupTarget) {
        Remove-Item -LiteralPath $cleanupTarget -Recurse -Force
      }
    } catch {
      throw "Quarantine failed and its exact destination could not be removed: $($_.Exception.Message)"
    }
  }
  throw $failure
}
