'use strict';

const { lstatSync, readdirSync, realpathSync } = require('node:fs');
const { isAbsolute, join, resolve } = require('node:path');

const { LegacyInspectionError, verifyLegacyManifest } = require('./inspect-legacy');

function invalid() {
  throw new LegacyInspectionError('LEGACY_INPUT_INVALID');
}

function comparable(path) {
  const normalized = resolve(path);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function validateRoot(path) {
  let metadata;
  try {
    metadata = lstatSync(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    invalid();
  }
  let canonical;
  try {
    canonical = realpathSync.native(path);
  } catch {
    invalid();
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || comparable(canonical) !== comparable(path)) invalid();
  return true;
}

function discoverConfiguredRoot(quarantineRoot) {
  if (
    typeof quarantineRoot !== 'string' ||
    quarantineRoot.length === 0 ||
    !isAbsolute(quarantineRoot) ||
    resolve(quarantineRoot) !== quarantineRoot
  ) {
    invalid();
  }
  if (!validateRoot(quarantineRoot)) return Object.freeze({ available: false });
  let candidates;
  try {
    candidates = readdirSync(quarantineRoot, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && /^\d{8}T\d{9}Z$/.test(entry.name))
      .map(entry => join(quarantineRoot, entry.name, 'manifest.json'))
      .sort((left, right) => right.localeCompare(left));
  } catch {
    invalid();
  }
  if (candidates.length === 0) return Object.freeze({ available: false });
  const verified = verifyLegacyManifest(candidates[0]);
  return Object.freeze({ available: true, manifestPath: verified.manifestPath });
}

function discoverLegacy({ manifestPath, quarantineRoot, environment = process.env } = {}) {
  if (environment === null || typeof environment !== 'object' || Array.isArray(environment)) invalid();
  const configuredManifest = manifestPath ?? environment.EASY_REWIND_LEGACY_MANIFEST;
  if (configuredManifest !== undefined && configuredManifest !== '') {
    if (
      typeof configuredManifest !== 'string' ||
      !isAbsolute(configuredManifest) ||
      resolve(configuredManifest) !== configuredManifest
    ) {
      invalid();
    }
    const verified = verifyLegacyManifest(configuredManifest);
    return Object.freeze({
      available: true,
      manifestPath: verified.manifestPath,
    });
  }
  const configuredRoot =
    quarantineRoot ??
    (typeof environment.LOCALAPPDATA === 'string' && environment.LOCALAPPDATA.length > 0
      ? join(resolve(environment.LOCALAPPDATA), 'easy-rewind', 'legacy-backup')
      : undefined);
  if (configuredRoot === undefined) return Object.freeze({ available: false });
  return discoverConfiguredRoot(configuredRoot);
}

module.exports = { discoverLegacy };
