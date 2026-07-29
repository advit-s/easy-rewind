'use strict';

const { spawn, spawnSync } = require('node:child_process');
const { createHash, randomBytes } = require('node:crypto');
const defaultSyncFilesystem = require('node:fs');
const defaultFilesystem = require('node:fs/promises');
const { isAbsolute, relative, resolve, sep } = require('node:path');

const ERROR_MESSAGES = Object.freeze({
  WINDOWS_ACL_OPERATION_FAILED: 'The current-user Windows ACL operation failed.',
  WINDOWS_ACL_TARGET_INVALID: 'The Windows ACL target is outside the protected runtime root.',
  WINDOWS_ACL_VERIFICATION_FAILED: 'The current-user Windows ACL could not be verified.',
  WINDOWS_DPAPI_FAILED: 'Windows current-user data protection failed.',
  WINDOWS_ENCRYPTION_UNAVAILABLE: 'Windows current-user encryption is unavailable.',
  WINDOWS_LOCAL_APP_DATA_REQUIRED: 'A valid Windows local application-data root is required.',
  WINDOWS_PLATFORM_REQUIRED: 'Windows protected platform adapters require Windows.',
  WINDOWS_SECRET_OPERATION_FAILED: 'The protected secret operation failed.',
});

const MAX_PROTECTED_BYTES = 1024 * 1024;
const MAX_ACL_OUTPUT_BYTES = 64 * 1024;
const SECRET_DIRECTORY = 'secrets';

class WindowsPlatformAdapterError extends Error {
  constructor(code) {
    super(ERROR_MESSAGES[code]);
    this.name = 'WindowsPlatformAdapterError';
    this.code = code;
  }
}

function fail(code) {
  throw new WindowsPlatformAdapterError(code);
}

function validateOptions(options) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    fail('WINDOWS_PLATFORM_REQUIRED');
  }
  if ((options.platform ?? process.platform) !== 'win32') fail('WINDOWS_PLATFORM_REQUIRED');
  const localAppData = options.localAppData;
  if (
    typeof localAppData !== 'string' ||
    localAppData.length === 0 ||
    localAppData.trim() !== localAppData ||
    !isAbsolute(localAppData)
  ) {
    fail('WINDOWS_LOCAL_APP_DATA_REQUIRED');
  }
  return resolve(localAppData);
}

function isContained(root, target) {
  const normalizedRoot = resolve(root).toLowerCase();
  const normalizedTarget = resolve(target).toLowerCase();
  const child = relative(normalizedRoot, normalizedTarget);
  return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

function validateFilesystem(filesystem) {
  if (
    filesystem === null ||
    typeof filesystem !== 'object' ||
    typeof filesystem.lstat !== 'function' ||
    typeof filesystem.mkdir !== 'function' ||
    typeof filesystem.readFile !== 'function' ||
    typeof filesystem.realpath !== 'function' ||
    typeof filesystem.rename !== 'function' ||
    typeof filesystem.rm !== 'function' ||
    typeof filesystem.writeFile !== 'function'
  ) {
    fail('WINDOWS_SECRET_OPERATION_FAILED');
  }
}

function validateAclController(controller) {
  if (controller === null || typeof controller !== 'object' || typeof controller.restrict !== 'function') {
    fail('WINDOWS_ACL_OPERATION_FAILED');
  }
}

function validateSyncFilesystem(filesystem) {
  if (
    filesystem === null ||
    typeof filesystem !== 'object' ||
    typeof filesystem.lstatSync !== 'function' ||
    typeof filesystem.realpathSync !== 'function'
  ) {
    fail('WINDOWS_ACL_OPERATION_FAILED');
  }
}

function validateSyncAclController(controller) {
  if (controller === null || typeof controller !== 'object' || typeof controller.restrict !== 'function') {
    fail('WINDOWS_ACL_OPERATION_FAILED');
  }
}

function validateProtection(protection) {
  if (
    protection === null ||
    typeof protection !== 'object' ||
    typeof protection.protect !== 'function' ||
    typeof protection.unprotect !== 'function'
  ) {
    fail('WINDOWS_ENCRYPTION_UNAVAILABLE');
  }
}

async function inspectTarget(filesystem, trustedRoot, target, kind) {
  const normalizedTarget = resolve(target);
  if (target !== normalizedTarget || !isContained(trustedRoot, normalizedTarget)) {
    fail('WINDOWS_ACL_TARGET_INVALID');
  }
  let metadata;
  let canonical;
  try {
    metadata = await filesystem.lstat(normalizedTarget);
    canonical = await filesystem.realpath(normalizedTarget);
  } catch {
    fail('WINDOWS_ACL_TARGET_INVALID');
  }
  if (
    metadata.isSymbolicLink() ||
    (typeof metadata.isReparsePoint === 'function' && metadata.isReparsePoint()) ||
    resolve(canonical).toLowerCase() !== normalizedTarget.toLowerCase() ||
    (kind === 'directory' ? !metadata.isDirectory() : !metadata.isFile())
  ) {
    fail('WINDOWS_ACL_TARGET_INVALID');
  }
  return `${String(metadata.dev)}:${String(metadata.ino)}`;
}

function validIdentityPart(value) {
  return (
    (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) ||
    (typeof value === 'bigint' && value >= 0n)
  );
}

function inspectTargetSync(filesystem, trustedRoot, target, kind) {
  if (typeof target !== 'string' || target.length === 0 || !isAbsolute(target)) {
    fail('WINDOWS_ACL_TARGET_INVALID');
  }
  const normalizedTarget = resolve(target);
  if (target !== normalizedTarget || !isContained(trustedRoot, normalizedTarget)) {
    fail('WINDOWS_ACL_TARGET_INVALID');
  }
  let metadata;
  let canonical;
  try {
    metadata = filesystem.lstatSync(normalizedTarget, { bigint: true });
    canonical = filesystem.realpathSync(normalizedTarget);
  } catch {
    fail('WINDOWS_ACL_TARGET_INVALID');
  }
  if (
    metadata === null ||
    typeof metadata !== 'object' ||
    typeof metadata.isSymbolicLink !== 'function' ||
    typeof metadata.isDirectory !== 'function' ||
    typeof metadata.isFile !== 'function' ||
    metadata.isSymbolicLink() ||
    (typeof metadata.isReparsePoint === 'function' && metadata.isReparsePoint()) ||
    resolve(canonical).toLowerCase() !== normalizedTarget.toLowerCase() ||
    !isContained(trustedRoot, canonical) ||
    (kind === 'directory' ? !metadata.isDirectory() : !metadata.isFile()) ||
    !validIdentityPart(metadata.dev) ||
    !validIdentityPart(metadata.ino)
  ) {
    fail('WINDOWS_ACL_TARGET_INVALID');
  }
  return `${String(metadata.dev)}:${String(metadata.ino)}`;
}

function createWindowsFilePermissions({ aclController, filesystem, trustedRoot }) {
  validateAclController(aclController);
  return Object.freeze({
    async restrictDirectory(target) {
      await restrict(target, 'directory');
    },
    async restrictFile(target) {
      await restrict(target, 'file');
    },
  });

  async function restrict(target, kind) {
    const identityBefore = await inspectTarget(filesystem, trustedRoot, target, kind);
    let result;
    try {
      result = await aclController.restrict({ kind, target });
    } catch {
      fail('WINDOWS_ACL_OPERATION_FAILED');
    }
    if (result?.verified !== true) fail('WINDOWS_ACL_VERIFICATION_FAILED');
    const identityAfter = await inspectTarget(filesystem, trustedRoot, target, kind);
    if (identityAfter !== identityBefore) fail('WINDOWS_ACL_VERIFICATION_FAILED');
  }
}

function createWindowsArtifactFilePermissions({ aclController, filesystem, trustedRoot }) {
  validateSyncAclController(aclController);
  validateSyncFilesystem(filesystem);
  return Object.freeze({
    restrictFile(target) {
      const identityBefore = inspectTargetSync(filesystem, trustedRoot, target, 'file');
      let result;
      try {
        result = aclController.restrict({ kind: 'file', target });
      } catch {
        fail('WINDOWS_ACL_OPERATION_FAILED');
      }
      if (
        result !== null &&
        (typeof result === 'object' || typeof result === 'function') &&
        typeof result.then === 'function'
      ) {
        Promise.resolve(result).catch(() => {});
        fail('WINDOWS_ACL_OPERATION_FAILED');
      }
      if (result?.verified !== true) fail('WINDOWS_ACL_VERIFICATION_FAILED');
      let identityAfter;
      try {
        identityAfter = inspectTargetSync(filesystem, trustedRoot, target, 'file');
      } catch {
        fail('WINDOWS_ACL_VERIFICATION_FAILED');
      }
      if (identityAfter !== identityBefore) fail('WINDOWS_ACL_VERIFICATION_FAILED');
    },
  });
}

function serializeSecret(value) {
  if (typeof value === 'string' && value.length > 0) {
    return Buffer.from(JSON.stringify({ type: 'text', value }), 'utf8');
  }
  if (value instanceof Uint8Array && value.byteLength > 0) {
    return Buffer.from(JSON.stringify({ type: 'binary', value: Buffer.from(value).toString('base64') }), 'utf8');
  }
  fail('WINDOWS_SECRET_OPERATION_FAILED');
}

function deserializeSecret(value) {
  try {
    const decoded = JSON.parse(Buffer.from(value).toString('utf8'));
    if (
      decoded !== null &&
      typeof decoded === 'object' &&
      Object.keys(decoded).sort().join('\0') === 'type\0value' &&
      decoded.type === 'text' &&
      typeof decoded.value === 'string' &&
      decoded.value.length > 0
    ) {
      return decoded.value;
    }
    if (
      decoded !== null &&
      typeof decoded === 'object' &&
      Object.keys(decoded).sort().join('\0') === 'type\0value' &&
      decoded.type === 'binary' &&
      typeof decoded.value === 'string' &&
      /^[A-Za-z0-9+/]+={0,2}$/.test(decoded.value)
    ) {
      const binary = Buffer.from(decoded.value, 'base64');
      if (binary.byteLength > 0) return Uint8Array.from(binary);
    }
  } catch {
    // The stable protected-operation error is authoritative.
  }
  fail('WINDOWS_SECRET_OPERATION_FAILED');
}

function secretFilename(name) {
  if (typeof name !== 'string' || name.length === 0) fail('WINDOWS_SECRET_OPERATION_FAILED');
  return `${createHash('sha256').update(name, 'utf8').digest('hex')}.bin`;
}

function createProtectedSecretAdapter({ filePermissions, filesystem, protection, storageRoot }) {
  validateProtection(protection);
  const secretsRoot = resolve(storageRoot, SECRET_DIRECTORY);

  async function ensureProtectedDirectories() {
    try {
      await filesystem.mkdir(storageRoot, { recursive: true });
      await filePermissions.restrictDirectory(storageRoot);
      await filesystem.mkdir(secretsRoot, { recursive: true });
      await filePermissions.restrictDirectory(secretsRoot);
    } catch (error) {
      if (error instanceof WindowsPlatformAdapterError) throw error;
      fail('WINDOWS_SECRET_OPERATION_FAILED');
    }
  }

  function targetFor(name) {
    return resolve(secretsRoot, secretFilename(name));
  }

  return Object.freeze({
    async delete(name) {
      const target = targetFor(name);
      try {
        await filesystem.rm(target, { force: true });
      } catch {
        fail('WINDOWS_SECRET_OPERATION_FAILED');
      }
    },
    async get(name) {
      const target = targetFor(name);
      let encrypted;
      try {
        encrypted = await filesystem.readFile(target);
      } catch (error) {
        if (error?.code === 'ENOENT') return null;
        fail('WINDOWS_SECRET_OPERATION_FAILED');
      }
      try {
        const plaintext = await protection.unprotect(Buffer.from(encrypted));
        if (!(plaintext instanceof Uint8Array) || plaintext.byteLength === 0) {
          fail('WINDOWS_SECRET_OPERATION_FAILED');
        }
        return deserializeSecret(plaintext);
      } catch (error) {
        if (error instanceof WindowsPlatformAdapterError) throw error;
        fail('WINDOWS_SECRET_OPERATION_FAILED');
      }
    },
    async set(name, value) {
      await ensureProtectedDirectories();
      const target = targetFor(name);
      const temporary = `${target}.${randomBytes(12).toString('hex')}.tmp`;
      let encrypted;
      try {
        encrypted = await protection.protect(serializeSecret(value));
        if (
          !(encrypted instanceof Uint8Array) ||
          encrypted.byteLength === 0 ||
          encrypted.byteLength > MAX_PROTECTED_BYTES
        ) {
          fail('WINDOWS_SECRET_OPERATION_FAILED');
        }
        await filesystem.writeFile(temporary, Buffer.from(encrypted), { flag: 'wx', mode: 0o600 });
        await filePermissions.restrictFile(temporary);
        await filesystem.rm(target, { force: true });
        await filesystem.rename(temporary, target);
      } catch (error) {
        try {
          await filesystem.rm(temporary, { force: true });
        } catch {
          // Cleanup failure cannot expose a more detailed error.
        }
        if (error instanceof WindowsPlatformAdapterError) throw error;
        fail('WINDOWS_SECRET_OPERATION_FAILED');
      }
    },
  });
}

function createElectronProtection(safeStorage) {
  if (
    safeStorage === null ||
    typeof safeStorage !== 'object' ||
    typeof safeStorage.decryptString !== 'function' ||
    typeof safeStorage.encryptString !== 'function' ||
    typeof safeStorage.isEncryptionAvailable !== 'function' ||
    safeStorage.isEncryptionAvailable() !== true
  ) {
    fail('WINDOWS_ENCRYPTION_UNAVAILABLE');
  }
  return Object.freeze({
    async protect(value) {
      try {
        return Buffer.from(safeStorage.encryptString(Buffer.from(value).toString('utf8')));
      } catch {
        fail('WINDOWS_ENCRYPTION_UNAVAILABLE');
      }
    },
    async unprotect(value) {
      try {
        return Buffer.from(safeStorage.decryptString(Buffer.from(value)), 'utf8');
      } catch {
        fail('WINDOWS_ENCRYPTION_UNAVAILABLE');
      }
    },
  });
}

function powershellExecutable(environment = process.env) {
  const systemRoot = environment.SystemRoot || environment.SYSTEMROOT;
  if (typeof systemRoot !== 'string' || systemRoot.length === 0) {
    fail('WINDOWS_DPAPI_FAILED');
  }
  return resolve(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

function runPowerShellJson({ executable = powershellExecutable(), input, script, timeoutMs = 15_000 } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    let stdout = '';
    const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
    });
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) rejectPromise(error);
      else resolvePromise(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error('operation failed'));
    }, timeoutMs);
    timer.unref?.();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdout += chunk;
      if (stdout.length > MAX_PROTECTED_BYTES * 2) {
        child.kill();
        finish(new Error('operation failed'));
      }
    });
    child.on('error', () => finish(new Error('operation failed')));
    child.on('close', code => {
      if (code !== 0) {
        finish(new Error('operation failed'));
        return;
      }
      try {
        finish(null, JSON.parse(stdout));
      } catch {
        finish(new Error('operation failed'));
      }
    });
    child.stdin.on('error', () => finish(new Error('operation failed')));
    child.stdin.end(JSON.stringify(input));
  });
}

function runPowerShellJsonSync({
  executable = powershellExecutable(),
  input,
  script,
  timeoutMs = 15_000,
  spawnSync: executeProcess = spawnSync,
} = {}) {
  if (
    typeof executable !== 'string' ||
    executable.length === 0 ||
    typeof script !== 'string' ||
    script.length === 0 ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 60_000 ||
    typeof executeProcess !== 'function'
  ) {
    throw new Error('operation failed');
  }
  let serialized;
  let result;
  try {
    serialized = JSON.stringify(input);
    result = executeProcess(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      input: serialized,
      maxBuffer: MAX_ACL_OUTPUT_BYTES,
      stdio: ['pipe', 'pipe', 'ignore'],
      timeout: timeoutMs,
      windowsHide: true,
    });
  } catch {
    throw new Error('operation failed');
  }
  if (
    result === null ||
    typeof result !== 'object' ||
    result.error !== undefined ||
    result.signal !== null ||
    result.status !== 0 ||
    typeof result.stdout !== 'string' ||
    Buffer.byteLength(result.stdout, 'utf8') > MAX_ACL_OUTPUT_BYTES
  ) {
    throw new Error('operation failed');
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error('operation failed');
  }
}

const DPAPI_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
$bytes = [Convert]::FromBase64String([string]$request.value)
if ($request.operation -eq 'protect') {
  $result = [Security.Cryptography.ProtectedData]::Protect(
    $bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
} elseif ($request.operation -eq 'unprotect') {
  $result = [Security.Cryptography.ProtectedData]::Unprotect(
    $bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
} else {
  throw 'Unsupported operation'
}
@{ value = [Convert]::ToBase64String($result) } | ConvertTo-Json -Compress
`;

function createDpapiProtection({ execute = runPowerShellJson } = {}) {
  if (typeof execute !== 'function') fail('WINDOWS_DPAPI_FAILED');
  const operation = action => async value => {
    try {
      const result = await execute({
        input: { operation: action, value: Buffer.from(value).toString('base64') },
        script: DPAPI_SCRIPT,
      });
      if (
        result === null ||
        typeof result !== 'object' ||
        typeof result.value !== 'string' ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(result.value)
      ) {
        fail('WINDOWS_DPAPI_FAILED');
      }
      const output = Buffer.from(result.value, 'base64');
      if (output.byteLength === 0 || output.byteLength > MAX_PROTECTED_BYTES) fail('WINDOWS_DPAPI_FAILED');
      return output;
    } catch (error) {
      if (error instanceof WindowsPlatformAdapterError) throw error;
      fail('WINDOWS_DPAPI_FAILED');
    }
  };
  return Object.freeze({
    protect: operation('protect'),
    unprotect: operation('unprotect'),
  });
}

const ACL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
$target = [IO.Path]::GetFullPath([string]$request.target)
$item = Get-Item -LiteralPath $target -Force
if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Linked target' }
$isDirectory = [bool]$item.PSIsContainer
if (($request.kind -eq 'directory') -ne $isDirectory) { throw 'Target kind mismatch' }
$current = [Security.Principal.WindowsIdentity]::GetCurrent().User
$sections = [Security.AccessControl.AccessControlSections]'Access, Owner, Group'
$acl = if ($isDirectory) {
  [IO.Directory]::GetAccessControl($target, $sections)
} else {
  [IO.File]::GetAccessControl($target, $sections)
}
$inheritance = if ($isDirectory) {
  [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
} else {
  [Security.AccessControl.InheritanceFlags]::None
}
function Test-ExactCurrentUserAcl($candidate, $currentSid, $expectedInheritance) {
  $candidateOwner = ([Security.Principal.NTAccount]$candidate.Owner).Translate(
    [Security.Principal.SecurityIdentifier]).Value
  $candidateRules = @($candidate.GetAccessRules(
    $true, $true, [Security.Principal.SecurityIdentifier]))
  return $candidate.AreAccessRulesProtected -and
    $candidateOwner -eq $currentSid.Value -and
    $candidateRules.Count -eq 1 -and
    $candidateRules[0].IdentityReference.Translate(
      [Security.Principal.SecurityIdentifier]).Value -eq $currentSid.Value -and
    $candidateRules[0].AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
    $candidateRules[0].FileSystemRights -eq [Security.AccessControl.FileSystemRights]::FullControl -and
    -not $candidateRules[0].IsInherited -and
    $candidateRules[0].InheritanceFlags -eq $expectedInheritance -and
    $candidateRules[0].PropagationFlags -eq [Security.AccessControl.PropagationFlags]::None
}
if (Test-ExactCurrentUserAcl $acl $current $inheritance) {
  @{ verified = $true } | ConvertTo-Json -Compress
  exit 0
}
$acl.SetAccessRuleProtection($true, $false)
$acl.SetOwner($current)
foreach ($existingRule in @($acl.GetAccessRules(
  $true, $true, [Security.Principal.SecurityIdentifier]))) {
  [void]$acl.RemoveAccessRuleSpecific($existingRule)
}
$rule = [Security.AccessControl.FileSystemAccessRule]::new(
  $current,
  [Security.AccessControl.FileSystemRights]::FullControl,
  $inheritance,
  [Security.AccessControl.PropagationFlags]::None,
  [Security.AccessControl.AccessControlType]::Allow)
[void]$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $target -AclObject $acl
$actual = if ($isDirectory) {
  [IO.Directory]::GetAccessControl($target, $sections)
} else {
  [IO.File]::GetAccessControl($target, $sections)
}
$valid = Test-ExactCurrentUserAcl $actual $current $inheritance
@{ verified = [bool]$valid } | ConvertTo-Json -Compress
`;

function createPowerShellAclController({ execute = runPowerShellJson } = {}) {
  if (typeof execute !== 'function') fail('WINDOWS_ACL_OPERATION_FAILED');
  return Object.freeze({
    async restrict({ kind, target }) {
      try {
        const result = await execute({
          input: { kind, target },
          script: ACL_SCRIPT,
        });
        return { verified: result?.verified === true };
      } catch {
        fail('WINDOWS_ACL_OPERATION_FAILED');
      }
    },
  });
}

function createPowerShellAclControllerSync({ execute = runPowerShellJsonSync } = {}) {
  if (typeof execute !== 'function') fail('WINDOWS_ACL_OPERATION_FAILED');
  return Object.freeze({
    restrict({ kind, target }) {
      try {
        const result = execute({
          input: { kind, target },
          script: ACL_SCRIPT,
        });
        if (
          result !== null &&
          (typeof result === 'object' || typeof result === 'function') &&
          typeof result.then === 'function'
        ) {
          Promise.resolve(result).catch(() => {});
          fail('WINDOWS_ACL_OPERATION_FAILED');
        }
        return { verified: result?.verified === true };
      } catch {
        fail('WINDOWS_ACL_OPERATION_FAILED');
      }
    },
  });
}

function createAdapters(options, protection) {
  const localAppData = validateOptions(options);
  const filesystem = options.filesystem ?? defaultFilesystem;
  validateFilesystem(filesystem);
  const storageRoot = resolve(localAppData, 'easy-rewind', 'runtime');
  const aclController = options.aclController ?? createPowerShellAclController(options.powershell);
  const syncFilesystem = options.syncFilesystem ?? defaultSyncFilesystem;
  validateSyncFilesystem(syncFilesystem);
  const syncAclController = options.syncAclController ?? createPowerShellAclControllerSync(options.powershellSync);
  const filePermissions = createWindowsFilePermissions({
    aclController,
    filesystem,
    trustedRoot: storageRoot,
  });
  const artifactFilePermissions = createWindowsArtifactFilePermissions({
    aclController: syncAclController,
    filesystem: syncFilesystem,
    trustedRoot: storageRoot,
  });
  const secretStoreAdapter = createProtectedSecretAdapter({
    filePermissions,
    filesystem,
    protection,
    storageRoot,
  });
  return Object.freeze({ artifactFilePermissions, filePermissions, secretStoreAdapter, storageRoot });
}

function createWindowsPlatformAdapters(options = {}) {
  const resolvedOptions = {
    ...options,
    localAppData: options.localAppData ?? process.env.LOCALAPPDATA,
  };
  validateOptions(resolvedOptions);
  return createAdapters(resolvedOptions, createElectronProtection(resolvedOptions.safeStorage));
}

function createStandaloneWindowsPlatformAdapters(options = {}) {
  const resolvedOptions = {
    ...options,
    localAppData: options.localAppData ?? process.env.LOCALAPPDATA,
  };
  validateOptions(resolvedOptions);
  const protection = resolvedOptions.dpapi ?? createDpapiProtection(resolvedOptions.powershell);
  return createAdapters(resolvedOptions, protection);
}

module.exports = {
  WindowsPlatformAdapterError,
  createDpapiProtection,
  createPowerShellAclController,
  createPowerShellAclControllerSync,
  createStandaloneWindowsPlatformAdapters,
  createWindowsPlatformAdapters,
  runPowerShellJson,
  runPowerShellJsonSync,
};
