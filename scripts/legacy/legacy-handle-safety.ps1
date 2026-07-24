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
    internal const uint Synchronize = 0x00100000;
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
    internal const int FileAttributeTagInfo = 9;
    internal const int ErrorSharingViolation = 32;
    internal const int ErrorLockViolation = 33;
    internal const int ErrorFileNotFound = 2;
    internal const int ErrorPathNotFound = 3;
    internal const int ErrorDirNotEmpty = 145;
    internal const uint NtFileCreate = 2;
    internal const uint NtFileOpen = 1;
    internal const uint NtFileOpenIf = 3;
    internal const uint NtFileDirectoryFile = 0x00000001;
    internal const uint NtFileSynchronousIoNonAlert = 0x00000020;
    internal const uint NtFileNonDirectoryFile = 0x00000040;
    internal const uint ObjectCaseInsensitive = 0x00000040;
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

    [StructLayout(LayoutKind.Sequential)]
    internal struct FileAttributeTagInformation {
      internal uint FileAttributes;
      internal uint ReparseTag;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct UnicodeString {
      internal ushort Length;
      internal ushort MaximumLength;
      internal IntPtr Buffer;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct ObjectAttributes {
      internal int Length;
      internal IntPtr RootDirectory;
      internal IntPtr ObjectName;
      internal uint Attributes;
      internal IntPtr SecurityDescriptor;
      internal IntPtr SecurityQualityOfService;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct IoStatusBlock {
      internal IntPtr Status;
      internal UIntPtr Information;
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
    internal static extern bool GetFileInformationByHandleEx(
      SafeFileHandle fileHandle,
      int fileInformationClass,
      out FileAttributeTagInformation fileInformation,
      uint bufferSize
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool SetFileInformationByHandle(
      SafeFileHandle fileHandle,
      int informationClass,
      ref FileDispositionInformation information,
      uint bufferSize
    );

    [DllImport("ntdll.dll")]
    internal static extern int NtCreateFile(
      out SafeFileHandle fileHandle,
      uint desiredAccess,
      ref ObjectAttributes objectAttributes,
      out IoStatusBlock ioStatusBlock,
      IntPtr allocationSize,
      uint fileAttributes,
      uint shareAccess,
      uint createDisposition,
      uint createOptions,
      IntPtr eaBuffer,
      uint eaLength
    );

    [DllImport("ntdll.dll")]
    internal static extern uint RtlNtStatusToDosError(int status);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    internal static extern uint GetFinalPathNameByHandle(
      SafeFileHandle fileHandle,
      StringBuilder filePath,
      uint filePathLength,
      uint flags
    );

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    internal static extern uint GetDriveType(string rootPathName);

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

    internal static void UpdateDeleteDisposition(
      SafeFileHandle handle,
      string path,
      bool deletePending
    ) {
      FileDispositionInformation information =
        new FileDispositionInformation();
      information.DeleteFile = deletePending;
      uint size = (uint)Marshal.SizeOf(typeof(FileDispositionInformation));
      if (!SetFileInformationByHandle(
          handle,
          FileDispositionInfo,
          ref information,
          size
        )) {
        throw new Win32Exception(
          Marshal.GetLastWin32Error(),
          "Unable to update delete disposition: " + path
        );
      }
    }

    internal static void ValidateSingleLeaf(string leafName) {
      if (String.IsNullOrWhiteSpace(leafName) ||
          leafName == "." ||
          leafName == ".." ||
          leafName.IndexOf('\\') >= 0 ||
          leafName.IndexOf('/') >= 0 ||
          leafName.IndexOf(':') >= 0) {
        throw new ArgumentException(
          "Child name must be one direct leaf.",
          "leafName"
        );
      }
      if (leafName.Length > (UInt16.MaxValue / 2) - 1) {
        throw new PathTooLongException("Child leaf is too long.");
      }
    }

    internal static SafeFileHandle OpenRelative(
      SafeFileHandle parentHandle,
      string parentPath,
      string leafName,
      uint desiredAccess,
      uint shareAccess,
      uint createDisposition,
      uint createOptions
    ) {
      ValidateSingleLeaf(leafName);
      string fullPath = System.IO.Path.Combine(parentPath, leafName);
      IntPtr nameBuffer = Marshal.StringToHGlobalUni(leafName);
      IntPtr unicodePointer = IntPtr.Zero;
      try {
        UnicodeString unicodeName = new UnicodeString();
        unicodeName.Length = (ushort)(leafName.Length * 2);
        unicodeName.MaximumLength = (ushort)((leafName.Length + 1) * 2);
        unicodeName.Buffer = nameBuffer;
        unicodePointer = Marshal.AllocHGlobal(
          Marshal.SizeOf(typeof(UnicodeString))
        );
        Marshal.StructureToPtr(unicodeName, unicodePointer, false);

        ObjectAttributes attributes = new ObjectAttributes();
        attributes.Length = Marshal.SizeOf(typeof(ObjectAttributes));
        attributes.RootDirectory = parentHandle.DangerousGetHandle();
        attributes.ObjectName = unicodePointer;
        attributes.Attributes = ObjectCaseInsensitive;

        IoStatusBlock ioStatusBlock;
        SafeFileHandle childHandle;
        int status = NtCreateFile(
          out childHandle,
          desiredAccess,
          ref attributes,
          out ioStatusBlock,
          IntPtr.Zero,
          0,
          shareAccess,
          createDisposition,
          createOptions,
          IntPtr.Zero,
          0
        );
        if (status < 0 || childHandle == null || childHandle.IsInvalid) {
          int error = (int)RtlNtStatusToDosError(status);
          if (childHandle != null) {
            childHandle.Dispose();
          }
          if (error == ErrorSharingViolation || error == ErrorLockViolation) {
            throw new IOException("source set is in use: " + fullPath);
          }
          if (error == ErrorFileNotFound || error == ErrorPathNotFound) {
            throw new FileNotFoundException(
              "Required relative child is missing: " + fullPath,
              fullPath
            );
          }
          throw new Win32Exception(
            error,
            "Unable to open relative child handle: " + fullPath
          );
        }
        return childHandle;
      } finally {
        if (unicodePointer != IntPtr.Zero) {
          Marshal.FreeHGlobal(unicodePointer);
        }
        Marshal.FreeHGlobal(nameBuffer);
      }
    }

    internal static string CanonicalizeLocalDrivePath(string path) {
      if (String.IsNullOrWhiteSpace(path) ||
          !System.IO.Path.IsPathRooted(path) ||
          path.StartsWith(@"\\", StringComparison.Ordinal) ||
          path.StartsWith(@"\??\", StringComparison.OrdinalIgnoreCase) ||
          path.StartsWith(@"\\?\", StringComparison.OrdinalIgnoreCase)) {
        throw new IOException(
          "Path must be an absolute canonical local-drive path: " + path
        );
      }
      string fullPath = System.IO.Path.GetFullPath(path);
      string root = System.IO.Path.GetPathRoot(fullPath);
      if (String.IsNullOrEmpty(root) ||
          root.Length != 3 ||
          !Char.IsLetter(root[0]) ||
          root[1] != ':' ||
          (root[2] != '\\' && root[2] != '/') ||
          fullPath.IndexOf(':', 2) >= 0 ||
          !String.Equals(path, fullPath, StringComparison.OrdinalIgnoreCase) ||
          GetDriveType(root) != 3) {
        throw new IOException(
          "Path must be an absolute canonical fixed-drive path: " + path
        );
      }
      return fullPath;
    }

    internal static void ValidateFinalPath(
      SafeFileHandle handle,
      string expectedPath
    ) {
      StringBuilder buffer = new StringBuilder(32768);
      uint length = GetFinalPathNameByHandle(
        handle,
        buffer,
        (uint)buffer.Capacity,
        0
      );
      if (length == 0 || length >= buffer.Capacity) {
        throw new Win32Exception(
          Marshal.GetLastWin32Error(),
          "Unable to resolve final held-handle path: " + expectedPath
        );
      }
      string finalPath = buffer.ToString();
      if (finalPath.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase)) {
        finalPath = @"\\" + finalPath.Substring(8);
      } else if (finalPath.StartsWith(@"\\?\", StringComparison.OrdinalIgnoreCase)) {
        finalPath = finalPath.Substring(4);
      }
      finalPath = System.IO.Path.GetFullPath(finalPath);
      string canonicalExpected = System.IO.Path.GetFullPath(expectedPath);
      if (!String.Equals(
          finalPath.TrimEnd('\\'),
          canonicalExpected.TrimEnd('\\'),
          StringComparison.OrdinalIgnoreCase
        )) {
        throw new IOException(
          "Held child path does not match its physical parent: " +
            canonicalExpected
        );
      }
    }

    internal static uint GetReparseTag(
      SafeFileHandle handle,
      string path
    ) {
      FileAttributeTagInformation information;
      uint size = (uint)Marshal.SizeOf(typeof(FileAttributeTagInformation));
      if (!GetFileInformationByHandleEx(
          handle,
          FileAttributeTagInfo,
          out information,
          size
        )) {
        throw new Win32Exception(
          Marshal.GetLastWin32Error(),
          "Unable to inspect held directory reparse tag: " + path
        );
      }
      if ((information.FileAttributes & AttributeReparsePoint) == 0 ||
          information.ReparseTag == 0) {
        throw new IOException(
          "Held directory reparse metadata is inconsistent: " + path
        );
      }
      return information.ReparseTag;
    }
  }

  public static class NativePathSafety {
    public static string CanonicalizeLocalDrivePath(string path) {
      return NativeMethods.CanonicalizeLocalDrivePath(path);
    }
  }

  public static class NativeReparsePolicy {
    private const uint IoReparseTagCloud = 0x9000001A;
    private const uint IoReparseTagCloudMask = 0x0000F000;
    private const uint IoReparseTagNameSurrogate = 0x20000000;

    public static bool IsAllowedDirectoryReparseTag(uint reparseTag) {
      bool isNameSurrogate =
        (reparseTag & IoReparseTagNameSurrogate) != 0;
      bool isCloudFamily =
        (reparseTag & ~IoReparseTagCloudMask) == IoReparseTagCloud;
      return !isNameSurrogate && isCloudFamily;
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
        NativeMethods.ValidateFinalPath(safeHandle, fullPath);
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

    private static NativeHandleFile OpenRelative(
      NativeDirectoryHandle parent,
      string leafName,
      uint desiredAccess,
      uint createDisposition,
      FileAccess access
    ) {
      if (parent == null) {
        throw new ArgumentNullException("parent");
      }
      string fullPath = System.IO.Path.Combine(parent.Path, leafName);
      SafeFileHandle safeHandle = null;
      NativeHandleFile result = null;
      try {
        safeHandle = NativeMethods.OpenRelative(
          parent.Handle,
          parent.Path,
          leafName,
          desiredAccess | NativeMethods.Synchronize,
          NativeMethods.ShareRead,
          createDisposition,
          NativeMethods.NtFileNonDirectoryFile |
            NativeMethods.NtFileSynchronousIoNonAlert |
            NativeMethods.FlagOpenReparsePoint
        );
        result = new NativeHandleFile(fullPath, safeHandle, access);
        result.ValidateOrdinarySingleLink();
        NativeMethods.ValidateFinalPath(safeHandle, fullPath);
        return result;
      } catch {
        if (result != null) {
          result.Dispose();
        } else if (safeHandle != null) {
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

    public static NativeHandleFile OpenQuarantineSource(
      NativeDirectoryHandle parent,
      string leafName
    ) {
      try {
        return OpenRelative(
          parent,
          leafName,
          NativeMethods.GenericRead,
          NativeMethods.NtFileOpen,
          FileAccess.Read
        );
      } catch (FileNotFoundException) {
        throw new FileNotFoundException(
          "Required legacy file is missing: " +
            System.IO.Path.Combine(parent.Path, leafName)
        );
      }
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

    public static NativeHandleFile OpenPurgeSource(
      NativeDirectoryHandle parent,
      string leafName
    ) {
      return OpenRelative(
        parent,
        leafName,
        NativeMethods.GenericRead | NativeMethods.Delete,
        NativeMethods.NtFileOpen,
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

    public static NativeHandleFile OpenBackupRead(
      NativeDirectoryHandle parent,
      string leafName
    ) {
      return OpenRelative(
        parent,
        leafName,
        NativeMethods.GenericRead,
        NativeMethods.NtFileOpen,
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

    public static NativeHandleFile CreateNew(
      NativeDirectoryHandle parent,
      string leafName
    ) {
      return OpenRelative(
        parent,
        leafName,
        NativeMethods.GenericRead |
          NativeMethods.GenericWrite |
          NativeMethods.Delete |
          NativeMethods.WriteDac,
        NativeMethods.NtFileCreate,
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
      NativeMethods.UpdateDeleteDisposition(handle, Path, deletePending);
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
    internal SafeFileHandle Handle {
      get {
        ThrowIfDisposed();
        return handle;
      }
    }

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
      return FromValidatedHandle(fullPath, safeHandle);
    }

    public static NativeDirectoryHandle OpenLocalVolumeRoot(string path) {
      string canonicalPath = NativeMethods.CanonicalizeLocalDrivePath(path);
      string root = System.IO.Path.GetPathRoot(canonicalPath);
      SafeFileHandle safeHandle = NativeMethods.CreateFile(
        root,
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
        throw new Win32Exception(
          error,
          "Unable to open trusted local-volume root: " + root
        );
      }
      return FromValidatedHandle(root, safeHandle);
    }

    public static NativeDirectoryHandle OpenExisting(
      NativeDirectoryHandle parent,
      string leafName
    ) {
      return OpenRelativeCore(
        parent,
        leafName,
        NativeMethods.NtFileOpen,
        false,
        false
      );
    }

    public static NativeDirectoryHandle OpenOrCreate(
      NativeDirectoryHandle parent,
      string leafName
    ) {
      return OpenRelativeCore(
        parent,
        leafName,
        NativeMethods.NtFileOpenIf,
        false,
        false
      );
    }

    private static NativeDirectoryHandle FromValidatedHandle(
      string fullPath,
      SafeFileHandle safeHandle
    ) {
      try {
      NativeMethods.ByHandleFileInformation information;
      if (!NativeMethods.GetFileInformationByHandle(safeHandle, out information)) {
        int error = Marshal.GetLastWin32Error();
        throw new Win32Exception(error, "Unable to inspect directory component: " + fullPath);
      }
      if ((information.FileAttributes & NativeMethods.AttributeDirectory) == 0) {
        throw new IOException("Path component is not a directory: " + fullPath);
      }
      if ((information.FileAttributes & NativeMethods.AttributeReparsePoint) != 0) {
        uint reparseTag = NativeMethods.GetReparseTag(safeHandle, fullPath);
        if (!NativeReparsePolicy.IsAllowedDirectoryReparseTag(reparseTag)) {
          throw new IOException(
            "Reparse or junction directory is not allowed (tag 0x" +
              reparseTag.ToString("X8") + "): " + fullPath
          );
        }
      }
      NativeMethods.ValidateFinalPath(safeHandle, fullPath);
      return new NativeDirectoryHandle(fullPath, safeHandle);
      } catch {
        safeHandle.Dispose();
        throw;
      }
    }

    public static NativeDirectoryHandle CreateNew(
      NativeDirectoryHandle parent,
      string leafName
    ) {
      return CreateNewCore(parent, leafName, false);
    }

    public static NativeDirectoryHandle CreateNewWithInjectedFailure(
      NativeDirectoryHandle parent,
      string leafName
    ) {
      return CreateNewCore(parent, leafName, true);
    }

    private static NativeDirectoryHandle CreateNewCore(
      NativeDirectoryHandle parent,
      string leafName,
      bool injectPostCreateFailure
    ) {
      return OpenRelativeCore(
        parent,
        leafName,
        NativeMethods.NtFileCreate,
        true,
        injectPostCreateFailure
      );
    }

    private static NativeDirectoryHandle OpenRelativeCore(
      NativeDirectoryHandle parent,
      string leafName,
      uint createDisposition,
      bool requestDeleteAccess,
      bool injectPostCreateFailure
    ) {
      if (parent == null) {
        throw new ArgumentNullException("parent");
      }
      parent.ThrowIfDisposed();
      NativeMethods.ValidateSingleLeaf(leafName);
      string fullPath = System.IO.Path.Combine(parent.Path, leafName);
      SafeFileHandle safeHandle = null;
      try {
        uint desiredAccess =
          NativeMethods.FileReadAttributes |
          NativeMethods.Synchronize;
        if (requestDeleteAccess) {
          desiredAccess |= NativeMethods.Delete | NativeMethods.WriteDac;
        }
        safeHandle = NativeMethods.OpenRelative(
          parent.Handle,
          parent.Path,
          leafName,
          desiredAccess,
          NativeMethods.ShareRead,
          createDisposition,
          NativeMethods.NtFileDirectoryFile |
            NativeMethods.NtFileSynchronousIoNonAlert |
            NativeMethods.FlagOpenReparsePoint
        );
        SafeFileHandle validationHandle = safeHandle;
        safeHandle = null;
        NativeDirectoryHandle result = FromValidatedHandle(
          fullPath,
          validationHandle
        );
        if (injectPostCreateFailure) {
          try {
            result.TrySetDeletePending();
          } finally {
            result.Dispose();
          }
          throw new IOException("Injected atomic directory creation failure.");
        }
        return result;
      } catch {
        if (safeHandle != null) {
          safeHandle.Dispose();
        }
        throw;
      }
    }

    public void ApplySecurityDescriptor(byte[] securityDescriptor) {
      ThrowIfDisposed();
      NativeMethods.ApplyPrivateSecurity(handle, securityDescriptor);
    }

    public bool TrySetDeletePending() {
      ThrowIfDisposed();
      try {
        NativeMethods.UpdateDeleteDisposition(handle, Path, true);
        return true;
      } catch (Win32Exception exception) {
        if (exception.NativeErrorCode == NativeMethods.ErrorDirNotEmpty) {
          return false;
        }
        throw;
      }
    }

    private void ThrowIfDisposed() {
      if (disposed) {
        throw new ObjectDisposedException("NativeDirectoryHandle");
      }
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

    public static NativeHandleFile CopyToCreateNew(
      NativeHandleFile source,
      NativeDirectoryHandle destinationParent,
      string destinationLeaf
    ) {
      NativeHandleFile destination = NativeHandleFile.CreateNew(
        destinationParent,
        destinationLeaf
      );
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
