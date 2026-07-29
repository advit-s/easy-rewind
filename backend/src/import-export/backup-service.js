'use strict';

const { assertIdentifier, assertNow, defaultIds, exactKeys, fail, sha256, stableStringify } = require('./bundle');

function createBackupService({ artifactStore, pathAdapter, filePermissions, now = Date.now, ids = defaultIds } = {}) {
  if (
    artifactStore === null ||
    typeof artifactStore !== 'object' ||
    typeof artifactStore.writeAtomic !== 'function' ||
    typeof artifactStore.read !== 'function' ||
    typeof artifactStore.remove !== 'function' ||
    pathAdapter === null ||
    typeof pathAdapter !== 'object' ||
    typeof pathAdapter.backupReference !== 'function' ||
    filePermissions === null ||
    typeof filePermissions !== 'object' ||
    typeof filePermissions.restrict !== 'function' ||
    typeof now !== 'function' ||
    typeof ids !== 'function'
  ) {
    fail('BACKUP_OPTIONS_INVALID');
  }

  function remove(reference) {
    try {
      artifactStore.remove(reference);
    } catch {
      // Best-effort cleanup is intentionally non-authoritative.
    }
  }

  function createVerified({ profileId, bytes } = {}) {
    assertIdentifier(profileId, 'BACKUP_INPUT_INVALID');
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) fail('BACKUP_INPUT_INVALID');
    const id = assertIdentifier(ids(), 'BACKUP_OPTIONS_INVALID');
    const createdAt = assertNow(now, 'BACKUP_OPTIONS_INVALID');
    const reference = pathAdapter.backupReference({ profileId, id });
    assertIdentifier(reference, 'BACKUP_OPTIONS_INVALID');
    const checksum = sha256(bytes);
    const envelope = {
      manifest: {
        format: 'easy-rewind-backup',
        version: 1,
        ownerId: profileId,
        createdAt,
        checksum,
      },
      payload: bytes.toString('base64'),
    };
    try {
      artifactStore.writeAtomic(reference, Buffer.from(stableStringify(envelope)), {
        contentType: 'application/json',
        sensitive: true,
      });
      filePermissions.restrict(reference);
      const verified = readVerified({ profileId, reference, checksum });
      if (!verified.equals(bytes)) fail('BACKUP_CHECKSUM_INVALID');
      return Object.freeze({ reference, checksum, verified: true, createdAt });
    } catch (error) {
      remove(reference);
      if (error?.code === 'BACKUP_CHECKSUM_INVALID') throw error;
      fail('BACKUP_FAILED');
    }
  }

  function readVerified({ profileId, reference, checksum } = {}) {
    assertIdentifier(profileId, 'BACKUP_INPUT_INVALID');
    assertIdentifier(reference, 'BACKUP_INPUT_INVALID');
    let artifact;
    try {
      artifact = artifactStore.read(reference);
    } catch {
      fail('BACKUP_INVALID');
    }
    let envelope;
    try {
      envelope = JSON.parse(artifact.toString('utf8'));
    } catch {
      fail('BACKUP_CHECKSUM_INVALID');
    }
    if (
      !exactKeys(envelope, ['manifest', 'payload']) ||
      !exactKeys(envelope.manifest, ['format', 'version', 'ownerId', 'createdAt', 'checksum']) ||
      envelope.manifest.format !== 'easy-rewind-backup' ||
      envelope.manifest.version !== 1 ||
      envelope.manifest.ownerId !== profileId ||
      !Number.isSafeInteger(envelope.manifest.createdAt) ||
      envelope.manifest.createdAt < 0 ||
      typeof envelope.manifest.checksum !== 'string' ||
      !/^[a-f0-9]{64}$/.test(envelope.manifest.checksum) ||
      typeof envelope.payload !== 'string'
    ) {
      fail('BACKUP_INVALID');
    }
    let bytes;
    try {
      bytes = Buffer.from(envelope.payload, 'base64');
    } catch {
      fail('BACKUP_INVALID');
    }
    if (
      sha256(bytes) !== envelope.manifest.checksum ||
      (checksum !== undefined && checksum !== envelope.manifest.checksum)
    ) {
      fail('BACKUP_CHECKSUM_INVALID');
    }
    return bytes;
  }

  return Object.freeze({ createVerified, readVerified, remove });
}

module.exports = { createBackupService };
