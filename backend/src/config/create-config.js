'use strict';

const { lstatSync, realpathSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { isAbsolute, join, parse, relative, resolve, sep } = require('node:path');

const {
  ALLOWED_SUBNET_POLICY_MODES,
  CONFIG_ERROR_MESSAGES,
  EXECUTION_MODES,
  LOOPBACK_HOSTS,
  PAIRING_POLICY_MODES,
  STORAGE_PATH_DEFAULTS,
} = require('./config-schema');

const defaultRepositoryRoot = resolve(__dirname, '..', '..', '..');
const referencePattern = /^[a-z][a-z0-9+.-]*:[a-z0-9][a-z0-9._/-]*$/i;
const forbiddenLanFields = Object.freeze([
  'applicationApi',
  'applicationApiCredentialRef',
  'loopbackCredentialRef',
  'credentialRef',
  'host',
  'allowEphemeralPort',
]);

class ConfigValidationError extends Error {
  constructor(code) {
    super(CONFIG_ERROR_MESSAGES[code]);
    this.name = 'ConfigValidationError';
    this.code = code;
  }
}

function fail(code) {
  throw new ConfigValidationError(code);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizedComparable(path) {
  const normalized = resolve(path);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isContained(parentPath, candidatePath) {
  const parent = normalizedComparable(parentPath);
  const candidate = normalizedComparable(candidatePath);
  const candidateRelative = relative(parent, candidate);
  return (
    candidateRelative === '' ||
    (isAbsolute(candidateRelative) === false &&
      candidateRelative !== '..' &&
      candidateRelative.startsWith(`..${sep}`) === false)
  );
}

function assertAbsolutePath(value, code) {
  if (typeof value !== 'string' || value.length === 0 || isAbsolute(value) === false) fail(code);
  return resolve(value);
}

function assertNoLinkedExistingAncestry(targetPath) {
  const target = resolve(targetPath);
  const volumeRoot = parse(target).root;
  let current = volumeRoot;

  for (const component of relative(volumeRoot, target).split(sep).filter(Boolean)) {
    current = join(current, component);
    let metadata;
    try {
      metadata = lstatSync(current);
    } catch (error) {
      if (error?.code === 'ENOENT') break;
      fail('CONFIG_STORAGE_INSPECTION_FAILED');
    }
    if (metadata.isSymbolicLink()) fail('CONFIG_STORAGE_LINKED');

    let canonical;
    try {
      canonical = realpathSync.native(current);
    } catch {
      fail('CONFIG_STORAGE_INSPECTION_FAILED');
    }
    if (normalizedComparable(canonical) !== normalizedComparable(current)) {
      fail('CONFIG_STORAGE_LINKED');
    }
  }
}

function normalizeStorage(input, mode) {
  if (input.storageRoot === undefined || input.storageRoot === null || input.storageRoot === '') {
    fail(mode === 'test' ? 'CONFIG_TEST_STORAGE_ROOT_REQUIRED' : 'CONFIG_STORAGE_ROOT_REQUIRED');
  }
  const storageRoot = assertAbsolutePath(input.storageRoot, 'CONFIG_STORAGE_ROOT_ABSOLUTE');

  if (mode === 'test') {
    const repositoryRoot =
      input.repositoryRoot === undefined
        ? defaultRepositoryRoot
        : assertAbsolutePath(input.repositoryRoot, 'CONFIG_REPOSITORY_ROOT_ABSOLUTE');
    if (isContained(repositoryRoot, storageRoot)) fail('CONFIG_TEST_STORAGE_ROOT_EXTERNAL');
    if (!isContained(resolve(tmpdir()), storageRoot)) fail('CONFIG_TEST_STORAGE_ROOT_TEMPORARY');
  }

  if (input.paths !== undefined && !isPlainObject(input.paths)) fail('CONFIG_PATHS_INVALID');
  const overrides = input.paths ?? {};
  for (const key of Object.keys(overrides)) {
    if (!Object.hasOwn(STORAGE_PATH_DEFAULTS, key)) fail('CONFIG_PATH_UNKNOWN');
  }

  const paths = {};
  for (const [key, segments] of Object.entries(STORAGE_PATH_DEFAULTS)) {
    const candidate = Object.hasOwn(overrides, key)
      ? assertAbsolutePath(overrides[key], 'CONFIG_PATH_ABSOLUTE')
      : resolve(storageRoot, ...segments);
    if (!isContained(storageRoot, candidate)) fail('CONFIG_PATH_ESCAPE');
    paths[key] = candidate;
  }

  assertNoLinkedExistingAncestry(storageRoot);
  for (const path of Object.values(paths)) assertNoLinkedExistingAncestry(path);

  return { storageRoot, paths };
}

function normalizeReference(value, code, { required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) fail(code);
    return null;
  }
  if (typeof value !== 'string') fail(code);
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 256 || !referencePattern.test(normalized)) fail(code);
  return normalized;
}

function normalizeApplicationApi(input, mode) {
  if (input !== undefined && !isPlainObject(input)) fail('CONFIG_APPLICATION_API_INVALID');
  const applicationApi = input ?? {};
  const enabled = applicationApi.enabled ?? mode !== 'test';
  if (typeof enabled !== 'boolean') fail('CONFIG_APPLICATION_API_INVALID');
  if (mode === 'test' && enabled) fail('CONFIG_TEST_LISTENER_ENABLED');

  const host = applicationApi.host ?? '127.0.0.1';
  if (!LOOPBACK_HOSTS.includes(host)) fail('CONFIG_APPLICATION_HOST_LOOPBACK');

  const allowEphemeralPort = applicationApi.allowEphemeralPort ?? false;
  if (typeof allowEphemeralPort !== 'boolean') fail('CONFIG_APPLICATION_API_INVALID');
  const port = applicationApi.port ?? (mode === 'test' ? 0 : 3210);
  const validNonzeroPort = Number.isInteger(port) && port >= 1 && port <= 65535;
  const validTestPort = mode === 'test' && enabled === false && port === 0;
  const validStandaloneDevelopmentPort = mode === 'standalone' && allowEphemeralPort === true && port === 0;
  if (!validNonzeroPort && !validTestPort && !validStandaloneDevelopmentPort) {
    fail('CONFIG_APPLICATION_PORT_INVALID');
  }
  if (allowEphemeralPort && mode !== 'standalone') fail('CONFIG_APPLICATION_PORT_INVALID');

  const credentialRef = normalizeReference(applicationApi.credentialRef, 'CONFIG_APPLICATION_CREDENTIAL_REF_INVALID');

  return { enabled, host, port, allowEphemeralPort, credentialRef };
}

function normalizeScheduler(input, mode) {
  if (input !== undefined && !isPlainObject(input)) fail('CONFIG_SCHEDULER_INVALID');
  const enabled = input?.enabled ?? mode !== 'test';
  if (typeof enabled !== 'boolean') fail('CONFIG_SCHEDULER_INVALID');
  if (mode === 'test' && enabled) fail('CONFIG_TEST_SCHEDULER_ENABLED');
  return { enabled };
}

function validPolicy(policy, allowedModes) {
  return (
    isPlainObject(policy) &&
    Object.keys(policy).length === 1 &&
    typeof policy.mode === 'string' &&
    allowedModes.includes(policy.mode)
  );
}

function normalizeLanSync(input, mode, applicationApi) {
  if (input !== undefined && !isPlainObject(input)) fail('CONFIG_LAN_SYNC_INVALID');
  const lanSync = input ?? {};
  const enabled = lanSync.enabled ?? false;
  if (typeof enabled !== 'boolean') fail('CONFIG_LAN_SYNC_INVALID');
  if (mode === 'test' && enabled) fail('CONFIG_TEST_LISTENER_ENABLED');

  if (!enabled) {
    return {
      enabled: false,
      port: null,
      tlsIdentityRef: null,
      pairingPolicy: null,
      allowedSubnetPolicy: null,
    };
  }

  if (forbiddenLanFields.some(field => Object.hasOwn(lanSync, field))) {
    fail('CONFIG_LAN_SYNC_BOUNDARY_REUSE');
  }

  const requiredValuesPresent =
    Object.hasOwn(lanSync, 'port') &&
    Object.hasOwn(lanSync, 'tlsIdentityRef') &&
    Object.hasOwn(lanSync, 'pairingPolicy') &&
    Object.hasOwn(lanSync, 'allowedSubnetPolicy');
  if (
    !requiredValuesPresent ||
    !validPolicy(lanSync.pairingPolicy, PAIRING_POLICY_MODES) ||
    !validPolicy(lanSync.allowedSubnetPolicy, ALLOWED_SUBNET_POLICY_MODES)
  ) {
    fail('CONFIG_LAN_SYNC_INCOMPLETE');
  }

  if (!Number.isInteger(lanSync.port) || lanSync.port < 1 || lanSync.port > 65535) {
    fail('CONFIG_LAN_PORT_INVALID');
  }
  const tlsIdentityRef = normalizeReference(lanSync.tlsIdentityRef, 'CONFIG_LAN_SYNC_INCOMPLETE', { required: true });
  if (applicationApi.credentialRef !== null && tlsIdentityRef === applicationApi.credentialRef) {
    fail('CONFIG_LAN_SYNC_BOUNDARY_REUSE');
  }

  return {
    enabled: true,
    port: lanSync.port,
    tlsIdentityRef,
    pairingPolicy: { mode: lanSync.pairingPolicy.mode },
    allowedSubnetPolicy: { mode: lanSync.allowedSubnetPolicy.mode },
  };
}

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function createConfig(input) {
  if (!isPlainObject(input)) fail('CONFIG_INPUT_INVALID');
  if (!EXECUTION_MODES.includes(input.mode)) fail('CONFIG_MODE_INVALID');

  const { storageRoot, paths } = normalizeStorage(input, input.mode);
  const applicationApi = normalizeApplicationApi(input.applicationApi, input.mode);
  const scheduler = normalizeScheduler(input.scheduler, input.mode);
  const lanSync = normalizeLanSync(input.lanSync, input.mode, applicationApi);

  return deepFreeze({
    mode: input.mode,
    storageRoot,
    paths,
    applicationApi,
    scheduler,
    lanSync,
  });
}

module.exports = {
  ConfigValidationError,
  createConfig,
};
