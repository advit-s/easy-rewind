Set-StrictMode -Version Latest

if ($null -eq ('EasyRewind.NativeHandleFile' -as [type])) {
  $nativeHandleSource = @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace EasyRewind {
  internal static class NativeMethods {
    internal const uint GenericRead = 0x80000000;
    internal const uint GenericWrite = 0x40000000;
    internal const uint Delete = 0x00010000;
    internal const uint WriteDac = 0x00040000;
    internal const uint WriteOwner = 0x00080000;
    internal const uint FileReadAttributes = 0x00000080;
    internal const uint ShareRead = 0x00000001;
    internal const uint ShareWrite = 0x00000002;
    internal const uint CreateNew = 1;
    internal const uint OpenExisting = 3;
    internal const uint AttributeNormal = 0x00000080;
    internal const uint AttributeDirectory = 0x00000010;
    internal const uint AttributeReparsePoint = 0x00000400;
    internal const uint FlagBackupSemantics = 0x02000000;
    internal const uint FlagOpenReparsePoint = 0x00200000;
    internal const int FileDispositionInfo = 4;
    internal const int ErrorSharingViolation = 32;
    internal const int ErrorLockViolation = 33;
    internal const uint DaclSecurityInformation = 0x00000004;
    internal const uint ProtectedDaclSecurityInformation = 0x80000000;

    [StructLayout(LayoutKind.Sequential)]
    internal struct FileTime {
      internal uint Low;
      internal uint High;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct ByHandleFileInformation {
      internal uint FileAttributes;
      internal FileTime CreationTime;
      internal FileTime LastAccessTime;
      internal FileTime LastWriteTime;
      internal uint VolumeSerialNumber;
      internal uint FileSizeHigh;
      internal uint FileSizeLow;
      internal uint NumberOfLinks;
      internal uint FileIndexHigh;
      internal uint FileIndexLow;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct FileDispositionInformation {
      [MarshalAs(UnmanagedType.Bool)]
      internal bool DeleteFile;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    internal static extern SafeFileHandle CreateFile(
      string fileName,
      uint desiredAccess,
      uint shareMode,
      IntPtr securityAttributes,
      uint creationDisposition,
      uint flagsAndAttributes,
      IntPtr templateFile
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool GetFileInformationByHandle(
      SafeFileHandle fileHandle,
      out ByHandleFileInformation information
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool SetFileInformationByHandle(
      SafeFileHandle fileHandle,
      int informationClass,
      ref FileDispositionInformation information,
      uint bufferSize
    );

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool CreateDirectory(
      string path,
      IntPtr securityAttributes
    );

    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool SetKernelObjectSecurity(
      SafeFileHandle handle,
      uint securityInformation,
      byte[] securityDescriptor
    );

    internal static void ApplyPrivateSecurity(
      SafeFileHandle handle,
      byte[] securityDescriptor
    ) {
      uint information =
        DaclSecurityInformation |
        ProtectedDaclSecurityInformation;
      if (!SetKernelObjectSecurity(handle, information, securityDescriptor)) {
        throw new Win32Exception(
          Marshal.GetLastWin32Error(),
          "Unable to apply exact security descriptor through held handle."
        );
      }
    }
  }

  public sealed class NativeFileSnapshot {
    public long Size { get; private set; }
    public string Sha256 { get; private set; }
    public uint VolumeSerialNumber { get; private set; }
    public ulong FileId { get; private set; }
    public uint LinkCount { get; private set; }

    internal NativeFileSnapshot(
      long size,
      string sha256,
      uint volumeSerialNumber,
      ulong fileId,
      uint linkCount
    ) {
      Size = size;
      Sha256 = sha256;
      VolumeSerialNumber = volumeSerialNumber;
      FileId = fileId;
      LinkCount = linkCount;
    }

    public bool HasSameIdentity(NativeFileSnapshot other) {
      return other != null &&
        VolumeSerialNumber == other.VolumeSerialNumber &&
        FileId == other.FileId;
    }
  }

  public sealed class NativeHandleFile : IDisposable {
    private SafeFileHandle handle;
    private FileStream stream;
    private bool disposed;

    public string Path { get; private set; }

    private NativeHandleFile(
      string path,
      SafeFileHandle safeHandle,
      FileAccess access
    ) {
      Path = System.IO.Path.GetFullPath(path);
      handle = safeHandle;
      stream = new FileStream(safeHandle, access, 65536, false);
    }

    private static NativeHandleFile Open(
      string path,
      uint desiredAccess,
      uint shareMode,
      uint creationDisposition,
      FileAccess access
    ) {
      string fullPath = System.IO.Path.GetFullPath(path);
      SafeFileHandle safeHandle = NativeMethods.CreateFile(
        fullPath,
        desiredAccess,
        shareMode,
        IntPtr.Zero,
        creationDisposition,
        NativeMethods.AttributeNormal | NativeMethods.FlagOpenReparsePoint,
        IntPtr.Zero
      );
      if (safeHandle.IsInvalid) {
        int error = Marshal.GetLastWin32Error();
        safeHandle.Dispose();
        if (error == NativeMethods.ErrorSharingViolation ||
            error == NativeMethods.ErrorLockViolation) {
          throw new IOException("source set is in use: " + fullPath);
        }
        throw new Win32Exception(error, "Unable to open stable file handle: " + fullPath);
      }

      NativeHandleFile result = null;
      try {
        result = new NativeHandleFile(fullPath, safeHandle, access);
        result.ValidateOrdinarySingleLink();
        return result;
      } catch {
        if (result != null) {
          result.Dispose();
        } else {
          safeHandle.Dispose();
        }
        throw;
      }
    }

    public static NativeHandleFile OpenQuarantineSource(string path) {
      return Open(
        path,
        NativeMethods.GenericRead,
        NativeMethods.ShareRead,
        NativeMethods.OpenExisting,
        FileAccess.Read
      );
    }

    public static NativeHandleFile OpenPurgeSource(string path) {
      return Open(
        path,
        NativeMethods.GenericRead | NativeMethods.Delete,
        NativeMethods.ShareRead,
        NativeMethods.OpenExisting,
        FileAccess.Read
      );
    }

    public static NativeHandleFile OpenBackupRead(string path) {
      return Open(
        path,
        NativeMethods.GenericRead,
        NativeMethods.ShareRead,
        NativeMethods.OpenExisting,
        FileAccess.Read
      );
    }

    public static NativeHandleFile CreateNew(string path) {
      return Open(
        path,
          NativeMethods.GenericRead |
          NativeMethods.GenericWrite |
          NativeMethods.Delete |
          NativeMethods.WriteDac,
        NativeMethods.ShareRead,
        NativeMethods.CreateNew,
        FileAccess.ReadWrite
      );
    }

    private NativeMethods.ByHandleFileInformation GetInformation() {
      NativeMethods.ByHandleFileInformation information;
      if (!NativeMethods.GetFileInformationByHandle(handle, out information)) {
        throw new Win32Exception(
          Marshal.GetLastWin32Error(),
          "Unable to read stable file identity: " + Path
        );
      }
      return information;
    }

    private static long GetSize(NativeMethods.ByHandleFileInformation information) {
      return ((long)information.FileSizeHigh << 32) | information.FileSizeLow;
    }

    private static ulong GetFileId(
      NativeMethods.ByHandleFileInformation information
    ) {
      return ((ulong)information.FileIndexHigh << 32) | information.FileIndexLow;
    }

    private void ValidateOrdinarySingleLink() {
      NativeMethods.ByHandleFileInformation information = GetInformation();
      if ((information.FileAttributes & NativeMethods.AttributeDirectory) != 0) {
        throw new IOException("Path is not an ordinary file: " + Path);
      }
      if ((information.FileAttributes & NativeMethods.AttributeReparsePoint) != 0) {
        throw new IOException("Reparse-point file is not allowed: " + Path);
      }
      if (information.NumberOfLinks != 1) {
        throw new IOException("Source or backup file has multiple hard links: " + Path);
      }
    }

    public NativeFileSnapshot Snapshot() {
      ThrowIfDisposed();
      NativeMethods.ByHandleFileInformation before = GetInformation();
      ValidateOrdinarySingleLink();
      stream.Position = 0;
      byte[] hash;
      using (SHA256 algorithm = SHA256.Create()) {
        hash = algorithm.ComputeHash(stream);
      }
      stream.Position = 0;
      NativeMethods.ByHandleFileInformation after = GetInformation();
      if (before.VolumeSerialNumber != after.VolumeSerialNumber ||
          GetFileId(before) != GetFileId(after) ||
          GetSize(before) != GetSize(after) ||
          after.NumberOfLinks != 1) {
        throw new IOException("Stable file identity changed while held: " + Path);
      }
      return new NativeFileSnapshot(
        GetSize(after),
        BitConverter.ToString(hash).Replace("-", String.Empty),
        after.VolumeSerialNumber,
        GetFileId(after),
        after.NumberOfLinks
      );
    }

    internal void CopyFrom(NativeHandleFile source) {
      ThrowIfDisposed();
      source.ThrowIfDisposed();
      source.stream.Position = 0;
      stream.Position = 0;
      stream.SetLength(0);
      source.stream.CopyTo(stream);
      stream.Flush(true);
      stream.Position = 0;
      source.stream.Position = 0;
    }

    public void WriteAllBytes(byte[] bytes) {
      ThrowIfDisposed();
      stream.Position = 0;
      stream.SetLength(0);
      stream.Write(bytes, 0, bytes.Length);
      stream.Flush(true);
      stream.Position = 0;
    }

    public byte[] ReadAllBytes() {
      ThrowIfDisposed();
      stream.Position = 0;
      if (stream.Length > Int32.MaxValue) {
        throw new IOException("Held file is too large to read: " + Path);
      }
      byte[] bytes = new byte[(int)stream.Length];
      int offset = 0;
      while (offset < bytes.Length) {
        int read = stream.Read(bytes, offset, bytes.Length - offset);
        if (read == 0) {
          throw new EndOfStreamException("Unexpected end of held file: " + Path);
        }
        offset += read;
      }
      stream.Position = 0;
      return bytes;
    }

    public void ApplySecurityDescriptor(byte[] securityDescriptor) {
      ThrowIfDisposed();
      NativeMethods.ApplyPrivateSecurity(handle, securityDescriptor);
    }

    internal void SetDeletePending(bool deletePending) {
      ThrowIfDisposed();
      NativeMethods.FileDispositionInformation information =
        new NativeMethods.FileDispositionInformation();
      information.DeleteFile = deletePending;
      uint size = (uint)Marshal.SizeOf(
        typeof(NativeMethods.FileDispositionInformation)
      );
      if (!NativeMethods.SetFileInformationByHandle(
          handle,
          NativeMethods.FileDispositionInfo,
          ref information,
          size
        )) {
        throw new Win32Exception(
          Marshal.GetLastWin32Error(),
          "Unable to update delete disposition: " + Path
        );
      }
    }

    private void ThrowIfDisposed() {
      if (disposed) {
        throw new ObjectDisposedException("NativeHandleFile");
      }
    }

    public void Dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      stream.Dispose();
    }
  }

  public sealed class NativeDirectoryHandle : IDisposable {
    private SafeFileHandle handle;
    private bool disposed;
    public string Path { get; private set; }

    private NativeDirectoryHandle(string path, SafeFileHandle safeHandle) {
      Path = System.IO.Path.GetFullPath(path);
      handle = safeHandle;
    }

    public static NativeDirectoryHandle OpenExisting(string path) {
      string fullPath = System.IO.Path.GetFullPath(path);
      SafeFileHandle safeHandle = NativeMethods.CreateFile(
        fullPath,
        NativeMethods.FileReadAttributes,
        NativeMethods.ShareRead,
        IntPtr.Zero,
        NativeMethods.OpenExisting,
        NativeMethods.FlagBackupSemantics | NativeMethods.FlagOpenReparsePoint,
        IntPtr.Zero
      );
      if (safeHandle.IsInvalid) {
        int error = Marshal.GetLastWin32Error();
        safeHandle.Dispose();
        throw new Win32Exception(error, "Unable to lock directory component: " + fullPath);
      }

      NativeMethods.ByHandleFileInformation information;
      if (!NativeMethods.GetFileInformationByHandle(safeHandle, out information)) {
        int error = Marshal.GetLastWin32Error();
        safeHandle.Dispose();
        throw new Win32Exception(error, "Unable to inspect directory component: " + fullPath);
      }
      if ((information.FileAttributes & NativeMethods.AttributeDirectory) == 0) {
        safeHandle.Dispose();
        throw new IOException("Path component is not a directory: " + fullPath);
      }
      if ((information.FileAttributes & NativeMethods.AttributeReparsePoint) != 0) {
        safeHandle.Dispose();
        throw new IOException("Reparse or junction directory is not allowed: " + fullPath);
      }
      return new NativeDirectoryHandle(fullPath, safeHandle);
    }

    public static NativeDirectoryHandle CreateNew(string path) {
      string fullPath = System.IO.Path.GetFullPath(path);
      if (!NativeMethods.CreateDirectory(fullPath, IntPtr.Zero)) {
        throw new Win32Exception(
          Marshal.GetLastWin32Error(),
          "Unable to create exact new directory: " + fullPath
        );
      }
      try {
        SafeFileHandle safeHandle = NativeMethods.CreateFile(
          fullPath,
          NativeMethods.FileReadAttributes |
            NativeMethods.WriteDac,
          NativeMethods.ShareRead,
          IntPtr.Zero,
          NativeMethods.OpenExisting,
          NativeMethods.FlagBackupSemantics |
            NativeMethods.FlagOpenReparsePoint,
          IntPtr.Zero
        );
        if (safeHandle.IsInvalid) {
          int error = Marshal.GetLastWin32Error();
          safeHandle.Dispose();
          throw new Win32Exception(
            error,
            "Unable to lock exact new directory: " + fullPath
          );
        }
        NativeMethods.ByHandleFileInformation information;
        if (!NativeMethods.GetFileInformationByHandle(safeHandle, out information) ||
            (information.FileAttributes & NativeMethods.AttributeDirectory) == 0 ||
            (information.FileAttributes & NativeMethods.AttributeReparsePoint) != 0) {
          int error = Marshal.GetLastWin32Error();
          safeHandle.Dispose();
          throw new Win32Exception(
            error,
            "New directory identity validation failed: " + fullPath
          );
        }
        return new NativeDirectoryHandle(fullPath, safeHandle);
      } catch {
        // The caller cannot safely clean up a directory whose authoritative
        // handle was never obtained. Leave the empty create-new artifact
        // fail-closed rather than re-resolving and deleting a swapped path.
        throw;
      }
    }

    public void ApplySecurityDescriptor(byte[] securityDescriptor) {
      if (disposed) {
        throw new ObjectDisposedException("NativeDirectoryHandle");
      }
      NativeMethods.ApplyPrivateSecurity(handle, securityDescriptor);
    }

    public void Dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      handle.Dispose();
    }
  }

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

  public static class NativeHandleOperations {
    public static NativeHandleFile CopyToCreateNew(
      NativeHandleFile source,
      string destinationPath
    ) {
      NativeHandleFile destination = NativeHandleFile.CreateNew(destinationPath);
      try {
        destination.CopyFrom(source);
        return destination;
      } catch {
        try {
          destination.SetDeletePending(true);
        } catch {
        }
        destination.Dispose();
        throw;
      }
    }

    public static void MarkDeletePendingAll(
      NativeHandleFile[] sourceHandles,
      int injectedFailureIndex
    ) {
      List<NativeHandleFile> marked = new List<NativeHandleFile>();
      Exception originalFailure = null;
      try {
        for (int index = 0; index < sourceHandles.Length; index++) {
          if (index == injectedFailureIndex) {
            throw new IOException("Injected disposition failure at index " + index + ".");
          }
          sourceHandles[index].SetDeletePending(true);
          marked.Add(sourceHandles[index]);
        }
        return;
      } catch (Exception failure) {
        originalFailure = failure;
      }

      Exception rollbackFailure = null;
      for (int index = marked.Count - 1; index >= 0; index--) {
        try {
          marked[index].SetDeletePending(false);
        } catch (Exception failure) {
          if (rollbackFailure == null) {
            rollbackFailure = failure;
          }
        }
      }
      if (rollbackFailure != null) {
        throw new AggregateException(
          "Delete disposition failed and rollback was incomplete.",
          originalFailure,
          rollbackFailure
        );
      }
      throw originalFailure;
    }
  }
}
'@

  $null = Add-Type -TypeDefinition $nativeHandleSource -Language CSharp
}

function Test-EasyRewindExecutableAssociation {
  param(
    [AllowEmptyString()][string]$ExecutablePath,
    [Parameter(Mandatory=$true)][string]$ResolvedSourceRoot
  )

  if ([string]::IsNullOrWhiteSpace($ExecutablePath)) {
    return $false
  }
  try {
    $canonicalExecutable = [System.IO.Path]::GetFullPath($ExecutablePath)
  } catch {
    return $false
  }
  $comparison = [System.StringComparison]::OrdinalIgnoreCase
  if ([string]::Equals($canonicalExecutable, $ResolvedSourceRoot, $comparison)) {
    return $true
  }
  $rootPrefix = (
    $ResolvedSourceRoot.TrimEnd([char[]]@('\', '/')) +
    [System.IO.Path]::DirectorySeparatorChar
  )
  return $canonicalExecutable.StartsWith($rootPrefix, $comparison)
}

function Test-EasyRewindCommandAssociation {
  param(
    [AllowEmptyString()][string]$CommandLine,
    [Parameter(Mandatory=$true)][string]$ResolvedSourceRoot
  )

  if ([string]::IsNullOrWhiteSpace($CommandLine)) {
    return $false
  }
  $trimmedRoot = $ResolvedSourceRoot.TrimEnd([char[]]@('\', '/'))
  $forms = @($trimmedRoot)
  if ($trimmedRoot.Contains('\')) {
    $forms += $trimmedRoot.Replace('\', '/')
  }
  foreach ($form in @($forms | Select-Object -Unique)) {
    $pattern = (
      '(?:^|[\s"''=])' +
      [System.Text.RegularExpressions.Regex]::Escape($form) +
      '(?:[\\/"''\s]|$)'
    )
    if ([System.Text.RegularExpressions.Regex]::IsMatch(
        $CommandLine,
        $pattern,
        [System.Text.RegularExpressions.RegexOptions]::IgnoreCase
      )) {
      return $true
    }
  }
  return $false
}

function Invoke-EasyRewindSupplementalProcessVerification {
  param([Parameter(Mandatory=$true)][string]$ResolvedSourceRoot)

  if ([System.Environment]::OSVersion.Platform -ne
      [System.PlatformID]::Win32NT) {
    return
  }

  $listeningPids = @()
  $tcpSucceeded = $false
  if ($null -ne (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue)) {
    try {
      $listeningPids = @(
        Get-NetTCPConnection -State Listen -LocalPort 5000 -ErrorAction Stop |
          Select-Object -ExpandProperty OwningProcess -Unique
      )
      $tcpSucceeded = $true
    } catch {
      $tcpSucceeded = $false
    }
  }
  if (-not $tcpSucceeded) {
    $netstatPath = Join-Path (
      [System.Environment]::GetFolderPath(
        [System.Environment+SpecialFolder]::Windows
      )
    ) 'System32\netstat.exe'
    if (-not (Test-Path -LiteralPath $netstatPath -PathType Leaf)) {
      throw 'Unable to verify listening port ownership.'
    }
    $netstatLines = @(& $netstatPath -ano -p TCP 2>$null)
    if ($LASTEXITCODE -ne 0) {
      throw 'Unable to verify listening port ownership.'
    }
    foreach ($line in $netstatLines) {
      if ([string]$line -match
          '^\s*TCP\s+\S+:5000\s+\S+\s+LISTENING\s+(\d+)\s*$') {
        $listeningPids += [int]$matches[1]
      }
    }
  }

  $processes = @(
    Get-Process -ErrorAction Stop | ForEach-Object {
      $executablePath = ''
      $commandLine = ''
      try {
        $executablePath = [EasyRewind.NativeProcessQuery]::GetExecutablePath(
          [int]$_.Id
        )
      } catch {
        $executablePath = ''
      }
      try {
        $commandLine = [EasyRewind.NativeProcessQuery]::GetCommandLine(
          [int]$_.Id
        )
      } catch {
        $commandLine = ''
      }
      [pscustomobject]@{
        Name = [string]$_.ProcessName
        ExecutablePath = $executablePath
        CommandLine = $commandLine
        ProcessId = [int]$_.Id
      }
    }
  )
  if ($processes.Count -eq 0) {
    throw 'Unable to enumerate Windows processes.'
  }

  $confirmed = [System.Collections.Generic.HashSet[int]]::new()
  $unverified = [System.Collections.Generic.HashSet[int]]::new()
  foreach ($process in $processes) {
    $name = [string]$process.Name
    $processId = [int]$process.ProcessId
    $executablePath = [string]$process.ExecutablePath
    $commandLine = [string]$process.CommandLine
    if ($name -match '^(?i:easy[ -]?rewind)(?:\.exe)?$') {
      $null = $confirmed.Add($processId)
      continue
    }
    if ($name -notmatch '^(?i:node|electron)(?:\.exe)?$') {
      continue
    }
    $hasExecutable = -not [string]::IsNullOrWhiteSpace($executablePath)
    $hasCommand = -not [string]::IsNullOrWhiteSpace($commandLine)
    $referencesSource = (
      ($hasExecutable -and
        (Test-EasyRewindExecutableAssociation `
          -ExecutablePath $executablePath `
          -ResolvedSourceRoot $ResolvedSourceRoot)) -or
      ($hasCommand -and
        (Test-EasyRewindCommandAssociation `
          -CommandLine $commandLine `
          -ResolvedSourceRoot $ResolvedSourceRoot))
    )
    $isPortServer = (
      $name -match '^(?i:node)(?:\.exe)?$' -and
      $hasCommand -and
      $commandLine -match '(?i)(?:^|[\\/"\s])server\.js(?:["\s]|$)' -and
      $listeningPids -contains $processId
    )
    if ($referencesSource -or $isPortServer) {
      $null = $confirmed.Add($processId)
    } elseif (-not $hasExecutable -or -not $hasCommand) {
      $null = $unverified.Add($processId)
    }
  }

  if ($unverified.Count -gt 0) {
    $pids = @($unverified | Sort-Object)
    throw "Unable to verify Node/Electron process metadata for PIDs: $($pids -join ', ')"
  }
  if ($confirmed.Count -gt 0) {
    $pids = @($confirmed | Sort-Object)
    throw "Easy Rewind processes are still running. PIDs: $($pids -join ', ')"
  }
}
